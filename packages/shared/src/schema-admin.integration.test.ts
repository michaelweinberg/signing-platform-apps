// Runs against the schema registry in docker-compose.yml. Start it with `docker compose up -d --wait`.
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { catalogueSchemas, findIncompatibleSchemas, registerSchemas } from './schema-admin.js';

const config = { url: process.env.SCHEMA_REGISTRY_URL ?? 'http://localhost:8081' };

const field = (name: string, extra: object = {}) => ({ name, type: 'string', ...extra });
const record = (fields: object[]) => ({ type: 'record', name: 'Thing', namespace: 'test', fields });

// A fresh subject per test, so reruns against the same registry start clean.
const newSubject = () => `test-${randomUUID()}`;

async function compatibilityOf(subject: string): Promise<unknown> {
  const response = await fetch(new URL(`/config/${subject}`, config.url));
  return ((await response.json()) as { compatibilityLevel?: unknown }).compatibilityLevel;
}

test('registering creates the subject with BACKWARD compatibility, and is repeatable', async () => {
  const schemas = [{ subject: newSubject(), schema: record([field('a')]) }];

  const [first] = await registerSchemas(config, schemas);
  const [second] = await registerSchemas(config, schemas);

  expect(second).toEqual(first);
  expect(await compatibilityOf(schemas[0]!.subject)).toBe('BACKWARD');
});

test('a subject the registry does not have yet is compatible', async () => {
  const schemas = [{ subject: newSubject(), schema: record([field('a')]) }];

  expect(await findIncompatibleSchemas(config, schemas)).toEqual([]);
});

test('a new field with a default is compatible; one without is reported and refused', async () => {
  const subject = newSubject();
  await registerSchemas(config, [{ subject, schema: record([field('a')]) }]);

  const withDefault = [{ subject, schema: record([field('a'), field('b', { default: '' })]) }];
  expect(await findIncompatibleSchemas(config, withDefault)).toEqual([]);

  const withoutDefault = [{ subject, schema: record([field('a'), field('b')]) }];
  const incompatible = await findIncompatibleSchemas(config, withoutDefault);
  expect(incompatible).toHaveLength(1);
  expect(incompatible[0]!.subject).toBe(subject);
  expect(incompatible[0]!.messages.join(' ')).toContain('b');

  await expect(registerSchemas(config, withoutDefault)).rejects.toThrow(/Could not register/);
});

test('the catalogue covers every event, under its TopicRecordNameStrategy subject', () => {
  const subjects = catalogueSchemas().map(({ subject }) => subject);

  expect(subjects).toHaveLength(7);
  expect(subjects).toContain('envelopes-signingplatform.envelopes.EnvelopeCompleted');
});
