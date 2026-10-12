import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The shelter location routes with the database and the map service replaced by stand-ins.
const state = vi.hoisted(() => ({ reads: 0, calls: [] as { name: string; args: Record<string, unknown> }[], lookups: [] as string[] }));
const record = { id: '00000000-0000-4000-8000-0000000000aa', code: 'PAWSCONNECT_MAIN_SHELTER', name: 'PawsConnect Animal Shelter', location_type: 'SHELTER', pickup_mode: 'FIXED', latitude: 15.017163, longitude: 120.948071, google_maps_url: 'https://maps.app.goo.gl/e6hDczktzrXMntQr9', formatted_address: null, address_verified_at: null, updated_at: '2026-10-12T00:00:00Z' };
const accounts: Record<string, string> = { super_administrator: '00000000-0000-4000-8000-000000000001', administrator: '00000000-0000-4000-8000-000000000002', shelter_staff: '00000000-0000-4000-8000-000000000003', shelter_driver: '00000000-0000-4000-8000-000000000004', buyer: '00000000-0000-4000-8000-000000000005' };
const roleOf = (id: string) => Object.entries(accounts).find(([, value]) => value === id)![0];
vi.mock('../../server/src/config/env', async original => {
  const actual = await original<typeof import('../../server/src/config/env')>();
  return { ...actual, configured: true };
});
vi.mock('../../server/src/config/supabase', () => ({ db: () => ({
  auth: { getUser: async (token: string) => { const id = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub; return { data: { user: { id, email: `${roleOf(id)}@example.org` } }, error: null }; } },
  rpc: async (name: string, args: Record<string, unknown>) => {
    if (name === 'account_session_allowed') return { data: true, error: null };
    if (name === 'account_permissions') return { data: [], error: null };
    // Telemetry and refusal logging also go through rpc; only the location change is under test.
    if (name === 'update_shelter_location') state.calls.push({ name, args });
    return { data: name === 'update_shelter_location' ? { ...record, name: args.p_name } : null, error: null };
  },
  from: (table: string) => {
    let user = '';
    const builder: any = { select: () => builder, eq: (column: string, value: string) => { if (column === 'user_id') user = value; return builder; }, single: () => builder, maybeSingle: () => builder, insert: () => builder,
      then: (resolve: (value: unknown) => void) => { if (table === 'shelter_locations') state.reads += 1; return Promise.resolve({ data: table === 'user_roles' ? [{ roles: { name: roleOf(user) } }] : table === 'shelter_locations' ? record : { mode: 'normal', modules: [], disabled_features: [], slow_request_ms: 2000 }, error: null }).then(resolve); } };
    return builder;
  },
}) }));
vi.mock('../../server/src/integrations/maps', () => ({ maps: { reverse: async (point: { latitude: number; longitude: number }) => { state.lookups.push(`${point.latitude},${point.longitude}`); return { address: 'Suggested road, Bulacan, Philippines', street: 'Suggested road', barangay: '', city: '', province: 'Bulacan' }; } } }));
import { createApp } from '../../server/src/app';
import { forgetShelterLocation } from '../../server/src/modules/shelter/location';

const app = createApp();
const as = (role: string) => ({ Authorization: `Bearer test.${Buffer.from(JSON.stringify({ sub: accounts[role], session_id: accounts[role] })).toString('base64url')}.test` });
const change = { name: 'PawsConnect Animal Shelter', latitude: 15.017163, longitude: 120.948071, google_maps_url: 'https://maps.app.goo.gl/e6hDczktzrXMntQr9', formatted_address: null, reason: 'Corrected after a site visit' };
beforeEach(() => { state.reads = 0; state.calls = []; state.lookups = []; forgetShelterLocation(); });

describe('shelter location', () => {
  it('is readable without signing in and is read from the database once while cached', async () => {
    const first = await request(app).get('/api/shelter-location').expect(200);
    expect(first.body.data).toMatchObject({ code: 'PAWSCONNECT_MAIN_SHELTER', latitude: 15.017163, longitude: 120.948071, formatted_address: null });
    await request(app).get('/api/shelter-location').expect(200);
    expect(state.reads).toBe(1);
  });

  it('can be changed only by an administrator or the super administrator', async () => {
    await request(app).put('/api/settings/shelter-location').send(change).expect(401);
    for (const role of ['shelter_staff', 'shelter_driver', 'buyer']) await request(app).put('/api/settings/shelter-location').set(as(role)).send(change).expect(403);
    expect(state.calls).toEqual([]);
    for (const role of ['administrator', 'super_administrator']) await request(app).put('/api/settings/shelter-location').set(as(role)).send(change).expect(200);
    expect(state.calls.map(call => [call.name, call.args.p_actor_id, call.args.p_code])).toEqual([['update_shelter_location', accounts.administrator, 'PAWSCONNECT_MAIN_SHELTER'], ['update_shelter_location', accounts.super_administrator, 'PAWSCONNECT_MAIN_SHELTER']]);
  });

  it('reads the record again after a change', async () => {
    await request(app).get('/api/shelter-location').expect(200);
    await request(app).put('/api/settings/shelter-location').set(as('administrator')).send(change).expect(200);
    await request(app).get('/api/shelter-location').expect(200);
    expect(state.reads).toBe(2);
  });

  it('rejects a change without a reason, with bad coordinates, or with fields it does not know', async () => {
    const send = (body: Record<string, unknown>) => request(app).put('/api/settings/shelter-location').set(as('administrator')).send(body);
    await send({ ...change, reason: '' }).expect(400);
    await send({ ...change, latitude: 120 }).expect(400);
    await send({ ...change, google_maps_url: 'http://example.test/map' }).expect(400);
    await send({ ...change, code: 'ANOTHER_SHELTER' }).expect(400);
    await send({ ...change, address_verified_at: '2026-01-01T00:00:00Z' }).expect(400);
    expect(state.calls).toEqual([]);
  });

  it('offers an address suggestion to editors only', async () => {
    const path = '/api/settings/shelter-location/address-lookup?latitude=15.017163&longitude=120.948071';
    await request(app).get(path).expect(401);
    await request(app).get(path).set(as('shelter_staff')).expect(403);
    const found = await request(app).get(path).set(as('administrator')).expect(200);
    expect(found.body.data).toEqual({ suggested_address: 'Suggested road, Bulacan, Philippines' });
    expect(state.lookups).toEqual(['15.017163,120.948071']);
  });
});
