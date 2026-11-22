// The one place that says who may do what. Routes declare a permission, never a group
// or a scope, so adding a role or a machine caller changes only this file.
//
// `sst.config.ts` imports this file to declare the Cognito groups, the resource server's
// scopes, and each machine client's scopes, so keep it free of imports.

export const permissions = [
  'agreements.write',
  'agreements.read',
  'documents.download',
  'webhooks.read',
  'webhooks.manage',
] as const;

export type Permission = (typeof permissions)[number];

/** Dashboard users: a Cognito group grants these permissions (`cognito:groups` claim). */
export const groupPermissions = {
  viewer: ['agreements.read', 'documents.download', 'webhooks.read'],
  operator: ['agreements.write', 'agreements.read', 'documents.download', 'webhooks.read', 'webhooks.manage'],
} as const satisfies Record<string, readonly Permission[]>;

/**
 * Machine callers: each app client is granted one scope per permission (`scope` claim).
 * The keys are the Cognito app client names.
 */
export const machineClientPermissions = {
  salesforce: ['agreements.write'],
  'smoke-test': ['agreements.write', 'agreements.read'],
} as const satisfies Record<string, readonly Permission[]>;

/** The Cognito resource server that defines the scopes. */
export const resourceServer = 'signing-api';

/** The scope that grants a permission, as it appears in a token: `signing-api/agreements.read`. */
export const scopeFor = (permission: Permission): string => `${resourceServer}/${permission}`;

const scopePermissions = new Map(permissions.map((permission) => [scopeFor(permission), permission]));

/** Every permission a token's groups and scopes grant. Unknown groups and scopes grant nothing. */
export function permissionsFor(token: { groups: readonly string[]; scopes: readonly string[] }): Set<Permission> {
  const granted = new Set<Permission>();
  for (const group of token.groups) {
    if (Object.hasOwn(groupPermissions, group)) {
      for (const permission of groupPermissions[group as keyof typeof groupPermissions]) granted.add(permission);
    }
  }
  for (const scope of token.scopes) {
    const permission = scopePermissions.get(scope);
    if (permission) granted.add(permission);
  }
  return granted;
}
