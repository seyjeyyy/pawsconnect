import { afterEach, expect, it, vi } from 'vitest';
import { OpenStreetMapProvider } from '../../server/src/integrations/maps';

// The map provider against stand-in responses shaped like the real services' answers. No request leaves the test.
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const shelter = { latitude: 15.017163, longitude: 120.948071 }, home = { latitude: 14.9, longitude: 120.9 };
const osrm = { code: 'Ok', routes: [{ distance: 18_412.4, duration: 2_210.6, geometry: { coordinates: [[120.948071, 15.017163], [120.92, 14.95], [120.9, 14.9]] } }] };
afterEach(() => vi.unstubAllGlobals());

it('returns road distance, duration and a line to draw, and asks once for the same trip', async () => {
  const fetchMock = vi.fn(async (_url: string) => json(osrm)); vi.stubGlobal('fetch', fetchMock);
  const provider = new OpenStreetMapProvider();
  const route = await provider.route(shelter, home);
  expect(route).toEqual({ distance_meters: 18_412, duration_seconds: 2_211, geometry: [[15.017163, 120.948071], [14.95, 120.92], [14.9, 120.9]] });
  expect(fetchMock.mock.calls[0][0]).toContain('/route/v1/driving/120.94807,15.01716;120.90000,14.90000');
  await provider.route(shelter, home);
  await provider.route(shelter, { latitude: 14.9000001, longitude: 120.9000001 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await provider.route(shelter, { latitude: 14.91, longitude: 120.9 });
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it('reports a failed route as a failure, never as a distance, and tries again next time', async () => {
  const provider = new OpenStreetMapProvider();
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
  await expect(provider.route(shelter, home)).rejects.toMatchObject({ code: 'ROUTE_UNAVAILABLE' });
  vi.stubGlobal('fetch', vi.fn(async () => json({ code: 'NoRoute', routes: [] }, 400)));
  await expect(provider.route(shelter, home)).rejects.toMatchObject({ code: 'ROUTE_NOT_FOUND' });
  vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'Too Many Requests' }, 429)));
  await expect(provider.route(shelter, home)).rejects.toMatchObject({ code: 'ROUTE_UNAVAILABLE' });
  const recovered = vi.fn(async () => json(osrm)); vi.stubGlobal('fetch', recovered);
  await expect(provider.route(shelter, home)).resolves.toMatchObject({ distance_meters: 18_412 });
  expect(recovered).toHaveBeenCalledTimes(1);
});

it('splits a looked-up address into the parts the forms use, and asks once for the same spot', async () => {
  const fetchMock = vi.fn(async (_url: string) => json({ display_name: 'Canlapan Street, Santo Rosario, Malolos, Bulacan, Central Luzon, 3000, Philippines', address: { road: 'Canlapan Street', neighbourhood: 'Camestisuhan District', quarter: 'Santo Rosario', village: 'Calero', city: 'Malolos', state: 'Bulacan', region: 'Central Luzon', country: 'Philippines' } }));
  vi.stubGlobal('fetch', fetchMock);
  const provider = new OpenStreetMapProvider();
  const place = await provider.reverse({ latitude: 14.8433, longitude: 120.8114 });
  expect(place).toEqual({ address: 'Canlapan Street, Santo Rosario, Malolos, Bulacan, Central Luzon, 3000, Philippines', street: 'Canlapan Street', barangay: 'Santo Rosario', city: 'Malolos', province: 'Bulacan' });
  await provider.reverse({ latitude: 14.84331, longitude: 120.81141 });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  // A place the service knows only by town still gives what it has, with the rest left empty.
  vi.stubGlobal('fetch', vi.fn(async () => json({ display_name: 'Maguinao, San Rafael, Bulacan, Central Luzon, 3008, Philippines', address: { quarter: 'Maguinao', town: 'San Rafael', state: 'Bulacan' } })));
  expect(await provider.reverse({ latitude: 15.017163, longitude: 120.948071 })).toMatchObject({ street: '', barangay: 'Maguinao', city: 'San Rafael', province: 'Bulacan' });
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'Unable to geocode' })));
  expect(await provider.reverse({ latitude: 10, longitude: 130 })).toBeNull();
});

it('searches an address once and reuses the answer', async () => {
  const fetchMock = vi.fn(async (_url: string) => json([{ display_name: '12 Example Street, Example Town, Bulacan, Philippines', lat: '14.9', lon: '120.9', place_id: 7 }]));
  vi.stubGlobal('fetch', fetchMock);
  const provider = new OpenStreetMapProvider();
  expect(await provider.geocode('12 Example Street, Example Town, Bulacan')).toEqual([{ address: '12 Example Street, Example Town, Bulacan, Philippines', latitude: 14.9, longitude: 120.9, place_id: '7' }]);
  await provider.geocode('  12 example street, example town, bulacan ');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0][0]).toContain('countrycodes=ph');
});
