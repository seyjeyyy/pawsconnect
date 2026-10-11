import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../config/supabase.js';
import { authenticate } from '../../middleware/auth.js';
import { ApiError, assertDb } from '../../utils/errors.js';
import { uuid } from '../../utils/validation.js';
import { eligibility } from '../geofencing/service.js';

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
  let discount = 0;
  if (input.coupon_code) {
    const coupon = assertDb(await db().from('coupons').select('*').eq('code', input.coupon_code.trim().toUpperCase()).eq('is_active', true).maybeSingle());
    const now = Date.now();
    if (!coupon || Date.parse(coupon.starts_at) > now || Date.parse(coupon.expires_at) <= now || subtotal < Number(coupon.minimum_subtotal_centavos) || (coupon.max_uses != null && coupon.used_count + coupon.reserved_count >= coupon.max_uses)) throw new ApiError(409, 'INVALID_COUPON', 'This discount code is unavailable for this order.');
    discount = Math.min(subtotal, coupon.discount_percent ? Math.floor(subtotal * coupon.discount_percent / 100) : Number(coupon.discount_centavos));
  }
  const delivery = Number(coverage.fee_centavos ?? 0);
  res.json({ data: { items: lines, subtotal_centavos: subtotal, discount_centavos: discount, delivery_centavos: delivery, total_centavos: subtotal - discount + delivery, currency: 'PHP', reservation: false } });
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
  res.json({ data: assertDb(await db().from('orders').select('*,order_items(*),shipments(*)').eq('id', uuid.parse(req.params.id)).eq('user_id', req.actor!.id).single()) });
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
