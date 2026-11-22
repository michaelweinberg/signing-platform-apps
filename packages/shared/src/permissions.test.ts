import { expect, test } from 'vitest';
import {
  groupPermissions,
  machineClientPermissions,
  permissions,
  permissionsFor,
  scopeFor,
  type Permission,
} from './permissions.js';

// The permission table in the architecture document, one row per caller.
const table: Record<string, Permission[]> = {
  viewer: ['agreements.read', 'documents.download', 'webhooks.read'],
  operator: ['agreements.write', 'agreements.read', 'documents.download', 'webhooks.read', 'webhooks.manage'],
  salesforce: ['agreements.write'],
  'smoke-test': ['agreements.write', 'agreements.read'],
};

const sorted = (granted: Iterable<Permission>) => [...granted].sort();

/** What a token grants when it carries exactly the scopes Cognito gives this machine client. */
const machineToken = (client: keyof typeof machineClientPermissions) =>
  permissionsFor({ groups: [], scopes: machineClientPermissions[client].map(scopeFor) });

test.each(['viewer', 'operator'] as const)('a user in the %s group gets that group’s permissions', (group) => {
  expect(sorted(permissionsFor({ groups: [group], scopes: [] }))).toEqual(sorted(table[group]!));
});

test.each(['salesforce', 'smoke-test'] as const)('the %s client’s scopes give its permissions', (client) => {
  expect(sorted(machineToken(client))).toEqual(sorted(table[client]!));
});

test('there are no groups or machine clients beyond the four in the architecture', () => {
  expect(Object.keys({ ...groupPermissions, ...machineClientPermissions }).sort()).toEqual(Object.keys(table).sort());
});

test('a viewer cannot write agreements or manage webhooks', () => {
  const granted = permissionsFor({ groups: ['viewer'], scopes: [] });
  expect(granted.has('agreements.write')).toBe(false);
  expect(granted.has('webhooks.manage')).toBe(false);
});

test('salesforce can create agreements but not read them', () => {
  expect(machineToken('salesforce').has('agreements.write')).toBe(true);
  expect(machineToken('salesforce').has('agreements.read')).toBe(false);
});

test('a user in both groups gets the union', () => {
  expect(sorted(permissionsFor({ groups: ['viewer', 'operator'], scopes: [] }))).toEqual(sorted(permissions));
});

test('unknown groups and scopes grant nothing', () => {
  const granted = permissionsFor({
    groups: ['admin', 'toString'],
    // Sign-in scopes, a bare permission name, and another resource server's scope.
    scopes: ['openid', 'email', 'agreements.write', 'other-api/agreements.write'],
  });
  expect(sorted(granted)).toEqual([]);
});
