import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The staff and driver transport routes over a small in-memory stand-in for the database:
// who may open a booking, what each is shown, and who may write staff notes.
const ids = { staff: '00000000-0000-4000-8000-000000000003', driver: '00000000-0000-4000-8000-000000000004', otherDriver: '00000000-0000-4000-8000-000000000014', vet: '00000000-0000-4000-8000-000000000006', customer: '00000000-0000-4000-8000-000000000005', otherCustomer: '00000000-0000-4000-8000-000000000015', booking: '0b6f2f0e-6a3c-4d0e-9d55-3f2b1c7a9e10', unassigned: '0b6f2f0e-6a3c-4d0e-9d55-3f2b1c7a9e11', vehicle: '0b6f2f0e-6a3c-4d0e-9d55-3f2b1c7a9e12' };
const accounts: Record<string, { role: string; permissions: string[]; name: string }> = {
  [ids.staff]: { role: 'shelter_staff', permissions: ['transport.manage'], name: 'Sam Staff' }, [ids.driver]: { role: 'shelter_driver', permissions: ['transport.assigned'], name: 'Dana Driver' },
  [ids.otherDriver]: { role: 'shelter_driver', permissions: ['transport.assigned'], name: 'Other Driver' }, [ids.vet]: { role: 'veterinarian', permissions: ['animals.view', 'animals.health'], name: 'Vic Vet' },
  [ids.customer]: { role: 'buyer', permissions: [], name: 'Cara Customer' }, [ids.otherCustomer]: { role: 'buyer', permissions: [], name: 'Someone Else' },
};
const state = vi.hoisted(() => ({ tables: {} as Record<string, Record<string, unknown>[]>, filters: [] as string[] }));
const booking = (id: string, extra: Record<string, unknown> = {}) => ({ id, reference: `PT-${id.slice(-4).toUpperCase()}`, user_id: ids.customer, driver_id: null, vehicle_id: null, status: 'scheduled', coverage_status: 'within_coverage', pet_details: 'Bantay — dog, 12 kg.', dropoff_address: '12 Example Street', preferred_schedule: '2030-01-15T02:00:00Z', fee_centavos: 45_000, paid_at: '2026-10-12T05:00:00Z', estimate_breakdown: { lines: [] }, estimate_total_centavos: 40_000, fuel_cost_centavos: 0, staff_cost_centavos: 0, other_cost_centavos: 0, created_at: '2026-10-12T02:00:00Z', ...extra });
vi.mock('../../server/src/config/env', async original => {
  const actual = await original<typeof import('../../server/src/config/env')>();
  return { ...actual, configured: true };
});
vi.mock('../../server/src/config/supabase', () => ({ db: () => ({
  auth: { getUser: async (token: string) => { const id = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub; return { data: { user: { id, email: 'person@example.org' } }, error: null }; } },
  rpc: async (name: string, args: Record<string, unknown>) => ({ data: name === 'account_session_allowed' ? true : name === 'account_permissions' ? accounts[String(args.p_user_id)].permissions : null, error: null }),
  from: (table: string) => {
    let rows = [...(state.tables[table] ?? [])], one = false, inserted: Record<string, unknown> | null = null, roleFor = '';
    const builder: any = {
      select: () => builder, order: () => builder, range: () => builder,
      eq: (column: string, value: unknown) => { if (table === 'user_roles') roleFor = String(value); state.filters.push(`${table}.${column}`); rows = rows.filter(row => row[column] === value); return builder; },
      in: (column: string, values: unknown[]) => { rows = rows.filter(row => values.includes(row[column])); return builder; },
      or: (expression: string) => { state.filters.push(`${table}.or:${expression}`); return builder; }, ilike: () => builder,
      gte: (column: string) => { state.filters.push(`${table}.gte:${column}`); return builder; }, lt: (column: string) => { state.filters.push(`${table}.lt:${column}`); return builder; },
      single: () => { one = true; return builder; }, maybeSingle: () => { one = true; return builder; },
      insert: (row: Record<string, unknown>) => { inserted = { id: 'new-note', created_at: '2026-10-12T06:00:00Z', ...row }; (state.tables[table] ??= []).push(inserted); return builder; },
      then: (resolve: (value: unknown) => void) => Promise.resolve(
        table === 'user_roles' ? { data: [{ roles: { name: accounts[roleFor].role } }], error: null }
        : inserted ? { data: inserted, error: null }
        : !(table in state.tables) ? { data: { mode: 'normal', modules: [], disabled_features: [], slow_request_ms: 2000 }, error: null }
        : one ? (rows[0] ? { data: rows[0], error: null } : { data: null, error: null }) : { data: rows, error: null, count: rows.length }).then(resolve),
    };
    return builder;
  },
}) }));
import { createApp } from '../../server/src/app';

const app = createApp();
const as = (id: string) => ({ Authorization: `Bearer test.${Buffer.from(JSON.stringify({ sub: id, session_id: id })).toString('base64url')}.test` });
beforeEach(() => {
  state.filters = [];
  state.tables = {
    transport_requests: [booking(ids.booking, { driver_id: ids.driver, vehicle_id: ids.vehicle }), booking(ids.unassigned, { status: 'under_review' })],
    transport_tracking_events: [{ id: 'e1', transport_request_id: ids.booking, status: 'scheduled', notes: 'Morning trip', actor_id: ids.staff, created_at: '2026-10-12T04:00:00Z' }],
    transport_handovers: [], transport_quotes: [{ id: 'q1', transport_request_id: ids.booking, amount_centavos: 45_000, breakdown: {}, expires_at: '2026-10-20T00:00:00Z', accepted_at: '2026-10-12T04:30:00Z', created_at: '2026-10-12T04:10:00Z' }],
    transport_internal_notes: [{ id: 'n1', transport_request_id: ids.booking, note: 'Customer asked for a discount; declined.', author_id: ids.staff, created_at: '2026-10-12T04:20:00Z' }],
    shelter_vehicles: [{ id: ids.vehicle, name: 'Shelter van', plate_number: 'TST 123' }],
    profiles: Object.entries(accounts).map(([id, account]) => ({ id, full_name: account.name })),
  };
});

describe('opening one booking', () => {
  it('gives staff everything: customer, price, quotation, history with names and staff notes', async () => {
    const data = (await request(app).get(`/api/admin/transport/${ids.booking}`).set(as(ids.staff)).expect(200)).body.data;
    expect(data).toMatchObject({ reference: 'PT-9E10', customer_name: 'Cara Customer', driver_name: 'Dana Driver', vehicle: { name: 'Shelter van', plate_number: 'TST 123' }, fee_centavos: 45_000, estimate_total_centavos: 40_000 });
    expect(data.quotes).toHaveLength(1);
    expect(data.history).toEqual([{ id: 'e1', status: 'scheduled', notes: 'Morning trip', created_at: '2026-10-12T04:00:00Z', actor_name: 'Sam Staff' }]);
    expect(data.internal_notes).toEqual([{ id: 'n1', note: 'Customer asked for a discount; declined.', created_at: '2026-10-12T04:20:00Z', author_name: 'Sam Staff' }]);
  });
  it('gives the assigned driver the trip and the contact, and nothing about money or staff notes', async () => {
    const data = (await request(app).get(`/api/admin/transport/${ids.booking}`).set(as(ids.driver)).expect(200)).body.data;
    expect(data).toMatchObject({ reference: 'PT-9E10', customer_name: 'Cara Customer', dropoff_address: '12 Example Street', vehicle: { name: 'Shelter van' } });
    expect(Object.keys(data).filter(key => /fee|paid|estimate|cost|quote|internal/.test(key))).toEqual([]);
    expect(JSON.stringify(data)).not.toContain('discount');
    expect(data.history[0]).not.toHaveProperty('actor_name');
  });
  it('refuses a driver a booking that is not theirs, and other field roles entirely', async () => {
    await request(app).get(`/api/admin/transport/${ids.booking}`).set(as(ids.otherDriver)).expect(404);
    await request(app).get(`/api/admin/transport/${ids.unassigned}`).set(as(ids.driver)).expect(404);
    await request(app).get(`/api/admin/transport/${ids.booking}`).set(as(ids.vet)).expect(403);
    await request(app).get(`/api/admin/transport/${ids.booking}`).set(as(ids.customer)).expect(403);
    await request(app).get(`/api/admin/transport/${ids.booking}`).expect(401);
  });
  it('gives the customer their own booking with price and history, without staff notes, and nobody else’s', async () => {
    const data = (await request(app).get(`/api/transport/requests/${ids.booking}`).set(as(ids.customer)).expect(200)).body.data;
    expect(data).toMatchObject({ reference: 'PT-9E10', fee_centavos: 45_000, driver_name: 'Dana Driver' });
    expect(data.quotes).toHaveLength(1);
    expect(data).not.toHaveProperty('internal_notes');
    expect(data).not.toHaveProperty('customer_name');
    expect(JSON.stringify(data)).not.toContain('discount');
    await request(app).get(`/api/transport/requests/${ids.booking}`).set(as(ids.otherCustomer)).expect(404);
  });
});

describe('staff notes', () => {
  it('can be added by staff and by nobody else', async () => {
    const path = `/api/admin/transport/${ids.booking}/notes`;
    for (const who of [ids.driver, ids.vet, ids.customer]) await request(app).post(path).set(as(who)).send({ note: 'Should not be saved' }).expect(403);
    expect(state.tables.transport_internal_notes).toHaveLength(1);
    await request(app).post(path).set(as(ids.staff)).send({ note: ' ' }).expect(400);
    await request(app).post(path).set(as(ids.staff)).send({ note: 'Gate code confirmed by phone.', author_id: ids.driver }).expect(400);
    await request(app).post(path).set(as(ids.staff)).send({ note: 'Gate code confirmed by phone.' }).expect(201);
    expect(state.tables.transport_internal_notes.at(-1)).toMatchObject({ transport_request_id: ids.booking, author_id: ids.staff, note: 'Gate code confirmed by phone.' });
  });
});

describe('the list', () => {
  it('shows a driver only their own jobs, without prices', async () => {
    const jobs = (await request(app).get('/api/admin/transport').set(as(ids.driver)).expect(200)).body.data;
    expect(jobs.map((job: { id: string }) => job.id)).toEqual([ids.booking]);
    expect(Object.keys(jobs[0]).filter(key => /fee|paid|estimate_total/.test(key))).toEqual([]);
    expect((await request(app).get('/api/admin/transport').set(as(ids.otherDriver)).expect(200)).body.data).toEqual([]);
  });
  it('filters by status, coverage, day and search for staff', async () => {
    const jobs = (await request(app).get('/api/admin/transport?status=under_review&coverage=within_coverage&date=2030-01-15&q=PT-9').set(as(ids.staff)).expect(200)).body.data;
    expect(jobs.map((job: { id: string }) => job.id)).toEqual([ids.unassigned]);
    expect(jobs[0]).toHaveProperty('fee_centavos');
    expect(state.filters).toEqual(expect.arrayContaining(['transport_requests.status', 'transport_requests.coverage_status', 'transport_requests.gte:preferred_schedule', 'transport_requests.lt:preferred_schedule', expect.stringContaining('reference.ilike.%PT-9%')]));
    await request(app).get('/api/admin/transport?coverage=anything').set(as(ids.staff)).expect(400);
    await request(app).get('/api/admin/transport?date=15-01-2030').set(as(ids.staff)).expect(400);
  });
});
