export { DecimalType, createSchemaRegistry, encodeEvent, type SchemaRegistryConfig } from './avro.js';
export * from './generated/events.js';
export {
  createOutboxRelay,
  outboxPut,
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
