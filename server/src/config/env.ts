import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)), quiet: true });
dotenv.config({ quiet: true });
const optional = z.string().optional().transform(value => value?.trim() || undefined);
const serviceUrl = (fallback: string) => z.string().optional().transform(value => (value?.trim() || fallback).replace(/\/+$/, '')).pipe(z.string().url());
export const env = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CLIENT_URL: z.string().url().default('http://localhost:5173'),
  SUPABASE_URL: optional,
  SUPABASE_ANON_KEY: optional,
  SUPABASE_SERVICE_ROLE_KEY: optional,
  // Test keys (sk_test_...) run in Stripe's sandbox; live keys (sk_live_...) take real payments.
  STRIPE_SECRET_KEY: optional,
  STRIPE_WEBHOOK_SECRET: optional,
  // OpenStreetMap services. The defaults are shared public endpoints for light use only.
  NOMINATIM_URL: serviceUrl('https://nominatim.openstreetmap.org'),
  OSRM_URL: serviceUrl('https://router.project-osrm.org'),
  RESEND_API_KEY: optional,
  RESEND_FROM: optional,
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
}).parse(process.env);
export const configured = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
export const integrations = {
  supabase: configured,
  stripe: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET),
  resend: Boolean(env.RESEND_API_KEY && env.RESEND_FROM),
};
