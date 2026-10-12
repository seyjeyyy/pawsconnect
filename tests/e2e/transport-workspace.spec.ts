import { expect, test, type Page } from '@playwright/test';

// The staff and driver transport screens on the isolated preview server. The API, the map tiles
// and the sign-in session are stand-ins; amounts are test inputs, not shelter rates.
const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const id = '0b6f2f0e-6a3c-4d0e-9d55-3f2b1c7a9e10';
const trip = { id, reference: 'PT-TEST000001', status: 'under_review', coverage_status: 'within_coverage', created_at: '2026-10-12T02:00:00Z', pet_details: 'Bantay — dog, 12 kg.', pet_name: 'Bantay', pet_species: 'dog', pet_weight_kg: 12, has_carrier: false, handling_requirements: 'Nervous in cars.', delivery_instructions: 'Blue gate.', shelter_location_id: 's', pickup_name: 'PawsConnect Animal Shelter', pickup_address: 'PawsConnect Animal Shelter', pickup_latitude: 15.017163, pickup_longitude: 120.948071, dropoff_address: '12 Example Street, Example Town, Bulacan', dropoff_city: 'Example Town', dropoff_latitude: 14.9, dropoff_longitude: 120.9, route_distance_km: 18.4, route_duration_minutes: 37, route_geometry: [[15.017163, 120.948071], [14.9, 120.9]], preferred_schedule: '2030-01-15T02:00:00Z', confirmed_schedule: null, contact_name: 'Ana Example', contact_phone: '+639171234567', driver_id: null, driver_name: null, vehicle: null, customer_name: 'Cara Customer', handover: null, history: [{ id: 'e1', status: 'under_review', notes: null, created_at: '2026-10-12T03:00:00Z' }] };
const staffOnly = { estimate_breakdown: { lines: [{ label: 'Base fee', amount_centavos: 10_000 }, { label: 'Distance: 18.4 km × ₱15.00 per km', amount_centavos: 27_600 }] }, estimate_total_centavos: 37_600, fee_centavos: null, paid_at: null, quotes: [], internal_notes: [] };
async function fixture(page: Page, role: 'staff' | 'driver') {
  const sent: any[] = [], lists: string[] = [];
  let current: any = role === 'staff' ? { ...trip, ...staffOnly } : { ...trip, status: 'scheduled', confirmed_schedule: '2030-01-15T02:00:00Z', driver_id: 'dana', driver_name: 'Dana Driver', vehicle: { name: 'Shelter van', plate_number: 'TST 123' }, history: [{ id: 'e1', status: 'scheduled', notes: null, created_at: '2026-10-13T03:00:00Z' }] };
  await page.route('**/tile.openstreetmap.org/**', route => route.fulfill({ contentType: 'image/png', body: tile }));
  await page.route('**/src/lib/supabase.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    const session={user:{id:'fixture',email:'fixture@example.test'},access_token:'fixture:${role}'};
    const channel={on(){return channel},subscribe(){return channel}};
    export const supabase={auth:{getSession:async()=>({data:{session}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})},channel:()=>channel,removeChannel:async()=>{}};` }));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api', '');
    let data: unknown = [], meta: unknown;
    if (path === '/auth/me') data = role === 'staff' ? { id: 'sam', full_name: 'Sam Staff', roles: ['shelter_staff'], permissions: ['transport.manage', 'reports.export'] } : { id: 'dana', full_name: 'Dana Driver', roles: ['shelter_driver'], permissions: ['transport.assigned'] };
    else if (path === '/admin/transport') { lists.push(url.search); data = [current]; meta = { total: 1, page: 1, limit: 15 }; }
    else if (path === `/admin/transport/${id}` && request.method() === 'GET') data = current;
    else if (path === `/admin/transport/${id}/status`) { const body = request.postDataJSON(); sent.push(['status', body]); current = { ...current, status: body.status, history: [...current.history, { id: `e${sent.length + 1}`, status: body.status, notes: null, created_at: '2026-10-14T03:00:00Z' }] }; data = current; }
    else if (path === `/admin/transport/${id}/quote`) { const body = request.postDataJSON(); sent.push(['quote', body]); current = { ...current, status: 'quoted', fee_centavos: body.amount_centavos, quotes: [{ id: 'q1', amount_centavos: body.amount_centavos, expires_at: body.expires_at, accepted_at: null, created_at: '2026-10-12T04:00:00Z' }] }; data = current; }
    else if (path === `/admin/transport/${id}/notes`) { const body = request.postDataJSON(); sent.push(['note', body]); current = { ...current, internal_notes: [...current.internal_notes, { id: 'n1', note: body.note, created_at: '2026-10-12T04:10:00Z', author_name: 'Sam Staff' }] }; data = current; }
    else if (path === '/assistant/bootstrap') data = { enabled: false };
    else if (path === '/cart') data = { items: [] };
    else if (path === '/health') data = { status: 'ok', payment_mode: 'unavailable' };
    else if (path === '/operations/status') data = { active: false };
    else if (path.includes('/operations/tour/')) data = null;
    else if (path === '/admin/overview') data = {};
    await route.fulfill({ json: { data, ...(meta ? { meta } : {}) } });
  });
  return { sent, lists };
}
const noSidewaysScroll = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);

test('staff filter the list, open a booking, send the final quote and add an internal note', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { sent, lists } = await fixture(page, 'staff');
  await page.goto('/admin/transport');
  await expect(page.getByRole('button', { name: /PT-TEST000001/ })).toBeVisible({ timeout: 20_000 });
  await page.getByLabel('Status').selectOption('under_review');
  await page.getByLabel('Coverage').selectOption('within_coverage');
  await page.getByLabel('Preferred schedule date').fill('2030-01-15');
  await expect.poll(() => lists.at(-1)).toContain('status=under_review&coverage=within_coverage&date=2030-01-15');
  await noSidewaysScroll(page);

  await page.getByRole('button', { name: /PT-TEST000001/ }).click();
  await expect(page).toHaveURL(new RegExp(`booking=${id}`));
  const detail = page.locator('.transport-detail');
  // The same pickup, destination and route the customer saw, plus what only staff see.
  await expect(detail.getByText('PawsConnect Animal Shelter').first()).toBeVisible();
  await expect(detail.getByText('12 Example Street, Example Town, Bulacan')).toBeVisible();
  await expect(detail.getByText('18.4 km · about 37 min')).toBeVisible();
  await expect(detail.getByText('(15.017163, 120.948071)')).toBeVisible();
  await expect(detail.getByText('Cara Customer')).toBeVisible();
  await expect(detail.getByText('Not quoted yet')).toBeVisible();
  await expect(detail.locator('.transport-total')).toContainText('₱376.00');
  // Staff never type the shelter address: there is nowhere to.
  await expect(page.getByLabel(/pickup|shelter address|latitude|longitude/i)).toHaveCount(0);

  await page.getByRole('button', { name: 'Use the estimate' }).click();
  await page.getByLabel('Quotation amount, in pesos').fill('420.50');
  await page.getByLabel('Valid until (Philippine time)').fill('2030-01-10T17:00');
  await page.getByRole('button', { name: 'Send quotation' }).click();
  await expect(page.getByText('Quotation sent to the customer.')).toBeVisible();
  await expect(detail.getByText('₱420.50')).toBeVisible();
  await page.getByLabel('Add a note').fill('Called the customer about the gate.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('Called the customer about the gate.')).toBeVisible();
  expect(sent).toEqual([['quote', { amount_centavos: 42_050, breakdown: { estimate_total_centavos: 37_600 }, expires_at: '2030-01-10T09:00:00.000Z' }], ['note', { note: 'Called the customer about the gate.' }]]);
  await noSidewaysScroll(page);
  await page.getByRole('button', { name: 'All transport requests' }).click();
  await expect(page.getByRole('button', { name: /PT-TEST000001/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test('a driver sees the trip and the contact, opens directions, and records pickup, transit and delivery', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { sent } = await fixture(page, 'driver');
  await page.goto('/admin/transport');
  await expect(page.getByRole('heading', { name: 'My transport jobs', level: 1 })).toBeVisible({ timeout: 20_000 });
  // No staff tools and no prices.
  await expect(page.getByLabel('Coverage')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export' })).toHaveCount(0);
  await page.getByRole('button', { name: /PT-TEST000001/ }).click();
  await expect(page.getByRole('heading', { name: 'Your next step' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Price' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Internal notes' })).toHaveCount(0);
  await expect(page.getByText(/₱/)).toHaveCount(0);
  const detail = page.locator('.transport-detail');
  await expect(detail.getByText('PawsConnect Animal Shelter').first()).toBeVisible();
  await expect(detail.getByText('12 Example Street, Example Town, Bulacan')).toBeVisible();
  await expect(detail.getByRole('link', { name: '+639171234567' })).toHaveAttribute('href', 'tel:+639171234567');
  await expect(page.getByRole('link', { name: 'Open in Google Maps' }).first()).toHaveAttribute('href', 'https://www.google.com/maps/dir/?api=1&origin=15.017163,120.948071&destination=14.9,120.9&travelmode=driving');
  await noSidewaysScroll(page);

  const step = page.locator('.transport-driver');
  for (const label of ['Picked up', 'In transit', 'Delivered']) {
    await step.getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Marked as' })).toBeVisible();
  }
  expect(sent.map(([kind, body]) => [kind, body.status])).toEqual([['status', 'picked_up'], ['status', 'in_transit'], ['status', 'arrived']]);
  // Each step now shows when it was recorded, and there is nothing further for the driver to press.
  await expect(step.locator('.transport-steps li.done')).toHaveCount(3);
  await expect(step.getByText('Shelter staff will confirm the handover')).toBeVisible();
  await expect(step.getByRole('button')).toHaveCount(0);
  await noSidewaysScroll(page);
  expect(errors).toEqual([]);
});
