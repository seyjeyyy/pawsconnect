import { createClient } from '@supabase/supabase-js';
import { configured, env } from './env.js';
import { ApiError } from '../utils/errors.js';

const client = configured ? createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
}) : null;
export function db() {
  if (!client) throw new ApiError(503, 'SETUP_REQUIRED', 'Connect Supabase to enable accounts, saved records, and transactions. The current catalog is a sample preview.');
  return client;
}
export function publicAuth() {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) throw new ApiError(503, 'SETUP_REQUIRED', 'Supabase authentication is not configured.');
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
}
