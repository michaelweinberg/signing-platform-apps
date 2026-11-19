import type { APIGatewayProxyResultV2 } from 'aws-lambda';

// Throwaway route: proves the deploy pipeline end to end. Remove it once a real route exists.
// eslint-disable-next-line @typescript-eslint/require-await -- Lambda needs an async handler.
export async function handler(): Promise<APIGatewayProxyResultV2> {
  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true }),
  };
}
