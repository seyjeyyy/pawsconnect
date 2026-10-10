import { env } from '../config/env.js';
import { ApiError } from '../utils/errors.js';
type Point = { latitude: number; longitude: number };
export interface MapProvider { geocode(address: string): Promise<unknown>; route(origin: Point, destination: Point): Promise<unknown> }
export class GoogleMapsProvider implements MapProvider {
  private key() { if (!env.GOOGLE_MAPS_SERVER_KEY) throw new ApiError(503, 'MAPS_NOT_CONFIGURED', 'Address search and route preview are not configured. You can enter coordinates manually.'); return env.GOOGLE_MAPS_SERVER_KEY; }
  async geocode(address: string) {
    const query = new URLSearchParams({ address, components: 'country:PH', key: this.key() });
    const response = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?${query}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new ApiError(502, 'MAPS_UNAVAILABLE', 'The address service is temporarily unavailable.');
    const json = await response.json() as { status: string; results: { formatted_address: string; geometry: { location: { lat: number; lng: number } }; place_id: string }[] };
    if (json.status !== 'OK' && json.status !== 'ZERO_RESULTS') throw new ApiError(502, 'MAPS_UNAVAILABLE', 'The map provider could not complete the search.');
    return json.results.map(r => ({ address: r.formatted_address, latitude: r.geometry.location.lat, longitude: r.geometry.location.lng, place_id: r.place_id }));
  }
  async route(origin: Point, destination: Point) {
    const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': this.key(), 'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters,routes.polyline.encodedPolyline' }, body: JSON.stringify({ origin: { location: { latLng: origin } }, destination: { location: { latLng: destination } }, travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', units: 'METRIC' }) });
    if (!response.ok) throw new ApiError(502, 'ROUTE_UNAVAILABLE', 'The route provider could not calculate this route.');
    const json = await response.json() as { routes?: { distanceMeters?: number; duration?: string; polyline?: { encodedPolyline?: string } }[] };
    const route = json.routes?.[0];
    if (!route) throw new ApiError(404, 'ROUTE_NOT_FOUND', 'No drivable route was found between these points.');
    // Provider-neutral shape, so another map provider can be substituted behind this interface.
    return { distance_meters: route.distanceMeters ?? 0, duration_seconds: Number.parseInt(route.duration ?? '0', 10) || 0, encoded_polyline: route.polyline?.encodedPolyline ?? null };
  }
}
export const maps: MapProvider = new GoogleMapsProvider();
