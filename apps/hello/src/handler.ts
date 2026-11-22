import { requirePermission } from '@signing-platform/shared';

// Throwaway route: proves the deploy pipeline and the token checks end to end.
// Remove it once a real route exists.
// eslint-disable-next-line @typescript-eslint/require-await -- Lambda needs an async handler.
export const handler = requirePermission('agreements.read', async () => ({
  statusCode: 200,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ok: true }),
}));
