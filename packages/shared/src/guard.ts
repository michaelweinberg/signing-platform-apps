import { trace } from '@opentelemetry/api';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { permissionsFor, type Permission } from './permissions.js';

/** The claims of a token the gateway's JWT authorizer has already verified. */
export type VerifiedClaims = Record<string, string | number | boolean | string[] | undefined>;

export interface Caller {
  /** The token's `sub`: the user's ID, or the client ID for a machine caller. */
  subject: string;
  /** The app client the token was issued to. */
  clientId: string;
}

/** The caller's token is valid but does not grant the permission the route needs. */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

// The HTTP API hands a list claim to the Lambda as one string, `[viewer operator]`,
// not as a JSON array. Accept both, and a plain space-separated string.
function listClaim(value: VerifiedClaims[string]): string[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  return value
    .replace(/^\[(.*)\]$/, '$1')
    .split(/[\s,]+/)
    .filter(Boolean);
}

/**
 * Checks verified claims against the permission a route needs, and records who is calling
 * on the current span. Returns the caller, or throws `ForbiddenError`.
 *
 * Authentication has already happened at the gateway; this is the authorisation step.
 */
export function authorize(claims: VerifiedClaims, permission: Permission): Caller {
  const { sub, client_id: clientId } = claims;

  // Recorded before the check, so a refused request is attributed too.
  const span = trace.getActiveSpan();
  if (typeof sub === 'string') span?.setAttribute('enduser.id', sub);
  if (typeof clientId === 'string') span?.setAttribute('oauth.client_id', clientId);

  // The authorizer also lets a Cognito ID token through (its `aud` is the client ID).
  // Only access tokens carry the caller's scopes, so nothing else is accepted.
  if (claims.token_use !== 'access' || typeof sub !== 'string' || typeof clientId !== 'string') {
    throw new ForbiddenError('Not a Cognito access token');
  }

  const granted = permissionsFor({
    groups: listClaim(claims['cognito:groups']),
    scopes: listClaim(claims.scope),
  });
  if (!granted.has(permission)) {
    throw new ForbiddenError(`Missing permission ${permission}`);
  }
  return { subject: sub, clientId };
}

/**
 * Wraps a Lambda handler behind the gateway so it runs only for callers with `permission`.
 * Anyone else gets `403`.
 *
 * ```ts
 * export const handler = requirePermission('agreements.read', async (event, caller) => { ... });
 * ```
 */
export function requirePermission<Result extends APIGatewayProxyResultV2>(
  permission: Permission,
  handler: (event: APIGatewayProxyEventV2WithJWTAuthorizer, caller: Caller) => Promise<Result>,
): (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<Result | APIGatewayProxyResultV2> {
  return async (event) => {
    let caller: Caller;
    try {
      // A route deployed without the authorizer has no claims: refuse it, don't crash.
      caller = authorize(event.requestContext.authorizer?.jwt?.claims ?? {}, permission);
    } catch (error) {
      if (!(error instanceof ForbiddenError)) throw error;
      return {
        statusCode: 403,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'Forbidden' }),
      };
    }
    return handler(event, caller);
  };
}
