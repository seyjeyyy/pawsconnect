import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shelter transport always starts at the official shelter. The database, the coverage
// function and the route service are stand-ins; what is asserted is what the API sends them.
const state = vi.hoisted(() => ({ inserts: [] as Record<string, unknown>[], coverage: [] as Record<string, unknown>[], routes: [] as unknown[][], shelter: {} as Record<string, unknown> }));
const customer = '00000000-0000-4000-8000-000000000005';
const official = { id: '00000000-0000-4000-8000-0000000000aa', code: 'PAWSCONNECT_MAIN_SHELTER', name: 'PawsConnect Animal Shelter', latitude: 15.017163, longitude: 120.948071, google_maps_url: null, formatted_address: null, address_verified_at: null, updated_at: '2026-10-12T00:00:00Z' };
vi.mock('../../server/src/config/env', async original => {
  const actual = await original<typeof import('../../server/src/config/env')>();
  return { ...actual, configured: true };
});
vi.mock('../../server/src/config/supabase', () => ({ db: () => ({
  auth: { getUser: async (token: string) => { const id = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub; return { data: { user: { id, email: 'person@example.org' } }, error: null }; } },
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === 'account_session_allowed') return { data: true, error: null };
    if (name === 'account_permissions') return { data: [], error: null };
    if (name === 'check_service_eligibility') { state.coverage.push(args); return { data: { status: 'outside_coverage', eligible: false, zones: [], fee_centavos: null }, error: null }; }
    return { data: null, error: null };
  },
  from: (table: string) => {
    let inserted: Record<string, unknown> | null = null;
    const builder: any = { select: () => builder, eq: () => builder, single: () => builder, maybeSingle: () => builder, order: () => builder,
      insert: (row: Record<string, unknown>) => { inserted = row; if (table === 'transport_requests') state.inserts.push(row); return builder; },
      then: (resolve: (value: unknown) => void) => Promise.resolve({ data: table === 'user_roles' ? [{ roles: { name: 'buyer' } }] : table === 'shelter_locations' ? state.shelter : table === 'transport_requests' ? { id: '00000000-0000-4000-8000-0000000000bb', status: 'submitted', coverage_status: 'manual_review_required', ...inserted } : { mode: 'normal', modules: [], disabled_features: [], slow_request_ms: 2000 }, error: null }).then(resolve) };
    return builder;
  },
}) }));
vi.mock('../../server/src/integrations/maps', () => ({ maps: { route: async (...points: unknown[]) => { state.routes.push(points); return { distance_meters: 12_345, duration_seconds: 1_500, geometry: [] }; } } }));
import { createApp } from '../../server/src/app';
import { forgetShelterLocation } from '../../server/src/modules/shelter/location';

const app = createApp();
const signedIn = { Authorization: `Bearer test.${Buffer.from(JSON.stringify({ sub: customer, session_id: customer })).toString('base64url')}.test` };
const destination = { dropoff_address: '12 Example Street, Example Barangay, Example Town, Bulacan', dropoff_latitude: 14.9, dropoff_longitude: 120.9 };
const booking = { pet_details: 'Bantay — dog, 12 kg. Customer has a secure carrier.', ...destination, preferred_schedule: new Date(Date.now() + 86_400_000).toISOString(), contact_phone: '+639171234567' };
beforeEach(() => { state.inserts = []; state.coverage = []; state.routes = []; state.shelter = { ...official }; forgetShelterLocation(); });

describe('shelter transport pickup', () => {
  it('is filled in from the official shelter record when the browser sends none', async () => {
    const saved = await request(app).post('/api/transport/requests').set(signedIn).send(booking).expect(201);
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0]).toMatchObject({ user_id: customer, pickup_address: 'PawsConnect Animal Shelter', pickup_latitude: 15.017163, pickup_longitude: 120.948071, ...destination });
    expect(saved.body.data).toMatchObject({ pickup_latitude: 15.017163, pickup_longitude: 120.948071 });
  });

  it('ignores pickup values sent straight to the API', async () => {
    await request(app).post('/api/transport/requests').set(signedIn).send({ ...booking, pickup_address: 'Somewhere else entirely', pickup_latitude: 14.5995, pickup_longitude: 120.9842 }).expect(201);
    expect(state.inserts[0]).toMatchObject({ pickup_address: 'PawsConnect Animal Shelter', pickup_latitude: 15.017163, pickup_longitude: 120.948071 });
    expect(JSON.stringify(state.inserts[0])).not.toContain('Somewhere else');
  });

  it('includes the address once an administrator has confirmed it', async () => {
    state.shelter = { ...official, formatted_address: 'Confirmed Road, Confirmed Town, Bulacan', address_verified_at: '2026-10-12T00:00:00Z' };
    await request(app).post('/api/transport/requests').set(signedIn).send(booking).expect(201);
    expect(state.inserts[0].pickup_address).toBe('PawsConnect Animal Shelter, Confirmed Road, Confirmed Town, Bulacan');
  });

  it('reports the coverage the database stored, and still needs a destination', async () => {
    const saved = await request(app).post('/api/transport/requests').set(signedIn).send(booking).expect(201);
    expect(saved.body.meta.alternative_available).toBe(false);
    expect(state.inserts[0]).not.toHaveProperty('coverage_status');
    const { dropoff_latitude: _removed, ...withoutDestination } = booking;
    await request(app).post('/api/transport/requests').set(signedIn).send(withoutDestination).expect(400);
    await request(app).post('/api/transport/requests').send(booking).expect(401);
  });

  it('previews the route from the shelter and refuses an origin from the browser', async () => {
    const route = await request(app).post('/api/maps/shelter-route').send({ destination: { latitude: 14.9, longitude: 120.9 } }).expect(200);
    expect(route.body.data).toMatchObject({ distance_meters: 12_345, duration_seconds: 1_500, origin: { name: 'PawsConnect Animal Shelter', latitude: 15.017163, longitude: 120.948071 } });
    expect(state.routes[0][0]).toMatchObject({ latitude: 15.017163, longitude: 120.948071 });
    expect(state.routes[0][1]).toEqual({ latitude: 14.9, longitude: 120.9 });
    await request(app).post('/api/maps/shelter-route').send({ origin: { latitude: 1, longitude: 1 }, destination: { latitude: 14.9, longitude: 120.9 } }).expect(400);
  });

  it('checks transport coverage from the shelter whatever origin is sent', async () => {
    await request(app).post('/api/geofencing/transport-coverage').send({ origin: { latitude: 1, longitude: 1 }, destination: { latitude: 14.9, longitude: 120.9 } }).expect(200);
    expect(state.coverage.map(call => [call.p_latitude, call.p_longitude])).toEqual([[15.017163, 120.948071], [14.9, 120.9]]);
  });
});
