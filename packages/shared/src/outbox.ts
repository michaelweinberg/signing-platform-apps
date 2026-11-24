import type { SchemaRegistry } from '@kafkajs/confluent-schema-registry';
import type { TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import {
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  context,
  metrics,
  propagation,
  trace,
  type Context,
  type Span,
} from '@opentelemetry/api';
import type { Message, Producer } from 'kafkajs';
import { assertValidEvent, encodeEvent } from './avro.js';
import { EVENT_CATALOGUE, type EventMap, type EventName } from './generated/events.js';
import { kafkaClientsFromEnv } from './kafka.js';
import { logger } from './logger.js';
import { startTelemetry, withTelemetry } from './telemetry.js';
import { serviceName, setAgreement } from './telemetry-context.js';

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
  /** When the item was written, in epoch milliseconds. The relay measures its delay from this. */
  createdAt?: number;
  /** The trace the handler was in when it wrote the item. The relay continues it. */
  traceparent?: string;
  tracestate?: string;
}

/** The current trace context, as the two W3C fields. Empty outside a recorded span. */
function currentTraceContext(): Pick<OutboxItem, 'traceparent' | 'tracestate'> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return {
    ...(carrier.traceparent ? { traceparent: carrier.traceparent } : {}),
    ...(carrier.tracestate ? { tracestate: carrier.tracestate } : {}),
  };
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
 *
 * The item records the trace it was built in, so call this inside the handler's span. A
 * DynamoDB stream carries no trace context of its own; this is how the trace crosses it.
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
    createdAt: Date.now(),
    ...currentTraceContext(),
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
    typeof item.payload === 'string' &&
    // Absent on items written before these fields existed.
    (item.createdAt === undefined || typeof item.createdAt === 'number') &&
    (item.traceparent === undefined || typeof item.traceparent === 'string') &&
    (item.tracestate === undefined || typeof item.tracestate === 'string')
  );
}

/** An outbox item on its way to Kafka, with the spans that describe the trip. */
interface Publication {
  item: OutboxItem;
  message: Message;
  /** The handler's trace, restored from the item, with the relay span current. */
  context: Context;
  relaySpan: Span;
  sendSpan?: Span;
}

// Bucket edges in milliseconds. 60 000 is the "outbox stuck" alert threshold.
const DELAY_BUCKETS_MS = [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000];

function createInstruments() {
  const meter = metrics.getMeter('signing-platform');
  return {
    eventsPublished: meter.createCounter('events_published_total', {
      description: 'Events published to Kafka',
    }),
    relayDelay: meter.createHistogram('outbox_relay_delay_ms', {
      description: 'Time from an outbox item being written to its event being published',
      unit: 'ms',
      advice: { explicitBucketBoundaries: DELAY_BUCKETS_MS },
    }),
  };
}

/**
 * Creates the outbox relay: the handler for a table's DynamoDB stream. It publishes every
 * newly inserted outbox item to Kafka as Avro, keyed by agreement ID, and ignores all other
 * records.
 *
 * It throws if anything fails, so the stream retries the whole batch. Events can therefore
 * be published more than once; consumers are idempotent on `eventId`.
 *
 * Each item continues the trace of the handler that wrote it: a relay span, and inside it a
 * send span whose context goes out in the message's `traceparent` and `tracestate` headers.
 */
export function createOutboxRelay({ producer, registry }: OutboxRelayDependencies) {
  startTelemetry();
  let instruments: ReturnType<typeof createInstruments> | undefined;

  return async function relay(event: { Records: OutboxStreamRecord[] }): Promise<void> {
    const tracer = trace.getTracer('signing-platform');
    // A batch can hold items from many traces. Each item's relay span links back to the
    // invocation that carried it.
    const invocation = trace.getActiveSpan()?.spanContext();
    const publications: Publication[] = [];

    try {
      for (const record of event.Records) {
        if (record.eventName !== 'INSERT' || !record.dynamodb?.NewImage) continue;
        const item = unmarshall(record.dynamodb.NewImage as Parameters<typeof unmarshall>[0]);
        if (typeof item.PK !== 'string' || !item.PK.startsWith(OUTBOX_KEY_PREFIX)) continue;
        if (!isOutboxItem(item)) throw new Error(`Malformed outbox item ${item.PK}`);

        const payload = JSON.parse(item.payload) as EventMap[EventName];
        const restored = setAgreement(propagation.extract(ROOT_CONTEXT, item), payload);
        const relaySpan = tracer.startSpan(
          'outbox relay',
          { attributes: { 'event.name': item.eventName }, links: invocation ? [{ context: invocation }] : [] },
          restored,
        );
        const publication: Publication = {
          item,
          message: { key: item.key, value: null },
          context: trace.setSpan(restored, relaySpan),
          relaySpan,
        };
        publications.push(publication);
        publication.message.value = await context.with(publication.context, () =>
          encodeEvent(registry, item.eventName, payload),
        );
      }
      if (publications.length === 0) return;

      const messagesByTopic = new Map<string, Message[]>();
      for (const publication of publications) {
        const { item, message } = publication;
        publication.sendSpan = tracer.startSpan(
          `send ${item.topic}`,
          {
            kind: SpanKind.PRODUCER,
            attributes: {
              'messaging.system': 'kafka',
              'messaging.operation.name': 'send',
              'messaging.operation.type': 'send',
              'messaging.destination.name': item.topic,
              'messaging.kafka.message.key': item.key,
            },
          },
          publication.context,
        );
        const headers: Record<string, string> = {};
        propagation.inject(trace.setSpan(publication.context, publication.sendSpan), headers);
        message.headers = headers;

        const messages = messagesByTopic.get(item.topic) ?? [];
        messages.push(message);
        messagesByTopic.set(item.topic, messages);
      }

      await producer.sendBatch({
        topicMessages: [...messagesByTopic].map(([topic, messages]) => ({ topic, messages })),
      });

      const publishedAt = Date.now();
      instruments ??= createInstruments();
      for (const { item, context: publicationContext } of publications) {
        // Label values are bounded: the service, and a topic and event name from the catalogue.
        instruments.eventsPublished.add(1, {
          service: serviceName(),
          topic: item.topic,
          event_type: item.eventName,
        });
        const delayMs = item.createdAt === undefined ? undefined : Math.max(0, publishedAt - item.createdAt);
        if (delayMs !== undefined) instruments.relayDelay.record(delayMs, { service: serviceName() });
        context.with(publicationContext, () =>
          logger.info('Published event', { eventName: item.eventName, topic: item.topic, delayMs }),
        );
      }
    } catch (error) {
      for (const { relaySpan, sendSpan } of publications) {
        for (const span of [sendSpan, relaySpan]) {
          span?.recordException(error as Error);
          span?.setStatus({ code: SpanStatusCode.ERROR });
        }
      }
      throw error;
    } finally {
      for (const { relaySpan, sendSpan } of publications) {
        sendSpan?.end();
        relaySpan.end();
      }
    }
  };
}

/**
 * The outbox relay as a Lambda handler, configured from the environment (see
 * `kafkaClientsFromEnv`). Subscribe it to a service table's DynamoDB stream:
 *
 * ```ts
 * export const handler = outboxRelayHandler();
 * ```
 *
 * The producer connects on the first invocation and is reused by later ones. The handler
 * is already wrapped in `withTelemetry`.
 */
export function outboxRelayHandler(): (event: { Records: OutboxStreamRecord[] }) => Promise<void> {
  let relay: Promise<ReturnType<typeof createOutboxRelay>> | undefined;

  async function connect() {
    const { kafka, registry } = kafkaClientsFromEnv();
    // Topics are declared in sst.config.ts. A missing one is an error, never created here.
    const producer = kafka.producer({ allowAutoTopicCreation: false });
    await producer.connect();
    return createOutboxRelay({ producer, registry });
  }

  return withTelemetry(async (event) => {
    relay ??= connect();
    // A failed connection must not be cached, or the function would fail until its next cold start.
    relay.catch(() => (relay = undefined));
    await (await relay)(event);
  });
}
