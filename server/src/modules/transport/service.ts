import { db } from '../../config/supabase.js';
import { maps } from '../../integrations/maps.js';
import { ApiError, assertDb } from '../../utils/errors.js';
import { eligibility, type Coverage } from '../geofencing/service.js';
import { shelterLocation, type ShelterLocation } from '../shelter/location.js';

// Everything a shelter transport request needs that the customer does not supply:
// where it starts, how far it is by road, and whether the destination is covered.
type Point = { latitude: number; longitude: number };
export type TransportSettings = { max_distance_km: number | null; base_fee_centavos: number | null; rate_per_km_centavos: number | null; handling_fees: Record<string, number>; surcharges: { label: string; amount_centavos: number }[] };
export type TransportCoverage = { status: Coverage['status']; reason?: 'beyond_max_distance'; max_distance_km?: number };
export type TransportPlan = { shelter: ShelterLocation; route: { distance_km: number; duration_minutes: number; geometry: [number, number][] }; coverage: TransportCoverage; settings: TransportSettings };

// Read on every preview and rarely changed, so it is kept for a minute; an edit through this API clears it.
let cached: { at: number; value: TransportSettings } | null = null;
export async function transportSettings(): Promise<TransportSettings> {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const row = assertDb<Partial<TransportSettings> | null>(await db().from('transport_settings').select('max_distance_km,base_fee_centavos,rate_per_km_centavos,handling_fees,surcharges').maybeSingle());
  const number = (value: unknown) => value === null || value === undefined ? null : Number(value);
  const value: TransportSettings = { max_distance_km: number(row?.max_distance_km), base_fee_centavos: number(row?.base_fee_centavos), rate_per_km_centavos: number(row?.rate_per_km_centavos), handling_fees: row?.handling_fees ?? {}, surcharges: row?.surcharges ?? [] };
  cached = { at: Date.now(), value };
  return value;
}
export const forgetTransportSettings = () => { cached = null; };

/** Coverage is decided by the destination: the service zones first, then the optional maximum driving distance. */
export function classifyCoverage(zones: Pick<Coverage, 'status'>, distanceKm: number, settings: Pick<TransportSettings, 'max_distance_km'>): TransportCoverage {
  if (zones.status === 'within_coverage' && settings.max_distance_km !== null && distanceKm > settings.max_distance_km) return { status: 'outside_coverage', reason: 'beyond_max_distance', max_distance_km: settings.max_distance_km };
  return { status: zones.status };
}
/** What the customer is told when a destination cannot be booked as shelter transport, or null when it can. */
export function coverageBlock(coverage: TransportCoverage): { code: string; message: string } | null {
  if (coverage.status === 'outside_coverage') return { code: 'OUTSIDE_COVERAGE', message: 'This location is outside our delivery area. You can send an Alternative request and our staff will review it.' };
  if (coverage.status === 'temporarily_unavailable') return { code: 'COVERAGE_PAUSED', message: 'Shelter transport to this area is paused for now. You can send an Alternative request and our staff will review it.' };
  return null;
}

/** Route from the official shelter and coverage for a destination. Nothing here comes from the browser except the destination point. */
export async function planTransport(destination: Point): Promise<TransportPlan> {
  const shelter = await shelterLocation();
  const [route, zones, settings] = await Promise.all([
    // A distance is either the routing service's answer or nothing: never an estimate of our own.
    maps.route(shelter, destination).catch(() => { throw new ApiError(502, 'ROUTE_UNAVAILABLE', 'We couldn’t calculate the route. Please try again.'); }),
    eligibility('transport', destination.latitude, destination.longitude),
    transportSettings(),
  ]);
  const distance_km = Math.round(route.distance_meters / 100) / 10;
  return { shelter, settings, route: { distance_km, duration_minutes: Math.max(1, Math.round(route.duration_seconds / 60)), geometry: route.geometry }, coverage: classifyCoverage(zones, distance_km, settings) };
}
