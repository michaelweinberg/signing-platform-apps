import type { SchemaRegistry } from '@kafkajs/confluent-schema-registry';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import type { Producer, TopicMessages } from 'kafkajs';
import { assertValidEvent, encodeEvent } from './avro.js';
import { EVENT_CATALOGUE, type EventMap, type EventName } from './generated/events.js';

const OUTBOX_KEY_PREFIX = 'OUTBOX#';

type TransactWriteItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/** What an outbox item holds, besides its key. */
interface OutboxItem {
  PK: string;
  eventName: EventName;
  topic: string;
  /** The Kafka message key: the agreement ID. */
  key: string;
  /** The event as JSON. The relay turns it into Avro. */
  payload: string;
}

export interface OutboxPutOptions {
  tableName: string;
  /** Set for tables that have a sort key. The outbox item repeats its partition key value there. */
  sortKeyAttribute?: string;
}

/**
 * Builds the outbox item for an event, as one entry of a DynamoDB `TransactWriteCommand`.
 * Put it in the same transaction as the state change, so that either both are written or neither.
 *
 * The event is checked against its Avro schema here, so a malformed event fails the handler
 * instead of getting stuck in the relay.
 */
export function outboxPut<N extends EventName>(
  eventName: N,
  event: EventMap[N],
  options: OutboxPutOptions,
): TransactWriteItem {
  assertValidEvent(eventName, event);

  const item: OutboxItem = {
    PK: `${OUTBOX_KEY_PREFIX}${event.eventId}`,
    eventName,
    topic: EVENT_CATALOGUE[eventName].topic,
    key: event.agreementId,
    payload: JSON.stringify(event),
  };

  return {
    Put: {
      TableName: options.tableName,
      Item: options.sortKeyAttribute ? { ...item, [options.sortKeyAttribute]: item.PK } : item,
      ConditionExpression: 'attribute_not_exists(PK)',
    },
  };
}

/**
 * The part of a DynamoDB Streams record the relay reads. Both the Lambda event and the
 * SDK's `GetRecords` output fit this shape.
 */
export interface OutboxStreamRecord {
  eventName?: string;
  dynamodb?: { NewImage?: Record<string, unknown> };
}

export interface OutboxRelayDependencies {
  /** A connected producer. The caller owns its lifecycle. */
  producer: Pick<Producer, 'sendBatch'>;
  registry: SchemaRegistry;
}

function isOutboxItem(item: Record<string, unknown>): item is Record<string, unknown> & OutboxItem {
  return (
    typeof item.PK === 'string' &&
    item.PK.startsWith(OUTBOX_KEY_PREFIX) &&
    typeof item.eventName === 'string' &&
    item.eventName in EVENT_CATALOGUE &&
    typeof item.topic === 'string' &&
    typeof item.key === 'string' &&
    typeof item.payload === 'string'
  );
}

/**
 * Creates the outbox relay: the handler for a table's DynamoDB stream. It publishes every
 * newly inserted outbox item to Kafka as Avro, keyed by agreement ID, and ignores all other
 * records.
 *
 * It throws if anything fails, so the stream retries the whole batch. Events can therefore
 * be published more than once; consumers are idempotent on `eventId`.
 */
export function createOutboxRelay({ producer, registry }: OutboxRelayDependencies) {
  return async function relay(event: { Records: OutboxStreamRecord[] }): Promise<void> {
    const messagesByTopic = new Map<string, TopicMessages['messages']>();

    for (const record of event.Records) {
      if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) continue;
      const item = unmarshall(record.dynamodb.NewImage as Parameters<typeof unmarshall>[0]);
      if (typeof item.PK !== 'string' || !item.PK.startsWith(OUTBOX_KEY_PREFIX)) continue;
      if (!isOutboxItem(item)) throw new Error(`Malformed outbox item ${item.PK}`);

      const value = await encodeEvent(registry, item.eventName, JSON.parse(item.payload));
      const messages = messagesByTopic.get(item.topic) ?? [];
      messages.push({ key: item.key, value });
      messagesByTopic.set(item.topic, messages);
    }

    if (messagesByTopic.size === 0) return;
    await producer.sendBatch({
      topicMessages: [...messagesByTopic].map(([topic, messages]) => ({ topic, messages })),
    });
  };
}
