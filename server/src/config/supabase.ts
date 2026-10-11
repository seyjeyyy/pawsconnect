import { createClient } from '@supabase/supabase-js';
import { configured, env } from './env.js';
import { ApiError } from '../utils/errors.js';

const client = configured ? createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
  global: { fetch: (input,init) => fetch(input,{...init,signal:init?.signal?AbortSignal.any([init.signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000)}) },
}) : null;
export function db() {
  if (!client) throw new ApiError(503, 'SETUP_REQUIRED', 'Connect Supabase to enable accounts, saved records, and transactions.');
  return client;
}
export function publicAuth() {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) throw new ApiError(503, 'SETUP_REQUIRED', 'Supabase authentication is not configured.');
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false },global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(10000)})} });
}
