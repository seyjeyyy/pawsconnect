import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { asUser, createDatabase, createUser } from '../helpers/db';

let db: PGlite;
let alice: string, bob: string, admin: string, superAdmin: string;

const rolesOf = async (userId: string) =>
  (await db.query<{ role_name: string }>('select role_name from public.user_roles where user_id = $1 order by role_name', [userId])).rows.map(r => r.role_name);

beforeAll(async () => {
  db = await createDatabase();
  alice = await createUser(db, 'alice@example.test', { full_name: 'Alice Reyes' });
  bob = await createUser(db, 'bob@example.test', { full_name: 'Bob Cruz' });
  admin = await createUser(db, 'admin@example.test', { full_name: 'Shelter Admin' });
  superAdmin = await createUser(db, 'it@example.test', { full_name: 'System Administrator' });
  // Bootstrap the first administrator and super administrator the way the README documents: directly in SQL.
  await db.query(`insert into public.user_roles (user_id, role_name) values ($1, 'administrator'), ($2, 'super_administrator')`, [admin, superAdmin]);
  await db.query(`insert into public.customer_addresses (user_id, recipient_name, phone, line1, city, province) values ($1, 'Bob Cruz', '09170000000', '12 Mabini Street', 'Malolos', 'Bulacan')`, [bob]);
});
afterAll(() => db.close());

describe('registration', () => {
  it('provisions a profile, buyer profile, cart and the community roles', async () => {
    const profile = await db.query<{ full_name: string }>('select full_name from public.profiles where id = $1', [alice]);
    expect(profile.rows[0].full_name).toBe('Alice Reyes');
    expect(await rolesOf(alice)).toEqual(['adopter', 'buyer', 'community_reporter', 'donor']);
    for (const table of ['buyer_profiles', 'adopter_profiles', 'carts']) {
      const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from public.${table} where user_id = $1`, [alice]);
      expect(rows[0].n, table).toBe(1);
    }
  });

  it('ignores roles smuggled in through sign-up metadata', async () => {
    const mallory = await createUser(db, 'mallory@example.test', { full_name: 'Mallory', role: 'administrator', roles: ['administrator', 'shelter_staff'], is_admin: true });
    const roles = await rolesOf(mallory);
    expect(roles).not.toContain('administrator');
    expect(roles).not.toContain('shelter_staff');
  });
});

describe('row level security', () => {
  it('lets a user read only their own profile and addresses', async () => {
    const seen = await asUser(db, alice, async tx => ({
      profiles: (await tx.query<{ id: string }>('select id from public.profiles')).rows.map(r => r.id),
      addresses: (await tx.query('select id from public.customer_addresses')).rows.length,
      roles: (await tx.query<{ user_id: string }>('select distinct user_id from public.user_roles')).rows.map(r => r.user_id),
    }));
    expect(seen.profiles).toEqual([alice]);
    expect(seen.addresses).toBe(0);
    expect(seen.roles).toEqual([alice]);
  });

  it('exposes no account data to anonymous visitors', async () => {
    for (const table of ['profiles', 'user_roles', 'customer_addresses', 'audit_logs', 'notifications']) {
      await expect(asUser(db, null, tx => tx.query(`select * from public.${table}`)), table).rejects.toThrow(/permission denied/);
    }
  });

  it('blocks a user from granting themselves a role', async () => {
    await expect(asUser(db, alice, tx => tx.query(`insert into public.user_roles (user_id, role_name) values ($1, 'administrator')`, [alice]))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, alice, tx => tx.query(`update public.user_roles set role_name = 'administrator' where user_id = $1`, [alice]))).rejects.toThrow(/permission denied/);
    expect(await rolesOf(alice)).not.toContain('administrator');
  });

  it('blocks direct execution of the role RPC, even when a real administrator id is supplied', async () => {
    await expect(asUser(db, alice, tx => tx.query(`select public.assign_user_role($1, $2, 'administrator', true)`, [admin, alice]))).rejects.toThrow(/permission denied/);
    expect(await rolesOf(alice)).not.toContain('administrator');
  });

  it('blocks writing addresses for, or editing the profile of, another user', async () => {
    await expect(asUser(db, alice, tx => tx.query(`insert into public.customer_addresses (user_id, recipient_name, phone, line1, city, province) values ($1, 'X', '09170000000', '1 Elsewhere Road', 'Malolos', 'Bulacan')`, [bob]))).rejects.toThrow(/row-level security/);
    const updated = await asUser(db, alice, tx => tx.query(`update public.profiles set full_name = 'Hacked' where id = $1`, [bob]));
    expect(updated.affectedRows).toBe(0);
    const own = await asUser(db, alice, tx => tx.query(`update public.profiles set phone = '09171234567' where id = $1`, [alice]));
    expect(own.affectedRows).toBe(1);
  });
});

describe('role administration', () => {
  it('rejects role changes requested by a customer or by a shelter administrator', async () => {
    await expect(db.query(`select public.assign_user_role($1, $2, 'shelter_staff', true)`, [alice, alice])).rejects.toThrow(/Super administrator required/);
    // Assigning roles is system administration; running the shelter does not include it.
    await expect(db.query(`select public.assign_user_role($1, $2, 'shelter_staff', true)`, [admin, bob])).rejects.toThrow(/Super administrator required/);
    expect(await rolesOf(bob)).not.toContain('shelter_staff');
  });

  it('lets the super administrator grant and revoke a role, and records both in the audit trail', async () => {
    await db.query(`select public.assign_user_role($1, $2, 'shelter_staff', true)`, [superAdmin, bob]);
    expect(await rolesOf(bob)).toContain('shelter_staff');
    // Staff can now read other profiles through RLS.
    const visible = await asUser(db, bob, tx => tx.query('select id from public.profiles'));
    expect(visible.rows.length).toBeGreaterThan(1);

    await db.query(`select public.assign_user_role($1, $2, 'shelter_staff', false)`, [superAdmin, bob]);
    expect(await rolesOf(bob)).not.toContain('shelter_staff');
    const log = await db.query<{ n: number }>(`select count(*)::int as n from public.audit_logs where action = 'role.changed' and actor_id = $1 and entity_id::text = $2`, [superAdmin, bob]);
    expect(log.rows[0].n).toBe(2);
  });

  it('stops the last holder of an elevated role from being removed, including by themselves', async () => {
    await expect(db.query(`select public.assign_user_role($1, $1, 'super_administrator', false)`, [superAdmin])).rejects.toThrow(/own super administrator role/);
    await expect(db.query(`select public.assign_user_role($1, $2, 'administrator', false)`, [superAdmin, admin])).rejects.toThrow(/last holder/);
    expect(await rolesOf(admin)).toContain('administrator');
  });
});

describe('separation of system administration and shelter operations', () => {
  const holds = async (user: string, role: string) => (await db.query<{ ok: boolean }>('select public.has_role($1, array[$2]) as ok', [user, role])).rows[0].ok;

  it('neither role implies the other', async () => {
    expect(await holds(superAdmin, 'administrator')).toBe(false);
    expect(await holds(admin, 'super_administrator')).toBe(false);
  });

  it('the super administrator cannot run shelter workflows, even calling the database functions directly', async () => {
    await expect(db.query('select public.admin_metrics($1)', [superAdmin])).rejects.toThrow(/Staff role required/);
    await expect(db.query(`select public.adjust_inventory($1, gen_random_uuid(), null, 5, 'Trying to change stock')`, [superAdmin])).rejects.toThrow(/staff role required/i);
    await expect(db.query(`select public.transition_order($1, gen_random_uuid(), 'processing')`, [superAdmin])).rejects.toThrow();
  });

  it('through Supabase directly, the super administrator reads accounts and the audit trail but not shelter records', async () => {
    await db.query(`insert into public.audit_logs (actor_id, action, entity_type) values ($1, 'test.entry', 'test')`, [admin]);
    const seen = await asUser(db, superAdmin, async tx => ({
      profiles: (await tx.query('select id from public.profiles')).rows.length,
      roles: (await tx.query('select distinct user_id from public.user_roles')).rows.length,
      audit: (await tx.query('select id from public.audit_logs')).rows.length,
      addresses: (await tx.query('select id from public.customer_addresses')).rows.length,
    }));
    expect(seen.profiles).toBeGreaterThan(1);
    expect(seen.roles).toBeGreaterThan(1);
    expect(seen.audit).toBeGreaterThan(0);
    expect(seen.addresses).toBe(0);
  });

  it('through Supabase directly, the shelter administrator reads neither other accounts\' roles nor the audit trail', async () => {
    const seen = await asUser(db, admin, async tx => ({
      roles: (await tx.query<{ user_id: string }>('select distinct user_id from public.user_roles')).rows.map(r => r.user_id),
      audit: (await tx.query('select id from public.audit_logs')).rows.length,
      addresses: (await tx.query('select id from public.customer_addresses')).rows.length,
    }));
    expect(seen.roles).toEqual([admin]);
    expect(seen.audit).toBe(0);
    // Still shelter staff: customer delivery addresses are needed to fulfil orders.
    expect(seen.addresses).toBeGreaterThan(0);
  });
});

describe('GeoSmart eligibility (PostGIS)', () => {
  // A small test rectangle around Malolos. Not a real service boundary.
  const zone = JSON.stringify({ type: 'Polygon', coordinates: [[[120.78, 14.82], [120.84, 14.82], [120.84, 14.87], [120.78, 14.87], [120.78, 14.82]]] });
  const check = async (service: string, latitude: number, longitude: number) =>
    (await db.query<{ result: { status: string; eligible: boolean } }>('select public.check_service_eligibility(p_service_type => $1, p_latitude => $2, p_longitude => $3) as result', [service, latitude, longitude])).rows[0].result;

  beforeAll(async () => {
    await db.query(`insert into public.service_zones (name, service_type, province, boundary, source_reference, is_active, created_by)
      values ('Test rescue zone', 'rescue', 'Bulacan', extensions.st_multi(extensions.st_setsrid(extensions.st_geomfromgeojson($1), 4326)), 'automated test fixture', true, $2)`, [zone, admin]);
  });

  it('reports a point inside an active zone as within coverage', async () => {
    expect(await check('rescue', 14.8433, 120.8114)).toMatchObject({ status: 'within_coverage', eligible: true });
  });
  it('reports a point outside every zone as outside coverage', async () => {
    expect(await check('rescue', 14.5995, 120.9842)).toMatchObject({ status: 'outside_coverage', eligible: false });
  });
  it('keeps service types separate: a rescue zone grants no transport coverage', async () => {
    expect(await check('transport', 14.8433, 120.8114)).toMatchObject({ status: 'outside_coverage', eligible: false });
  });
  it('ignores a zone once it is deactivated', async () => {
    await db.query(`update public.service_zones set is_active = false where name = 'Test rescue zone'`);
    expect(await check('rescue', 14.8433, 120.8114)).toMatchObject({ status: 'outside_coverage', eligible: false });
  });
});

describe('privileged RPCs', () => {
  it('are executable by signed-in or anonymous clients only if explicitly allow-listed', async () => {
    const allowed = ['can_read_report', 'can_read_transport', 'check_service_eligibility', 'current_session_allowed', 'has_role', 'is_admin', 'is_staff', 'is_system_admin'];
    const { rows } = await db.query<{ proname: string }>(`
      select distinct p.proname from pg_proc p
      where p.pronamespace = 'public'::regnamespace
        and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute'))
      order by 1`);
    expect(rows.map(r => r.proname)).toEqual(allowed);
  });

  it('cannot be used by a customer to settle their own payment', async () => {
    await expect(asUser(db, alice, tx => tx.query(`select public.settle_payment('evt', 'pay', 'order', gen_random_uuid(), 100, 'PHP', 'paid')`))).rejects.toThrow(/permission denied/);
  });
});
