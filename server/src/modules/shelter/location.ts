import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../config/supabase.js';
import { authenticate, authorize } from '../../middleware/auth.js';
import { maps } from '../../integrations/maps.js';
import { ApiError, assertDb } from '../../utils/errors.js';
import { point } from '../../utils/validation.js';

// The official shelter location is one database record. Nothing else in the
// client or the API holds the shelter's coordinates or address: read it here.
export const MAIN_SHELTER = 'PAWSCONNECT_MAIN_SHELTER';
export type ShelterLocation = {
  id: string; code: string; name: string; location_type: string; pickup_mode: string;
  latitude: number; longitude: number; google_maps_url: string | null;
  /** Null until an administrator has confirmed it. */
  formatted_address: string | null; address_verified_at: string | null; updated_at: string;
};
const columns = 'id,code,name,location_type,pickup_mode,latitude,longitude,google_maps_url,formatted_address,address_verified_at,updated_at';

// Read on most transport requests and rarely changed, so it is kept for a minute.
// An edit made through this API clears it straight away on the instance that served it.
let cached: { at: number; value: ShelterLocation } | null = null;
export async function shelterLocation(): Promise<ShelterLocation> {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const value = assertDb<ShelterLocation | null>(await db().from('shelter_locations').select(columns).eq('code', MAIN_SHELTER).maybeSingle());
  if (!value) throw new ApiError(503, 'SHELTER_LOCATION_MISSING', 'The shelter location has not been set up yet.');
  cached = { at: Date.now(), value };
  return value;
}
export const forgetShelterLocation = () => { cached = null; };

export const shelterRouter = Router();
shelterRouter.get('/shelter-location', async (_req, res) => {
  res.json({ data: await shelterLocation() });
});

// Shelter administrators and the super administrator. The database function checks again.
const editors = [authenticate, authorize('administrator', 'super_administrator')];
shelterRouter.get('/settings/shelter-location/address-lookup', ...editors, async (req, res) => {
  const input = z.object({ latitude: z.coerce.number().min(-90).max(90), longitude: z.coerce.number().min(-180).max(180) }).strict().parse(req.query);
  res.json({ data: { suggested_address: (await maps.reverse(input))?.address ?? null } });
});
const locationInput = point.extend({
  name: z.string().trim().min(2).max(150),
  google_maps_url: z.string().trim().url().max(500).startsWith('https://').nullable(),
  formatted_address: z.string().trim().min(5).max(500).nullable(),
  reason: z.string().trim().min(5).max(500),
}).strict();
shelterRouter.put('/settings/shelter-location', ...editors, async (req, res) => {
  const input = locationInput.parse(req.body);
  const data = assertDb(await db().rpc('update_shelter_location', { p_actor_id: req.actor!.id, p_code: MAIN_SHELTER, p_name: input.name, p_latitude: input.latitude, p_longitude: input.longitude, p_google_maps_url: input.google_maps_url, p_formatted_address: input.formatted_address, p_reason: input.reason }));
  forgetShelterLocation();
  res.json({ data });
});
