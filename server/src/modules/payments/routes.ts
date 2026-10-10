import { Router } from 'express';
import { z } from 'zod';
import { env, integrations } from '../../config/env.js';
import { db } from '../../config/supabase.js';
import { createCheckout, retrieveCheckout, stripeLiveMode, verifyStripeSignature } from '../../integrations/stripe.js';
import { authenticate } from '../../middleware/auth.js';
import { ApiError, assertDb } from '../../utils/errors.js';
import { uuid } from '../../utils/validation.js';

export const paymentRouter = Router();
paymentRouter.post('/payments/create', authenticate, async (req, res) => {
  if (!integrations.stripe) throw new ApiError(503, 'PAYMENTS_NOT_CONFIGURED', 'Online payments are not configured. No payment has been collected.');
  const { resource_type, resource_id } = z.object({ resource_type: z.enum(['order', 'donation', 'transport', 'adoption']), resource_id: uuid }).strict().parse(req.body);
  const tables = { order: 'orders', donation: 'donations', transport: 'transport_requests', adoption: 'adoption_applications' };
  const resource = assertDb(await db().from(tables[resource_type]).select('*').eq('id', resource_id).eq('user_id', req.actor!.id).single());
  if (resource_type === 'order' && (resource.status !== 'pending_payment' || Date.parse(resource.reservation_expires_at) <= Date.now())) throw new ApiError(409, 'ORDER_NOT_PAYABLE', 'This order is no longer awaiting payment or its reservation expired.');
  if (resource_type === 'donation' && (resource.donation_type !== 'monetary' || resource.status !== 'pending')) throw new ApiError(409, 'DONATION_NOT_PAYABLE', 'This donation is not awaiting payment.');
  if (resource_type === 'transport' && (resource.status !== 'confirmed' || resource.paid_at)) throw new ApiError(409, 'TRANSPORT_NOT_PAYABLE', 'Confirm a valid transport quotation before payment.');
  if (resource_type === 'adoption' && (!['approved', 'reserved', 'awaiting_handover'].includes(resource.status) || resource.fee_paid_at)) throw new ApiError(409, 'ADOPTION_NOT_PAYABLE', 'This adoption fee is not awaiting payment.');
  // The amount is read from the record being paid for. Nothing from the request body is used.
  const amount = Number(resource_type === 'order' ? resource.total_centavos : resource_type === 'donation' ? resource.amount_centavos : resource.fee_centavos);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new ApiError(409, 'NO_PAYMENT_REQUIRED', 'There is no payable amount for this record.');

  const existing = assertDb(await db().from('payment_transactions').select('*').eq('resource_type', resource_type).eq('resource_id', resource_id).eq('status', 'pending').maybeSingle());
  if (existing?.checkout_url) { res.json({ data: { id: existing.id, checkout_url: existing.checkout_url, status: existing.status } }); return; }
  // A pending row without a URL means an earlier attempt was interrupted. Reusing its id as the
  // idempotency key makes Stripe return that attempt's session rather than creating a second one.
  const transaction = existing ?? assertDb(await db().from('payment_transactions').insert({ user_id: req.actor!.id, resource_type, resource_id, amount_centavos: amount, currency: 'PHP', provider: 'stripe' }).select().single());
  try {
    const session = await createCheckout({ type: resource_type, id: resource_id, amount }, transaction.id);
    if (!session.url) throw new ApiError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider did not return a checkout link.');
    const result = assertDb(await db().from('payment_transactions').update({ provider_checkout_id: session.id, checkout_url: session.url }).eq('id', transaction.id).select().single());
    res.status(201).json({ data: { id: result.id, checkout_url: result.checkout_url, status: 'pending' } });
  } catch (error) {
    // A definite provider refusal frees the record for a new attempt. A timeout is ambiguous
    // (the session may exist), so the row stays pending and the retry above reuses it.
    if (error instanceof ApiError && error.code === 'PAYMENT_PROVIDER_ERROR') assertDb(await db().from('payment_transactions').update({ status: 'failed', failure_reason: error.code }).eq('id', transaction.id));
    throw error;
  }
});

const eventSchema = z.object({
  id: z.string().min(1),
  type: z.string(),
  livemode: z.boolean(),
  data: z.object({ object: z.object({ id: z.string() }).passthrough() }),
});
const settled = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];
const failed = ['checkout.session.async_payment_failed'];

// Mounted with express.raw(): the signature covers the exact bytes Stripe sent.
export const webhookRouter = Router();
webhookRouter.post('/stripe', async (req, res) => {
  if (!env.STRIPE_WEBHOOK_SECRET) throw new ApiError(503, 'PAYMENTS_NOT_CONFIGURED', 'Payment verification is not configured.');
  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw) || !verifyStripeSignature(raw, req.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET)) throw new ApiError(400, 'INVALID_SIGNATURE', 'The webhook signature or timestamp is invalid.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new ApiError(400, 'INVALID_JSON', 'Invalid webhook payload.'); }
  const event = eventSchema.parse(parsed);
  if (event.livemode !== stripeLiveMode()) throw new ApiError(400, 'PAYMENT_MODE_MISMATCH', 'The event mode does not match this environment.');
  if (![...settled, ...failed].includes(event.type)) { res.json({ data: { received: true, ignored: true } }); return; }

  const transaction = assertDb(await db().from('payment_transactions').select('*').eq('provider_checkout_id', event.data.object.id).maybeSingle());
  // 409 makes Stripe retry: the event can arrive before the session id is saved on our side.
  if (!transaction) throw new ApiError(409, 'CHECKOUT_NOT_BOUND', 'The checkout has not been attached to a platform payment yet. Retry delivery.');

  // Re-read the session from Stripe rather than trusting the event body, and settle only what
  // Stripe itself reports as paid. Redirects and metadata can never settle money.
  const session = await retrieveCheckout(event.data.object.id);
  if (session.livemode !== stripeLiveMode()) throw new ApiError(400, 'PAYMENT_MODE_MISMATCH', 'Wrong provider mode.');
  const paid = settled.includes(event.type);
  // A completed session with a delayed payment method is not paid yet; the async event follows.
  if (paid && session.payment_status !== 'paid') { res.json({ data: { received: true, awaiting_payment: true } }); return; }
  if (!session.payment_intent || session.amount_total == null || !session.currency) throw new ApiError(409, 'PAYMENT_NOT_VERIFIED', 'The provider has not reported a completed payment.');

  const result = assertDb(await db().rpc('settle_payment', {
    p_event_id: event.id,
    p_provider_payment_id: session.payment_intent,
    p_resource_type: transaction.resource_type,
    p_resource_id: transaction.resource_id,
    p_amount_centavos: session.amount_total,
    p_currency: session.currency.toUpperCase(),
    p_status: paid ? 'paid' : 'failed',
  }));
  res.json({ data: result });
});
