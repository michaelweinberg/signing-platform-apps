import { trace, type Span } from '@opentelemetry/api';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { afterEach, expect, test, vi } from 'vitest';
import { ForbiddenError, authorize, requirePermission, type VerifiedClaims } from './guard.js';

// Claims as the HTTP API passes them to a Lambda: every value is a string.
const viewer: VerifiedClaims = {
  sub: 'user-1',
  client_id: 'dashboard-client',
  token_use: 'access',
  scope: 'openid email',
  'cognito:groups': '[viewer]',
};

const smokeTest: VerifiedClaims = {
  sub: 'smoke-client',
  client_id: 'smoke-client',
  token_use: 'access',
  scope: 'signing-api/agreements.write signing-api/agreements.read',
};

const eventWith = (claims: VerifiedClaims | undefined) =>
  ({
    requestContext: { authorizer: claims && { jwt: { claims, scopes: [] } } },
  }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

/** Makes a fake span the active one and returns the attributes set on it. */
function activeSpan() {
  const attributes: Record<string, unknown> = {};
  const span = { setAttribute: (key: string, value: unknown) => void (attributes[key] = value) };
  vi.spyOn(trace, 'getActiveSpan').mockReturnValue(span as unknown as Span);
  return attributes;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test('a user whose group grants the permission is let through', () => {
  expect(authorize(viewer, 'agreements.read')).toEqual({ subject: 'user-1', clientId: 'dashboard-client' });
});

test('a user whose group does not grant the permission is refused', () => {
  expect(() => authorize(viewer, 'agreements.write')).toThrow(ForbiddenError);
});

test('a machine client is let through on its scopes and refused beyond them', () => {
  expect(authorize(smokeTest, 'agreements.read')).toEqual({ subject: 'smoke-client', clientId: 'smoke-client' });
  expect(() => authorize(smokeTest, 'webhooks.manage')).toThrow(ForbiddenError);
});

test.each([
  ['the gateway’s bracketed string', '[viewer operator]'],
  ['a JSON array', ['viewer', 'operator']],
  ['a comma-separated string', 'viewer,operator'],
])('several groups are read from %s', (_, groups) => {
  expect(() => authorize({ ...viewer, 'cognito:groups': groups }, 'webhooks.manage')).not.toThrow();
});

test('a user in no group has no permissions', () => {
  expect(() => authorize({ ...viewer, 'cognito:groups': undefined }, 'agreements.read')).toThrow(ForbiddenError);
});

test('an ID token is refused even when its group grants the permission', () => {
  expect(() => authorize({ ...viewer, token_use: 'id' }, 'agreements.read')).toThrow(ForbiddenError);
});

test('the caller’s subject and client ID are added to the current span', () => {
  const attributes = activeSpan();
  authorize(viewer, 'agreements.read');
  expect(attributes).toEqual({ 'enduser.id': 'user-1', 'oauth.client_id': 'dashboard-client' });
});

test('a refused caller is still recorded on the span', () => {
  const attributes = activeSpan();
  expect(() => authorize(viewer, 'agreements.write')).toThrow(ForbiddenError);
  expect(attributes).toEqual({ 'enduser.id': 'user-1', 'oauth.client_id': 'dashboard-client' });
});

test('a guarded handler runs for a permitted caller and is given the caller', async () => {
  const handler = requirePermission('agreements.read', (_, caller) =>
    Promise.resolve({ statusCode: 200, body: caller.subject }),
  );
  expect(await handler(eventWith(viewer))).toEqual({ statusCode: 200, body: 'user-1' });
});

test('a guarded handler answers 403 without running when the permission is missing', async () => {
  const inner = vi.fn();
  const handler = requirePermission('agreements.write', inner);
  expect(await handler(eventWith(viewer))).toMatchObject({ statusCode: 403 });
  expect(inner).not.toHaveBeenCalled();
});

test('a guarded handler answers 403 when the route has no authorizer', async () => {
  const handler = requirePermission('agreements.read', vi.fn());
  expect(await handler(eventWith(undefined))).toMatchObject({ statusCode: 403 });
});
