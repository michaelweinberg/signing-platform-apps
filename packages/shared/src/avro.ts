import { SchemaRegistry, SchemaType } from '@kafkajs/confluent-schema-registry';
import avro from 'avsc';
import { EVENT_CATALOGUE, type EventName } from './generated/events.js';

const DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/;

interface DecimalSchema {
  precision?: unknown;
  scale?: unknown;
}

/**
 * Avro's `decimal` logical type, exposed to application code as a string such as
 * `"1250.00"`. On the wire it is the unscaled integer as big-endian two's-complement bytes.
 */
export class DecimalType extends avro.types.LogicalType {
  private readonly precision: number;
  private readonly scale: number;

  constructor(schema: avro.Schema, opts?: unknown) {
    super(schema, opts);
    const { precision, scale = 0 } = schema as DecimalSchema;
    if (typeof precision !== 'number' || typeof scale !== 'number') {
      throw new Error('A decimal schema needs a numeric precision and scale');
    }
    this.precision = precision;
    this.scale = scale;
  }

  protected override _fromValue(bytes: Buffer): string {
    const unscaled =
      bytes.length === 0 ? 0n : BigInt.asIntN(bytes.length * 8, BigInt(`0x${bytes.toString('hex')}`));
    const digits = (unscaled < 0n ? -unscaled : unscaled).toString().padStart(this.scale + 1, '0');
    const whole = digits.slice(0, digits.length - this.scale);
    const fraction = digits.slice(digits.length - this.scale);
    return `${unscaled < 0n ? '-' : ''}${whole}${this.scale > 0 ? `.${fraction}` : ''}`;
  }

  // Returning undefined tells avsc the value is invalid for this type.
  protected override _toValue(value: unknown): Buffer | undefined {
    if (typeof value !== 'string') return undefined;
    const match = DECIMAL_PATTERN.exec(value);
    if (!match) return undefined;
    const [, sign = '', whole = '', fraction = ''] = match;
    if (fraction.length > this.scale) return undefined;

    const digits = `${whole}${fraction.padEnd(this.scale, '0')}`.replace(/^0+(?=\d)/, '');
    if (digits.length > this.precision) return undefined;

    const unscaled = BigInt(`${sign}${digits}`);
    const magnitudeBits = (unscaled < 0n ? -unscaled - 1n : unscaled).toString(2).length;
    const byteLength = Math.ceil((magnitudeBits + 1) / 8);
    const hex = BigInt.asUintN(byteLength * 8, unscaled).toString(16).padStart(byteLength * 2, '0');
    return Buffer.from(hex, 'hex');
  }
}

const AVRO_OPTIONS = { logicalTypes: { decimal: DecimalType } };

const eventTypes = new Map<EventName, avro.Type>();

/** The compiled Avro type for an event, built from its `.avsc` schema. */
export function avroTypeFor(eventName: EventName): avro.Type {
  let type = eventTypes.get(eventName);
  if (!type) {
    type = avro.Type.forSchema(EVENT_CATALOGUE[eventName].schema as avro.Schema, AVRO_OPTIONS);
    eventTypes.set(eventName, type);
  }
  return type;
}

/** Throws, naming the offending fields, if the event does not match its schema. */
export function assertValidEvent(eventName: EventName, event: unknown): void {
  const invalidPaths: string[] = [];
  avroTypeFor(eventName).isValid(event, {
    errorHook: (path) => invalidPaths.push(path.join('.')),
  });
  if (invalidPaths.length > 0) {
    throw new Error(`${eventName} does not match its Avro schema at: ${invalidPaths.join(', ')}`);
  }
}

export interface SchemaRegistryConfig {
  host: string;
  auth?: { username: string; password: string };
}

/**
 * A schema registry client that understands the logical types the event schemas use.
 * Every service must create its client here so that encode and decode agree.
 */
export function createSchemaRegistry(config: SchemaRegistryConfig): SchemaRegistry {
  return new SchemaRegistry(config, { [SchemaType.AVRO]: AVRO_OPTIONS });
}

const schemaIds = new WeakMap<SchemaRegistry, Map<EventName, Promise<number>>>();

function schemaIdFor(registry: SchemaRegistry, eventName: EventName): Promise<number> {
  let ids = schemaIds.get(registry);
  if (!ids) {
    ids = new Map();
    schemaIds.set(registry, ids);
  }
  let id = ids.get(eventName);
  if (!id) {
    const { subject, schema } = EVENT_CATALOGUE[eventName];
    // Look the schema up; never register it. Registration belongs to the deploy pipeline.
    id = registry.getRegistryIdBySchema(subject, {
      type: SchemaType.AVRO,
      schema: JSON.stringify(schema),
    });
    ids.set(eventName, id);
    // A failed lookup must not be cached, or one registry blip would break the process for good.
    id.catch(() => ids.delete(eventName));
  }
  return id;
}

/**
 * Encodes an event as Avro in Confluent wire format (magic byte, schema ID, payload).
 * The schema ID is the one the registry holds for this exact schema under the event's
 * `TopicRecordNameStrategy` subject. Fails if the schema has not been registered.
 */
export async function encodeEvent(
  registry: SchemaRegistry,
  eventName: EventName,
  event: unknown,
): Promise<Buffer> {
  return registry.encode(await schemaIdFor(registry, eventName), event);
}
