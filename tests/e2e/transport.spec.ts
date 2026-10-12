import { expect, test, type Page } from '@playwright/test';

// Browser-only fixtures on the isolated preview server: the API, the map tiles and the
// sign-in session are stand-ins. These tests cover the shelter transport form itself.
const tile = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const shelter = { name: 'PawsConnect Animal Shelter', latitude: 15.017163, longitude: 120.948071, google_maps_url: 'https://maps.app.goo.gl/e6hDczktzrXMntQr9', formatted_address: null };
async function fixture(page: Page, options: { signedIn?: boolean; routeFailures?: number } = {}) {
  const previews: any[] = [], bookings: any[] = []; let failures = options.routeFailures ?? 0;
  await page.route('**/tile.openstreetmap.org/**', route => route.fulfill({ contentType: 'image/png', body: tile }));
  await page.route('**/src/lib/supabase.ts', route => route.fulfill({ contentType: 'application/javascript', body: `
    const session=${options.signedIn === false ? 'null' : "{user:{id:'alice',email:'alice@example.test'},access_token:'fixture:alice'}"};
    const channel={on(){return channel},subscribe(){return channel}};
    export const supabase={auth:{getSession:async()=>({data:{session}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})},channel:()=>channel,removeChannel:async()=>{}};` }));
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace('/api', '');
    let data: unknown = [];
    if (path === '/auth/me') data = { id: 'alice', full_name: 'Alice Fixture', permissions: [], roles: ['buyer', 'adopter'] };
    else if (path === '/shelter-location') data = shelter;
    else if (path === '/adoption-applications/mine') data = [{ id: '00000000-0000-4000-8000-0000000000c1', status: 'approved', pets: { name: 'Bantay', species: 'cat' } }];
    else if (path === '/maps/geocode') data = [{ address: '12 Example Street, Example Town, Bulacan, Philippines', latitude: 14.9, longitude: 120.9, place_id: 'a' }];
    else if (path === '/maps/reverse') data = { address: 'Fixture Road, Fixture Barangay, Fixture Town, Bulacan', street: 'Fixture Road', barangay: 'Fixture Barangay', city: 'Fixture Town', province: 'Bulacan' };
    else if (path === '/transport/preview') {
      previews.push(request.postDataJSON());
      if (failures-- > 0) return route.fulfill({ status: 502, json: { error: { code: 'ROUTE_UNAVAILABLE', message: 'We couldn’t calculate the route. Please try again.' } } });
      data = { origin: shelter, route: { distance_km: 18.4, duration_minutes: 37, geometry: [[15.017163, 120.948071], [14.9, 120.9]] }, coverage: { status: 'within_coverage' }, estimate: null };
    }
    else if (path === '/transport/requests') { bookings.push(request.postDataJSON()); await new Promise(resolve => setTimeout(resolve, 300)); data = { id: 'abcd1234-0000-4000-8000-000000000000', status: 'submitted' }; }
    else if (path === '/assistant/bootstrap') data = { enabled: false };
    else if (path === '/cart') data = { items: [] };
    else if (path === '/health') data = { status: 'ok', payment_mode: 'unavailable' };
    else if (path === '/operations/status') data = { active: false };
    else if (path.includes('/operations/tour/')) data = null;
    await route.fulfill({ json: { data } });
  });
  return { previews, bookings };
}
const form = (page: Page) => page.locator('form.transport-form');
async function typeAddress(page: Page) {
  await form(page).getByLabel('Street').fill('12 Example Street');
  await form(page).getByLabel('Barangay').fill('Example Barangay');
  await form(page).getByLabel('City / municipality').fill('Example Town');
}
async function searchForAddress(page: Page) {
  await typeAddress(page);
  await form(page).getByRole('button', { name: 'Find address' }).click();
  await form(page).getByRole('button', { name: /12 Example Street, Example Town/ }).click();
}

test('a guest is asked to sign in before any form is shown', async ({ page }) => {
  await fixture(page, { signedIn: false });
  await page.goto('/transport');
  await expect(page.getByRole('heading', { name: 'Sign in to request pet transport' })).toBeVisible();
  await expect(page.locator('main').getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/auth/login?next=/transport');
  await expect(page.locator('form.transport-form')).toHaveCount(0);
  await expect(page.getByLabel('Pet name')).toHaveCount(0);
});

test('the pickup is the shelter and cannot be edited; no coordinates are asked for', async ({ page }) => {
  await fixture(page);
  await page.goto('/transport');
  const pickup = form(page).locator('fieldset', { hasText: 'Pickup' }).first();
  await expect(pickup.getByText('PawsConnect Animal Shelter')).toBeVisible();
  await expect(pickup.getByRole('link', { name: 'View on Google Maps' })).toHaveAttribute('href', shelter.google_maps_url);
  await expect(pickup.locator('input, select, textarea')).toHaveCount(0);
  await expect(form(page).getByLabel(/latitude|longitude/i)).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(0);
  // The other tab keeps its own pickup fields.
  await page.getByRole('button', { name: 'Alternative request' }).click();
  await expect(page.locator('fieldset.location-picker', { hasText: 'Pickup location' }).getByLabel('Street address or landmark')).toBeVisible();
});

test('search, the map and the device location all move the same pin, and a chosen destination is never replaced unasked', async ({ page, context }) => {
  const { previews } = await fixture(page);
  await context.grantPermissions(['geolocation']); await context.setGeolocation({ latitude: 14.95, longitude: 120.95 });
  await page.goto('/transport');
  // Related adoption fills in the animal's name and species.
  await form(page).getByLabel('Related adoption (if any)').selectOption({ index: 1 });
  await expect(form(page).getByLabel('Pet name')).toHaveValue('Bantay');
  await expect(form(page).getByLabel('Species')).toHaveValue('cat');

  await searchForAddress(page);
  await expect(form(page).getByText('18.4 km').first()).toBeVisible();
  // Search moves the pin and leaves the typed address alone.
  await expect(form(page).getByLabel('Street')).toHaveValue('12 Example Street');
  expect(previews.at(-1)).toEqual({ destination: { latitude: 14.9, longitude: 120.9 } });
  const confirm = form(page).getByLabel(/I confirm the destination/);
  await confirm.check();

  // The device location is offered, not applied.
  await form(page).getByRole('button', { name: 'Use my location' }).click();
  await expect(form(page).getByText('Fixture Road, Fixture Barangay, Fixture Town, Bulacan')).toBeVisible();
  await expect(form(page).getByLabel('Street')).toHaveValue('12 Example Street');
  await expect(confirm).toBeChecked();
  await form(page).getByRole('button', { name: 'Keep my destination' }).click();
  expect(previews).toHaveLength(1);
  // Accepting it moves the pin, updates the address and asks for confirmation again.
  await form(page).getByRole('button', { name: 'Use my location' }).click();
  await form(page).getByRole('button', { name: 'Replace my destination with this' }).click();
  await expect(form(page).getByLabel('Street')).toHaveValue('Fixture Road');
  await expect(confirm).not.toBeChecked();
  await expect.poll(() => previews.at(-1)).toEqual({ destination: { latitude: 14.95, longitude: 120.95 } });

  // Clicking the map moves the same pin and fills the address in; it can then be corrected by hand.
  const map = form(page).getByRole('application', { name: /Destination map/ });
  await map.scrollIntoViewIfNeeded();
  const box = (await map.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await expect(form(page).getByText('We filled in the address for this spot')).toBeVisible();
  await expect.poll(() => previews.length).toBe(3);
  expect(previews[2].destination.latitude).not.toBe(14.95);
  await form(page).getByLabel('Street').fill('Corrected Street');
  await expect(form(page).getByLabel('Street')).toHaveValue('Corrected Street');
  expect(previews).toHaveLength(3);
  await expect(form(page).locator('.transport-marker-destination')).toHaveCount(2); // one pin, shown on the picker and on the route map
});

test('a refused location request explains itself and leaves the other options working', async ({ page }) => {
  await fixture(page);
  await page.goto('/transport');
  await form(page).getByRole('button', { name: 'Use my location' }).click();
  await expect(form(page).getByText(/Location access was not allowed|couldn’t get your location/)).toBeVisible();
  await searchForAddress(page);
  await expect(form(page).getByText('18.4 km').first()).toBeVisible();
});

test('a routing failure shows an error with Retry and never a distance', async ({ page }) => {
  await fixture(page, { routeFailures: 1 });
  await page.goto('/transport');
  await searchForAddress(page);
  await expect(form(page).getByRole('alert')).toContainText('We couldn’t calculate the route. Please try again.');
  await expect(form(page).getByText(/\d km/)).toHaveCount(0);
  await expect(form(page).getByRole('button', { name: 'Submit transport request' })).toBeDisabled();
  await form(page).getByRole('button', { name: 'Retry' }).click();
  await expect(form(page).getByText('18.4 km').first()).toBeVisible();
  await expect(form(page).getByText('Staff will send you a quote after reviewing your request.')).toBeVisible();
});

test('submitting twice creates one booking, with no pickup sent from the browser', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { bookings } = await fixture(page);
  await page.goto('/transport');
  await form(page).getByLabel('Pet name').fill('Mingming');
  await form(page).getByLabel('Weight in kilograms').fill('4');
  await form(page).getByLabel('Preferred date and time (Philippine time)').fill('2030-01-15T10:00');
  await searchForAddress(page);
  await expect(form(page).getByText('18.4 km').first()).toBeVisible();
  // A number typed the local way is stored in +63 form.
  await form(page).getByLabel('Mobile number, ten digits after +63').fill('0917 123 4567');
  const submit = form(page).getByRole('button', { name: 'Submit transport request' });
  await expect(submit).toBeDisabled();
  await form(page).getByLabel(/I confirm the destination/).check();
  await form(page).getByLabel(/pet transport policy/).check();
  await submit.dblclick();
  await expect(page.getByRole('heading', { name: 'Request received' })).toBeVisible();
  await expect(page.getByText('Reference ABCD1234')).toBeVisible();
  await expect(page.getByRole('link', { name: 'View my transport requests' })).toHaveAttribute('href', '/account/transport');
  expect(bookings).toHaveLength(1);
  expect(bookings[0]).toMatchObject({ pet_name: 'Mingming', pet_species: 'dog', pet_weight_kg: 4, preferred_schedule: '2030-01-15T02:00:00.000Z', dropoff_street: '12 Example Street', dropoff_city: 'Example Town', dropoff_latitude: 14.9, dropoff_longitude: 120.9, contact_name: 'Alice Fixture', contact_phone: '+639171234567', destination_confirmed: true, policy_accepted: true });
  expect(Object.keys(bookings[0]).filter(key => /pickup|fee|price|distance|coverage|status/.test(key))).toEqual([]);
  expect(errors).toEqual([]);
});
