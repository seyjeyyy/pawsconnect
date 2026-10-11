import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../config/supabase.js';
import { authenticate } from '../../middleware/auth.js';
import { ApiError, assertDb } from '../../utils/errors.js';
import { pagination, safeSearch, uuid } from '../../utils/validation.js';

export const connectedRouter = Router();
connectedRouter.use(authenticate);
const lists: Record<string, { table: string; select: string; owner?: string; search?: string }> = {
  orders: { table: 'orders', select: '*,order_items(*),shipments(*)', search: 'order_number' },
  payments: { table: 'payment_transactions', select: 'id,resource_type,resource_id,amount_centavos,currency,status,livemode,created_at,paid_at' },
  applications: { table: 'adoption_applications', select: '*,pets(id,name,image_url),adoption_appointments(*)', search: 'status' },
  reports: { table: 'stray_reports', select: '*,stray_report_photos(*),rescue_events(status,created_at)', search: 'description' },
  transport: { table: 'transport_requests', select: '*,transport_quotes(*),transport_tracking_events(*),transport_handovers(*)', search: 'pet_details' },
  alternatives: { table: 'alternative_transport_requests', select: '*', search: 'details' },
  donations: { table: 'donations', select: '*', search: 'status' },
  wishlist: { table: 'wishlist_items', select: '*,products(id,name,slug,image_url,price_centavos,is_published,is_sample)' },
  favorites: { table: 'favorite_pets', select: '*,pets(id,name,image_url,status,is_published,is_sample)' },
  reviews: { table: 'customer_reviews', select: '*,products(name,image_url)' },
  notifications: { table: 'notifications', select: '*', search: 'title' },
  messages: { table: 'contact_messages', select: 'id,name,email,message,status,reply,replied_at,created_at', search: 'message' },
  refunds: { table: 'refunds', select: '*', owner: 'requested_by', search: 'reason' },
};
connectedRouter.get('/account/summary', async (req, res) => {
  res.json({ data: assertDb(await db().rpc('account_metrics', { p_actor_id: req.actor!.id })) });
});
connectedRouter.get('/account/records/:kind', async (req, res) => {
  const resource = lists[z.string().parse(req.params.kind)];
  if (!resource) throw new ApiError(404, 'NOT_FOUND', 'Account resource not found.');
  const { page, limit, q } = pagination.parse(req.query);
  let query = db().from(resource.table).select(resource.select, { count: 'exact' }).eq(resource.owner ?? 'user_id', req.actor!.id);
  if (q && resource.search) query = query.ilike(resource.search, `%${safeSearch(q)}%`);
  const result = await query.order('created_at', { ascending: false }).range((page - 1) * limit, page * limit - 1);
  res.json({ data: assertDb(result), meta: { total: result.count, page, limit } });
});
connectedRouter.post('/favorite-pets', async (req, res) => {
  const { pet_id } = z.object({ pet_id: uuid }).strict().parse(req.body);
  assertDb(await db().from('pets').select('id').eq('id', pet_id).eq('is_published', true).eq('is_sample', false).in('status', ['available','reserved','adopted']).single());
  res.status(201).json({ data: assertDb(await db().from('favorite_pets').upsert({ user_id: req.actor!.id, pet_id }).select().single()) });
});
connectedRouter.delete('/favorite-pets/:id', async (req, res) => {
  assertDb(await db().from('favorite_pets').delete().eq('user_id', req.actor!.id).eq('pet_id', uuid.parse(req.params.id)));
  res.json({ data: { deleted: true } });
});
connectedRouter.post('/refund-requests', async (req, res) => {
  const input = z.object({ payment_id: uuid, reason: z.string().min(10).max(2000) }).strict().parse(req.body);
  res.status(201).json({ data: assertDb(await db().rpc('request_refund', { p_actor_id: req.actor!.id, p_payment_id: input.payment_id, p_reason: input.reason })) });
});
