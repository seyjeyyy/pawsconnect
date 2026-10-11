import { integrations } from '../config/env.js';
import { db } from '../config/supabase.js';

const MINUTE = 60_000;

// Unpaid orders hold stock for 30 minutes and approved pets are held for a
// limited time. These database functions release whatever has lapsed; they are
// idempotent and skip rows another instance has locked, so running the API on
// several instances is safe.
const jobs: { name: string; rpc: string; everyMs: number }[] = [
  { name: 'expire unpaid order reservations', rpc: 'expire_order_reservations', everyMs: MINUTE },
  { name: 'expire pet reservations', rpc: 'expire_pet_reservations', everyMs: 5 * MINUTE },
];

/** Starts the recurring jobs. Returns a function that stops them. */
export function startJobs() {
  if (!integrations.supabase) return () => {};
  const timers = jobs.map(job => {
    const run = async () => {
      const { data, error } = await db().rpc('run_operations_job', { p_kind: job.rpc, p_actor_id: null });
      if (error) console.error(`Job failed (${job.name}):`, error.code || 'unknown');
      else if (data?.status === 'failed') console.error(`Job failed (${job.name}):`, data.error_code);
      else if (data?.affected_rows) console.log(`Job (${job.name}): ${data.affected_rows} released`);
    };
    void run();
    const timer = setInterval(run, job.everyMs);
    timer.unref();
    return timer;
  });
  return () => timers.forEach(clearInterval);
}
