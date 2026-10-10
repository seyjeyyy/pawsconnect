import { db } from '../../config/supabase.js';
import { assertDb } from '../../utils/errors.js';
export type Coverage = { status: 'within_coverage' | 'outside_coverage' | 'temporarily_unavailable' | 'manual_review_required'; eligible: boolean; zones: { id: string; name: string; fee_centavos: number }[]; fee_centavos: number | null };
export async function eligibility(service_type: string, latitude: number, longitude: number): Promise<Coverage> {
  return assertDb(await db().rpc('check_service_eligibility', { p_service_type: service_type, p_latitude: latitude, p_longitude: longitude })) as Coverage;
}
