import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../config/supabase.js';
import { authenticate } from '../../middleware/auth.js';
import { ApiError, assertDb } from '../../utils/errors.js';
import { uuid } from '../../utils/validation.js';
import { eligibility } from '../geofencing/service.js';
import { withReferences } from '../analytics/references.js';

export const orderInput = z.object({ items: z.array(z.object({ product_id: uuid, variant_id: uuid.optional(), quantity: z.number().int().min(1).max(99) }).strict()).min(1).max(50), address_id: uuid, coupon_code: z.string().max(50).optional().nullable() }).strict();
export const commerceRouter = Router();
commerceRouter.use(authenticate);
async function cart(user_id: string) {
  return assertDb(await db().from('carts').upsert({ user_id }, { onConflict: 'user_id' }).select().single());
}
commerceRouter.get('/cart', async (req, res) => {
  const current = await cart(req.actor!.id);
  const items = assertDb(await db().from('cart_items').select('*,products(id,name,slug,price_centavos,image_url,stock_quantity,reserved_quantity,is_published,is_sample),product_variants(*)').eq('cart_id', current.id));
  res.json({ data: { id: current.id, items } });
});
commerceRouter.post('/cart/items', async (req, res) => {
  const input = z.object({ product_id: uuid, variant_id: uuid.optional(), quantity: z.number().int().min(1).max(99) }).strict().parse(req.body);
  const data = assertDb(await db().rpc('set_cart_item', { p_actor_id: req.actor!.id, p_product_id: input.product_id, p_variant_id: input.variant_id ?? null, p_quantity: input.quantity }));
  res.status(201).json({ data });
});
commerceRouter.patch('/cart/items/:id', async (req, res) => {
  const { quantity } = z.object({ quantity: z.number().int().min(1).max(99) }).strict().parse(req.body);
  const current = await cart(req.actor!.id);
  const item = assertDb(await db().from('cart_items').select('product_id,variant_id').eq('id', uuid.parse(req.params.id)).eq('cart_id', current.id).single());
  res.json({ data: assertDb(await db().rpc('set_cart_item', { p_actor_id: req.actor!.id, p_product_id: item.product_id, p_variant_id: item.variant_id, p_quantity: quantity })) });
});
commerceRouter.delete('/cart/items/:id', async (req, res) => {
  const current = await cart(req.actor!.id);
  assertDb(await db().from('cart_items').delete().eq('id', uuid.parse(req.params.id)).eq('cart_id', current.id));
  res.json({ data: { deleted: true } });
});
commerceRouter.delete('/cart', async (req, res) => {
  const current = await cart(req.actor!.id);
  assertDb(await db().from('cart_items').delete().eq('cart_id', current.id));
  res.json({ data: { deleted: true } });
});
commerceRouter.post('/orders/quote', async (req, res) => {
  const input = orderInput.parse(req.body);
  const address = assertDb(await db().from('customer_addresses').select('*').eq('id', input.address_id).eq('user_id', req.actor!.id).single());
  if (address.latitude == null || address.longitude == null) throw new ApiError(409, 'LOCATION_REQUIRED', 'Add delivery coordinates to this address.');
  const coverage = await eligibility('delivery', address.latitude, address.longitude);
  if (!coverage.eligible) throw new ApiError(409, 'DELIVERY_UNAVAILABLE', 'This location needs an approved product delivery zone before checkout.', coverage);
  const consolidated = new Map<string, typeof input.items[number]>();
  for (const item of input.items) { const key = `${item.product_id}:${item.variant_id ?? ''}`; const count = (consolidated.get(key)?.quantity ?? 0) + item.quantity; if (count > 99) throw new ApiError(400, 'QUANTITY_LIMIT', 'A product quantity cannot exceed 99.'); consolidated.set(key, { ...item, quantity: count }); }
  let subtotal = 0;
  const lines = [];
  for (const item of consolidated.values()) {
    const product = assertDb(await db().from('products').select('*').eq('id', item.product_id).eq('is_published', true).single());
    const purchasable = item.variant_id ? assertDb(await db().from('product_variants').select('*').eq('id', item.variant_id).eq('product_id', item.product_id).eq('is_active', true).single()) : product;
    if (product.is_sample) throw new ApiError(409, 'SAMPLE_PRODUCT', 'Sample products cannot be purchased.');
    if (purchasable.stock_quantity - purchasable.reserved_quantity < item.quantity) throw new ApiError(409, 'OUT_OF_STOCK', `${product.name} does not have enough available stock.`);
    const amount = Number(purchasable.price_centavos) * item.quantity;
    subtotal += amount;
    lines.push({ ...item, name: product.name, unit_price_centavos: Number(purchasable.price_centavos), line_total_centavos: amount });
  }
  const delivery = Number(coverage.fee_centavos ?? 0);
  let discount = 0, voucher: { code: string; name: string; applies_to: string; discount_percent: number | null } | null = null;
  if (input.coupon_code?.trim()) {
    // The same database routine reserve_order uses, so a quote and the order it becomes cannot disagree.
    const result = assertDb<{ code: string; name: string; applies_to: string; discount_percent: number | null; discount_centavos: number }>(await db().rpc('evaluate_voucher', { p_user_id: req.actor!.id, p_code: input.coupon_code, p_subtotal_centavos: subtotal, p_delivery_centavos: delivery, p_lock: false }));
    discount = Number(result.discount_centavos);
    voucher = { code: result.code, name: result.name, applies_to: result.applies_to, discount_percent: result.discount_percent };
  }
  res.json({ data: { items: lines, subtotal_centavos: subtotal, discount_centavos: discount, delivery_centavos: delivery, total_centavos: subtotal - discount + delivery, voucher, currency: 'PHP', reservation: false } });
});
// The signed-in customer's vouchers: what they can use now, what they have used, what has lapsed,
// and how far they are from the next loyalty reward. Whether a voucher fits a particular order is
// still decided by evaluate_voucher at checkout.
commerceRouter.get('/vouchers/mine', async (req, res) => {
  const user = req.actor!.id, now = Date.now();
  const [couponRows, grantRows, redemptionRows, ruleRows, orderRows] = await Promise.all([
    db().from('coupons').select('id,code,name,description,kind,applies_to,discount_percent,discount_centavos,max_discount_centavos,minimum_subtotal_centavos,starts_at,expires_at,is_active,max_uses,used_count,reserved_count,per_user_limit'),
    db().from('voucher_grants').select('coupon_id,granted_at').eq('user_id', user),
    db().from('voucher_redemptions').select('coupon_id,status,discount_centavos,updated_at,orders(order_number)').eq('user_id', user).in('status', ['reserved', 'redeemed']),
    db().from('loyalty_rules').select('id,name,metric,threshold,reward_code,created_at').eq('is_active', true),
    db().from('orders').select('total_centavos,paid_at,status').eq('user_id', user).not('paid_at', 'is', null),
  ]);
  type Coupon = { id: string; code: string; name: string | null; description: string | null; kind: string; applies_to: string; discount_percent: number | null; discount_centavos: number | null; max_discount_centavos: number | null; minimum_subtotal_centavos: number; starts_at: string; expires_at: string; is_active: boolean; max_uses: number | null; used_count: number; reserved_count: number; per_user_limit: number };
  const coupons = assertDb<Coupon[]>(couponRows), grants = assertDb<{ coupon_id: string; granted_at: string }[]>(grantRows);
  const redemptions = assertDb<{ coupon_id: string; status: string; discount_centavos: number; updated_at: string; orders: { order_number: string } | { order_number: string }[] | null }[]>(redemptionRows);
  const rules = assertDb<{ id: string; name: string; metric: string; threshold: number; reward_code: string; created_at: string }[]>(ruleRows);
  const paidOrders = assertDb<{ total_centavos: number; paid_at: string; status: string }[]>(orderRows).filter(order => !['cancelled', 'refunded'].includes(order.status));
  const hasPaidOrder = assertDb<unknown[]>(orderRows).length > 0;
  const vouchers = coupons.flatMap(coupon => {
    const mine = redemptions.filter(row => row.coupon_id === coupon.id), granted = grants.filter(row => row.coupon_id === coupon.id).length;
    const used = mine.filter(row => row.status === 'redeemed').length, held = mine.filter(row => row.status === 'reserved').length;
    const allowed = coupon.kind === 'loyalty' ? granted : coupon.per_user_limit;
    const expired = Date.parse(coupon.expires_at) <= now, started = Date.parse(coupon.starts_at) <= now;
    const touched = mine.length > 0 || granted > 0;
    // Vouchers the customer never held and cannot use are not listed at all.
    if (!touched && (!coupon.is_active || !started || coupon.kind === 'loyalty' || (coupon.kind === 'first_purchase' && hasPaidOrder))) return [];
    if (!touched && expired && now - Date.parse(coupon.expires_at) > 30 * 86_400_000) return [];
    const claimed = coupon.max_uses != null && coupon.used_count + coupon.reserved_count >= coupon.max_uses;
    const remaining = Math.max(allowed - used - held, 0);
    const status = remaining > 0 && !expired && coupon.is_active && started && !claimed && !(coupon.kind === 'first_purchase' && hasPaidOrder) ? 'available'
      : held > 0 ? 'held' : used > 0 ? 'used' : expired ? 'expired' : 'unavailable';
    const order = mine.map(row => Array.isArray(row.orders) ? row.orders[0] : row.orders).find(Boolean);
    return [{ code: coupon.code, name: coupon.name || coupon.code, description: coupon.description, kind: coupon.kind, applies_to: coupon.applies_to,
      discount_percent: coupon.discount_percent, discount_centavos: coupon.discount_centavos, max_discount_centavos: coupon.max_discount_centavos,
      minimum_subtotal_centavos: Number(coupon.minimum_subtotal_centavos), expires_at: coupon.expires_at, status, remaining_uses: status === 'available' ? remaining : 0,
      used_count: used, last_order_number: order?.order_number ?? null }];
  });
  const loyalty = rules.map(rule => {
    const counted = paidOrders.filter(order => Date.parse(order.paid_at) >= Date.parse(rule.created_at));
    const progress = rule.metric === 'orders' ? counted.length : counted.reduce((sum, order) => sum + Number(order.total_centavos), 0);
    const threshold = Number(rule.threshold), reward = coupons.find(coupon => coupon.code === rule.reward_code);
    return { name: rule.name, metric: rule.metric, threshold, progress: progress % threshold, earned: Math.floor(progress / threshold), reward_name: reward?.name || rule.reward_code };
  });
  res.json({ data: { vouchers, loyalty } });
});
commerceRouter.post('/orders', async (req, res) => {
  const input = orderInput.parse(req.body);
  const data = assertDb(await db().rpc('reserve_order', { p_user_id: req.actor!.id, p_items: input.items, p_address_id: input.address_id, p_coupon_code: input.coupon_code?.trim().toUpperCase() ?? null }));
  res.status(201).json({ data });
});
commerceRouter.get('/orders', async (req, res) => {
  res.json({ data: assertDb(await db().from('orders').select('*,order_items(*)').eq('user_id', req.actor!.id).order('created_at', { ascending: false }).limit(100)) });
});
commerceRouter.get('/orders/:id', async (req, res) => {
  const order = assertDb<Record<string, unknown>>(await db().from('orders').select('*,order_items(*),shipments(*)').eq('id', uuid.parse(req.params.id)).eq('user_id', req.actor!.id).single());
  res.json({ data: (await withReferences([order], { people: false }))[0] });
});
commerceRouter.post('/orders/:id/cancel', async (req, res) => {
  const data = assertDb(await db().rpc('transition_order', { p_actor_id: req.actor!.id, p_order_id: uuid.parse(req.params.id), p_status: 'cancelled' }));
  res.json({ data });
});
commerceRouter.get('/wishlist', async (req, res) => {
  res.json({ data: assertDb(await db().from('wishlist_items').select('*,products(id,name,slug,image_url,price_centavos,stock_quantity,is_published,is_sample)').eq('user_id', req.actor!.id)) });
});
commerceRouter.post('/wishlist', async (req, res) => {
  const { product_id } = z.object({ product_id: uuid }).strict().parse(req.body);
  assertDb(await db().from('products').select('id').eq('id', product_id).eq('is_published', true).single());
  res.status(201).json({ data: assertDb(await db().from('wishlist_items').upsert({ user_id: req.actor!.id, product_id }).select().single()) });
});
commerceRouter.delete('/wishlist/:id', async (req, res) => {
  assertDb(await db().from('wishlist_items').delete().eq('user_id', req.actor!.id).eq('product_id', uuid.parse(req.params.id)));
  res.json({ data: { deleted: true } });
});
commerceRouter.get('/reviews/mine', async (req, res) => {
  res.json({ data: assertDb(await db().from('customer_reviews').select('*,products(name,image_url)').eq('user_id', req.actor!.id).order('created_at', { ascending: false })) });
});
commerceRouter.post('/products/:id/reviews', async (req, res) => {
  const product_id = uuid.parse(req.params.id);
  const input = z.object({ rating: z.number().int().min(1).max(5), comment: z.string().min(5).max(2000) }).strict().parse(req.body);
  const purchases = assertDb(await db().from('order_items').select('id,orders!inner(user_id,status)').eq('product_id', product_id).eq('orders.user_id', req.actor!.id).eq('orders.status', 'delivered').limit(1));
  if (!purchases.length) throw new ApiError(403, 'VERIFIED_PURCHASE_REQUIRED', 'Reviews are available after a purchased item has been delivered.');
  res.status(201).json({ data: assertDb(await db().from('customer_reviews').insert({ user_id: req.actor!.id, product_id, order_item_id: purchases[0].id, rating: input.rating, body: input.comment }).select().single()) });
});
