import { db } from '../../config/supabase.js';
import { ApiError, assertDb } from '../../utils/errors.js';

// One booking with everything a screen needs, shaped for who is looking. The service role reads
// everything, so the narrowing happens here: a customer gets their own booking, a driver only a
// booking assigned to them and nothing about money or staff notes, staff get it all.
export type TransportView = 'staff' | 'driver' | 'customer';
type Row = Record<string, unknown> & { id: string; user_id: string; driver_id: string | null; vehicle_id: string | null };
const names = async (ids: (string | null | undefined)[]) => {
  const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (!wanted.length) return new Map<string, string>();
  const rows = assertDb<{ id: string; full_name: string | null }[]>(await db().from('profiles').select('id,full_name').in('id', wanted));
  return new Map(rows.map(row => [row.id, row.full_name ?? '']));
};
const moneyFields = ['fee_centavos', 'paid_at', 'estimate_breakdown', 'estimate_total_centavos', 'fuel_cost_centavos', 'staff_cost_centavos', 'other_cost_centavos'];

export async function transportDetail(id: string, view: TransportView, actorId: string) {
  let query = db().from('transport_requests').select('*').eq('id', id);
  if (view === 'customer') query = query.eq('user_id', actorId);
  if (view === 'driver') query = query.eq('driver_id', actorId);
  const booking = assertDb<Row | null>(await query.maybeSingle());
  if (!booking) throw new ApiError(404, 'NOT_FOUND', 'This transport request was not found.');

  const [events, handover, quotes, notes, vehicle] = await Promise.all([
    db().from('transport_tracking_events').select('id,status,notes,actor_id,created_at').eq('transport_request_id', id).order('created_at', { ascending: true }),
    db().from('transport_handovers').select('recipient_name,notes,recipient_confirmed_at').eq('transport_request_id', id).maybeSingle(),
    view === 'driver' ? null : db().from('transport_quotes').select('id,amount_centavos,breakdown,expires_at,accepted_at,created_at').eq('transport_request_id', id).order('created_at', { ascending: false }),
    view === 'staff' ? db().from('transport_internal_notes').select('id,note,author_id,created_at').eq('transport_request_id', id).order('created_at', { ascending: true }) : null,
    booking.vehicle_id ? db().from('shelter_vehicles').select('name,plate_number').eq('id', booking.vehicle_id).maybeSingle() : null,
  ]);
  const history = assertDb<{ id: string; status: string; notes: string | null; actor_id: string; created_at: string }[]>(events);
  const staffNotes = notes ? assertDb<{ id: string; note: string; author_id: string; created_at: string }[]>(notes) : [];
  // Customers see who their driver is; staff also see who wrote each note and made each change.
  const people = await names([booking.driver_id, ...(view === 'customer' ? [] : [booking.user_id]), ...(view === 'staff' ? [...history.map(event => event.actor_id), ...staffNotes.map(note => note.author_id)] : [])]);

  const shown: Record<string, unknown> = { ...booking };
  if (view === 'driver') for (const key of moneyFields) delete shown[key];
  return {
    ...shown,
    customer_name: view === 'customer' ? undefined : people.get(booking.user_id) || null,
    driver_name: booking.driver_id ? people.get(booking.driver_id) || null : null,
    vehicle: vehicle ? assertDb(vehicle) : null,
    history: history.map(event => ({ id: event.id, status: event.status, notes: event.notes, created_at: event.created_at, ...(view === 'staff' ? { actor_name: people.get(event.actor_id) || null } : {}) })),
    handover: assertDb(handover),
    ...(quotes ? { quotes: assertDb(quotes) } : {}),
    ...(view === 'staff' ? { internal_notes: staffNotes.map(note => ({ id: note.id, note: note.note, created_at: note.created_at, author_name: people.get(note.author_id) || null })) } : {}),
  };
}
