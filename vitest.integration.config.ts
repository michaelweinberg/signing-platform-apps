import { defineConfig } from 'vitest/config';

// Integration tests need the services in docker-compose.yml to be running.
export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    env: { KAFKAJS_NO_PARTITIONER_WARNING: '1' },
  },
});
