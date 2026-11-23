// Checks or registers every event schema against a schema registry.
//
//   pnpm schemas:check      Fails if any .avsc file is not BACKWARD-compatible with the registry.
//   pnpm schemas:register   Sets each subject to BACKWARD and registers its schema.
//
// Reads SCHEMA_REGISTRY_URL, and SCHEMA_REGISTRY_API_KEY and SCHEMA_REGISTRY_API_SECRET
// if the registry needs them (Confluent Cloud does; the local one does not).
import { findIncompatibleSchemas, registerSchemas } from '../src/schema-admin.js';

const command = process.argv[2];
const { SCHEMA_REGISTRY_URL: url, SCHEMA_REGISTRY_API_KEY: key, SCHEMA_REGISTRY_API_SECRET: secret } = process.env;

if (!url) throw new Error('Set SCHEMA_REGISTRY_URL');
if (Boolean(key) !== Boolean(secret)) {
  throw new Error('Set both SCHEMA_REGISTRY_API_KEY and SCHEMA_REGISTRY_API_SECRET, or neither');
}
const config = { url, auth: key && secret ? { username: key, password: secret } : undefined };

if (command === 'check') {
  const incompatible = await findIncompatibleSchemas(config);
  for (const { subject, messages } of incompatible) {
    // The `::error::` prefix makes GitHub Actions show the line as an annotation.
    console.error(`::error::${subject} is not BACKWARD-compatible with the registered schema.`);
    for (const message of messages) console.error(`  ${message}`);
  }
  if (incompatible.length > 0) process.exit(1);
  console.log('Every schema is BACKWARD-compatible with the registry.');
} else if (command === 'register') {
  for (const { subject, id } of await registerSchemas(config)) console.log(`${subject}: schema ID ${id}`);
} else {
  throw new Error('Usage: schemas.ts check|register');
}
