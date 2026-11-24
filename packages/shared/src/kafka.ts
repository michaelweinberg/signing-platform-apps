import type { SchemaRegistry } from '@kafkajs/confluent-schema-registry';
import { Kafka, logLevel } from 'kafkajs';
import { createSchemaRegistry } from './avro.js';

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Environment variable ${name} is not set`);
  return value;
}

/** Reads a key and secret that must be set together, or not at all. */
function credentials(env: Env, keyName: string, secretName: string) {
  const key = env[keyName];
  const secret = env[secretName];
  if (!key && !secret) return undefined;
  if (!key || !secret) throw new Error(`Set both ${keyName} and ${secretName}, or neither`);
  return { username: key, password: secret };
}

/**
 * The Kafka and schema registry clients for a running service, from its environment:
 *
 * - `KAFKA_BOOTSTRAP_SERVERS`, and `KAFKA_API_KEY` with `KAFKA_API_SECRET`
 * - `SCHEMA_REGISTRY_URL`, and `SCHEMA_REGISTRY_API_KEY` with `SCHEMA_REGISTRY_API_SECRET`
 *
 * With credentials the connection uses TLS and SASL/PLAIN, as Confluent Cloud requires.
 * Without them it is plaintext, for the local broker.
 */
export function kafkaClientsFromEnv(env: Env = process.env): { kafka: Kafka; registry: SchemaRegistry } {
  const sasl = credentials(env, 'KAFKA_API_KEY', 'KAFKA_API_SECRET');
  const kafka = new Kafka({
    brokers: required(env, 'KAFKA_BOOTSTRAP_SERVERS').split(','),
    logLevel: logLevel.ERROR,
    ...(sasl ? { ssl: true, sasl: { mechanism: 'plain' as const, ...sasl } } : {}),
  });
  const registry = createSchemaRegistry({
    host: required(env, 'SCHEMA_REGISTRY_URL'),
    auth: credentials(env, 'SCHEMA_REGISTRY_API_KEY', 'SCHEMA_REGISTRY_API_SECRET'),
  });
  return { kafka, registry };
}
