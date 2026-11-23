import { outboxRelayHandler } from '@signing-platform/shared';

// Throwaway: the outbox relay for the throwaway table. Remove it with publish.ts.
export const handler = outboxRelayHandler();
