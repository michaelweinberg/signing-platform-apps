// Waits for the event the throwaway function published to arrive on its topic, and prints it.
//
//   pnpm --filter @signing-platform/publish-event expect-event <topic> <agreementId>
//
// Reads the same environment variables as a running service (see `kafkaClientsFromEnv`).
// Throwaway, like the function it checks.
import { randomUUID } from 'node:crypto';
import { kafkaClientsFromEnv } from '@signing-platform/shared';

const TIMEOUT_MS = 90_000;

const [topic, key] = process.argv.slice(2);
if (!topic || !key) throw new Error('Usage: expect-event.ts <topic> <agreementId>');

const { kafka, registry } = kafkaClientsFromEnv();
const groupId = `publish-event-check-${randomUUID()}`;
const consumer = kafka.consumer({ groupId });

await consumer.connect();
await consumer.subscribe({ topic, fromBeginning: true });

let value: Buffer | undefined;
try {
  value = await new Promise<Buffer | undefined>((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), TIMEOUT_MS);
    consumer
      .run({
        eachMessage: ({ message }) => {
          if (message.key?.toString() === key && message.value) {
            clearTimeout(timer);
            resolve(message.value);
          }
          return Promise.resolve();
        },
      })
      .catch(reject);
  });
} finally {
  await consumer.disconnect();
  // The group was only ever for this run.
  const admin = kafka.admin();
  await admin.connect();
  await admin.deleteGroups([groupId]).catch(() => undefined);
  await admin.disconnect();
}

if (!value) {
  console.error(`::error::No message with key ${key} arrived on ${topic} within ${TIMEOUT_MS / 1000} seconds.`);
  process.exit(1);
}

// Confluent wire format: magic byte 0, a four-byte schema ID, then the Avro payload.
console.log(`Message on ${topic}: magic byte ${value.readUInt8(0)}, schema ID ${value.readUInt32BE(1)}`);
console.log(JSON.stringify(await registry.decode(value), null, 2));
