import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asUser, createDatabase, createUser } from '../helpers/db';

// Vouchers on a real Postgres: what a voucher is worth, who may use it, how many times,
// and what happens to it when the order is paid, cancelled or expires (migration 022).

let db: PGlite;
let staff: string, ana: string, ben: string;
let anaAddress: string, benAddress: string;
let bowl: string;

const DELIVERY_FEE = 8000;
const BOWL = 12000;
type Order = { id: string; status: string; subtotal_centavos: number; discount_centavos: number; delivery_centavos: number; total_centavos: number };
const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];
const reserve = async (user: string, address: string, quantity: number, code: string | null = null) =>
  (await one<{ o: Order }>('select to_jsonb(public.reserve_order($1, $2::jsonb, $3, $4)) as o', [user, JSON.stringify([{ product_id: bowl, quantity }]), address, code])).o;
const evaluate = async (user: string, code: string, subtotal: number, fee = DELIVERY_FEE) =>
  (await one<{ v: { discount_centavos: number; applies_to: string } }>('select public.evaluate_voucher($1, $2, $3, $4) as v', [user, code, subtotal, fee])).v;
const coupon = (code: string) => one<{ used_count: number; reserved_count: number }>('select used_count, reserved_count from public.coupons where code = $1', [code]);
const redemption = (orderId: string) => one<{ status: string; discount_centavos: number }>('select status, discount_centavos from public.voucher_redemptions where order_id = $1', [orderId]);
const grants = async (user: string, code: string) => Number((await one<{ n: number }>('select count(*)::int as n from public.voucher_grants g join public.coupons c on c.id = g.coupon_id where g.user_id = $1 and c.code = $2', [user, code])).n);
const voucher = (code: string, columns: Record<string, unknown>) => {
  const all = { code, expires_at: new Date(Date.now() + 86_400_000).toISOString(), ...columns };
  const keys = Object.keys(all);
  return db.query(`insert into public.coupons (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(all));
};
/** What POST /api/payments/create and the verified webhook do, together. */
async function pay(user: string, order: Order) {
  const checkoutId = `cs_${order.id.replaceAll('-', '').slice(0, 20)}${Math.random().toString(36).slice(2, 8)}`;
  await db.query(`insert into public.payment_transactions (user_id, resource_type, resource_id, amount_centavos, provider_checkout_id, checkout_url) values ($1, 'order', $2, $3, $4, 'https://checkout.example.test')`, [user, order.id, order.total_centavos, checkoutId]);
  await db.query(`select public.settle_payment($1, $2, 'order', $3, $4, 'PHP', 'paid')`, [`evt_${checkoutId}`, `pi_${checkoutId}`, order.id, order.total_centavos]);
}
const cancel = (user: string, orderId: string) => db.query(`select public.transition_order($1, $2, 'cancelled')`, [user, orderId]);

beforeAll(async () => {
  db = await createDatabase();
  staff = await createUser(db, 'staff@example.test');
  ana = await createUser(db, 'ana@example.test');
  ben = await createUser(db, 'ben@example.test');
  await db.query(`insert into public.user_roles (user_id, role_name) values ($1, 'shelter_staff')`, [staff]);
  // Test delivery rectangle around Malolos. Not a real service boundary.
  await db.query(`insert into public.service_zones (name, service_type, province, boundary, source_reference, is_active, fee_centavos, created_by)
    values ('Test delivery zone', 'delivery', 'Bulacan', extensions.st_multi(extensions.st_geomfromtext('POLYGON((120.78 14.82, 120.84 14.82, 120.84 14.87, 120.78 14.87, 120.78 14.82))', 4326)), 'automated test fixture', true, $1, $2)`, [DELIVERY_FEE, staff]);
  const address = async (user: string) => (await one<{ id: string }>(`insert into public.customer_addresses (user_id, recipient_name, phone, line1, city, province, latitude, longitude) values ($1, 'Recipient', '09170000000', '12 Mabini Street', 'Malolos', 'Bulacan', 14.8433, 120.8114) returning id`, [user])).id;
  anaAddress = await address(ana); benAddress = await address(ben);
});
beforeEach(async () => {
  bowl = (await one<{ id: string }>(`insert into public.products (name, slug, price_centavos, cost_centavos, stock_quantity, is_published) values ('Steel Bowl', $1, $2, 7000, 500, true) returning id`, ['steel-bowl-' + Math.random().toString(36).slice(2, 9), BOWL])).id;
});
afterAll(() => db.close());

describe('what a voucher is worth', () => {
  it('takes a percentage off the products, capped at the maximum discount', async () => {
    await voucher('TEN', { discount_percent: 10 });
    await voucher('HALFCAP', { discount_percent: 50, max_discount_centavos: 2000 });
    expect((await evaluate(ana, 'TEN', 50000)).discount_centavos).toBe(5000);
    expect((await evaluate(ana, 'HALFCAP', 50000)).discount_centavos).toBe(2000);
    expect((await evaluate(ana, 'halfcap ', 3000)).discount_centavos).toBe(1500);
  });

  it('never takes more than the amount it applies to', async () => {
    await voucher('BIGFIXED', { discount_centavos: 100000 });
    const order = await reserve(ana, anaAddress, 1, 'BIGFIXED');
    expect(order).toMatchObject({ subtotal_centavos: BOWL, discount_centavos: BOWL, delivery_centavos: DELIVERY_FEE, total_centavos: DELIVERY_FEE });
  });

  it('applies a delivery voucher to the delivery fee, not the products', async () => {
    await voucher('FREESHIP', { discount_percent: 100, applies_to: 'delivery' });
    await voucher('SHIP30', { discount_centavos: 3000, applies_to: 'delivery' });
    const free = await reserve(ana, anaAddress, 2, 'FREESHIP');
    expect(free).toMatchObject({ subtotal_centavos: 2 * BOWL, discount_centavos: DELIVERY_FEE, total_centavos: 2 * BOWL });
    expect((await evaluate(ben, 'SHIP30', BOWL)).discount_centavos).toBe(3000);
    expect((await evaluate(ben, 'SHIP30', BOWL, 1000)).discount_centavos).toBe(1000);
  });

  it('requires the minimum spend on products', async () => {
    await voucher('MIN500', { discount_centavos: 5000, minimum_subtotal_centavos: 50000 });
    await expect(evaluate(ana, 'MIN500', 49999)).rejects.toThrow(/Spend at least PHP 500.00/);
    expect((await evaluate(ana, 'MIN500', 50000)).discount_centavos).toBe(5000);
  });
});

describe('who may use a voucher, and how often', () => {
  it('refuses unknown, switched-off, not-yet-started and expired vouchers', async () => {
    await voucher('OFF', { discount_percent: 10, is_active: false });
    await voucher('SOON', { discount_percent: 10, starts_at: new Date(Date.now() + 3_600_000).toISOString() });
    await voucher('GONE', { discount_percent: 10, starts_at: new Date(Date.now() - 172_800_000).toISOString(), expires_at: new Date(Date.now() - 86_400_000).toISOString() });
    for (const code of ['NOSUCH', 'OFF', 'SOON']) await expect(evaluate(ana, code, BOWL)).rejects.toThrow(/not valid/);
    await expect(evaluate(ana, 'GONE', BOWL)).rejects.toThrow(/expired/);
    await expect(reserve(ana, anaAddress, 1, 'GONE')).rejects.toThrow(/expired/);
  });

  it('lets one customer use a single-use voucher once, while others still can', async () => {
    await voucher('ONCE', { discount_percent: 10 });
    const first = await reserve(ana, anaAddress, 1, 'ONCE');
    await expect(reserve(ana, anaAddress, 1, 'ONCE')).rejects.toThrow(/held by an order awaiting payment/);
    await pay(ana, first);
    await expect(reserve(ana, anaAddress, 1, 'ONCE')).rejects.toThrow(/already used/);
    expect((await reserve(ben, benAddress, 1, 'ONCE')).discount_centavos).toBe(1200);
  });

  it('allows the configured number of uses per customer', async () => {
    await voucher('TWICE', { discount_centavos: 1000, per_user_limit: 2 });
    await pay(ana, await reserve(ana, anaAddress, 1, 'TWICE'));
    await pay(ana, await reserve(ana, anaAddress, 1, 'TWICE'));
    await expect(reserve(ana, anaAddress, 1, 'TWICE')).rejects.toThrow(/already used/);
  });

  it('stops at the total number of uses across all customers', async () => {
    await voucher('ONLYONE', { discount_percent: 10, max_uses: 1 });
    await reserve(ana, anaAddress, 1, 'ONLYONE');
    await expect(reserve(ben, benAddress, 1, 'ONLYONE')).rejects.toThrow(/fully claimed/);
  });

  it('keeps a first-order voucher for customers with no paid order', async () => {
    const cara = await createUser(db, 'cara@example.test');
    const caraAddress = (await one<{ id: string }>(`insert into public.customer_addresses (user_id, recipient_name, phone, line1, city, province, latitude, longitude) values ($1, 'Cara', '09170000000', '12 Mabini Street', 'Malolos', 'Bulacan', 14.8433, 120.8114) returning id`, [cara])).id;
    await voucher('WELCOME', { discount_percent: 15, kind: 'first_purchase' });
    // ana already has paid orders from the tests above.
    await expect(evaluate(ana, 'WELCOME', BOWL)).rejects.toThrow(/first order only/);
    const order = await reserve(cara, caraAddress, 1, 'WELCOME');
    expect(order.discount_centavos).toBe(1800);
    await pay(cara, order);
    await expect(evaluate(cara, 'WELCOME', BOWL)).rejects.toThrow(/first order only/);
  });

  it('locks the voucher row before counting its uses', async () => {
    // PGlite is single-connection, so two simultaneous checkouts cannot be run here.
    // This asserts the mechanism that makes them safe on a real server.
    const { src } = await one<{ src: string }>(`select prosrc as src from pg_proc where proname = 'evaluate_voucher'`);
    expect(src.indexOf('for update')).toBeGreaterThan(-1);
    expect(src.indexOf('for update')).toBeLessThan(src.indexOf('voucher_redemptions'));
    const reserveSrc = (await one<{ src: string }>(`select prosrc as src from pg_proc where proname = 'reserve_order'`)).src;
    expect(reserveSrc).toMatch(/evaluate_voucher\(p_user_id,p_coupon_code,v_subtotal,v_fee,true\)/);
  });
});

describe('a voucher follows its order', () => {
  it('is reserved with the order and redeemed only when the payment is verified', async () => {
    await voucher('FOLLOW', { discount_percent: 10, max_uses: 5 });
    const order = await reserve(ana, anaAddress, 1, 'FOLLOW');
    expect(await redemption(order.id)).toMatchObject({ status: 'reserved', discount_centavos: 1200 });
    expect(await coupon('FOLLOW')).toEqual({ used_count: 0, reserved_count: 1 });
    await pay(ana, order);
    expect((await redemption(order.id)).status).toBe('redeemed');
    expect(await coupon('FOLLOW')).toEqual({ used_count: 1, reserved_count: 0 });
  });

  it('is released when the customer cancels before paying, and can be used again', async () => {
    await voucher('RETRY', { discount_percent: 10, max_uses: 1 });
    const order = await reserve(ana, anaAddress, 1, 'RETRY');
    await cancel(ana, order.id);
    expect((await redemption(order.id)).status).toBe('released');
    expect(await coupon('RETRY')).toEqual({ used_count: 0, reserved_count: 0 });
    expect((await reserve(ana, anaAddress, 1, 'RETRY')).discount_centavos).toBe(1200);
  });

  it('is released when an unpaid reservation expires', async () => {
    await voucher('LAPSE', { discount_percent: 10 });
    const order = await reserve(ana, anaAddress, 1, 'LAPSE');
    await db.query(`update public.orders set reservation_expires_at = now() - interval '1 minute' where id = $1`, [order.id]);
    await db.query('select public.expire_order_reservations()');
    expect((await redemption(order.id)).status).toBe('released');
    expect((await evaluate(ana, 'LAPSE', BOWL)).discount_centavos).toBe(1200);
  });

  it('does not create a redemption when checkout fails', async () => {
    await voucher('NOSTOCK', { discount_percent: 10 });
    await expect(reserve(ana, anaAddress, 99, 'NOSTOCK')).resolves.toBeTruthy();
    await db.query('update public.products set stock_quantity = reserved_quantity where id = $1', [bowl]);
    const before = Number((await one<{ n: number }>(`select count(*)::int as n from public.voucher_redemptions r join public.coupons c on c.id = r.coupon_id where c.code = 'NOSTOCK'`)).n);
    await expect(reserve(ben, benAddress, 1, 'NOSTOCK')).rejects.toThrow(/Insufficient stock/);
    const after = Number((await one<{ n: number }>(`select count(*)::int as n from public.voucher_redemptions r join public.coupons c on c.id = r.coupon_id where c.code = 'NOSTOCK'`)).n);
    expect(after).toBe(before);
    expect((await coupon('NOSTOCK')).reserved_count).toBe(1);
  });
});

describe('loyalty rewards', () => {
  it('grants a reward every N paid orders, once per milestone, and only that customer can use it', async () => {
    const dan = await createUser(db, 'dan@example.test');
    const danAddress = (await one<{ id: string }>(`insert into public.customer_addresses (user_id, recipient_name, phone, line1, city, province, latitude, longitude) values ($1, 'Dan', '09170000000', '12 Mabini Street', 'Malolos', 'Bulacan', 14.8433, 120.8114) returning id`, [dan])).id;
    await voucher('LOYAL50', { discount_centavos: 5000, kind: 'loyalty', name: 'Loyalty reward' });
    await db.query(`insert into public.loyalty_rules (name, metric, threshold, reward_code) values ('Every 2 orders', 'orders', 2, 'LOYAL50')`);
    await expect(evaluate(dan, 'LOYAL50', BOWL)).rejects.toThrow(/not earned yet/);

    await pay(dan, await reserve(dan, danAddress, 1));
    expect(await grants(dan, 'LOYAL50')).toBe(0);
    await pay(dan, await reserve(dan, danAddress, 1));
    expect(await grants(dan, 'LOYAL50')).toBe(1);
    const notice = await one<{ title: string; link: string }>(`select title, link from public.notifications where user_id = $1 and title = 'You earned a reward voucher'`, [dan]);
    expect(notice.link).toBe('/account/vouchers');

    // Calling it again, or updating the order again, grants nothing new.
    expect(Number((await one<{ n: number }>('select public.grant_loyalty_rewards($1) as n', [dan])).n)).toBe(0);
    expect(await grants(dan, 'LOYAL50')).toBe(1);

    await expect(evaluate(ben, 'LOYAL50', BOWL)).rejects.toThrow(/not earned yet/);
    const rewarded = await reserve(dan, danAddress, 1, 'LOYAL50');
    expect(rewarded.discount_centavos).toBe(5000);
    await pay(dan, rewarded);
    // Order 3 paid: one grant, one use. No reward left until the next milestone.
    await expect(evaluate(dan, 'LOYAL50', BOWL)).rejects.toThrow(/already used/);
    await pay(dan, await reserve(dan, danAddress, 1));
    expect(await grants(dan, 'LOYAL50')).toBe(2);
    expect((await evaluate(dan, 'LOYAL50', BOWL)).discount_centavos).toBe(5000);
  });

  it('counts spending when the rule is by amount, and ignores orders paid before the rule existed', async () => {
    const eve = await createUser(db, 'eve@example.test');
    const eveAddress = (await one<{ id: string }>(`insert into public.customer_addresses (user_id, recipient_name, phone, line1, city, province, latitude, longitude) values ($1, 'Eve', '09170000000', '12 Mabini Street', 'Malolos', 'Bulacan', 14.8433, 120.8114) returning id`, [eve])).id;
    await pay(eve, await reserve(eve, eveAddress, 5)); // before the rule: must not count
    await voucher('SPEND', { discount_percent: 10, kind: 'loyalty' });
    await db.query(`insert into public.loyalty_rules (name, metric, threshold, reward_code) values ('Every PHP 500 spent', 'spend', 50000, 'SPEND')`);
    await pay(eve, await reserve(eve, eveAddress, 1)); // 12000 + 8000 = 20000
    expect(await grants(eve, 'SPEND')).toBe(0);
    await pay(eve, await reserve(eve, eveAddress, 3)); // 36000 + 8000 = 44000, running total 64000
    expect(await grants(eve, 'SPEND')).toBe(1);
  });
});

describe('access', () => {
  it('lets a customer read only their own redemptions and grants, and change neither', async () => {
    const mine = await asUser(db, ana, tx => tx.query<{ user_id: string }>('select user_id from public.voucher_redemptions'));
    expect(mine.rows.length).toBeGreaterThan(0);
    expect(mine.rows.every(row => row.user_id === ana)).toBe(true);
    await expect(asUser(db, ana, tx => tx.query(`update public.voucher_redemptions set status = 'released'`))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, ana, tx => tx.query(`insert into public.voucher_grants (coupon_id, user_id, reason) select id, $1, 'self-service' from public.coupons limit 1`, [ana]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, ana, tx => tx.query('select * from public.loyalty_rules'))).rejects.toThrow(/permission denied/);
  });

  it('does not let a signed-in customer call the voucher functions directly', async () => {
    await expect(asUser(db, ana, tx => tx.query(`select public.evaluate_voucher($1, 'TEN', 1000, 0)`, [ana]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, ana, tx => tx.query('select public.grant_loyalty_rewards($1)', [ana]))).rejects.toThrow(/permission denied/);
  });
});
