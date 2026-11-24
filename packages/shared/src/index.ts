export { DecimalType, createSchemaRegistry, encodeEvent, type SchemaRegistryConfig } from './avro.js';
export * from './generated/events.js';
export { kafkaClientsFromEnv } from './kafka.js';
export { logger } from './logger.js';
export {
  createOutboxRelay,
  outboxPut,
  outboxRelayHandler,
  type OutboxPutOptions,
  type OutboxRelayDependencies,
  type OutboxStreamRecord,
} from './outbox.js';
export { ForbiddenError, authorize, requirePermission, type Caller, type VerifiedClaims } from './guard.js';
export {
  groupPermissions,
  machineClientPermissions,
  permissions,
  permissionsFor,
  resourceServer,
  scopeFor,
  type Permission,
} from './permissions.js';
export { flushTelemetry, startTelemetry, withTelemetry, type TelemetryDestinations } from './telemetry.js';
export { withAgreement, type AgreementIds } from './telemetry-context.js';
