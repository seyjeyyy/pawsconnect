import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'server/src/**/*.test.ts'],
    exclude: ['tests/e2e/**', '**/node_modules/**'],
    environment: 'node',
    env: { NODE_ENV: 'test' },
    // Each database test file boots its own in-process Postgres with PostGIS.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
