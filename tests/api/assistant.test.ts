import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The assistant's tools are its whole reach into the database. These tests check
// which tools each account is offered, that every read is pinned to the signed-in
// account, and that the HTTP routes refuse anonymous and unconfigured use. No
// provider request is ever made: the key is blank under test.
const state = vi.hoisted(() => ({ queries: [] as { table: string; filters: [string, unknown][]; select: string }[], rpc: vi.fn(), rows: {} as Record<string, any[]> }));
const ids = { alice: '00000000-0000-4000-8000-000000000001', staff: '00000000-0000-4000-8000-000000000003', admin: '00000000-0000-4000-8000-000000000004' };
const roles: Record<string, string[]> = { [ids.alice]: ['buyer', 'adopter'], [ids.staff]: ['shelter_staff', 'buyer'], [ids.admin]: ['super_administrator'] };
const client = {
  auth: { getUser: async (token: string) => { const id = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub; return roles[id] ? { data: { user: { id } }, error: null } : { data: { user: null }, error: { message: 'invalid' } }; } },
  rpc: state.rpc,
  from: (table: string) => {
    const entry = { table, filters: [] as [string, unknown][], select: '*' }; state.queries.push(entry);
    let one = false;
    const builder: any = {
      select: (columns: string) => { entry.select = columns; return builder; },
      eq: (key: string, value: unknown) => { entry.filters.push([key, value]); return builder; },
      ilike: (key: string, value: unknown) => { entry.filters.push([key, value]); return builder; },
      lt: () => builder, order: () => builder, limit: () => builder, delete: () => builder, maybeSingle: () => { one = true; return builder; }, single: () => { one = true; return builder; },
      then: (resolve: (value: unknown) => void) => {
        const rows = table === 'user_roles' ? (roles[String(entry.filters.find(([key]) => key === 'user_id')?.[1])] ?? []).map(name => ({ roles: { name } })) : state.rows[table] ?? [];
        return Promise.resolve({ data: one ? rows[0] ?? null : rows, count: rows.length, error: null }).then(resolve);
      },
    };
    return builder;
  },
};
vi.mock('../../server/src/config/env', async original => { const actual = await original<typeof import('../../server/src/config/env')>(); return { ...actual, configured: true }; });
vi.mock('../../server/src/config/supabase', () => ({ db: () => client }));
import { createApp } from '../../server/src/app';
import { assistantTools, suggestionsFor, toolsFor } from '../../server/src/modules/assistant/tools';

const tokenFor = (id: string) => `test.${Buffer.from(JSON.stringify({ sub: id, session_id: id })).toString('base64url')}.test`;
const names = (actor: { id: string; roles: string[]; permissions?: string[] }) => toolsFor(actor).map(tool => tool.name);
const tool = (name: string) => assistantTools.find(candidate => candidate.name === name)!;
const user = { id: ids.alice, roles: ['buyer', 'adopter'], permissions: [] };
const adoptionStaff = { id: ids.staff, roles: ['shelter_staff', 'buyer'], permissions: ['adoptions.review'] };
const superAdmin = { id: ids.admin, roles: ['super_administrator'], permissions: [] };

beforeEach(() => {
  state.queries = []; state.rows = {};
  state.rpc.mockReset().mockImplementation(async (name: string) => ({ data: name === 'account_session_allowed' ? true : name === 'account_permissions' ? [] : { status: 'ok', mode: 'normal', modules: [], disabled_features: [] }, error: null }));
  state.rows.operations_config = [{ mode: 'normal', modules: [], disabled_features: [], starts_at: null, ends_at: null, public_notice: '', slow_request_ms: 2000 }];
});

describe('assistant tool access', () => {
  it('offers each account type only its own tools', () => {
    expect(names(user)).toEqual(['search_adoptable_pets', 'search_products', 'my_records', 'my_volunteer_status', 'my_account_summary']);
    expect(names(adoptionStaff)).toEqual(['search_adoptable_pets', 'search_products', 'my_records', 'my_volunteer_status', 'workspace_overview', 'staff_records']);
    expect(names(superAdmin)).toEqual(['search_adoptable_pets', 'search_products', 'my_records', 'my_volunteer_status', 'system_overview', 'system_records']);
    // Staff with no module assigned, and field roles, get no shelter lists.
    expect(names({ id: ids.staff, roles: ['shelter_staff'], permissions: [] })).not.toContain('staff_records');
    expect(names({ id: ids.staff, roles: ['veterinarian'], permissions: ['animals.view'] })).not.toContain('staff_records');
  });
  it('reads personal records only for the signed-in account, whatever the model sends', async () => {
    for (const kind of ['adoption_applications', 'orders', 'rescue_reports', 'donations', 'transport_requests', 'payments', 'notifications']) {
      state.queries = [];
      await tool('my_records').run(user, { kind }, client as any);
      expect(state.queries[0].filters, kind).toContainEqual(['user_id', ids.alice]);
    }
    // A user id smuggled into the input is rejected by the schema before anything runs.
    expect(tool('my_records').input.safeParse({ kind: 'orders', user_id: ids.staff }).success).toBe(false);
    expect(tool('staff_records').input.safeParse({ module: 'audit_logs' }).success).toBe(false);
  });
  it('refuses a staff module the account is not assigned to, even if the tool is called directly', async () => {
    expect(await tool('staff_records').run(adoptionStaff, { module: 'orders', limit: 5 }, client as any)).toEqual({ error: 'This account is not assigned to that module.' });
    expect(state.queries).toEqual([]);
    expect(await tool('staff_records').run(user, { module: 'adoptions', limit: 5 }, client as any)).toHaveProperty('error');
    expect(await tool('system_records').run(adoptionStaff, { kind: 'users', limit: 5 }, client as any)).toHaveProperty('error');
    expect(state.queries).toEqual([]);
    state.rows.adoption_applications = [{ id: 'a', status: 'submitted' }];
    expect(await tool('staff_records').run(adoptionStaff, { module: 'adoptions', status: 'submitted', limit: 5 }, client as any)).toMatchObject({ total_matching: 1, path: '/admin/adoptions' });
  });
  it('never selects private contact details, documents or payment payloads', () => {
    const source = String(assistantTools.map(candidate => candidate.run).join('\n'));
    for (const column of ['reporter_contact', 'contact_phone', 'document_paths', 'address_snapshot', 'provider_payload', 'pickup_address', 'cost_centavos', 'phone']) expect(source, column).not.toContain(column);
    expect(source).not.toContain("select('*");
  });
  it('lists only published, available animals for adoption suggestions', async () => {
    await tool('search_adoptable_pets').run(user, { species: 'dog', limit: 3 }, client as any);
    expect(state.queries[0].filters).toEqual(expect.arrayContaining([['is_published', true], ['is_sample', false], ['status', 'available'], ['species', 'dog']]));
  });
  it('matches suggested prompts to the account', () => {
    expect(suggestionsFor(user)).toContain('Help me adopt a pet');
    expect(suggestionsFor(adoptionStaff)).toEqual(['What should I prioritize?', 'Which adoption applications need review?']);
    expect(suggestionsFor(superAdmin)).toContain('Show the system overview');
  });
});

describe('assistant routes', () => {
  const app = createApp();
  it('requires sign-in for every assistant route', async () => {
    await request(app).get('/api/assistant/bootstrap').expect(401);
    await request(app).get('/api/assistant/messages').expect(401);
    await request(app).delete('/api/assistant/messages').expect(401);
    await request(app).post('/api/assistant/chat').send({ message: 'hi' }).expect(401);
  });
  it('derives the account type from the server, not the request', async () => {
    const response = await request(app).get('/api/assistant/bootstrap?account_type=super_administrator').set('Authorization', `Bearer ${tokenFor(ids.alice)}`).expect(200);
    expect(response.body.data).toMatchObject({ enabled: false, account_type: 'user' });
  });
  it('rejects unknown fields and reports honestly when no provider key is configured', async () => {
    await request(app).post('/api/assistant/chat').set('Authorization', `Bearer ${tokenFor(ids.alice)}`).send({ message: 'hi', role: 'super_administrator' }).expect(400);
    await request(app).post('/api/assistant/chat').set('Authorization', `Bearer ${tokenFor(ids.alice)}`).send({ message: 'hi', page: '/account?token=secret' }).expect(400);
    const response = await request(app).post('/api/assistant/chat').set('Authorization', `Bearer ${tokenFor(ids.alice)}`).send({ message: 'hi', page: '/account/overview' }).expect(503);
    expect(response.body.error.code).toBe('ASSISTANT_UNAVAILABLE');
  });
  it('reads conversation history only for the signed-in account', async () => {
    state.rows.assistant_conversations = [{ id: 'c1' }];
    await request(app).get('/api/assistant/messages').set('Authorization', `Bearer ${tokenFor(ids.alice)}`).expect(200);
    const reads = state.queries.filter(query => query.table.startsWith('assistant_'));
    expect(reads.length).toBeGreaterThan(0);
    for (const query of reads) expect(query.filters, query.table).toContainEqual(['user_id', ids.alice]);
  });
});
