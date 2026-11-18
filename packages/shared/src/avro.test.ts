import { describe, expect, test } from 'vitest';
import { assertValidEvent, avroTypeFor } from './avro.js';
import { EVENT_CATALOGUE, type AgreementRequested } from './generated/events.js';

const event: AgreementRequested = {
  eventId: '0b0e7c1c-51a5-4a55-9d0b-0d3a5f1f6a01',
  eventType: 'agreement.requested',
  eventVersion: 1,
  occurredAt: 1_794_000_000_000,
  agreementId: '5f3c2c56-6a55-4b43-8f0e-7a4f0f0f2b02',
  correlationId: 'OPP-0001',
  source: 'SALESFORCE',
  opportunityId: '006xx000001',
  templateId: 'standard-msa',
  customerName: 'Acme Ltd',
  amount: '12500.50',
  currency: 'GBP',
  signerName: 'Ada Lovelace',
  signerEmail: 'ada@example.com',
};

test('the catalogue holds every event with its topic and TopicRecordNameStrategy subject', () => {
  const subjects = Object.fromEntries(
    Object.entries(EVENT_CATALOGUE).map(([name, { topic, subject }]) => [name, { topic, subject }]),
  );
  expect(subjects).toEqual({
    AgreementRequested: {
      topic: 'agreements',
      subject: 'agreements-signingplatform.agreements.AgreementRequested',
    },
    DocumentGenerated: {
      topic: 'documents',
      subject: 'documents-signingplatform.documents.DocumentGenerated',
    },
    DocumentGenerationFailed: {
      topic: 'documents',
      subject: 'documents-signingplatform.documents.DocumentGenerationFailed',
    },
    DocumentVaulted: { topic: 'vault', subject: 'vault-signingplatform.vault.DocumentVaulted' },
    EnvelopeCompleted: {
      topic: 'envelopes',
      subject: 'envelopes-signingplatform.envelopes.EnvelopeCompleted',
    },
    EnvelopeDeclined: {
      topic: 'envelopes',
      subject: 'envelopes-signingplatform.envelopes.EnvelopeDeclined',
    },
    EnvelopeSent: { topic: 'envelopes', subject: 'envelopes-signingplatform.envelopes.EnvelopeSent' },
  });
});

describe('decimal amounts', () => {
  const type = avroTypeFor('AgreementRequested');
  const roundTrip = (amount: string) =>
    (type.fromBuffer(type.toBuffer({ ...event, amount })) as AgreementRequested).amount;

  test.each([
    ['12500.50', '12500.50'],
    ['0.01', '0.01'],
    ['0', '0.00'],
    ['7', '7.00'],
    ['1.5', '1.50'],
    ['-0.05', '-0.05'],
    ['-128', '-128.00'],
    ['1.27', '1.27'],
    ['1.28', '1.28'],
    ['9999999999.99', '9999999999.99'],
    ['-9999999999.99', '-9999999999.99'],
  ])('%s survives an Avro round trip as %s', (written, read) => {
    expect(roundTrip(written)).toBe(read);
  });

  test('the bytes are the unscaled value in big-endian two\'s complement', () => {
    const encode = (amount: string) => {
      const withAmount = type.toBuffer({ ...event, amount });
      const withZero = type.toBuffer({ ...event, amount: '0' });
      // The amount is the only field that differs, so compare the hex around it.
      return { length: withAmount.length - withZero.length, hex: withAmount.toString('hex') };
    };
    // 1.27 is unscaled 127 (0x7f, one byte); 1.28 is 128, which needs a leading zero byte.
    expect(encode('1.27')).toMatchObject({ length: 0 });
    expect(encode('1.27').hex).toContain('027f');
    expect(encode('1.28')).toMatchObject({ length: 1 });
    expect(encode('1.28').hex).toContain('040080');
    expect(encode('-0.01').hex).toContain('02ff');
  });

  test.each(['1.005', '10000000000.00', 'abc', '', '1e3', '1,000.00'])(
    '%j is rejected',
    (amount) => {
      expect(() => assertValidEvent('AgreementRequested', { ...event, amount })).toThrow(/amount/);
    },
  );
});

describe('assertValidEvent', () => {
  test('accepts an event that matches its schema', () => {
    expect(() => assertValidEvent('AgreementRequested', event)).not.toThrow();
  });

  test('names every field that does not match', () => {
    expect(() =>
      assertValidEvent('AgreementRequested', { ...event, customerName: undefined, source: 'EMAIL' }),
    ).toThrow(/AgreementRequested.*source.*customerName|AgreementRequested.*customerName.*source/);
  });
});
