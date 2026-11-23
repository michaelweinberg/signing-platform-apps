import { randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { outboxPut, type AgreementRequested } from '@signing-platform/shared';

// Throwaway function: proves that an event written to an outbox on a deployed stage
// reaches Confluent Cloud as Avro. Remove it, with its table and relay, once a real
// service publishes.

const documents = DynamoDBDocumentClient.from(new DynamoDBClient());

/** Writes a made-up agreement and its `AgreementRequested` event in one transaction. */
export async function handler(): Promise<{ topic: string; agreementId: string; eventId: string }> {
  const tableName = process.env.TABLE_NAME;
  if (!tableName) throw new Error('Environment variable TABLE_NAME is not set');

  const event: AgreementRequested = {
    eventId: randomUUID(),
    eventType: 'agreement.requested',
    eventVersion: 1,
    occurredAt: Date.now(),
    agreementId: randomUUID(),
    correlationId: 'THROWAWAY',
    source: 'DASHBOARD',
    opportunityId: null,
    templateId: 'throwaway',
    customerName: 'Throwaway Ltd',
    amount: '1.00',
    currency: 'GBP',
    signerName: 'Nobody',
    signerEmail: 'nobody@example.com',
  };

  await documents.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: tableName, Item: { PK: `AGREEMENT#${event.agreementId}` } } },
        outboxPut('AgreementRequested', event, { tableName }),
      ],
    }),
  );

  return { topic: 'agreements', agreementId: event.agreementId, eventId: event.eventId };
}
