import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { asUser, createDatabase, createUser } from '../helpers/db';

// The official shelter location is one record. Anyone reads it; only an administrator
// or the super administrator changes it, through one audited function.
let db: PGlite, system: string, admin: string, limitedAdmin: string, staff: string, driver: string, buyer: string;
const row = async (sql: string, args: unknown[] = []) => (await db.query<any>(sql, args)).rows[0];
const update = (actor: string, values: Partial<{ name: string; latitude: number; longitude: number; url: string | null; address: string | null; reason: string }> = {}) =>
  db.query('select * from public.update_shelter_location($1,$2,$3,$4,$5,$6,$7,$8)', [actor, 'PAWSCONNECT_MAIN_SHELTER', values.name ?? 'PawsConnect Animal Shelter', values.latitude ?? 15.017163, values.longitude ?? 120.948071, values.url === undefined ? 'https://maps.app.goo.gl/e6hDczktzrXMntQr9' : values.url, values.address ?? null, values.reason ?? 'Routine correction for the test']);

beforeAll(async () => {
  db = await createDatabase();
  [system, admin, limitedAdmin, staff, driver, buyer] = await Promise.all(['system', 'admin', 'limited', 'staff', 'driver', 'buyer'].map(name => createUser(db, `${name}@shelter-location.test`)));
  await db.query("insert into public.user_roles(user_id,role_name) values($1,'super_administrator'),($2,'administrator'),($3,'administrator'),($4,'shelter_staff'),($5,'shelter_driver')", [system, admin, limitedAdmin, staff, driver]);
  // An administrator whose module assignment no longer includes service zones.
  await db.query("select public.set_staff_access($1,$2,array['animals.view','transport.manage'])", [system, limitedAdmin]);
});
afterAll(() => db?.close());

describe('official shelter location', () => {
  it('starts as the one given record, with no address typed in', async () => {
    const rows = (await db.query<any>('select * from public.shelter_locations')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ code: 'PAWSCONNECT_MAIN_SHELTER', name: 'PawsConnect Animal Shelter', location_type: 'SHELTER', pickup_mode: 'FIXED', latitude: 15.017163, longitude: 120.948071, google_maps_url: 'https://maps.app.goo.gl/e6hDczktzrXMntQr9', formatted_address: null, address_verified_at: null });
  });

  it('can be read by anyone and written directly by no one', async () => {
    for (const reader of [null, buyer, staff, driver, admin]) expect((await asUser(db, reader, tx => tx.query('select code from public.shelter_locations'))).rows, String(reader)).toHaveLength(1);
    for (const writer of [buyer, staff, admin, system]) {
      await expect(asUser(db, writer, tx => tx.query("update public.shelter_locations set latitude=1"))).rejects.toThrow(/permission denied/);
      await expect(asUser(db, writer, tx => tx.query("insert into public.shelter_locations(code,name,latitude,longitude) values('SECOND_SHELTER','Second',1,1)"))).rejects.toThrow(/permission denied/);
      await expect(asUser(db, writer, tx => tx.query('delete from public.shelter_locations'))).rejects.toThrow(/permission denied/);
      await expect(asUser(db, writer, tx => tx.query("select public.update_shelter_location($1,'PAWSCONNECT_MAIN_SHELTER','X name',1,1,null,null,'Called from a browser session')", [writer]))).rejects.toThrow(/permission denied/);
    }
  });

  it('refuses everyone except an administrator with the zones module and the super administrator', async () => {
    for (const actor of [buyer, staff, driver, limitedAdmin]) await expect(update(actor, { latitude: 1, longitude: 1 }), actor).rejects.toThrow(/Administrator role required/);
    expect((await row('select latitude,longitude from public.shelter_locations'))).toEqual({ latitude: 15.017163, longitude: 120.948071 });
    expect((await row("select count(*)::int n from public.audit_logs where action='shelter_location.updated'")).n).toBe(0);
  });

  it('requires a reason and keeps the coordinates within range', async () => {
    await expect(update(admin, { reason: 'x' })).rejects.toThrow(/reason/);
    await expect(update(admin, { latitude: 120 })).rejects.toThrow();
    await expect(update(admin, { url: 'http://example.test/map' })).rejects.toThrow();
  });

  it('records who confirmed the address and writes each change to the audit trail', async () => {
    await update(admin, { address: 'Confirmed test address, Bulacan', reason: 'Address confirmed against the shelter records' });
    const saved = await row('select * from public.shelter_locations');
    expect(saved).toMatchObject({ formatted_address: 'Confirmed test address, Bulacan', address_verified_by: admin, updated_by: admin });
    expect(saved.address_verified_at).toBeTruthy();
    const audit = await row("select * from public.audit_logs where action='shelter_location.updated' order by created_at desc limit 1");
    expect(audit).toMatchObject({ actor_id: admin, entity_type: 'shelter_location', entity_id: saved.id });
    expect(audit.details).toMatchObject({ reason: 'Address confirmed against the shelter records', before: { formatted_address: null, latitude: 15.017163 }, after: { formatted_address: 'Confirmed test address, Bulacan', latitude: 15.017163 } });

    // An unrelated edit keeps the original confirmation.
    await update(system, { name: 'PawsConnect Animal Shelter (Main)', address: 'Confirmed test address, Bulacan' });
    const renamed = await row('select * from public.shelter_locations');
    expect(renamed).toMatchObject({ name: 'PawsConnect Animal Shelter (Main)', address_verified_by: admin, updated_by: system });
    expect(new Date(renamed.address_verified_at).getTime()).toBe(new Date(saved.address_verified_at).getTime());
  });

  it('does not let a confirmed address follow the pin to another place', async () => {
    // Moving the pin while keeping the old text counts as a new confirmation by the person who moved it.
    await update(system, { latitude: 15.02, longitude: 120.95, address: 'Confirmed test address, Bulacan' });
    expect(await row('select address_verified_by from public.shelter_locations')).toEqual({ address_verified_by: system });
    // Moving it with no address leaves the address unconfirmed.
    await update(admin, { latitude: 15.03, longitude: 120.96, address: null });
    expect(await row('select formatted_address,address_verified_at,address_verified_by from public.shelter_locations')).toEqual({ formatted_address: null, address_verified_at: null, address_verified_by: null });
    expect((await row("select count(*)::int n from public.audit_logs where action='shelter_location.updated'")).n).toBe(4);
  });
});
