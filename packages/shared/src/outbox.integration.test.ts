// Runs against the services in docker-compose.yml. Start them with `docker compose up -d --wait`.
import { randomUUID } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DescribeStreamCommand,
  DynamoDBStreamsClient,
  GetRecordsCommand,
  GetShardIteratorCommand,
} from '@aws-sdk/client-dynamodb-streams';
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { SchemaType } from '@kafkajs/confluent-schema-registry';
import { Kafka, logLevel, type KafkaMessage } from 'kafkajs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  EVENT_CATALOGUE,
  createOutboxRelay,
  createSchemaRegistry,
  encodeEvent,
  outboxPut,
  type AgreementRequested,
  type OutboxStreamRecord,
} from './index.js';

const awsConfig = {
  endpoint: process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:8000',
  region: 'local',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
};
const dynamo = new DynamoDBClient(awsConfig);
const documents = DynamoDBDocumentClient.from(dynamo);
const streams = new DynamoDBStreamsClient(awsConfig);

const kafka = new Kafka({
  brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
  logLevel: logLevel.ERROR,
});
const producer = kafka.producer();
const registry = createSchemaRegistry({
  host: process.env.SCHEMA_REGISTRY_URL ?? 'http://localhost:8081',
});
const relay = createOutboxRelay({ producer, registry });

const tableName = `outbox-test-${randomUUID()}`;
let streamArn: string;

beforeAll(async () => {
  const table = await dynamo.send(
    new CreateTableCommand({
      TableName: tableName,
      AttributeDefinitions: [{ AttributeName: 'PK', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }],
      BillingMode: 'PAY_PER_REQUEST',
      StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' },
    }),
  );
  streamArn = table.TableDescription!.LatestStreamArn!;

  // The deploy pipeline's jobs: create the topics and register the schemas.
  const admin = kafka.admin();
  await admin.connect();
  const topics = [...new Set(Object.values(EVENT_CATALOGUE).map(({ topic }) => topic))];
  await admin.createTopics({ topics: topics.map((topic) => ({ topic, numPartitions: 3 })) });
  await admin.disconnect();
  for (const { subject, schema } of Object.values(EVENT_CATALOGUE)) {
    await registry.register({ type: SchemaType.AVRO, schema: JSON.stringify(schema) }, { subject });
  }

  await producer.connect();
});

afterAll(async () => {
  await producer.disconnect();
  await dynamo.send(new DeleteTableCommand({ TableName: tableName }));
});

/** Reads every record on the table's stream, as the Lambda event source mapping would. */
async function readStream(): Promise<OutboxStreamRecord[]> {
  const { StreamDescription } = await streams.send(new DescribeStreamCommand({ StreamArn: streamArn }));
  const records: OutboxStreamRecord[] = [];
  for (const shard of StreamDescription?.Shards ?? []) {
    const { ShardIterator } = await streams.send(
      new GetShardIteratorCommand({
        StreamArn: streamArn,
        ShardId: shard.ShardId,
        ShardIteratorType: 'TRIM_HORIZON',
      }),
    );
    const page = await streams.send(new GetRecordsCommand({ ShardIterator }));
    records.push(...(page.Records ?? []));
  }
  return records;
}

/** Reads the topic from the beginning until a message with the given key arrives. */
async function consumeByKey(topic: string, key: string): Promise<KafkaMessage> {
  const consumer = kafka.consumer({ groupId: `outbox-test-${randomUUID()}` });
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  try {
    return await new Promise<KafkaMessage>((resolve, reject) => {
      consumer
        .run({
          eachMessage: ({ message }) => {
            if (message.key?.toString() === key) resolve(message);
            return Promise.resolve();
          },
        })
        .catch(reject);
    });
  } finally {
    await consumer.disconnect();
  }
}

function agreementRequested(): AgreementRequested {
  return {
    eventId: randomUUID(),
    eventType: 'agreement.requested',
    eventVersion: 1,
    occurredAt: Date.now(),
    agreementId: randomUUID(),
    correlationId: 'OPP-0001',
    source: 'DASHBOARD',
    opportunityId: null,
    templateId: 'standard-msa',
    customerName: 'Acme Ltd',
    amount: '12500.50',
    currency: 'GBP',
    signerName: 'Ada Lovelace',
    signerEmail: 'ada@example.com',
  };
}

test('a state change and its event are written together and the relay publishes the event as Avro', async () => {
  const event = agreementRequested();
  const agreementKey = `AGREEMENT#${event.agreementId}`;

  await documents.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: tableName, Item: { PK: agreementKey, customerName: event.customerName } } },
        outboxPut('AgreementRequested', event, { tableName }),
      ],
    }),
  );
  const state = await documents.send(new GetCommand({ TableName: tableName, Key: { PK: agreementKey } }));
  expect(state.Item).toMatchObject({ customerName: 'Acme Ltd' });

  await relay({ Records: await readStream() });

  const message = await consumeByKey('agreements', event.agreementId);
  const value = message.value!;

  // Confluent wire format: magic byte 0, then the schema ID registered under the
  // TopicRecordNameStrategy subject.
  expect(value.readUInt8(0)).toBe(0);
  expect(value.readUInt32BE(1)).toBe(
    await registry.getLatestSchemaId('agreements-signingplatform.agreements.AgreementRequested'),
  );
  expect(await registry.decode(value)).toEqual(event);
});

test('a process that has validated an event can still encode it with a new registry client', async () => {
  const event = agreementRequested();
  // Validates the event, which compiles its schema.
  outboxPut('AgreementRequested', event, { tableName });

  // A client that has not seen the schema fetches it from the registry and compiles it again.
  const freshRegistry = createSchemaRegistry({
    host: process.env.SCHEMA_REGISTRY_URL ?? 'http://localhost:8081',
  });
  const value = await encodeEvent(freshRegistry, 'AgreementRequested', event);

  expect(await freshRegistry.decode(value)).toEqual(event);
});

test('a failed transaction writes neither the state change nor the outbox item', async () => {
  const event = agreementRequested();
  const recordsBefore = (await readStream()).length;

  await expect(
    documents.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: tableName,
              Item: { PK: `AGREEMENT#${event.agreementId}` },
              ConditionExpression: 'attribute_exists(PK)',
            },
          },
          outboxPut('AgreementRequested', event, { tableName }),
        ],
      }),
    ),
  ).rejects.toThrow(/ConditionalCheckFailed/);

  const outboxItem = await documents.send(
    new GetCommand({ TableName: tableName, Key: { PK: `OUTBOX#${event.eventId}` } }),
  );
  expect(outboxItem.Item).toBeUndefined();
  expect(await readStream()).toHaveLength(recordsBefore);
});
