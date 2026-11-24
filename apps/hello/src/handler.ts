import { requirePermission, withTelemetry } from '@signing-platform/shared';

// Throwaway route: proves the deploy pipeline and the token checks end to end.
// Remove it once a real route exists.
export const handler = withTelemetry(
  // eslint-disable-next-line @typescript-eslint/require-await -- Lambda needs an async handler.
  requirePermission('agreements.read', async () => ({
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  })),
);
