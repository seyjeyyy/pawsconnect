import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shelter transport always starts at the official shelter. The database, the coverage
// function and the route service are stand-ins; what is asserted is what the API sends them.
const state = vi.hoisted(() => ({ inserts: [] as Record<string, unknown>[], coverage: [] as Record<string, unknown>[], routes: [] as unknown[][], shelter: {} as Record<string, unknown>, routeFails: false }));
const customer = '00000000-0000-4000-8000-000000000005', application = '00000000-0000-4000-8000-0000000000c1', adoptedPet = '00000000-0000-4000-8000-0000000000c2';
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
      then: (resolve: (value: unknown) => void) => Promise.resolve({ data: table === 'user_roles' ? [{ roles: { name: 'buyer' } }] : table === 'shelter_locations' ? state.shelter : table === 'adoption_applications' ? { id: application, pet_id: adoptedPet } : table === 'transport_requests' ? { id: '00000000-0000-4000-8000-0000000000bb', status: 'submitted', coverage_status: 'manual_review_required', ...inserted } : { mode: 'normal', modules: [], disabled_features: [], slow_request_ms: 2000 }, error: null }).then(resolve) };
    return builder;
  },
}) }));
vi.mock('../../server/src/integrations/maps', () => ({ maps: {
  route: async (...points: unknown[]) => { state.routes.push(points); if (state.routeFails) throw new Error('route service down'); return { distance_meters: 12_345, duration_seconds: 1_500, geometry: [[15.017163, 120.948071], [14.9, 120.9]] }; },
  reverse: async () => ({ address: 'Example Road, Example Barangay, Example Town, Bulacan', street: 'Example Road', barangay: 'Example Barangay', city: 'Example Town', province: 'Bulacan' }),
} }));
import { createApp } from '../../server/src/app';
import { forgetShelterLocation } from '../../server/src/modules/shelter/location';

const app = createApp();
const signedIn = { Authorization: `Bearer test.${Buffer.from(JSON.stringify({ sub: customer, session_id: customer })).toString('base64url')}.test` };
const destination = { dropoff_latitude: 14.9, dropoff_longitude: 120.9 };
const booking = { pet_name: 'Bantay', pet_species: 'dog', pet_weight_kg: 12, has_carrier: true, dropoff_street: '12 Example Street', dropoff_barangay: 'Example Barangay', dropoff_city: 'Example Town', dropoff_province: 'Bulacan', ...destination, preferred_schedule: new Date(Date.now() + 86_400_000).toISOString(), contact_name: 'Ana Example', contact_phone: '+639171234567', destination_confirmed: true, policy_accepted: true };
beforeEach(() => { state.inserts = []; state.coverage = []; state.routes = []; state.shelter = { ...official }; state.routeFails = false; forgetShelterLocation(); });

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

  it('composes the stored text from the parts the customer entered', async () => {
    await request(app).post('/api/transport/requests').set(signedIn).send({ ...booking, handling_requirements: 'Nervous in cars', delivery_instructions: 'Blue gate' }).expect(201);
    expect(state.inserts[0]).toMatchObject({ pet_details: 'Bantay — dog, 12 kg. Customer has a secure carrier.', dropoff_address: '12 Example Street, Example Barangay, Example Town, Bulacan', contact_phone: '+639171234567', handling_requirements: 'Nervous in cars\nDelivery instructions: Blue gate\nContact name: Ana Example' });
    // Only columns the table has are written.
    expect(Object.keys(state.inserts[0]).sort()).toEqual(['adoption_application_id', 'contact_phone', 'dropoff_address', 'dropoff_latitude', 'dropoff_longitude', 'handling_requirements', 'pet_details', 'pet_id', 'pickup_address', 'pickup_latitude', 'pickup_longitude', 'preferred_schedule', 'user_id']);
  });

  it('links the animal from the customer’s own adoption application', async () => {
    await request(app).post('/api/transport/requests').set(signedIn).send({ ...booking, adoption_application_id: application }).expect(201);
    expect(state.inserts[0]).toMatchObject({ adoption_application_id: application, pet_id: adoptedPet });
  });

  it('needs the confirmations, a +63 mobile number, a future schedule and no unknown fields', async () => {
    const send = (change: Record<string, unknown>) => request(app).post('/api/transport/requests').set(signedIn).send({ ...booking, ...change });
    await send({ destination_confirmed: false }).expect(400);
    await send({ policy_accepted: undefined }).expect(400);
    for (const contact_phone of ['09171234567', '+6391712345', '+63917123456789', '+15551234567']) await send({ contact_phone }).expect(400);
    await send({ preferred_schedule: new Date(Date.now() - 60_000).toISOString() }).expect(400);
    await send({ pet_weight_kg: 0 }).expect(400);
    await send({ fee_centavos: 1, status: 'paid' }).expect(400);
    await send({ coverage_status: 'within_coverage' }).expect(400);
    expect(state.inserts).toEqual([]);
  });

  it('previews road distance, travel time and coverage for a destination, from the shelter', async () => {
    await request(app).post('/api/transport/preview').send({ destination: { latitude: 14.9, longitude: 120.9 } }).expect(401);
    const preview = await request(app).post('/api/transport/preview').set(signedIn).send({ destination: { latitude: 14.9, longitude: 120.9 } }).expect(200);
    expect(preview.body.data).toMatchObject({ origin: { name: 'PawsConnect Animal Shelter', latitude: 15.017163, longitude: 120.948071 }, route: { distance_km: 12.3, duration_minutes: 25 }, coverage: { status: 'outside_coverage' }, estimate: null });
    expect(preview.body.data.route.geometry).toHaveLength(2);
    expect(state.routes[0][0]).toMatchObject({ latitude: 15.017163, longitude: 120.948071 });
    // Coverage is asked about the destination.
    expect(state.coverage.map(call => [call.p_latitude, call.p_longitude])).toEqual([[14.9, 120.9]]);
    await request(app).post('/api/transport/preview').set(signedIn).send({ origin: { latitude: 1, longitude: 1 }, destination: { latitude: 14.9, longitude: 120.9 } }).expect(400);
  });

  it('reports a routing failure instead of a guessed distance', async () => {
    state.routeFails = true;
    const failed = await request(app).post('/api/transport/preview').set(signedIn).send({ destination: { latitude: 14.9, longitude: 120.9 } }).expect(502);
    expect(failed.body.error).toMatchObject({ code: 'ROUTE_UNAVAILABLE', message: 'We couldn’t calculate the route. Please try again.' });
    expect(JSON.stringify(failed.body)).not.toMatch(/distance|duration/);
  });

  it('gives the address parts for a point picked on the map', async () => {
    const place = await request(app).get('/api/maps/reverse?latitude=14.9&longitude=120.9').expect(200);
    expect(place.body.data).toMatchObject({ street: 'Example Road', barangay: 'Example Barangay', city: 'Example Town', province: 'Bulacan' });
    await request(app).get('/api/maps/reverse?latitude=140&longitude=120.9').expect(400);
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
