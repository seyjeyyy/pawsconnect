import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';

type Point = { latitude: number; longitude: number };
export type GeocodeResult = { address: string; latitude: number; longitude: number; place_id: string };
export type RouteResult = { distance_meters: number; duration_seconds: number; geometry: [number, number][] };

/** Address search and routing sit behind this interface so the provider can be swapped without touching routes or the client. */
export interface MapProvider {
  geocode(address: string): Promise<GeocodeResult[]>;
  route(origin: Point, destination: Point): Promise<RouteResult>;
}

/**
 * OpenStreetMap services: Nominatim for address search, OSRM for driving
 * routes. No API key. The default public endpoints are shared community
 * services meant for light use (Nominatim: at most one request per second and
 * an identifying User-Agent; the OSRM demo server offers no uptime guarantee).
 * For production traffic, point NOMINATIM_URL and OSRM_URL at a hosted or
 * self-hosted instance.
 */
export class OpenStreetMapProvider implements MapProvider {
  private readonly headers = { 'User-Agent': `PawsConnect/1.0 (${env.CLIENT_URL})`, Accept: 'application/json' };
  private readonly cache = new Map<string, { at: number; results: GeocodeResult[] }>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastGeocode = 0;

  /** Runs geocoding requests one at a time, at least a second apart, per Nominatim's usage policy. */
  private throttled<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastGeocode + 1100 - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      this.lastGeocode = Date.now();
      return task();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  async geocode(address: string): Promise<GeocodeResult[]> {
    const key = address.trim().toLowerCase();
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.at < 86_400_000) return cached.results;

    const query = new URLSearchParams({ q: address, format: 'jsonv2', countrycodes: 'ph', limit: '5', addressdetails: '0' });
    const results = await this.throttled(async () => {
      let response: Response;
      try { response = await fetch(`${env.NOMINATIM_URL}/search?${query}`, { headers: this.headers, signal: AbortSignal.timeout(10000) }); }
      catch { throw new ApiError(502, 'MAPS_UNAVAILABLE', 'The address service is temporarily unavailable. You can place the pin on the map instead.'); }
      if (!response.ok) throw new ApiError(502, 'MAPS_UNAVAILABLE', 'The address service could not complete the search. You can place the pin on the map instead.');
      const json = await response.json() as { display_name: string; lat: string; lon: string; place_id: number }[];
      return json.map(r => ({ address: r.display_name, latitude: Number(r.lat), longitude: Number(r.lon), place_id: String(r.place_id) }))
        .filter(r => Number.isFinite(r.latitude) && Number.isFinite(r.longitude));
    });
    if (this.cache.size > 500) this.cache.clear();
    this.cache.set(key, { at: Date.now(), results });
    return results;
  }

  async route(origin: Point, destination: Point): Promise<RouteResult> {
    // OSRM takes longitude,latitude pairs.
    const path = `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}`;
    let response: Response;
    try { response = await fetch(`${env.OSRM_URL}/route/v1/driving/${path}?overview=simplified&geometries=geojson`, { headers: this.headers, signal: AbortSignal.timeout(10000) }); }
    catch { throw new ApiError(502, 'ROUTE_UNAVAILABLE', 'The route service is temporarily unavailable.'); }
    const json = await response.json().catch(() => null) as { code?: string; routes?: { distance: number; duration: number; geometry?: { coordinates?: [number, number][] } }[] } | null;
    if (json?.code === 'NoRoute' || (response.ok && !json?.routes?.length)) throw new ApiError(404, 'ROUTE_NOT_FOUND', 'No drivable route was found between these points.');
    const route = json?.routes?.[0];
    if (!response.ok || !route) throw new ApiError(502, 'ROUTE_UNAVAILABLE', 'The route service could not calculate this route.');
    return {
      distance_meters: Math.round(route.distance),
      duration_seconds: Math.round(route.duration),
      // [latitude, longitude] pairs, ready for a map polyline.
      geometry: (route.geometry?.coordinates ?? []).map(([longitude, latitude]) => [latitude, longitude]),
    };
  }
}

export const maps: MapProvider = new OpenStreetMapProvider();
