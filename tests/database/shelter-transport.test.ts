import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { applyMigrations, asUser, createDatabase, createUser } from '../helpers/db';

// Migration 021 on a database that already holds a booking made the old way, with a
// customer-typed pickup. Then the rules for bookings that start at the official shelter.
const BEFORE = '202610120020_shelter_location.sql';
let db: PGlite, admin: string, staff: string, limited: string, system: string, driver: string, customer: string, shelter: string, legacy: string, vehicle: string;
const one = async <T = any>(sql: string, args: unknown[] = []) => (await db.query<T>(sql, args)).rows[0];
// Inside the test zone; the shelter itself (15.017163, 120.948071) is outside it.
const covered = { latitude: 14.85, longitude: 120.82 }, uncovered = { latitude: 14.5, longitude: 121.0 };
const book = (destination: { latitude: number; longitude: number }, extra: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = { user_id: customer, shelter_location_id: shelter, pickup_name: 'PawsConnect Animal Shelter', pickup_address: 'PawsConnect Animal Shelter', pickup_latitude: 15.017163, pickup_longitude: 120.948071, pet_details: 'Bantay — dog, 12 kg.', dropoff_address: '12 Example Street, Example Town, Bulacan', dropoff_latitude: destination.latitude, dropoff_longitude: destination.longitude, preferred_schedule: new Date(Date.now() + 2 * 86_400_000).toISOString(), contact_phone: '+639171234567', route_distance_km: 20.5, route_duration_minutes: 40, ...extra };
  const keys = Object.keys(row);
  return one(`insert into public.transport_requests(${keys.join(',')}) values(${keys.map((_, index) => `$${index + 1}`).join(',')}) returning *`, Object.values(row));
};

beforeAll(async () => {
  db = await createDatabase({ through: BEFORE });
  [admin, staff, limited, system, driver, customer] = await Promise.all(['admin', 'staff', 'limited', 'system', 'driver', 'customer'].map(name => createUser(db, `${name}@shelter-transport.test`)));
  await db.query("insert into public.user_roles(user_id,role_name) values($1,'administrator'),($2,'shelter_staff'),($3,'shelter_staff'),($4,'super_administrator'),($5,'shelter_driver')", [admin, staff, limited, system, driver]);
  await db.query("select public.set_staff_access($1,$2,array['animals.view'])", [system, limited]);
  await db.query(`insert into public.service_zones(name,service_type,province,boundary,source_reference,is_active,created_by)
    values('Test transport boundary','transport','Bulacan',extensions.st_multi(extensions.st_geomfromtext('POLYGON((120.76 14.8, 120.88 14.8, 120.88 14.9, 120.76 14.9, 120.76 14.8))',4326)),'test fixture',true,$1)`, [admin]);
  await db.query("insert into public.shelter_drivers(user_id,license_reference,verified_by,is_active) values($1,'TEST-LICENCE',$2,true)", [driver, admin]);
  vehicle = (await one("insert into public.shelter_vehicles(name,plate_number,animal_capacity,is_active) values('Test van','TST 123',4,true) returning id")).id;
  shelter = (await one("select id from public.shelter_locations where code='PAWSCONNECT_MAIN_SHELTER'")).id;
  // A booking as it existed before: the customer typed the pickup, and both ends are inside the zone.
  legacy = (await one("insert into public.transport_requests(user_id,pet_details,pickup_address,dropoff_address,pickup_latitude,pickup_longitude,dropoff_latitude,dropoff_longitude,preferred_schedule,contact_phone,handling_requirements) values($1,'Old dog in carrier','12 Mabini Street, Malolos','Customer destination',14.84,120.81,14.85,120.82,now()+interval '2 days','0917 000 0000','Keep calm') returning id", [customer])).id;
  await applyMigrations(db, file => file > BEFORE);
});
afterAll(() => db?.close());

describe('upgrading a database that already holds a booking', () => {
  it('leaves the old booking’s pickup, destination and status as they were', async () => {
    const row = await one('select * from public.transport_requests where id=$1', [legacy]);
    expect(row).toMatchObject({ pickup_address: '12 Mabini Street, Malolos', pickup_latitude: 14.84, pickup_longitude: 120.81, dropoff_latitude: 14.85, dropoff_longitude: 120.82, status: 'submitted', coverage_status: 'within_coverage', handling_requirements: 'Keep calm', shelter_location_id: null, pickup_name: null, route_distance_km: null, estimate_total_centavos: null });
    expect(row.reference).toMatch(/^PT-[0-9A-F]{10}$/);
  });
  it('can list bookings whose saved pickup is not the official shelter, for review', async () => {
    const rows = (await db.query<any>("select t.id from public.transport_requests t cross join public.shelter_locations s where s.code='PAWSCONNECT_MAIN_SHELTER' and t.shelter_location_id is null and (t.pickup_latitude<>s.latitude or t.pickup_longitude<>s.longitude)")).rows;
    expect(rows.map(row => row.id)).toEqual([legacy]);
  });
  it('keeps the both-ends rule for the old booking', async () => {
    await db.query('update public.transport_requests set pickup_latitude=14.5,pickup_longitude=121.0 where id=$1', [legacy]);
    expect((await one('select coverage_status from public.transport_requests where id=$1', [legacy])).coverage_status).toBe('outside_coverage');
    await db.query("select public.transition_transport($1,$2,'under_review')", [staff, legacy]);
    await expect(db.query("select public.create_transport_quote($1,$2,50000,'{}',now()+interval '1 day')", [staff, legacy])).rejects.toThrow(/Both locations must be in approved/);
    await db.query('update public.transport_requests set pickup_latitude=14.84,pickup_longitude=120.81 where id=$1', [legacy]);
  });
  it('starts with no pricing and no distance limit, closed to browser sessions', async () => {
    expect(await one('select max_distance_km,base_fee_centavos,rate_per_km_centavos,handling_fees,surcharges from public.transport_settings')).toEqual({ max_distance_km: null, base_fee_centavos: null, rate_per_km_centavos: null, handling_fees: {}, surcharges: [] });
    for (const reader of [customer, staff, admin]) await expect(asUser(db, reader, tx => tx.query('select * from public.transport_settings'))).rejects.toThrow(/permission denied/);
    await expect(asUser(db, admin, tx => tx.query('update public.transport_settings set base_fee_centavos=1'))).rejects.toThrow(/permission denied/);
  });
});

describe('a booking that starts at the official shelter', () => {
  it('is covered when the destination is in a zone, although the shelter itself is not', async () => {
    expect((await one("select public.check_service_eligibility('transport',120.948071,15.017163) as data")).data.eligible).toBe(false);
    const saved = await book(covered);
    expect(saved).toMatchObject({ coverage_status: 'within_coverage', status: 'submitted', shelter_location_id: shelter, route_distance_km: '20.5' });
    expect(saved.reference).toMatch(/^PT-[0-9A-F]{10}$/);
  });
  it('is refused when the destination is outside every zone, or the zone is paused', async () => {
    await expect(book(uncovered)).rejects.toThrow(/outside our delivery area/);
    await db.query("update public.service_zones set availability='temporarily_unavailable' where service_type='transport'");
    await expect(book(covered)).rejects.toThrow(/outside our delivery area/);
    await db.query("update public.service_zones set availability='manual_review' where service_type='transport'");
    // A zone marked for manual review still accepts the request; staff decide.
    expect((await book(covered)).coverage_status).toBe('manual_review_required');
    await db.query("update public.service_zones set availability='available' where service_type='transport'");
  });
  it('is refused beyond the maximum driving distance, when one is set', async () => {
    await db.query('update public.transport_settings set max_distance_km=15');
    await expect(book(covered)).rejects.toThrow(/outside our delivery area/);
    expect((await book(covered, { route_distance_km: 14.9 })).coverage_status).toBe('within_coverage');
    await db.query('update public.transport_settings set max_distance_km=null');
    expect((await book(covered, { route_distance_km: 300 })).coverage_status).toBe('within_coverage');
  });
  it('cannot be created already confirmed, paid or assigned', async () => {
    await expect(book(covered, { status: 'confirmed' })).rejects.toThrow(/staff review/);
    await expect(book(covered, { paid_at: new Date().toISOString() })).rejects.toThrow(/staff review/);
    await expect(book(covered, { driver_id: driver })).rejects.toThrow(/staff review/);
  });
  it('moves forward only through staff and the assigned driver, checking the destination and not the shelter', async () => {
    const saved = await book(covered);
    // The customer cannot review, quote, schedule or deliver their own booking.
    for (const status of ['under_review', 'scheduled', 'picked_up', 'completed']) await expect(db.query('select public.transition_transport($1,$2,$3)', [customer, saved.id, status])).rejects.toThrow(/not permitted/);
    // Staff without the transport module are refused too.
    await expect(db.query("select public.transition_transport($1,$2,'under_review')", [limited, saved.id])).rejects.toThrow(/not permitted/);
    await db.query("select public.transition_transport($1,$2,'under_review')", [staff, saved.id]);
    await expect(db.query("select public.create_transport_quote($1,$2,45000,'{}',now()+interval '1 day')", [limited, saved.id])).rejects.toThrow();
    await db.query("select public.create_transport_quote($1,$2,0,'{}',now()+interval '1 day')", [staff, saved.id]);
    await db.query("select public.transition_transport($1,$2,'confirmed')", [customer, saved.id]);
    // Steps cannot be skipped.
    await expect(db.query("select public.transition_transport($1,$2,'in_transit')", [staff, saved.id])).rejects.toThrow(/not permitted/);
    await db.query("select public.schedule_transport($1,$2,$3,$4,now()+interval '3 days')", [staff, saved.id, driver, vehicle]);
    await expect(db.query("select public.transition_transport($1,$2,'in_transit')", [driver, saved.id])).rejects.toThrow(/not permitted/);
    for (const status of ['picked_up', 'in_transit', 'arrived']) await db.query('select public.transition_transport($1,$2,$3)', [driver, saved.id, status]);
    expect((await one('select status from public.transport_requests where id=$1', [saved.id])).status).toBe('arrived');
    expect((await db.query("select status from public.transport_tracking_events where transport_request_id=$1 order by created_at", [saved.id])).rows.map((row: any) => row.status)).toEqual(expect.arrayContaining(['under_review', 'quoted', 'confirmed', 'scheduled', 'picked_up', 'in_transit', 'arrived']));
  });
  it('stops being schedulable if its destination leaves coverage', async () => {
    const saved = await book(covered);
    await db.query("select public.transition_transport($1,$2,'under_review')", [staff, saved.id]);
    await db.query("update public.service_zones set is_active=false where service_type='transport'");
    await expect(db.query("select public.create_transport_quote($1,$2,0,'{}',now()+interval '1 day')", [staff, saved.id])).rejects.toThrow(/Both locations must be in approved/);
    await db.query("update public.service_zones set is_active=true where service_type='transport'");
  });
  it('keeps its saved pickup when the shelter record is edited later', async () => {
    const saved = await book(covered);
    await db.query("select public.update_shelter_location($1,'PAWSCONNECT_MAIN_SHELTER','Renamed Shelter',15.5,121.5,null,'A new confirmed address, Bulacan','Moved for the test')", [admin]);
    expect(await one('select pickup_name,pickup_address,pickup_latitude,pickup_longitude from public.transport_requests where id=$1', [saved.id])).toEqual({ pickup_name: 'PawsConnect Animal Shelter', pickup_address: 'PawsConnect Animal Shelter', pickup_latitude: 15.017163, pickup_longitude: 120.948071 });
    expect(await one('select pickup_address,pickup_latitude from public.transport_requests where id=$1', [legacy])).toEqual({ pickup_address: '12 Mabini Street, Malolos', pickup_latitude: 14.84 });
  });
  it('is visible to its customer, its assigned driver and staff, and to nobody else', async () => {
    const other = await createUser(db, 'other@shelter-transport.test');
    const mine = (await asUser(db, customer, tx => tx.query('select id from public.transport_requests'))).rows.length;
    expect(mine).toBeGreaterThan(3);
    expect((await asUser(db, other, tx => tx.query('select id from public.transport_requests'))).rows).toHaveLength(0);
    expect((await asUser(db, driver, tx => tx.query('select id from public.transport_requests'))).rows).toHaveLength(1);
    expect((await asUser(db, staff, tx => tx.query('select id from public.transport_requests'))).rows).toHaveLength(mine);
    await expect(asUser(db, customer, tx => tx.query("update public.transport_requests set status='completed'"))).rejects.toThrow(/permission denied/);
  });
});

describe('transport pricing settings', () => {
  const save = (actor: string, values: Partial<{ max: number | null; base: number | null; rate: number | null; reason: string }> = {}) =>
    db.query('select * from public.update_transport_settings($1,$2,$3,$4,$5,$6,$7)', [actor, values.max ?? null, values.base === undefined ? 10000 : values.base, values.rate === undefined ? 1500 : values.rate, JSON.stringify({ species: { dog: 5000 } }), JSON.stringify([{ label: 'Carrier loan', amount_centavos: 4000, when: 'no_carrier' }]), values.reason ?? 'Rates approved for the test']);
  it('can be changed only by an administrator holding the transport module, never from a browser session', async () => {
    for (const actor of [customer, staff, limited, system, driver]) await expect(save(actor), actor).rejects.toThrow(/Administrator role required/);
    await expect(asUser(db, admin, tx => tx.query("select public.update_transport_settings($1,null,1,1,'{}','[]','Called from a browser session')", [admin]))).rejects.toThrow(/permission denied/);
    expect((await one('select base_fee_centavos from public.transport_settings')).base_fee_centavos).toBeNull();
  });
  it('needs a reason and well-formed values', async () => {
    await expect(save(admin, { reason: 'x' })).rejects.toThrow(/reason/);
    await expect(save(admin, { base: -1 })).rejects.toThrow();
    await expect(save(admin, { max: 0 })).rejects.toThrow();
    await expect(db.query("select public.update_transport_settings($1,null,1,1,'[]','[]','Wrong shape for the test')", [admin])).rejects.toThrow(/Invalid pricing settings/);
  });
  it('saves the values and records before and after in the audit trail', async () => {
    await save(admin, { max: 60 });
    expect(await one('select max_distance_km,base_fee_centavos,rate_per_km_centavos,handling_fees,surcharges,updated_by from public.transport_settings')).toEqual({ max_distance_km: '60.0', base_fee_centavos: 10000, rate_per_km_centavos: 1500, handling_fees: { species: { dog: 5000 } }, surcharges: [{ label: 'Carrier loan', amount_centavos: 4000, when: 'no_carrier' }], updated_by: admin });
    const audit = await one("select actor_id,details from public.audit_logs where action='transport_settings.updated' order by created_at desc limit 1");
    expect(audit.actor_id).toBe(admin);
    expect(audit.details).toMatchObject({ reason: 'Rates approved for the test', before: { base_fee_centavos: null, rate_per_km_centavos: null }, after: { base_fee_centavos: 10000, rate_per_km_centavos: 1500, max_distance_km: 60 } });
    // Clearing the values again is a change like any other.
    await save(admin, { base: null, rate: null });
    expect(await one('select base_fee_centavos,rate_per_km_centavos,max_distance_km from public.transport_settings')).toEqual({ base_fee_centavos: null, rate_per_km_centavos: null, max_distance_km: null });
    expect((await one("select count(*)::int n from public.audit_logs where action='transport_settings.updated'")).n).toBe(2);
  });
});
