import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';

/** Whether the configured secret key is a live-mode key. Test keys start with sk_test_. */
export const stripeLiveMode = () => Boolean(env.STRIPE_SECRET_KEY?.startsWith('sk_live_'));

/**
 * Verifies a Stripe-Signature header: `t=<unix seconds>,v1=<hex hmac>[,v1=...]`,
 * where the HMAC-SHA256 is taken over `<t>.<raw body>` with the endpoint's
 * signing secret. Rejects timestamps more than five minutes from `now` so a
 * captured request cannot be replayed later.
 */
export function verifyStripeSignature(raw: Buffer, header: string | undefined, secret: string, now = Date.now()): boolean {
  if (!header || !secret) return false;
  let timestamp = '';
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 0) return false;
    const key = part.slice(0, separator).trim(), value = part.slice(separator + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (!/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest();
  return signatures.some(signature => /^[a-f0-9]{64}$/i.test(signature) && timingSafeEqual(expected, Buffer.from(signature, 'hex')));
}

export type CheckoutSession = {
  id: string;
  url: string | null;
  livemode: boolean;
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  amount_total: number | null;
  currency: string | null;
  payment_intent: string | null;
};

async function request(path: string, method: 'GET' | 'POST', form?: Record<string, string>, idempotencyKey?: string): Promise<CheckoutSession> {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) throw new ApiError(503, 'PAYMENTS_NOT_CONFIGURED', 'Online payments are not configured. No payment has been collected.');
  let response: Response;
  try {
    response = await fetch(`https://api.stripe.com${path}`, {
      method,
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(form ? { body: new URLSearchParams(form) } : {}),
    });
  } catch {
    throw new ApiError(502, 'PAYMENT_PROVIDER_TIMEOUT', 'The payment provider did not respond. Check your payment history before retrying this payment.');
  }
  const result = await response.json().catch(() => null) as (CheckoutSession & { error?: { type?: string; code?: string } }) | null;
  if (!response.ok || !result?.id) {
    // Log the provider's error class only; never the request or response body.
    console.error('Stripe request failed:', response.status, result?.error?.code || result?.error?.type || 'unknown');
    throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider declined this checkout request.');
  }
  return result;
}

/**
 * Creates a hosted Checkout Session for exactly `amount` centavos. The amount
 * always comes from the database record being paid for, never from the client.
 * `idempotencyKey` is the platform transaction id, so a retried request returns
 * the same session instead of opening a second payable one.
 */
export function createCheckout(resource: { type: string; id: string; amount: number }, idempotencyKey: string) {
  const label = { order: 'Shop order', donation: 'Donation to PawsConnect', transport: 'Pet transport service', adoption: 'Adoption processing fee' }[resource.type] ?? 'PawsConnect payment';
  return request('/v1/checkout/sessions', 'POST', {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'php',
    'line_items[0][price_data][unit_amount]': String(resource.amount),
    'line_items[0][price_data][product_data][name]': `${label} ${resource.id.slice(0, 8).toUpperCase()}`,
    client_reference_id: resource.id,
    'metadata[resource_type]': resource.type,
    'metadata[resource_id]': resource.id,
    success_url: `${env.CLIENT_URL}/payment/return`,
    cancel_url: `${env.CLIENT_URL}/account/${resource.type === 'donation' ? 'donations' : resource.type === 'transport' ? 'transport' : resource.type === 'adoption' ? 'applications' : 'orders'}`,
  }, idempotencyKey);
}

export function retrieveCheckout(id: string) {
  if (!/^cs_[a-zA-Z0-9_]+$/.test(id)) throw new ApiError(400, 'INVALID_CHECKOUT', 'Invalid checkout reference.');
  return request(`/v1/checkout/sessions/${id}`, 'GET');
}
