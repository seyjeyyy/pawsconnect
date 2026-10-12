import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asUser, createDatabase, createUser } from '../helpers/db';

// Exercises the order, stock and payment functions the API calls, on a real
// Postgres. The API never computes money itself: it passes product ids and
// quantities to reserve_order and the payment provider's verified amount to
// settle_payment.

let db: PGlite;
let staff: string, ana: string, ben: string;
let anaAddress: string, benAddress: string, farAddress: string;
let kibble: string, bowl: string, hidden: string;

const DELIVERY_FEE = 8000;
type Order = { id: string; status: string; subtotal_centavos: number; discount_centavos: number; delivery_centavos: number; total_centavos: number };
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const stock = (id: string) => one<{ stock_quantity: number; reserved_quantity: number }>('select stock_quantity, reserved_quantity from public.products where id = $1', [id]);
const reserve = async (user: string, address: string, items: { product_id: string; quantity: number }[], coupon: string | null = null) =>
  (await one<{ o: Order }>('select to_jsonb(public.reserve_order($1, $2::jsonb, $3, $4)) as o', [user, JSON.stringify(items), address, coupon])).o;
const order = (id: string) => one<Order>('select * from public.orders where id = $1', [id]);

/** What POST /api/payments/create does: record a pending transaction bound to a provider checkout. */
async function startCheckout(user: string, orderId: string, amount: number) {
  const checkoutId = `cs_${orderId.replaceAll('-', '').slice(0, 20)}${Math.random().toString(36).slice(2, 8)}`;
  await db.query(`insert into public.payment_transactions (user_id, resource_type, resource_id, amount_centavos, provider_checkout_id, checkout_url) values ($1, 'order', $2, $3, $4, 'https://checkout.example.test')`, [user, orderId, amount, checkoutId]);
}
/** What the verified webhook does. */
const settle = async (eventId: string, paymentId: string, orderId: string, amount: number, status = 'paid') =>
  (await one<{ r: { status?: string; duplicate?: boolean; requires_review?: boolean } }>(`select public.settle_payment($1, $2, 'order', $3, $4, 'PHP', $5) as r`, [eventId, paymentId, orderId, amount, status])).r;

async function address(user: string, latitude: number, longitude: number) {
  return (await one<{ id: string }>(`insert into public.customer_addresses (user_id, recipient_name, phone, line1, city, province, latitude, longitude) values ($1, 'Recipient', '09170000000', '12 Mabini Street', 'Malolos', 'Bulacan', $2, $3) returning id`, [user, latitude, longitude])).id;
}
async function product(name: string, price: number, stockQuantity: number, published = true) {
  return (await one<{ id: string }>(`insert into public.products (name, slug, price_centavos, cost_centavos, stock_quantity, is_published) values ($1, $2, $3, $4, $5, $6) returning id`, [name, name.toLowerCase().replaceAll(' ', '-') + '-' + Math.random().toString(36).slice(2, 7), price, Math.round(price * 0.6), stockQuantity, published])).id;
}

beforeAll(async () => {
  db = await createDatabase();
  staff = await createUser(db, 'staff@example.test');
  ana = await createUser(db, 'ana@example.test');
  ben = await createUser(db, 'ben@example.test');
  await db.query(`insert into public.user_roles (user_id, role_name) values ($1, 'shelter_staff')`, [staff]);
  // Test delivery rectangle around Malolos. Not a real service boundary.
  await db.query(`insert into public.service_zones (name, service_type, province, boundary, source_reference, is_active, fee_centavos, created_by)
    values ('Test delivery zone', 'delivery', 'Bulacan', extensions.st_multi(extensions.st_geomfromtext('POLYGON((120.78 14.82, 120.84 14.82, 120.84 14.87, 120.78 14.87, 120.78 14.82))', 4326)), 'automated test fixture', true, $1, $2)`, [DELIVERY_FEE, staff]);
  anaAddress = await address(ana, 14.8433, 120.8114);
  benAddress = await address(ben, 14.85, 120.80);
  farAddress = await address(ana, 14.5995, 120.9842); // Manila: outside the zone
  hidden = await product('Unpublished Item', 10000, 5, false);
});
beforeEach(async () => {
  kibble = await product('Dog Kibble', 25000, 2);
  bowl = await product('Steel Bowl', 12000, 10);
});
afterAll(() => db.close());

describe('checkout calculation', () => {
  it('prices the order from the database, adds the zone delivery fee and reserves stock', async () => {
    const o = await reserve(ana, anaAddress, [{ product_id: kibble, quantity: 2 }, { product_id: bowl, quantity: 1 }]);
    expect(o).toMatchObject({ status: 'pending_payment', subtotal_centavos: 62000, discount_centavos: 0, delivery_centavos: DELIVERY_FEE, total_centavos: 70000 });
    expect(await stock(kibble)).toEqual({ stock_quantity: 2, reserved_quantity: 2 });
    expect(await stock(bowl)).toEqual({ stock_quantity: 10, reserved_quantity: 1 });
    const items = await db.query<{ unit_price_centavos: number; line_total_centavos: number }>('select unit_price_centavos, line_total_centavos from public.order_items where order_id = $1 order by line_total_centavos', [o.id]);
    expect(items.rows.map(r => Number(r.line_total_centavos))).toEqual([12000, 50000]);
  });

  it('ignores any price the client sends with a cart line', async () => {
    const tampered = [{ product_id: bowl, quantity: 1, price_centavos: 1, unit_price_centavos: 1, line_total_centavos: 1 }];
    expect((await reserve(ana, anaAddress, tampered)).subtotal_centavos).toBe(12000);
  });

  it('merges duplicate lines for the same product before checking stock', async () => {
    await expect(reserve(ana, anaAddress, [{ product_id: kibble, quantity: 2 }, { product_id: kibble, quantity: 1 }])).rejects.toThrow(/Insufficient stock/);
  });

  it('applies a valid discount code and rejects expired or exhausted ones', async () => {
    await db.query(`insert into public.coupons (code, discount_percent, expires_at, max_uses) values ('TENOFF', 10, now() + interval '1 day', 1), ('OLD', 10, now() + interval '1 second', null) on conflict do nothing`);
    await db.query(`update public.coupons set starts_at = now() - interval '2 days', expires_at = now() - interval '1 day' where code = 'OLD'`);
    const o = await reserve(ana, anaAddress, [{ product_id: bowl, quantity: 2 }], 'tenoff');
    expect(o).toMatchObject({ subtotal_centavos: 24000, discount_centavos: 2400, total_centavos: 24000 - 2400 + DELIVERY_FEE });
    await expect(reserve(ben, benAddress, [{ product_id: bowl, quantity: 1 }], 'TENOFF')).rejects.toThrow(/fully claimed/);
    await expect(reserve(ben, benAddress, [{ product_id: bowl, quantity: 1 }], 'OLD')).rejects.toThrow(/voucher has expired/);
    await expect(reserve(ben, benAddress, [{ product_id: bowl, quantity: 1 }], 'NOSUCH')).rejects.toThrow(/voucher code is not valid/);
  });

  it.each([
    ['more than the available stock', () => reserve(ana, anaAddress, [{ product_id: kibble, quantity: 3 }]), /Insufficient stock/],
    ['an unpublished product', () => reserve(ana, anaAddress, [{ product_id: hidden, quantity: 1 }]), /unavailable/],
    ['an address outside every delivery zone', () => reserve(ana, farAddress, [{ product_id: bowl, quantity: 1 }]), /not within an active approved delivery zone/],
    ["another customer's address", () => reserve(ana, benAddress, [{ product_id: bowl, quantity: 1 }]), /Address not found/],
    ['a zero or negative quantity', () => reserve(ana, anaAddress, [{ product_id: bowl, quantity: 0 }]), /Invalid cart line/],
    ['an empty cart', () => reserve(ana, anaAddress, []), /1 to 100 lines/],
  ])('refuses %s and reserves nothing', async (_label, attempt, message) => {
    await expect(attempt()).rejects.toThrow(message);
    expect((await stock(kibble)).reserved_quantity).toBe(0);
    expect((await stock(bowl)).reserved_quantity).toBe(0);
  });
});

describe('overselling', () => {
  it('lets only one of two customers reserve the last units', async () => {
    const first = await reserve(ana, anaAddress, [{ product_id: kibble, quantity: 2 }]);
    await expect(reserve(ben, benAddress, [{ product_id: kibble, quantity: 1 }])).rejects.toThrow(/Insufficient stock/);
    expect(first.status).toBe('pending_payment');
    expect(await stock(kibble)).toEqual({ stock_quantity: 2, reserved_quantity: 2 });
  });

  it('takes a row lock on each product before reading its stock', async () => {
    // PGlite is single-connection, so true parallel checkouts cannot be run here.
    // This asserts the mechanism that makes them safe on a real server.
    const { src } = await one<{ src: string }>(`select prosrc as src from pg_proc where proname = 'reserve_order'`);
    const lock = src.indexOf('for update'), read = src.indexOf('stock_quantity-v_product.reserved_quantity');
    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(read);
  });

  it('returns stock when the customer cancels, and when a reservation expires', async () => {
    const cancelled = await reserve(ana, anaAddress, [{ product_id: kibble, quantity: 2 }]);
    await expect(db.query(`select public.transition_order($1, $2, 'cancelled')`, [ben, cancelled.id])).rejects.toThrow(/not permitted/);
    await db.query(`select public.transition_order($1, $2, 'cancelled')`, [ana, cancelled.id]);
    expect((await stock(kibble)).reserved_quantity).toBe(0);

    const stale = await reserve(ben, benAddress, [{ product_id: kibble, quantity: 1 }]);
    await db.query(`update public.orders set reservation_expires_at = now() - interval '1 minute' where id = $1`, [stale.id]);
    const { n } = await one<{ n: number }>('select public.expire_order_reservations() as n');
    expect(n).toBe(1);
    expect((await order(stale.id)).status).toBe('cancelled');
    expect(await stock(kibble)).toEqual({ stock_quantity: 2, reserved_quantity: 0 });
  });
});

describe('payment settlement', () => {
  it('cannot record a transaction as already paid, or for the wrong amount or owner', async () => {
    const o = await reserve(ana, anaAddress, [{ product_id: bowl, quantity: 1 }]);
    const insert = (user: string, amount: number, status: string) => db.query(`insert into public.payment_transactions (user_id, resource_type, resource_id, amount_centavos, status) values ($1, 'order', $2, $3, $4)`, [user, o.id, amount, status]);
    await expect(insert(ana, o.total_centavos, 'paid')).rejects.toThrow(/await provider verification/);
    await expect(insert(ana, 100, 'pending')).rejects.toThrow(/does not match/);
    await expect(insert(ben, o.total_centavos, 'pending')).rejects.toThrow(/does not match/);
  });

  it('marks the order paid and deducts stock only on a verified payment of the exact total', async () => {
    const o = await reserve(ana, anaAddress, [{ product_id: kibble, quantity: 2 }]);
    await startCheckout(ana, o.id, o.total_centavos);
    expect((await order(o.id)).status).toBe('pending_payment');

    await expect(settle('evt_short', 'pay_short', o.id, o.total_centavos - 1)).rejects.toThrow(/does not match/);
    expect((await order(o.id)).status).toBe('pending_payment');

    expect(await settle('evt_ok', 'pay_ok', o.id, o.total_centavos)).toMatchObject({ status: 'paid', requires_review: false });
    expect((await order(o.id)).status).toBe('paid');
    expect(await stock(kibble)).toEqual({ stock_quantity: 0, reserved_quantity: 0 });
    const movement = await one<{ quantity: number; reason: string }>('select quantity, reason from public.inventory_movements where reference_id = $1', [o.id]);
    expect(movement).toEqual({ quantity: -2, reason: 'sale' });
  });

  it('processes a duplicate webhook once', async () => {
    const o = await reserve(ana, anaAddress, [{ product_id: bowl, quantity: 3 }]);
    await startCheckout(ana, o.id, o.total_centavos);
    await settle('evt_dup', 'pay_dup', o.id, o.total_centavos);
    // Same event redelivered, then a different event for the same provider payment.
    expect(await settle('evt_dup', 'pay_dup', o.id, o.total_centavos)).toMatchObject({ duplicate: true });
    expect(await settle('evt_dup_again', 'pay_dup', o.id, o.total_centavos)).toMatchObject({ duplicate: true });
    expect(await stock(bowl)).toEqual({ stock_quantity: 7, reserved_quantity: 0 });
    const { n } = await one<{ n: number }>('select count(*)::int as n from public.inventory_movements where reference_id = $1', [o.id]);
    expect(n).toBe(1);
  });

  it('refuses to settle an order that has no checkout bound to it', async () => {
    const o = await reserve(ana, anaAddress, [{ product_id: bowl, quantity: 1 }]);
    await expect(settle('evt_unbound', 'pay_unbound', o.id, o.total_centavos)).rejects.toThrow(/No matching payment checkout/);
    expect((await order(o.id)).status).toBe('pending_payment');
  });

  it('records a failed payment without paying the order or touching stock', async () => {
    const o = await reserve(ana, anaAddress, [{ product_id: bowl, quantity: 1 }]);
    await startCheckout(ana, o.id, o.total_centavos);
    expect(await settle('evt_fail', 'pay_fail', o.id, o.total_centavos, 'failed')).toMatchObject({ status: 'failed' });
    expect((await order(o.id)).status).toBe('pending_payment');
    expect(await stock(bowl)).toEqual({ stock_quantity: 10, reserved_quantity: 1 });
  });

  it('flags a payment that arrives after the reservation expired for staff review instead of shipping it', async () => {
    const o = await reserve(ana, anaAddress, [{ product_id: kibble, quantity: 1 }]);
    await startCheckout(ana, o.id, o.total_centavos);
    await db.query(`update public.orders set reservation_expires_at = now() - interval '1 minute' where id = $1`, [o.id]);
    expect(await settle('evt_late', 'pay_late', o.id, o.total_centavos)).toMatchObject({ status: 'paid_requires_review', requires_review: true });
    expect((await order(o.id)).status).toBe('cancelled');
    expect(await stock(kibble)).toEqual({ stock_quantity: 2, reserved_quantity: 0 });
  });
});

describe('order state machine', () => {
  async function paidOrder() {
    const o = await reserve(ana, anaAddress, [{ product_id: bowl, quantity: 1 }]);
    await startCheckout(ana, o.id, o.total_centavos);
    await settle(`evt_${o.id}`, `pay_${o.id}`, o.id, o.total_centavos);
    return o.id;
  }
  const move = (actor: string, id: string, status: string) => db.query(`select public.transition_order($1, $2, $3)`, [actor, id, status]);

  it('advances one step at a time, by staff only', async () => {
    const id = await paidOrder();
    await expect(move(ana, id, 'processing')).rejects.toThrow(/not permitted/);
    await expect(move(staff, id, 'shipped')).rejects.toThrow(/not permitted/);
    for (const status of ['processing', 'ready_for_shipment', 'shipped', 'delivered']) await move(staff, id, status);
    expect((await order(id)).status).toBe('delivered');
    await expect(move(staff, id, 'processing')).rejects.toThrow(/not permitted/);
  });

  it('does not allow a paid order to be cancelled, or refunded without a recorded refund', async () => {
    const id = await paidOrder();
    await expect(move(ana, id, 'cancelled')).rejects.toThrow(/not permitted/);
    await expect(move(staff, id, 'refunded')).rejects.toThrow(/not permitted/);
    expect((await order(id)).status).toBe('paid');
  });

  it('accepts a review only from a customer whose purchase was delivered', async () => {
    const id = await paidOrder();
    const item = await one<{ id: string }>('select id from public.order_items where order_id = $1', [id]);
    const review = (user: string) => db.query(`insert into public.customer_reviews (user_id, product_id, order_item_id, rating, body, is_approved) values ($1, $2, $3, 5, 'Sturdy and easy to clean.', true)`, [user, bowl, item.id]);
    await expect(review(ana)).rejects.toThrow(/delivered purchase/);
    for (const status of ['processing', 'ready_for_shipment', 'shipped', 'delivered']) await move(staff, id, status);
    await expect(review(ben)).rejects.toThrow(/delivered purchase/);
    await review(ana);
    // A review can never be inserted pre-approved.
    expect((await one<{ is_approved: boolean }>('select is_approved from public.customer_reviews where order_item_id = $1', [item.id])).is_approved).toBe(false);
  });
});

describe('inventory', () => {
  const adjust = (actor: string, id: string, delta: number, reason = 'Supplier delivery received') => db.query('select public.adjust_inventory($1, $2, null, $3, $4)', [actor, id, delta, reason]);

  it('lets staff adjust stock with a reason, recorded as a movement', async () => {
    await adjust(staff, kibble, 10);
    expect((await stock(kibble)).stock_quantity).toBe(12);
    const movement = await one<{ quantity: number; actor_id: string }>(`select quantity, actor_id from public.inventory_movements where product_id = $1`, [kibble]);
    expect(movement).toEqual({ quantity: 10, actor_id: staff });
  });

  it('refuses customers, missing reasons, and write-offs below reserved stock', async () => {
    await expect(adjust(ana, kibble, 5)).rejects.toThrow(/staff role required/);
    await expect(adjust(staff, kibble, 5, 'x')).rejects.toThrow(/reason is required/);
    await reserve(ana, anaAddress, [{ product_id: kibble, quantity: 2 }]);
    await expect(adjust(staff, kibble, -1, 'Damaged in storage')).rejects.toThrow(/reserved by pending orders/);
    expect(await stock(kibble)).toEqual({ stock_quantity: 2, reserved_quantity: 2 });
  });
});

describe('order privacy', () => {
  it("hides one customer's orders and payments from another, and blocks direct writes", async () => {
    const o = await reserve(ana, anaAddress, [{ product_id: bowl, quantity: 1 }]);
    await startCheckout(ana, o.id, o.total_centavos);
    const seenByBen = await asUser(db, ben, async tx => ({
      orders: (await tx.query('select id from public.orders where id = $1', [o.id])).rows.length,
      payments: (await tx.query('select id from public.payment_transactions where resource_id = $1', [o.id])).rows.length,
    }));
    expect(seenByBen).toEqual({ orders: 0, payments: 0 });
    expect((await asUser(db, ana, tx => tx.query('select id from public.orders where id = $1', [o.id]))).rows.length).toBe(1);
    await expect(asUser(db, ana, tx => tx.query(`update public.orders set status = 'paid' where id = $1`, [o.id]))).rejects.toThrow(/permission denied/);
  });

  it('requires the audited API for catalog changes, including by staff', async () => {
    for (const user of [ana, staff]) {
      await expect(asUser(db, user, tx => tx.query('update public.products set price_centavos = 1 where id = $1', [bowl]))).rejects.toThrow(/permission denied/);
      await expect(asUser(db, user, tx => tx.query("insert into public.products (name, slug, price_centavos, is_published) values ('Free Stuff', 'free-stuff', 0, true)"))).rejects.toThrow(/permission denied/);
      await expect(asUser(db, user, tx => tx.query("insert into public.coupons (code, discount_percent, expires_at) values ('FREE', 100, now() + interval '1 day')"))).rejects.toThrow(/permission denied/);
    }
    expect(Number((await one<{ price_centavos: number }>('select price_centavos from public.products where id = $1', [bowl])).price_centavos)).toBe(12000);
  });});
