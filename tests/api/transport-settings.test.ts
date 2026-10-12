import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Transport pricing: who may read and change it, and how it reaches the customer's estimate
// and the saved booking. The database and the route service are stand-ins; the amounts are test inputs.
const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, updates: [] as Record<string, unknown>[], inserts: [] as Record<string, unknown>[] }));
const accounts: Record<string, { id: string; permissions: string[] }> = {
  administrator: { id: '00000000-0000-4000-8000-000000000002', permissions: ['transport.manage', 'zones.manage'] },
  shelter_staff: { id: '00000000-0000-4000-8000-000000000003', permissions: ['transport.manage'] },
  super_administrator: { id: '00000000-0000-4000-8000-000000000001', permissions: [] },
  shelter_driver: { id: '00000000-0000-4000-8000-000000000004', permissions: ['transport.assigned'] },
  buyer: { id: '00000000-0000-4000-8000-000000000005', permissions: [] },
};
const roleOf = (id: string) => Object.keys(accounts).find(role => accounts[role].id === id)!;
const unset = { max_distance_km: null, base_fee_centavos: null, rate_per_km_centavos: null, handling_fees: {}, surcharges: [], updated_at: '2026-10-12T00:00:00Z' };
const priced = { ...unset, base_fee_centavos: 10_000, rate_per_km_centavos: 1_500, handling_fees: { species: { dog: 5_000, cat: null, other: null }, size: { small_max_kg: null, medium_max_kg: null, small: null, medium: null, large: null } }, surcharges: [{ label: 'Carrier loan', amount_centavos: 4_000, when: 'no_carrier' }] };
vi.mock('../../server/src/config/env', async original => {
  const actual = await original<typeof import('../../server/src/config/env')>();
  return { ...actual, configured: true };
});
vi.mock('../../server/src/config/supabase', () => ({ db: () => ({
  auth: { getUser: async (token: string) => { const id = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub; return { data: { user: { id, email: `${roleOf(id)}@example.org` } }, error: null }; } },
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === 'account_session_allowed') return { data: true, error: null };
    if (name === 'account_permissions') return { data: accounts[roleOf(String(args.p_user_id))].permissions, error: null };
    if (name === 'check_service_eligibility') return { data: { status: 'within_coverage', eligible: true, zones: [], fee_centavos: null }, error: null };
    if (name === 'update_transport_settings') { state.updates.push(args); return { data: { ...state.settings }, error: null }; }
    return { data: null, error: null };
  },
  from: (table: string) => {
    let user = '', inserted: Record<string, unknown> | null = null;
    const builder: any = { select: () => builder, eq: (column: string, value: string) => { if (column === 'user_id') user = value; return builder; }, single: () => builder, maybeSingle: () => builder, order: () => builder,
      insert: (row: Record<string, unknown>) => { inserted = row; if (table === 'transport_requests') state.inserts.push(row); return builder; },
      then: (resolve: (value: unknown) => void) => Promise.resolve({ data: table === 'user_roles' ? [{ roles: { name: roleOf(user) } }] : table === 'transport_settings' ? state.settings
        : table === 'shelter_locations' ? { id: '00000000-0000-4000-8000-0000000000aa', code: 'PAWSCONNECT_MAIN_SHELTER', name: 'PawsConnect Animal Shelter', latitude: 15.017163, longitude: 120.948071, google_maps_url: null, formatted_address: null }
        : table === 'transport_requests' ? { id: '00000000-0000-4000-8000-0000000000bb', reference: 'PT-TEST000001', status: 'submitted', coverage_status: 'within_coverage', ...inserted } : { mode: 'normal', modules: [], disabled_features: [], slow_request_ms: 2000 }, error: null }).then(resolve) };
    return builder;
  },
}) }));
vi.mock('../../server/src/integrations/maps', () => ({ maps: { route: async () => ({ distance_meters: 18_400, duration_seconds: 2_220, geometry: [] }) } }));
import { createApp } from '../../server/src/app';
import { forgetShelterLocation } from '../../server/src/modules/shelter/location';
import { forgetTransportSettings } from '../../server/src/modules/transport/service';

const app = createApp();
const as = (role: string) => ({ Authorization: `Bearer test.${Buffer.from(JSON.stringify({ sub: accounts[role].id, session_id: accounts[role].id })).toString('base64url')}.test` });
const change = { max_distance_km: 60, base_fee_centavos: 10_000, rate_per_km_centavos: 1_500, handling_fees: { species: { dog: 5_000, cat: null, other: null }, size: { small_max_kg: 10, medium_max_kg: 25, small: null, medium: 2_000, large: 6_000 } }, surcharges: [{ label: 'Carrier loan', amount_centavos: 4_000, when: 'no_carrier' }], reason: 'Rates approved by the shelter' };
const booking = { pet_name: 'Bantay', pet_species: 'dog', pet_weight_kg: 12, has_carrier: false, dropoff_street: '12 Example Street', dropoff_barangay: 'Example Barangay', dropoff_city: 'Example Town', dropoff_province: 'Bulacan', dropoff_latitude: 14.9, dropoff_longitude: 120.9, preferred_schedule: new Date(Date.now() + 86_400_000).toISOString(), contact_name: 'Ana Example', contact_phone: '+639171234567', destination_confirmed: true, policy_accepted: true };
const preview = (pet?: Record<string, unknown>) => request(app).post('/api/transport/preview').set(as('buyer')).send({ destination: { latitude: 14.9, longitude: 120.9 }, ...(pet ? { pet } : {}) });
beforeEach(() => { state.settings = { ...unset }; state.updates = []; state.inserts = []; forgetShelterLocation(); forgetTransportSettings(); });

describe('transport pricing settings', () => {
  it('can be read by staff with the transport module and by no one outside shelter operations', async () => {
    await request(app).get('/api/admin/transport-settings').expect(401);
    for (const role of ['administrator', 'shelter_staff']) expect((await request(app).get('/api/admin/transport-settings').set(as(role)).expect(200)).body.data).toMatchObject({ base_fee_centavos: null, rate_per_km_centavos: null, surcharges: [] });
    for (const role of ['super_administrator', 'shelter_driver', 'buyer']) await request(app).get('/api/admin/transport-settings').set(as(role)).expect(403);
  });
  it('can be changed only by an administrator', async () => {
    for (const role of ['shelter_staff', 'super_administrator', 'shelter_driver', 'buyer']) await request(app).put('/api/admin/transport-settings').set(as(role)).send(change).expect(403);
    expect(state.updates).toEqual([]);
    await request(app).put('/api/admin/transport-settings').set(as('administrator')).send(change).expect(200);
    expect(state.updates).toEqual([{ p_actor_id: accounts.administrator.id, p_max_distance_km: 60, p_base_fee_centavos: 10_000, p_rate_per_km_centavos: 1_500, p_handling_fees: change.handling_fees, p_surcharges: change.surcharges, p_reason: 'Rates approved by the shelter' }]);
  });
  it('rejects a change with no reason, negative or fractional money, size limits out of order, or unknown fields', async () => {
    const send = (body: Record<string, unknown>) => request(app).put('/api/admin/transport-settings').set(as('administrator')).send(body);
    await send({ ...change, reason: ' ' }).expect(400);
    await send({ ...change, base_fee_centavos: -1 }).expect(400);
    await send({ ...change, rate_per_km_centavos: 12.5 }).expect(400);
    await send({ ...change, max_distance_km: 0 }).expect(400);
    await send({ ...change, handling_fees: { ...change.handling_fees, size: { ...change.handling_fees.size, small_max_kg: 30 } } }).expect(400);
    await send({ ...change, surcharges: [{ label: 'x', amount_centavos: 100, when: 'sometimes' }] }).expect(400);
    await send({ ...change, updated_by: accounts.buyer.id }).expect(400);
    expect(state.updates).toEqual([]);
  });
});

describe('estimate', () => {
  it('is absent while pricing is not set up, on the preview and on the saved booking', async () => {
    expect((await preview({ species: 'dog', weight_kg: 12, has_carrier: false }).expect(200)).body.data.estimate).toBeNull();
    await request(app).post('/api/transport/requests').set(as('buyer')).send(booking).expect(201);
    expect(state.inserts[0]).toMatchObject({ estimate_breakdown: null, estimate_total_centavos: null });
  });
  it('is calculated by the server from the road distance and the configured rates', async () => {
    state.settings = { ...priced };
    const shown = (await preview({ species: 'dog', weight_kg: 12, has_carrier: false }).expect(200)).body.data.estimate;
    expect(shown.lines).toEqual([{ label: 'Base fee', amount_centavos: 10_000 }, { label: 'Distance: 18.4 km × ₱15.00 per km', amount_centavos: 27_600 }, { label: 'Handling: dog', amount_centavos: 5_000 }, { label: 'Carrier loan', amount_centavos: 4_000 }]);
    expect(shown.total_centavos).toBe(46_600);
    // With a carrier the surcharge does not apply.
    expect((await preview({ species: 'dog', weight_kg: 12, has_carrier: true }).expect(200)).body.data.estimate.total_centavos).toBe(42_600);
  });
  it('is saved on the booking as the server calculated it, whatever the browser sends', async () => {
    state.settings = { ...priced };
    await request(app).post('/api/transport/requests').set(as('buyer')).send({ ...booking, estimate_total_centavos: 1 }).expect(400);
    await request(app).post('/api/transport/requests').set(as('buyer')).send(booking).expect(201);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({ estimate_total_centavos: 46_600, route_distance_km: 18.4 });
    expect((state.inserts[0].estimate_breakdown as any).lines).toHaveLength(4);
    // The estimate is not the price: nothing sets the fee at this point.
    expect(state.inserts[0]).not.toHaveProperty('fee_centavos');
  });
});
