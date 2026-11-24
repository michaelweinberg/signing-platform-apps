import { marshall } from '@aws-sdk/util-dynamodb';
import type { SchemaRegistry } from '@kafkajs/confluent-schema-registry';
import type { ProducerBatch } from 'kafkajs';
import { expect, test } from 'vitest';
import type { EnvelopeSent } from './generated/events.js';
import { createOutboxRelay, outboxPut } from './outbox.js';

const event: EnvelopeSent = {
  eventId: '0b0e7c1c-51a5-4a55-9d0b-0d3a5f1f6a01',
  eventType: 'envelope.sent',
  eventVersion: 1,
  occurredAt: 1_794_000_000_000,
  agreementId: '5f3c2c56-6a55-4b43-8f0e-7a4f0f0f2b02',
  correlationId: 'OPP-0001',
  envelopeId: 'env-1',
  sentAt: 1_794_000_000_500,
};

// Stands in for the registry: "encodes" by tagging the JSON with a fixed schema ID.
const registry = {
  getRegistryIdBySchema: () => Promise.resolve(7),
  encode: (id: number, payload: unknown) => Promise.resolve(Buffer.from(`${id}:${JSON.stringify(payload)}`)),
} as unknown as SchemaRegistry;

function relayWithSpy() {
  const batches: ProducerBatch[] = [];
  const relay = createOutboxRelay({
    registry,
    producer: {
      sendBatch: (batch) => {
        batches.push(batch);
        return Promise.resolve([]);
      },
    },
  });
  return { relay, batches };
}

const insert = (item: Record<string, unknown>) => ({
  eventName: 'INSERT',
  dynamodb: { NewImage: marshall(item) },
});

test('the outbox item holds the event, its topic, and the agreement ID as the message key', () => {
  expect(outboxPut('EnvelopeSent', event, { tableName: 'signing' })).toEqual({
    Put: {
      TableName: 'signing',
      Item: {
        PK: `OUTBOX#${event.eventId}`,
        eventName: 'EnvelopeSent',
        topic: 'envelopes',
        key: event.agreementId,
        payload: JSON.stringify(event),
        createdAt: expect.any(Number) as number,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    },
  });
});

test('on a table with a sort key, the outbox item fills it', () => {
  const { Put } = outboxPut('EnvelopeSent', event, { tableName: 'signing', sortKeyAttribute: 'SK' });
  expect(Put?.Item).toMatchObject({ PK: `OUTBOX#${event.eventId}`, SK: `OUTBOX#${event.eventId}` });
});

test('an event that does not match its schema is refused before it reaches the table', () => {
  const malformed = { ...event, sentAt: 'yesterday' } as unknown as EnvelopeSent;
  expect(() => outboxPut('EnvelopeSent', malformed, { tableName: 'signing' })).toThrow(/sentAt/);
});

test('the relay publishes inserted outbox items in stream order, keyed by agreement ID', async () => {
  const { relay, batches } = relayWithSpy();
  const later = { ...event, eventId: '9c1d1c1c-51a5-4a55-9d0b-0d3a5f1f6a09' };
  const items = [event, later].map((e) => outboxPut('EnvelopeSent', e, { tableName: 'signing' }).Put!.Item!);

  await relay({ Records: items.map(insert) });

  expect(batches).toEqual([
    {
      topicMessages: [
        {
          topic: 'envelopes',
          messages: [event, later].map((e) => ({
            key: event.agreementId,
            value: Buffer.from(`7:${JSON.stringify(e)}`),
            // No span is being recorded here, so there is no trace context to carry.
            headers: {},
          })),
        },
      ],
    },
  ]);
});

test('the relay ignores state items and records that are not inserts', async () => {
  const { relay, batches } = relayWithSpy();
  const outboxItem = outboxPut('EnvelopeSent', event, { tableName: 'signing' }).Put!.Item!;

  await relay({
    Records: [
      insert({ PK: 'AGREEMENT#1', status: 'SENT' }),
      { eventName: 'MODIFY', dynamodb: { NewImage: marshall(outboxItem) } },
      { eventName: 'REMOVE', dynamodb: {} },
    ],
  });

  expect(batches).toEqual([]);
});

test('the relay fails the batch on an outbox item it cannot read', async () => {
  const { relay, batches } = relayWithSpy();
  await expect(
    relay({ Records: [insert({ PK: 'OUTBOX#1', eventName: 'NoSuchEvent' })] }),
  ).rejects.toThrow('Malformed outbox item OUTBOX#1');
  expect(batches).toEqual([]);
});
