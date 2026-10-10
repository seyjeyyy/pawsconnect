import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';

export function verifyPaymongoSignature(raw: Buffer, header: string | undefined, secret: string, live: boolean, now = Date.now()): boolean {
  if (!header || !secret) return false;
  const parts: Record<string, string> = {};
  for (const entry of header.split(',')) { const [key, value] = entry.trim().split('='); if (!key || parts[key] !== undefined) return false; parts[key] = value ?? ''; }
  if (!/^\d+$/.test(parts.t ?? '') || Math.abs(now / 1000 - Number(parts.t)) > 300) return false;
  const supplied = parts[live ? 'li' : 'te'];
  if (!supplied || !/^[a-f0-9]{64}$/i.test(supplied)) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.`).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(supplied, 'hex'));
}
type Checkout = { id: string; attributes: { checkout_url: string; livemode: boolean; reference_number?: string; payments?: { id: string; attributes: { amount: number; currency: string; status: string } }[]; payment_intent?: { id: string; attributes: { amount: number; currency: string; status: string; payments?: { id: string; attributes: { amount: number; currency: string; status: string } }[] } } } };
async function request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Checkout> {
  if (!env.PAYMONGO_SECRET_KEY || !env.PAYMONGO_WEBHOOK_SECRET) throw new ApiError(503, 'PAYMENTS_NOT_CONFIGURED', 'Online payments are not configured. No payment has been collected.');
  if (env.PAYMONGO_LIVE_MODE !== env.PAYMONGO_SECRET_KEY.startsWith('sk_live_')) throw new ApiError(503, 'PAYMENT_MODE_MISMATCH', 'Payment mode does not match the configured provider key.');
  let response: Response;
  try { response = await fetch(`https://api.paymongo.com${path}`, { method, signal: AbortSignal.timeout(15000), headers: { Authorization: `Basic ${Buffer.from(`${env.PAYMONGO_SECRET_KEY}:`).toString('base64')}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  catch { throw new ApiError(502, 'PAYMENT_PROVIDER_TIMEOUT', 'Payment provider did not respond. Contact the shelter before retrying this payment request.'); }
  if (!response.ok) throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider declined this checkout request. Check enabled merchant payment methods.');
  const result = await response.json() as { data: Checkout };
  if (!result.data?.id) throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider returned an incomplete response.');
  return result.data;
}
export async function createCheckout(resource: { type: string; id: string; amount: number }) {
  const methods = env.PAYMONGO_PAYMENT_METHODS.split(',').map(s => s.trim()).filter(Boolean);
  if (!methods.length) throw new ApiError(503, 'PAYMENTS_NOT_CONFIGURED', 'Configure at least one merchant-approved payment method.');
  return request('/v2/checkout_sessions', 'POST', { data: { attributes: { line_items: [{ name: `PawsConnect ${resource.type} ${resource.id.slice(0, 8)}`, amount: resource.amount, currency: 'PHP', quantity: 1 }], payment_method_types: methods, reference_number: resource.id, description: `PawsConnect ${resource.type}`, success_url: `${env.CLIENT_URL}/payment/return`, cancel_url: `${env.CLIENT_URL}/account/orders`, metadata: { resource_type: resource.type, resource_id: resource.id } } } });
}
export async function retrieveCheckout(id: string) {
  if (!/^cs_[a-zA-Z0-9]+$/.test(id)) throw new ApiError(400, 'INVALID_CHECKOUT', 'Invalid checkout reference.');
  return request(`/v2/checkout_sessions/${id}`, 'GET');
}
