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
  // The AI assistant. Without a key the assistant reports itself unavailable; nothing else is affected.
  // Any provider with an OpenAI-style chat completions API (Gemini, Groq, OpenRouter…). See docs/ASSISTANT.md.
  ASSISTANT_API_KEY: optional,
  ASSISTANT_BASE_URL: serviceUrl('https://generativelanguage.googleapis.com/v1beta/openai'),
  ASSISTANT_MODEL: z.string().optional().transform(value => value?.trim() || 'gemini-3.5-flash'),
  // Sent as `reasoning_effort` when set. Leave empty for providers or models that do not accept it.
  ASSISTANT_REASONING_EFFORT: optional,
  ASSISTANT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  RESEND_API_KEY: optional,
  RESEND_FROM: optional,
  // A separately secured worker polls the operations queue. No worker runs in Vercel.
  OPERATIONS_WORKER_SECRET: optional,
  OPERATIONS_WORKER_KINDS: optional,
  SUPABASE_MANAGEMENT_TOKEN: optional,
  SUPABASE_PROJECT_REF: optional,
  RELEASE_COMMIT: optional,
  RELEASE_DATE: optional,
  RELEASE_NOTES: optional,
  VERCEL_ENV: optional,
  VERCEL_GIT_COMMIT_SHA: optional,
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
}).parse(process.env);
export const configured = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
export const integrations = {
  supabase: configured,
  stripe: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET),
  resend: Boolean(env.RESEND_API_KEY && env.RESEND_FROM),
};
