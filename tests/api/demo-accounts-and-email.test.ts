import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The demo-account switch and transactional email, with the database and the
// email provider replaced by stand-ins. No message leaves the test process.
const state = vi.hoisted(() => ({ flags: { DEMO_ACCOUNTS_DISABLED: true, resend: true }, sent: [] as any[], waits: [] as Promise<unknown>[] }));
const ids = { demo: '00000000-0000-4000-8000-000000000001', real: '00000000-0000-4000-8000-000000000002' };
const emails: Record<string, string> = { [ids.demo]: 'Buyer@PawsConnect.test', [ids.real]: 'person@example.org' };
vi.mock('@vercel/functions', () => ({ waitUntil: (work: Promise<unknown>) => { state.waits.push(work); } }));
vi.mock('../../server/src/config/env', async original => {
  const actual = await original<typeof import('../../server/src/config/env')>();
  return { ...actual, configured: true, env: new Proxy(actual.env, { get: (target, key) => key === 'DEMO_ACCOUNTS_DISABLED' ? state.flags.DEMO_ACCOUNTS_DISABLED : key === 'RESEND_API_KEY' ? 're_test' : key === 'RESEND_FROM' ? 'PawsConnect <updates@example.org>' : (target as any)[key] }), integrations: new Proxy(actual.integrations, { get: (target, key) => key === 'resend' ? state.flags.resend : (target as any)[key] }) };
});
vi.mock('../../server/src/config/supabase', () => ({ db: () => ({
  auth: { getUser: async (token: string) => { const id = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub; return { data: { user: { id, email: emails[id] } }, error: null }; }, admin: { getUserById: async (id: string) => ({ data: { user: { id, email: emails[id] } } }) } },
  rpc: async (name: string) => ({ data: name === 'account_session_allowed' ? true : [], error: null }),
  from: (table: string) => { const builder: any = { select: () => builder, eq: () => builder, single: () => builder, maybeSingle: () => builder, then: (resolve: (value: unknown) => void) => Promise.resolve({ data: table === 'user_roles' ? [] : { mode: 'normal', modules: [], disabled_features: [], slow_request_ms: 2000, full_name: 'Fixture' }, error: null }).then(resolve) }; return builder; },
}) }));
import { createApp } from '../../server/src/app';
import { emailOwner, emailUser } from '../../server/src/integrations/email';

const tokenFor = (id: string) => `test.${Buffer.from(JSON.stringify({ sub: id, session_id: id })).toString('base64url')}.test`;
beforeEach(() => {
  state.flags = { DEMO_ACCOUNTS_DISABLED: true, resend: true }; state.sent = []; state.waits = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => { state.sent.push(JSON.parse(String(init.body))); return new Response('{}', { status: 200 }); }));
});

describe('demo account switch', () => {
  const app = createApp();
  it('refuses the seeded demo accounts when the flag is on, and nobody else', async () => {
    const refused = await request(app).get('/api/assistant/bootstrap').set('Authorization', `Bearer ${tokenFor(ids.demo)}`).expect(403);
    expect(refused.body.error.code).toBe('DEMO_ACCOUNT_DISABLED');
    await request(app).get('/api/assistant/bootstrap').set('Authorization', `Bearer ${tokenFor(ids.real)}`).expect(200);
  });
  it('leaves demo accounts working when the flag is off', async () => {
    state.flags.DEMO_ACCOUNTS_DISABLED = false;
    await request(app).get('/api/assistant/bootstrap').set('Authorization', `Bearer ${tokenFor(ids.demo)}`).expect(200);
  });
});

describe('transactional email', () => {
  it('sends to the account’s own address, with record text escaped', async () => {
    emailUser(ids.real, { subject: 'Payment received', lines: ['Paid <b>₱549.00</b> & thanks'], link: { label: 'View your payments', path: '/account/payments' } });
    await Promise.all(state.waits);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0]).toMatchObject({ to: ['person@example.org'], subject: 'Payment received', from: 'PawsConnect <updates@example.org>' });
    expect(state.sent[0].html).toContain('Paid &lt;b&gt;₱549.00&lt;/b&gt; &amp; thanks');
    expect(state.sent[0].text).toContain('/account/payments');
  });
  it('sends nothing for an anonymous record or when email is not configured', async () => {
    emailOwner(() => Promise.resolve({ data: { user_id: null } }), () => ({ subject: 'x', lines: ['y'] }));
    await Promise.all(state.waits);
    state.flags.resend = false;
    emailUser(ids.real, { subject: 'x', lines: ['y'] });
    await Promise.all(state.waits);
    expect(state.sent).toHaveLength(0);
  });
  it('never throws into the action that triggered it when the provider fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try { emailUser(ids.real, { subject: 'x', lines: ['y'] }); await expect(Promise.all(state.waits)).resolves.toBeDefined(); expect(log).toHaveBeenCalledWith('Email delivery unavailable'); }
    finally { log.mockRestore(); }
  });
});
