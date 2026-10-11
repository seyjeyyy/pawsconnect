import { createApp } from './app.js';
import { env, integrations } from './config/env.js';
import { startJobs } from './jobs/scheduler.js';

const server = createApp().listen(env.PORT, () => {
  console.log(`PawsConnect API listening on http://127.0.0.1:${env.PORT}/api (${env.NODE_ENV})`);
  const missing = Object.entries(integrations).filter(([, ready]) => !ready).map(([name]) => name);
  if (missing.length) console.log(`Not configured: ${missing.join(', ')}. See server/.env.example.`);
  if (!integrations.supabase) console.log('Supabase unavailable: database-backed features return setup-required errors.');
});

const stopJobs = startJobs();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { stopJobs(); server.close(() => process.exit(0)); });
}
