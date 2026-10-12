import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shelter transport requests. The database, the coverage function and the route service are
// stand-ins; what is asserted is what the API works out for itself and what it saves.
const state = vi.hoisted(() => ({ inserts: [] as Record<string, unknown>[], coverageCalls: [] as Record<string, unknown>[], routes: [] as unknown[][], shelter: {} as Record<string, unknown>, settings: {} as Record<string, unknown>, coverage: 'within_coverage', routeFails: false }));
const customer = '00000000-0000-4000-8000-000000000005', application = '00000000-0000-4000-8000-0000000000c1', adoptedPet = '00000000-0000-4000-8000-0000000000c2';
const official = { id: '00000000-0000-4000-8000-0000000000aa', code: 'PAWSCONNECT_MAIN_SHELTER', name: 'PawsConnect Animal Shelter', latitude: 15.017163, longitude: 120.948071, google_maps_url: null, formatted_address: null, address_verified_at: null, updated_at: '2026-10-12T00:00:00Z' };
const noSettings = { max_distance_km: null, base_fee_centavos: null, rate_per_km_centavos: null, handling_fees: {}, surcharges: [] };
vi.mock('../../server/src/config/env', async original => {
  const actual = await original<typeof import('../../server/src/config/env')>();
  return { ...actual, configured: true };
});
vi.mock('../../server/src/config/supabase', () => ({ db: () => ({
  auth: { getUser: async (token: string) => { const id = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub; return { data: { user: { id, email: 'person@example.org' } }, error: null }; } },
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === 'account_session_allowed') return { data: true, error: null };
    if (name === 'account_permissions') return { data: [], error: null };
    if (name === 'check_service_eligibility') { state.coverageCalls.push(args); return { data: { status: state.coverage, eligible: state.coverage === 'within_coverage', zones: [], fee_centavos: null }, error: null }; }
    return { data: null, error: null };
  },
  from: (table: string) => {
    let inserted: Record<string, unknown> | null = null;
    const answer = () => table === 'user_roles' ? [{ roles: { name: 'buyer' } }] : table === 'shelter_locations' ? state.shelter : table === 'transport_settings' ? state.settings : table === 'adoption_applications' ? { id: application, pet_id: adoptedPet }
      : table === 'transport_requests' ? { id: '00000000-0000-4000-8000-0000000000bb', reference: 'PT-TEST000001', status: 'submitted', coverage_status: state.coverage, ...inserted } : { mode: 'normal', modules: [], disabled_features: [], slow_request_ms: 2000 };
    const builder: any = { select: () => builder, eq: () => builder, single: () => builder, maybeSingle: () => builder, order: () => builder,
      insert: (row: Record<string, unknown>) => { inserted = row; if (table === 'transport_requests') state.inserts.push(row); return builder; },
      then: (resolve: (value: unknown) => void) => Promise.resolve({ data: answer(), error: null }).then(resolve) };
    return builder;
  },
}) }));
vi.mock('../../server/src/integrations/maps', () => ({ maps: {
  route: async (...points: unknown[]) => { state.routes.push(points); if (state.routeFails) throw new Error('route service down'); return { distance_meters: 12_345, duration_seconds: 1_500, geometry: [[15.017163, 120.948071], [14.9, 120.9]] }; },
  reverse: async () => ({ address: 'Example Road, Example Barangay, Example Town, Bulacan', street: 'Example Road', barangay: 'Example Barangay', city: 'Example Town', province: 'Bulacan' }),
} }));
import { createApp } from '../../server/src/app';
import { forgetShelterLocation } from '../../server/src/modules/shelter/location';
import { forgetTransportSettings } from '../../server/src/modules/transport/service';

const app = createApp();
const signedIn = { Authorization: `Bearer test.${Buffer.from(JSON.stringify({ sub: customer, session_id: customer })).toString('base64url')}.test` };
const destination = { dropoff_latitude: 14.9, dropoff_longitude: 120.9 };
const booking = { pet_name: 'Bantay', pet_species: 'dog', pet_weight_kg: 12, has_carrier: true, dropoff_street: '12 Example Street', dropoff_barangay: 'Example Barangay', dropoff_city: 'Example Town', dropoff_province: 'Bulacan', ...destination, preferred_schedule: new Date(Date.now() + 86_400_000).toISOString(), contact_name: 'Ana Example', contact_phone: '+639171234567', destination_confirmed: true, policy_accepted: true };
const submit = (change: Record<string, unknown> = {}) => request(app).post('/api/transport/requests').set(signedIn).send({ ...booking, ...change });
const preview = () => request(app).post('/api/transport/preview').set(signedIn).send({ destination: { latitude: 14.9, longitude: 120.9 } });
beforeEach(() => { Object.assign(state, { inserts: [], coverageCalls: [], routes: [], shelter: { ...official }, settings: { ...noSettings }, coverage: 'within_coverage', routeFails: false }); forgetShelterLocation(); forgetTransportSettings(); });

describe('pickup', () => {
  it('is the official shelter, saved on the booking with the route the server calculated', async () => {
    const saved = await submit().expect(201);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({ user_id: customer, shelter_location_id: official.id, pickup_name: 'PawsConnect Animal Shelter', pickup_address: 'PawsConnect Animal Shelter', pickup_latitude: 15.017163, pickup_longitude: 120.948071, ...destination, route_distance_km: 12.3, route_duration_minutes: 25 });
    expect(state.inserts[0].route_geometry).toHaveLength(2);
    expect(saved.body.data.reference).toBe('PT-TEST000001');
    expect(saved.body.meta.reference).toBe('PT-TEST000001');
  });
  it('ignores pickup values sent straight to the API', async () => {
    await submit({ pickup_address: 'Somewhere else entirely', pickup_latitude: 14.5995, pickup_longitude: 120.9842 }).expect(201);
    expect(state.inserts[0]).toMatchObject({ pickup_address: 'PawsConnect Animal Shelter', pickup_latitude: 15.017163, pickup_longitude: 120.948071 });
    expect(JSON.stringify(state.inserts[0])).not.toContain('Somewhere else');
    expect(state.routes[0][0]).toMatchObject({ latitude: 15.017163, longitude: 120.948071 });
  });
  it('uses the address once an administrator has confirmed it', async () => {
    state.shelter = { ...official, formatted_address: 'Confirmed Road, Confirmed Town, Bulacan', address_verified_at: '2026-10-12T00:00:00Z' };
    await submit().expect(201);
    expect(state.inserts[0]).toMatchObject({ pickup_name: 'PawsConnect Animal Shelter', pickup_address: 'Confirmed Road, Confirmed Town, Bulacan' });
  });
});

describe('what is saved', () => {
  it('keeps each part the customer entered and never a price, status or coverage from the browser', async () => {
    await submit({ handling_requirements: 'Nervous in cars', delivery_instructions: 'Blue gate' }).expect(201);
    expect(state.inserts[0]).toMatchObject({ pet_name: 'Bantay', pet_species: 'dog', pet_weight_kg: 12, has_carrier: true, pet_details: 'Bantay — dog, 12 kg. Customer has a secure carrier.', dropoff_street: '12 Example Street', dropoff_barangay: 'Example Barangay', dropoff_city: 'Example Town', dropoff_province: 'Bulacan', dropoff_address: '12 Example Street, Example Barangay, Example Town, Bulacan', contact_name: 'Ana Example', contact_phone: '+639171234567', handling_requirements: 'Nervous in cars', delivery_instructions: 'Blue gate' });
    expect(Object.keys(state.inserts[0]).filter(key => /fee|status|paid|driver|vehicle|estimate|coverage/.test(key))).toEqual([]);
  });
  it('links the animal from the customer’s own adoption application', async () => {
    await submit({ adoption_application_id: application }).expect(201);
    expect(state.inserts[0]).toMatchObject({ adoption_application_id: application, pet_id: adoptedPet });
  });
  it('needs a signed-in customer, the confirmations, a +63 mobile number, a future schedule and no unknown fields', async () => {
    await request(app).post('/api/transport/requests').send(booking).expect(401);
    await submit({ destination_confirmed: false }).expect(400);
    await submit({ policy_accepted: undefined }).expect(400);
    await submit({ dropoff_latitude: undefined }).expect(400);
    for (const contact_phone of ['09171234567', '+6391712345', '+63917123456789', '+15551234567']) await submit({ contact_phone }).expect(400);
    await submit({ preferred_schedule: new Date(Date.now() - 60_000).toISOString() }).expect(400);
    await submit({ pet_weight_kg: 0 }).expect(400);
    for (const forged of [{ fee_centavos: 1 }, { status: 'paid' }, { coverage_status: 'within_coverage' }, { route_distance_km: 1 }, { estimate_total_centavos: 1 }, { shelter_location_id: official.id }]) await submit(forged).expect(400);
    expect(state.inserts).toEqual([]);
  });
});

describe('coverage', () => {
  it('is decided by the destination alone', async () => {
    await submit().expect(201);
    expect(state.coverageCalls.map(call => [call.p_service_type, call.p_latitude, call.p_longitude])).toEqual([['transport', 14.9, 120.9]]);
  });
  it('blocks a destination outside the delivery area and points to the Alternative request', async () => {
    state.coverage = 'outside_coverage';
    const refused = await submit().expect(409);
    expect(refused.body.error).toMatchObject({ code: 'OUTSIDE_COVERAGE', message: 'This location is outside our delivery area. You can send an Alternative request and our staff will review it.' });
    expect(state.inserts).toEqual([]);
    const shown = await preview().expect(200);
    expect(shown.body.data.coverage).toMatchObject({ status: 'outside_coverage', message: refused.body.error.message });
  });
  it('blocks an area where delivery is paused', async () => {
    state.coverage = 'temporarily_unavailable';
    expect((await submit().expect(409)).body.error.code).toBe('COVERAGE_PAUSED');
    expect(state.inserts).toEqual([]);
  });
  it('blocks a destination beyond the maximum driving distance, when one is set', async () => {
    state.settings = { ...noSettings, max_distance_km: 10 };
    expect((await submit().expect(409)).body.error.code).toBe('OUTSIDE_COVERAGE');
    expect((await preview().expect(200)).body.data.coverage).toMatchObject({ status: 'outside_coverage', reason: 'beyond_max_distance', max_distance_km: 10 });
    expect(state.inserts).toEqual([]);
    forgetTransportSettings(); state.settings = { ...noSettings, max_distance_km: 12.3 };
    await submit().expect(201);
  });
  it('accepts a destination that needs a staff review, without confirming anything', async () => {
    state.coverage = 'manual_review_required';
    await submit().expect(201);
    expect(state.inserts[0]).not.toHaveProperty('status');
    expect((await preview().expect(200)).body.data.coverage).toMatchObject({ status: 'manual_review_required', message: null });
  });
});

describe('route', () => {
  it('is previewed from the shelter with road distance and travel time', async () => {
    await request(app).post('/api/transport/preview').send({ destination: { latitude: 14.9, longitude: 120.9 } }).expect(401);
    const shown = await preview().expect(200);
    expect(shown.body.data).toMatchObject({ origin: { name: 'PawsConnect Animal Shelter', latitude: 15.017163, longitude: 120.948071 }, route: { distance_km: 12.3, duration_minutes: 25 }, coverage: { status: 'within_coverage', message: null }, estimate: null });
    expect(state.routes[0]).toEqual([expect.objectContaining({ latitude: 15.017163, longitude: 120.948071 }), { latitude: 14.9, longitude: 120.9 }]);
    await request(app).post('/api/transport/preview').set(signedIn).send({ origin: { latitude: 1, longitude: 1 }, destination: { latitude: 14.9, longitude: 120.9 } }).expect(400);
  });
  it('that cannot be calculated is an error with no distance, and no booking is saved', async () => {
    state.routeFails = true;
    const failed = await preview().expect(502);
    expect(failed.body.error).toMatchObject({ code: 'ROUTE_UNAVAILABLE', message: 'We couldn’t calculate the route. Please try again.' });
    expect(JSON.stringify(failed.body)).not.toMatch(/distance|duration/);
    await submit().expect(502);
    expect(state.inserts).toEqual([]);
  });
  it('previews from the shelter on the public route too, refusing an origin from the browser', async () => {
    const route = await request(app).post('/api/maps/shelter-route').send({ destination: { latitude: 14.9, longitude: 120.9 } }).expect(200);
    expect(route.body.data).toMatchObject({ distance_meters: 12_345, origin: { name: 'PawsConnect Animal Shelter', latitude: 15.017163, longitude: 120.948071 } });
    await request(app).post('/api/maps/shelter-route').send({ origin: { latitude: 1, longitude: 1 }, destination: { latitude: 14.9, longitude: 120.9 } }).expect(400);
    await request(app).post('/api/geofencing/transport-coverage').send({ origin: { latitude: 1, longitude: 1 }, destination: { latitude: 14.9, longitude: 120.9 } }).expect(200);
    expect(state.coverageCalls.at(-1)).toMatchObject({ p_latitude: 14.9, p_longitude: 120.9 });
  });
  it('gives the address parts for a point picked on the map', async () => {
    const place = await request(app).get('/api/maps/reverse?latitude=14.9&longitude=120.9').expect(200);
    expect(place.body.data).toMatchObject({ street: 'Example Road', barangay: 'Example Barangay', city: 'Example Town', province: 'Bulacan' });
    await request(app).get('/api/maps/reverse?latitude=140&longitude=120.9').expect(400);
  });
});
