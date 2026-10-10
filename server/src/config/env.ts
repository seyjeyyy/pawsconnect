import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
dotenv.config({ quiet: true });
const optional = z.string().optional().transform(value => value?.trim() || undefined);
export const env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CLIENT_URL: z.string().url().default('http://localhost:5173'),
  SUPABASE_URL: optional,
  SUPABASE_ANON_KEY: optional,
  SUPABASE_SERVICE_ROLE_KEY: optional,
  PAYMONGO_SECRET_KEY: optional,
  PAYMONGO_WEBHOOK_SECRET: optional,
  PAYMONGO_LIVE_MODE: z.enum(['true', 'false']).default('false').transform(v => v === 'true'),
  PAYMONGO_PAYMENT_METHODS: z.string().default('gcash,paymaya,card'),
  GOOGLE_MAPS_SERVER_KEY: optional,
  RESEND_API_KEY: optional,
  RESEND_FROM: optional,
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
}).parse(process.env);
export const configured = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
export const integrations = {
  supabase: configured,
  paymongo: Boolean(env.PAYMONGO_SECRET_KEY && env.PAYMONGO_WEBHOOK_SECRET),
  maps: Boolean(env.GOOGLE_MAPS_SERVER_KEY),
  resend: Boolean(env.RESEND_API_KEY && env.RESEND_FROM),
};
