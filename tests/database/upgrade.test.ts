import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyMigrations, createDatabase, createUser } from '../helpers/db';

// The live database was at migration 008 and already held orders, payments,
// pets and applications when migrations 009-013 were written. This rebuilds
// that situation and applies them on top, so an upgrade that only works on an
// empty database is caught here.
const LAST_APPLIED = '202610100008_stripe_provider.sql';

describe('upgrading a populated database from 008', () => {
  it('applies 009-013 without losing or misclassifying existing records', async () => {
    const db = await createDatabase({ through: LAST_APPLIED });
    const one = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0];

    // --- data as it existed before the upgrade ---
    const admin = await createUser(db, 'admin@example.test');
    const buyer = await createUser(db, 'buyer@example.test');
    await db.query(`insert into public.user_roles (user_id, role_name) values ($1, 'administrator')`, [admin]);
    await db.query(`insert into public.service_zones (name, service_type, province, boundary, source_reference, is_active, fee_centavos, created_by)
      values ('Test delivery zone', 'delivery', 'Bulacan', extensions.st_multi(extensions.st_geomfromtext('POLYGON((120.78 14.82, 120.84 14.82, 120.84 14.87, 120.78 14.87, 120.78 14.82))', 4326)), 'test fixture', true, 8000, $1)`, [admin]);
    const product = (await one<{ id: string }>(`insert into public.products (name, slug, price_centavos, cost_centavos, stock_quantity, is_published) values ('Bowl', 'bowl', 12000, 7000, 10, true) returning id`)).id;
    const address = (await one<{ id: string }>(`insert into public.customer_addresses (user_id, recipient_name, phone, line1, city, province, latitude, longitude) values ($1, 'Buyer', '09170000000', '12 Mabini Street', 'Malolos', 'Bulacan', 14.8433, 120.8114) returning id`, [buyer])).id;
    const order = (await one<{ o: { id: string; total_centavos: number } }>(`select to_jsonb(public.reserve_order($1, $2::jsonb, $3, null)) as o`, [buyer, JSON.stringify([{ product_id: product, quantity: 2 }]), address])).o;
    await db.query(`insert into public.payment_transactions (user_id, resource_type, resource_id, amount_centavos, provider, provider_checkout_id, checkout_url) values ($1, 'order', $2, $3, 'stripe', 'cs_test_existing123', 'https://checkout.example.test')`, [buyer, order.id, order.total_centavos]);
    await db.query(`select public.settle_payment('evt_before', 'pi_before', 'order', $1, $2, 'PHP', 'paid')`, [order.id, order.total_centavos]);
    const pet = (await one<{ id: string }>(`insert into public.pets (name, species, sex, size, status, is_published) values ('Bantay', 'dog', 'male', 'medium', 'available', true) returning id`)).id;
    await db.query(`insert into public.adoption_applications (user_id, pet_id, motivation) values ($1, $2, 'We would like to give Bantay a calm home.')`, [buyer, pet]);
    await db.query(`insert into public.contact_messages (name, email, message) values ('Visitor', 'visitor@example.test', 'Hello, are weekend visits possible?')`);
    const before = await one<{ orders: number; payments: number; applications: number; notifications: number; audit: number }>(`select
      (select count(*)::int from public.orders) as orders, (select count(*)::int from public.payment_transactions) as payments,
      (select count(*)::int from public.adoption_applications) as applications, (select count(*)::int from public.notifications) as notifications,
      (select count(*)::int from public.audit_logs) as audit`);

    // --- the upgrade ---
    await applyMigrations(db, file => file > LAST_APPLIED);

    // Nothing was removed.
    const after = await one<typeof before>(`select
      (select count(*)::int from public.orders) as orders, (select count(*)::int from public.payment_transactions) as payments,
      (select count(*)::int from public.adoption_applications) as applications, (select count(*)::int from public.notifications) as notifications,
      (select count(*)::int from public.audit_logs) as audit`);
    expect(after).toEqual(before);

    // The existing Stripe sandbox payment is classified as a test payment, and the order stays paid.
    expect(await one(`select livemode, status from public.payment_transactions where provider_checkout_id = 'cs_test_existing123'`)).toEqual({ livemode: false, status: 'paid' });
    expect((await one<{ status: string }>('select status from public.orders where id = $1', [order.id])).status).toBe('paid');

    // New derived column is correct for existing stock (10 in stock, 2 sold).
    expect(await one(`select stock_quantity, reserved_quantity, available_quantity from public.products where id = $1`, [product])).toEqual({ stock_quantity: 8, reserved_quantity: 0, available_quantity: 8 });

    // Reports no longer count sandbox payments as revenue, and say so.
    const metrics = (await one<{ m: Record<string, number | string> }>(`select public.admin_metrics($1) as m`, [admin])).m;
    expect(metrics).toMatchObject({ store_revenue_centavos: 0, gross_receipts_centavos: 0, test_payments: 1, verified_payments: 0, total_orders: 1 });

    // The existing administrator keeps working, and the new top role exists but nobody holds it yet.
    expect((await one<{ ok: boolean }>(`select public.has_role($1, array['administrator']) as ok`, [admin])).ok).toBe(true);
    expect((await one<{ n: number }>(`select count(*)::int as n from public.user_roles where role_name = 'super_administrator'`)).n).toBe(0);
    await db.close();
  });

  it('the combined file given to the operator is exactly migrations 009-013, in one transaction', () => {
    // supabase/APPLY_009_TO_013.sql is generated for pasting into the SQL editor and is not committed.
    // If it exists locally, it must not have drifted from the migration files it was built from.
    let combined: string;
    try { combined = readFileSync(new URL('../../supabase/APPLY_009_TO_013.sql', import.meta.url), 'utf8'); } catch { return; }
    const normalise = (text: string) => text.replace(/\r\n/g, '\n');
    expect(normalise(combined)).toMatch(/^(--.*\n)+begin;\n/);
    expect(normalise(combined).trimEnd().endsWith('commit;')).toBe(true);
    for (const file of ['202610110009_connected_data.sql', '202610110010_workflow_integrity.sql', '202610110011_security_operations.sql', '202610110012_atomic_submissions.sql', '202610110013_payment_environment.sql']) {
      const source = normalise(readFileSync(new URL(`../../supabase/migrations/${file}`, import.meta.url), 'utf8'));
      expect(normalise(combined), file).toContain(source);
    }
  });
});

it('upgrades a populated 014 database to 016 without changing users, access or customer records',async()=>{
 const previous='202610110014_separate_system_and_shelter_roles.sql';
 const db=await createDatabase({through:previous});
 try{
  const buyer=await createUser(db,'upgrade-buyer@test.local');
  const operator=await createUser(db,'upgrade-operator@test.local');
  await db.query("insert into user_roles(user_id,role_name) values($1,'super_administrator')",[operator]);
  await db.query("insert into customer_addresses(user_id,recipient_name,phone,line1,city,province) values($1,'Upgrade fixture','09000000000','Fixture address','Malolos','Bulacan')",[buyer]);
  const snapshot=async()=>({
   users:(await db.query('select * from profiles order by id')).rows,
   roles:(await db.query('select * from user_roles order by user_id,role_name')).rows,
   addresses:(await db.query('select * from customer_addresses order by id')).rows,
   audit:(await db.query('select * from audit_logs order by id')).rows,
  });
  const before=await snapshot();
  await applyMigrations(db,file=>file>previous);
  expect(await snapshot()).toEqual(before);
  expect((await db.query("select mode,schema_version from operations_config")).rows).toEqual([{mode:'normal',schema_version:'016'}]);
  expect((await db.query('select * from account_access_controls')).rows).toEqual([]);
  expect((await db.query('select public.account_session_allowed($1,$1) allowed',[buyer])).rows).toEqual([{allowed:true}]);
 }finally{await db.close();}
});
