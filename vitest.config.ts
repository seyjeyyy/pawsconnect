import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'server/src/**/*.test.ts'],
    exclude: ['tests/e2e/**', '**/node_modules/**'],
    environment: 'node',
    // Tests never touch live services: blank values take precedence over server/.env,
    // so the API always runs in preview mode here even on a configured machine.
    env: { NODE_ENV: 'test', SUPABASE_URL: '', SUPABASE_ANON_KEY: '', SUPABASE_SERVICE_ROLE_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '', RESEND_API_KEY: '', RESEND_FROM: '', OPERATIONS_WORKER_SECRET: '', OPERATIONS_WORKER_KINDS: '', SUPABASE_MANAGEMENT_TOKEN: '', SUPABASE_PROJECT_REF: '' },
    // Each database test file boots its own in-process Postgres with PostGIS.
    maxWorkers: 2,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
