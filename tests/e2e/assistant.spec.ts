import { expect, test, type Page } from '@playwright/test';

// Browser-only fixtures on the isolated preview server. The chat reply is a canned
// stream standing in for the AI provider: these tests cover the panel, not the model.
const people = { alice: 'Alice Fixture', bob: 'Bob Fixture' };
async function fixture(page: Page, reply: (body: any) => { status?: number; frames?: [string, unknown][]; error?: string }) {
  const calls: string[] = [], sent: any[] = [];
  await page.route('**/src/lib/supabase.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    let session=JSON.parse(sessionStorage.getItem('fixture-session')||'null')||{user:{id:'alice',email:'alice@example.test'},access_token:'fixture:alice'};
    const listeners=new Set();const channel={on(){return channel},subscribe(){return channel}};
    export const supabase={auth:{getSession:async()=>({data:{session}}),onAuthStateChange:cb=>{listeners.add(cb);return {data:{subscription:{unsubscribe(){listeners.delete(cb)}}}}},
      signInWithPassword:async({email})=>{const id=email.split('@')[0];session={user:{id,email},access_token:'fixture:'+id};sessionStorage.setItem('fixture-session',JSON.stringify(session));listeners.forEach(cb=>cb('SIGNED_IN',session));return {data:{session},error:null}},
      signOut:async()=>{session=null;sessionStorage.removeItem('fixture-session');listeners.forEach(cb=>cb('SIGNED_OUT',null));return {error:null}}},channel:()=>channel,removeChannel:async()=>{}};` }));
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace('/api', '');
    const who = (request.headers().authorization?.split(':')[1] || 'alice') as keyof typeof people;
    calls.push(`${request.method()} ${path}`);
    if (path === '/assistant/chat') {
      sent.push({ who, ...request.postDataJSON() });
      const result = reply(request.postDataJSON());
      if (result.error) return route.fulfill({ status: result.status ?? 503, json: { error: { code: 'ASSISTANT_UNAVAILABLE', message: result.error } } });
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: (result.frames ?? []).map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('') });
    }
    let data: unknown = [], meta: unknown;
    if (path === '/auth/me') data = { id: who, full_name: people[who], permissions: [], roles: ['buyer', 'adopter'] };
    else if (path === '/assistant/bootstrap') data = { enabled: true, account_type: 'user', suggestions: ['Help me adopt a pet', 'Track my adoption application'] };
    else if (path === '/assistant/messages') { data = who === 'alice' && request.method() === 'GET' ? [{ role: 'user', content: 'Alice private question', created_at: '2026-10-01T00:00:00Z' }, { role: 'assistant', content: 'Alice private answer', created_at: '2026-10-01T00:00:01Z' }] : []; meta = { history_available: true, has_more: false }; }
    else if (path === '/cart') data = { items: [] };
    else if (path === '/health') data = { status: 'ok', payment_mode: 'unavailable' };
    else if (path === '/operations/status') data = { active: false };
    else if (path.includes('/operations/tour/')) data = null;
    else if (path === '/account/summary') data = { orders: 0, applications: 1, reports: 0, updates: 0 };
    await route.fulfill({ json: { data, ...(meta ? { meta } : {}) } });
  });
  return { calls, sent };
}
const answer = { frames: [['tool', { label: 'Checking your records' }], ['delta', { text: 'Your application is **Under review**. See **[your applications](/account/applications)**. <img src=x onerror=alert(1)> [bad](https://example.test/x)' }], ['done', { saved: true }]] as [string, unknown][] };

test('the assistant loads nothing until opened, then answers and links inside the app', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { calls, sent } = await fixture(page, () => answer);
  await page.goto('/account/overview');
  await expect(page.locator('.dashboard-main h1')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(calls.filter(call => call.includes('assistant'))).toEqual([]);
  expect(await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('AssistantPanel')))).toBe(false);

  await page.getByRole('button', { name: 'Open PawsConnect AI Assistant' }).click();
  const panel = page.getByRole('dialog', { name: 'PawsConnect AI Assistant' });
  await expect(panel.getByText('Alice private answer')).toBeVisible();
  await panel.getByRole('textbox', { name: 'Message the assistant' }).fill('What happened to my application?');
  await panel.getByRole('button', { name: 'Send message' }).click();
  await expect(panel.getByRole('link', { name: 'your applications' })).toBeVisible();
  // Only the route is sent as page context, and model text is never rendered as HTML or as an outside link.
  expect(sent[0]).toMatchObject({ who: 'alice', message: 'What happened to my application?', page: '/account/overview', new_conversation: false });
  expect(Object.keys(sent[0]).sort()).toEqual(['message', 'new_conversation', 'page', 'who']);
  await expect(panel.locator('img')).toHaveCount(0);
  await expect(panel.getByRole('link', { name: 'bad' })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  await panel.getByRole('link', { name: 'your applications' }).click();
  await expect(page).toHaveURL(/\/account\/applications$/);
  expect(errors).toEqual([]);
});

test('a failed reply keeps the question, explains plainly and can be retried', async ({ page }) => {
  let attempts = 0;
  const { sent } = await fixture(page, () => ++attempts === 1 ? { error: 'I’m having trouble responding right now. You can still use the PawsConnect features normally.' } : answer);
  await page.goto('/account/overview');
  await page.getByRole('button', { name: 'Open PawsConnect AI Assistant' }).click();
  const panel = page.getByRole('dialog', { name: 'PawsConnect AI Assistant' });
  await panel.getByRole('button', { name: 'New conversation' }).click();
  await panel.getByRole('button', { name: 'Track my adoption application' }).click();
  await expect(panel.getByRole('alert')).toContainText('trouble responding');
  await expect(panel.getByText('Track my adoption application')).toHaveCount(1);
  await panel.getByRole('button', { name: 'Try again' }).click();
  await expect(panel.getByRole('link', { name: 'your applications' })).toBeVisible();
  await expect(panel.locator('.assistant-user')).toHaveCount(1);
  expect(sent.map(body => body.new_conversation)).toEqual([true, true]);
});

test('switching accounts never shows the previous person’s conversation', async ({ page }) => {
  await fixture(page, () => answer);
  await page.goto('/account/overview');
  await page.getByRole('button', { name: 'Open PawsConnect AI Assistant' }).click();
  await expect(page.getByText('Alice private answer')).toBeVisible();
  await page.evaluate(async () => { const { supabase } = await import('/src/lib/supabase.ts' as string); await supabase.auth.signOut(); });
  await expect(page.getByRole('dialog', { name: 'PawsConnect AI Assistant' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open PawsConnect AI Assistant' })).toHaveCount(0);
  await page.evaluate(async () => { const { supabase } = await import('/src/lib/supabase.ts' as string); await supabase.auth.signInWithPassword({ email: 'bob@example.test', password: 'x' }); });
  await page.getByRole('button', { name: 'Open PawsConnect AI Assistant' }).click();
  const panel = page.getByRole('dialog', { name: 'PawsConnect AI Assistant' });
  await expect(panel.getByText('Hi, Bob.')).toBeVisible();
  await expect(panel.getByText('Alice private')).toHaveCount(0);
});
