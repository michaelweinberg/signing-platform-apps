// What the deploy pipeline and the pull request checks do to the schema registry.
// Running services never call this: they only look schemas up (see avro.ts).
import { EVENT_CATALOGUE } from './generated/events.js';

export interface SchemaRegistryAdminConfig {
  url: string;
  auth?: { username: string; password: string };
}

export interface SubjectSchema {
  subject: string;
  schema: object;
}

export interface IncompatibleSchema {
  subject: string;
  /** The registry's explanation of what breaks. */
  messages: string[];
}

const COMPATIBILITY = 'BACKWARD';
const SUBJECT_NOT_FOUND = 40401;

/** Every event schema in the catalogue, with its `TopicRecordNameStrategy` subject. */
export function catalogueSchemas(): SubjectSchema[] {
  return Object.values(EVENT_CATALOGUE).map(({ subject, schema }) => ({ subject, schema }));
}

async function request(
  config: SchemaRegistryAdminConfig,
  method: string,
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/vnd.schemaregistry.v1+json' };
  if (config.auth) {
    const { username, password } = config.auth;
    headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  }
  const response = await fetch(new URL(path, config.url), { method, headers, body: JSON.stringify(body) });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Record<string, unknown> };
  } catch {
    throw new Error(`Schema registry ${method} ${path} returned ${response.status}: ${text.slice(0, 200)}`);
  }
}

function failure(action: string, subject: string, result: { status: number; body: Record<string, unknown> }) {
  return new Error(`Could not ${action} ${subject}: ${result.status} ${JSON.stringify(result.body)}`);
}

const avro = (schema: object) => ({ schemaType: 'AVRO', schema: JSON.stringify(schema) });

/**
 * Returns the schemas that are not `BACKWARD`-compatible with the latest version the
 * registry holds for their subject. A subject the registry does not have yet is compatible.
 * Changes nothing in the registry.
 */
export async function findIncompatibleSchemas(
  config: SchemaRegistryAdminConfig,
  schemas: SubjectSchema[] = catalogueSchemas(),
): Promise<IncompatibleSchema[]> {
  const incompatible: IncompatibleSchema[] = [];
  for (const { subject, schema } of schemas) {
    const path = `/compatibility/subjects/${encodeURIComponent(subject)}/versions/latest?verbose=true`;
    const result = await request(config, 'POST', path, avro(schema));
    if (result.status === 404 && result.body.error_code === SUBJECT_NOT_FOUND) continue;
    if (result.status !== 200) throw failure('check', subject, result);
    if (result.body.is_compatible !== true) {
      const messages = Array.isArray(result.body.messages) ? result.body.messages.map(String) : [];
      incompatible.push({ subject, messages });
    }
  }
  return incompatible;
}

/**
 * Sets every subject's compatibility to `BACKWARD` and registers its schema. Registering a
 * schema the registry already holds changes nothing. Throws on the first schema the
 * registry rejects, which includes an incompatible one.
 *
 * Returns the schema ID the registry holds for each subject.
 */
export async function registerSchemas(
  config: SchemaRegistryAdminConfig,
  schemas: SubjectSchema[] = catalogueSchemas(),
): Promise<{ subject: string; id: number }[]> {
  const registered: { subject: string; id: number }[] = [];
  for (const { subject, schema } of schemas) {
    const subjectPath = encodeURIComponent(subject);

    // Set before registering, so the registry checks the new version against this level
    // and not against whatever its global default happens to be.
    const configured = await request(config, 'PUT', `/config/${subjectPath}`, { compatibility: COMPATIBILITY });
    if (configured.status !== 200) throw failure('set compatibility on', subject, configured);

    const result = await request(config, 'POST', `/subjects/${subjectPath}/versions`, avro(schema));
    if (result.status !== 200 || typeof result.body.id !== 'number') throw failure('register', subject, result);
    registered.push({ subject, id: result.body.id });
  }
  return registered;
}
