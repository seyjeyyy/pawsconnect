import { createHmac } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../server/src/app';
import { verifyStripeSignature } from '../../server/src/integrations/stripe';

// No Supabase credentials are present under test, so this exercises the API's
// preview mode: public catalog works, everything that needs an account refuses.
const app = createApp();

describe('API foundation', () => {
  it('reports health and which integrations are configured, without secrets', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.integrations).toEqual({ supabase: false, stripe: false, resend: false });
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves the catalog as labelled, unpurchasable sample data', async () => {
    const res = await request(app).get('/api/products?limit=3').expect(200);
    expect(res.body.meta).toMatchObject({ sample: true, limit: 3 });
    expect(res.body.data).toHaveLength(3);
    for (const product of res.body.data) expect(product).toMatchObject({ is_sample: true, stock_quantity: 0 });
  });

  it('filters sample pets and returns 404 for an unknown one', async () => {
    const cats = await request(app).get('/api/pets?species=cat').expect(200);
    expect(cats.body.data.every((p: { species: string }) => p.species === 'cat')).toBe(true);
    const missing = await request(app).get('/api/pets/30000000-0000-4000-8000-00000000ffff').expect(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });

  it('rejects invalid query parameters with a structured validation error', async () => {
    const res = await request(app).get('/api/products?limit=5000').expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects malformed JSON without leaking a stack trace', async () => {
    const res = await request(app).post('/api/auth/register').set('Content-Type', 'application/json').send('{"email":').expect(400);
    expect(res.body).toEqual({ error: { code: 'INVALID_JSON', message: expect.any(String) } });
  });
});

describe('registration input', () => {
  const valid = { email: 'new.user@example.test', password: 'a-long-passphrase', full_name: 'New User' };

  it('refuses any attempt to choose a role at sign-up', async () => {
    const res = await request(app).post('/api/auth/register').send({ ...valid, role: 'administrator' }).expect(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(res.body.error.details)).toContain('role');
  });

  it('enforces the 10 character minimum password', async () => {
    const res = await request(app).post('/api/auth/register').send({ ...valid, password: 'short123' }).expect(400);
    expect(res.body.error.details.fieldErrors.password).toBeDefined();
  });

  it('says clearly that accounts are unavailable until Supabase is connected', async () => {
    const res = await request(app).post('/api/auth/register').send(valid).expect(503);
    expect(res.body.error.code).toBe('SETUP_REQUIRED');
  });
});

describe('protected routes', () => {
  it.each([
    ['get', '/api/auth/me'], ['get', '/api/addresses'], ['get', '/api/cart'], ['post', '/api/orders'],
    ['get', '/api/admin/analytics'], ['get', '/api/admin/users'], ['post', '/api/donations'], ['get', '/api/transport/requests/mine'],
  ] as const)('%s %s is never served without an authenticated account', async (method, path) => {
    const res = await request(app)[method](path);
    expect([401, 503]).toContain(res.status);
    expect(res.body.data).toBeUndefined();
  });
});

describe('Stripe webhook verification', () => {
  const secret = 'whsec_test_secret';
  const body = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', livemode: false, data: { object: { id: 'cs_test_1' } } }));
  const sign = (timestamp: number, payload = body, key = secret) => createHmac('sha256', key).update(`${timestamp}.`).update(payload).digest('hex');
  const now = 1_800_000_000_000;
  const t = now / 1000;

  it('accepts a correctly signed payload', () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${sign(t)}`, secret, now)).toBe(true);
  });
  it('accepts when any one of several v1 signatures matches (secret rotation)', () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${'0'.repeat(64)},v1=${sign(t)}`, secret, now)).toBe(true);
  });
  it('rejects a tampered body, a wrong secret, a malformed or missing header', () => {
    expect(verifyStripeSignature(Buffer.from('{"id":"evt_2"}'), `t=${t},v1=${sign(t)}`, secret, now)).toBe(false);
    expect(verifyStripeSignature(body, `t=${t},v1=${sign(t, body, 'whsec_other')}`, secret, now)).toBe(false);
    expect(verifyStripeSignature(body, `t=${t},v0=${sign(t)}`, secret, now)).toBe(false);
    expect(verifyStripeSignature(body, 'garbage', secret, now)).toBe(false);
    expect(verifyStripeSignature(body, undefined, secret, now)).toBe(false);
  });
  it('rejects a replayed signature older than five minutes', () => {
    const old = t - 301;
    expect(verifyStripeSignature(body, `t=${old},v1=${sign(old)}`, secret, now)).toBe(false);
  });
  it('refuses unsigned webhook requests over HTTP', async () => {
    const res = await request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json').send('{"id":"evt_1"}');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.data).toBeUndefined();
  });
  it('no longer exposes the old PayMongo webhook path', async () => {
    const res = await request(app).post('/api/webhooks/paymongo').set('Content-Type', 'application/json').send('{}');
    expect(res.body.data).toBeUndefined();
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});
