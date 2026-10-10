import { Router } from 'express';
import { z } from 'zod';
import { env, integrations } from '../../config/env.js';
import { db } from '../../config/supabase.js';
import { authenticate } from '../../middleware/auth.js';
import { ApiError, assertDb } from '../../utils/errors.js';
import { uuid } from '../../utils/validation.js';
import { createCheckout, retrieveCheckout, verifyPaymongoSignature } from '../../integrations/paymongo.js';

export const paymentRouter = Router();
paymentRouter.post('/payments/create', authenticate, async (req, res) => {
  if (!integrations.paymongo) throw new ApiError(503, 'PAYMENTS_NOT_CONFIGURED', 'Online payments are not configured. No payment has been collected.');
  const { resource_type, resource_id } = z.object({ resource_type: z.enum(['order', 'donation', 'transport', 'adoption']), resource_id: uuid }).strict().parse(req.body);
  const tables = { order: 'orders', donation: 'donations', transport: 'transport_requests', adoption: 'adoption_applications' };
  const resource = assertDb(await db().from(tables[resource_type]).select('*').eq('id', resource_id).eq('user_id', req.actor!.id).single());
  if (resource_type === 'order' && (resource.status !== 'pending_payment' || Date.parse(resource.reservation_expires_at) <= Date.now())) throw new ApiError(409, 'ORDER_NOT_PAYABLE', 'This order is no longer awaiting payment or its reservation expired.');
  if (resource_type === 'donation' && (resource.donation_type !== 'monetary' || resource.status !== 'pending')) throw new ApiError(409, 'DONATION_NOT_PAYABLE', 'This donation is not awaiting payment.');
  if (resource_type === 'transport' && (resource.status !== 'confirmed' || resource.paid_at)) throw new ApiError(409, 'TRANSPORT_NOT_PAYABLE', 'Confirm a valid transport quotation before payment.');
  if (resource_type === 'adoption' && (!['approved', 'reserved', 'awaiting_handover'].includes(resource.status) || resource.fee_paid_at)) throw new ApiError(409, 'ADOPTION_NOT_PAYABLE', 'This adoption fee is not awaiting payment.');
  const amount = Number(resource_type === 'order' ? resource.total_centavos : resource_type === 'donation' ? resource.amount_centavos : resource.fee_centavos);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new ApiError(409, 'NO_PAYMENT_REQUIRED', 'There is no payable amount for this record.');
  const existing = assertDb(await db().from('payment_transactions').select('*').eq('resource_type', resource_type).eq('resource_id', resource_id).eq('status', 'pending').maybeSingle());
  if (existing?.checkout_url) { res.json({ data: { id: existing.id, checkout_url: existing.checkout_url, status: existing.status } }); return; }
  if (existing) throw new ApiError(409, 'CHECKOUT_INITIALIZING', 'Checkout is being prepared or needs staff verification. Please check your payment history before retrying.');
  const transaction = assertDb(await db().from('payment_transactions').insert({ user_id: req.actor!.id, resource_type, resource_id, amount_centavos: amount, currency: 'PHP' }).select().single());
  try {
    const session = await createCheckout({ type: resource_type, id: resource_id, amount });
    if (session.attributes.livemode !== env.PAYMONGO_LIVE_MODE) throw new ApiError(502, 'PAYMENT_MODE_MISMATCH', 'The checkout mode does not match this environment.');
    const result = assertDb(await db().from('payment_transactions').update({ provider_checkout_id: session.id, checkout_url: session.attributes.checkout_url }).eq('id', transaction.id).select().single());
    res.status(201).json({ data: { id: result.id, checkout_url: result.checkout_url, status: 'pending' } });
  } catch (error) {
    // Network ambiguity is kept pending to prevent issuing multiple payable sessions.
    if (error instanceof ApiError && error.code === 'PAYMENT_PROVIDER_ERROR') assertDb(await db().from('payment_transactions').update({ status: 'failed', failure_reason: error.code }).eq('id', transaction.id));
    throw error;
  }
});

export const webhookRouter = Router();
webhookRouter.post('/paymongo', async (req, res) => {
  if (!env.PAYMONGO_WEBHOOK_SECRET) throw new ApiError(503, 'PAYMENTS_NOT_CONFIGURED', 'Payment verification is not configured.');
  const raw = req.body as Buffer;
  if (!Buffer.isBuffer(raw) || !verifyPaymongoSignature(raw, req.get('Paymongo-Signature'), env.PAYMONGO_WEBHOOK_SECRET, env.PAYMONGO_LIVE_MODE)) throw new ApiError(400, 'INVALID_SIGNATURE', 'The webhook signature or timestamp is invalid.');
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new ApiError(400, 'INVALID_JSON', 'Invalid webhook payload.'); }
  const envelope = z.object({ data: z.object({ id: z.string().min(1), type: z.string(), attributes: z.record(z.unknown()).optional(), data: z.unknown().optional() }) }).parse(parsed);
  const event = envelope.data;
  const eventType = typeof event.attributes?.type === 'string' ? event.attributes.type : event.type;
  if (eventType !== 'checkout_session.payment.paid') { res.json({ data: { received: true, ignored: true } }); return; }
  const checkoutEvent = z.object({ id: z.string() }).parse(event.attributes?.data ?? event.data);
  const transaction = assertDb(await db().from('payment_transactions').select('*').eq('provider_checkout_id', checkoutEvent.id).maybeSingle());
  if (!transaction) throw new ApiError(409, 'CHECKOUT_NOT_BOUND', 'The checkout has not been attached to a platform payment yet. Retry delivery.');
  // Retrieve from the provider as well as validating HMAC. Client redirects and metadata cannot settle money.
  const checkout = await retrieveCheckout(checkoutEvent.id);
  if (checkout.attributes.livemode !== env.PAYMONGO_LIVE_MODE) throw new ApiError(400, 'PAYMENT_MODE_MISMATCH', 'Wrong provider mode.');
  const payments = checkout.attributes.payments ?? checkout.attributes.payment_intent?.attributes.payments ?? [];
  const paid = payments.find(payment => payment.attributes.status === 'paid');
  if (!paid) throw new ApiError(409, 'PAYMENT_NOT_VERIFIED', 'The provider has not reported a settled payment.');
  const result = assertDb(await db().rpc('settle_payment', { p_event_id: event.id, p_provider_payment_id: paid.id, p_resource_type: transaction.resource_type, p_resource_id: transaction.resource_id, p_amount_centavos: paid.attributes.amount, p_currency: paid.attributes.currency, p_status: 'paid' }));
  res.json({ data: result });
});
