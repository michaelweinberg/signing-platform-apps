// Generates src/generated/events.ts from schemas/<topic>/<RecordName>.avsc.
// Run with `pnpm generate`. The pull request workflow reruns it and fails on any diff.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

type AvroType = string | AvroType[] | AvroComplexType;
interface AvroField {
  name: string;
  type: AvroType;
  doc?: string;
}
interface AvroComplexType {
  type: string;
  logicalType?: string;
  name?: string;
  namespace?: string;
  doc?: string;
  fields?: AvroField[];
  symbols?: string[];
  items?: AvroType;
  values?: AvroType;
  scale?: number;
}

const NAMESPACE_ROOT = 'signingplatform';

// Every event record starts with these fields. See the event catalogue.
const COMMON_FIELDS: AvroField[] = [
  { name: 'eventId', type: { type: 'string', logicalType: 'uuid' } },
  { name: 'eventType', type: 'string' },
  { name: 'eventVersion', type: 'int' },
  { name: 'occurredAt', type: { type: 'long', logicalType: 'timestamp-millis' } },
  { name: 'agreementId', type: { type: 'string', logicalType: 'uuid' } },
  { name: 'correlationId', type: 'string' },
];

const PRIMITIVES: Record<string, string> = {
  null: 'null',
  boolean: 'boolean',
  int: 'number',
  long: 'number',
  float: 'number',
  double: 'number',
  string: 'string',
  bytes: 'Uint8Array',
};

const packageDir = join(import.meta.dirname, '..');
const schemasDir = join(packageDir, 'schemas');
const outFile = join(packageDir, 'src', 'generated', 'events.ts');

// Named types (records and enums) found while walking a schema, in declaration order.
const declarations = new Map<string, string>();

function declare(name: string, source: string, file: string): void {
  if (declarations.has(name)) throw new Error(`${file}: type name ${name} is declared twice`);
  declarations.set(name, source);
}

function fieldComment(type: AvroType): string | undefined {
  if (typeof type !== 'object' || Array.isArray(type)) return undefined;
  if (type.logicalType === 'timestamp-millis') return 'Epoch milliseconds.';
  if (type.logicalType === 'decimal') return `Decimal string with ${type.scale ?? 0} decimal places.`;
  if (type.logicalType === 'uuid') return 'UUID.';
  return undefined;
}

function toTs(type: AvroType, file: string): string {
  if (typeof type === 'string') {
    // A bare name that is not a primitive refers to a named type declared earlier.
    return PRIMITIVES[type] ?? type;
  }
  if (Array.isArray(type)) return type.map((member) => toTs(member, file)).join(' | ');

  switch (type.type) {
    case 'record': {
      if (!type.name || !type.fields) throw new Error(`${file}: record without name or fields`);
      const lines = type.fields.flatMap((field) => {
        const comment = field.doc ?? fieldComment(field.type);
        const line = `  ${field.name}: ${toTs(field.type, file)};`;
        return comment ? [`  /** ${comment} */`, line] : [line];
      });
      const doc = type.doc ? `/** ${type.doc} */\n` : '';
      declare(type.name, `${doc}export interface ${type.name} {\n${lines.join('\n')}\n}`, file);
      return type.name;
    }
    case 'enum': {
      if (!type.name || !type.symbols) throw new Error(`${file}: enum without name or symbols`);
      const union = type.symbols.map((symbol) => `'${symbol}'`).join(' | ');
      declare(type.name, `export type ${type.name} = ${union};`, file);
      return type.name;
    }
    case 'array': {
      if (!type.items) throw new Error(`${file}: array without items`);
      return `Array<${toTs(type.items, file)}>`;
    }
    case 'map': {
      if (!type.values) throw new Error(`${file}: map without values`);
      return `Record<string, ${toTs(type.values, file)}>`;
    }
    case 'bytes':
      // Decimals travel as strings so they survive JSON and never touch floating point.
      return type.logicalType === 'decimal' ? 'string' : 'Uint8Array';
    case 'fixed':
      return 'Uint8Array';
    default: {
      const primitive = PRIMITIVES[type.type];
      if (!primitive) throw new Error(`${file}: unsupported Avro type ${type.type}`);
      return primitive;
    }
  }
}

const files = readdirSync(schemasDir, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.avsc'))
  .sort();

const events: { name: string; topic: string; subject: string; schema: AvroComplexType }[] = [];

for (const file of files) {
  const schema = JSON.parse(readFileSync(join(schemasDir, file), 'utf8')) as AvroComplexType;
  const topic = basename(dirname(file));
  const name = basename(file, '.avsc');
  const namespace = `${NAMESPACE_ROOT}.${topic}`;

  if (schema.type !== 'record' || !schema.fields) throw new Error(`${file}: must be a record`);
  if (schema.name !== name) throw new Error(`${file}: record name must be ${name}`);
  if (schema.namespace !== namespace) throw new Error(`${file}: namespace must be ${namespace}`);
  if (!isDeepStrictEqual(schema.fields.slice(0, COMMON_FIELDS.length), COMMON_FIELDS)) {
    throw new Error(`${file}: must start with the common fields from the event catalogue`);
  }

  toTs(schema, file);
  // TopicRecordNameStrategy: <topic>-<namespace>.<RecordName>
  events.push({ name, topic, subject: `${topic}-${namespace}.${name}`, schema });
}

events.sort((a, b) => a.name.localeCompare(b.name));

const catalogueEntries = events.map(({ name, topic, subject, schema }) => {
  const schemaSource = JSON.stringify(schema, null, 2).replaceAll('\n', '\n    ');
  return `  ${name}: {\n    topic: '${topic}',\n    subject: '${subject}',\n    schema: ${schemaSource},\n  },`;
});

const output = `// Generated by scripts/generate-types.ts from schemas/**/*.avsc. Do not edit by hand.
// Run \`pnpm generate\` after changing a schema.

${[...declarations.values()].join('\n\n')}

/** Maps each event's record name to its TypeScript type. */
export interface EventMap {
${events.map(({ name }) => `  ${name}: ${name};`).join('\n')}
}

export type EventName = keyof EventMap;

export interface EventDefinition {
  /** The Kafka topic the event is published to. */
  topic: string;
  /** The schema registry subject, following TopicRecordNameStrategy. */
  subject: string;
  /** The Avro schema, exactly as in the .avsc file. */
  schema: { type: 'record'; name: string; namespace: string; doc?: string; fields: unknown[] };
}

export const EVENT_CATALOGUE: Record<EventName, EventDefinition> = {
${catalogueEntries.join('\n')}
};
`;

writeFileSync(outFile, output);
console.log(`Wrote ${events.length} events to ${outFile}`);
