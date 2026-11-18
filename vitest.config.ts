import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages}/*/src/**/*.test.ts'],
    // Integration tests run separately, with `pnpm test:integration`.
    exclude: [...configDefaults.exclude, '**/*.integration.test.ts'],
  },
});
