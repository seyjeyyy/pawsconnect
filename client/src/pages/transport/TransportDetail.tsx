import { lazy, Suspense } from 'react';
import { ExternalLink, MapPin, Navigation, PawPrint, Phone } from 'lucide-react';
import { money } from '../../lib/api';
import './transport.css';

const TransportMap = lazy(() => import('../../components/transport/TransportMap'));

// One booking, shown the same way to the customer, staff and the assigned driver: the same pickup,
// destination and route. What differs is what each may see (the API decides) and what each may do.
export type TransportView = 'staff' | 'driver' | 'customer';
export type Booking = {
  id: string; reference: string; status: string; coverage_status: string; created_at: string;
  pet_details: string; pet_name: string | null; pet_species: string | null; pet_weight_kg: number | string | null; has_carrier: boolean | null;
  handling_requirements: string | null; delivery_instructions: string | null;
  shelter_location_id: string | null; pickup_name: string | null; pickup_address: string; pickup_latitude: number; pickup_longitude: number;
  dropoff_address: string; dropoff_latitude: number; dropoff_longitude: number;
  route_distance_km: number | string | null; route_duration_minutes: number | null; route_geometry: [number, number][] | null;
  preferred_schedule: string; confirmed_schedule: string | null; contact_name: string | null; contact_phone: string;
  estimate_breakdown?: { lines: { label: string; amount_centavos: number }[] } | null; estimate_total_centavos?: number | null; fee_centavos?: number | null; paid_at?: string | null;
  customer_name?: string | null; driver_id: string | null; driver_name: string | null; vehicle: { name: string; plate_number: string } | null;
  history: { id: string; status: string; notes: string | null; created_at: string; actor_name?: string | null }[];
  handover: { recipient_name: string; notes: string; recipient_confirmed_at: string } | null;
  quotes?: { id: string; amount_centavos: number; expires_at: string; accepted_at: string | null; created_at: string }[];
  internal_notes?: { id: string; note: string; created_at: string; author_name: string | null }[];
};

export const statusLabel = (status: string) => ({ arrived: 'Delivered, awaiting handover', picked_up: 'Picked up', in_transit: 'In transit', under_review: 'Under review' } as Record<string, string>)[status] ?? status.replaceAll('_', ' ').replace(/^\w/, letter => letter.toUpperCase());
export const coverageLabel: Record<string, string> = { within_coverage: 'Within coverage', outside_coverage: 'Outside coverage', temporarily_unavailable: 'Coverage paused', manual_review_required: 'Needs review' };
export const when = (value: string | null | undefined) => value ? new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' }).format(new Date(value)) : '—';
export const travelTime = (minutes: number) => minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
/** Driving directions from the saved pickup to the destination, opened in Google Maps. */
export const directionsUrl = (booking: Pick<Booking, 'pickup_latitude' | 'pickup_longitude' | 'dropoff_latitude' | 'dropoff_longitude'>) => `https://www.google.com/maps/dir/?api=1&origin=${booking.pickup_latitude},${booking.pickup_longitude}&destination=${booking.dropoff_latitude},${booking.dropoff_longitude}&travelmode=driving`;

export function StatusBadge({ status }: { status: string }) { return <span className={`badge status-${status}`}>{statusLabel(status)}</span>; }

export function TransportDetail({ booking, view }: { booking: Booking; view: TransportView }) {
  const pickupName = booking.pickup_name ?? 'Pickup';
  return <div className="transport-detail">
    <section className="card transport-detail-route">
      <h3><MapPin size={18} />Route</h3>
      <Suspense fallback={<div className="transport-map-loading transport-map-medium" role="status">Loading the map…</div>}>
        <TransportMap label={`Route from ${pickupName} to the destination`} shelter={{ name: pickupName, latitude: booking.pickup_latitude, longitude: booking.pickup_longitude }} destination={{ latitude: booking.dropoff_latitude, longitude: booking.dropoff_longitude }} route={booking.route_geometry} />
      </Suspense>
      <dl className="transport-recap transport-recap-plain">
        <div><dt>From</dt><dd>{booking.pickup_name && booking.pickup_name !== booking.pickup_address ? <><strong>{booking.pickup_name}</strong><br /></> : null}{booking.pickup_address}{view === 'staff' && <span className="muted small"> ({booking.pickup_latitude}, {booking.pickup_longitude})</span>}{!booking.shelter_location_id && <><br /><span className="muted small">Pickup entered by the customer, before pickups were fixed at the shelter.</span></>}</dd></div>
        <div><dt>To</dt><dd>{booking.dropoff_address}{view === 'staff' && <span className="muted small"> ({booking.dropoff_latitude}, {booking.dropoff_longitude})</span>}</dd></div>
        <div><dt>Road distance</dt><dd>{booking.route_distance_km !== null ? `${Number(booking.route_distance_km)} km` : <span className="muted">Not recorded</span>}{booking.route_duration_minutes !== null && ` · about ${travelTime(booking.route_duration_minutes)}`}</dd></div>
        <div><dt>Coverage</dt><dd><span className={`badge transport-coverage-${booking.coverage_status}`}>{coverageLabel[booking.coverage_status] ?? booking.coverage_status}</span></dd></div>
      </dl>
      {view !== 'customer' && <a className="btn btn-secondary" href={directionsUrl(booking)} target="_blank" rel="noreferrer"><Navigation size={16} />Open in Google Maps</a>}
    </section>

    <section className="card">
      <h3><PawPrint size={18} />Pet and contact</h3>
      <dl className="transport-recap transport-recap-plain">
        <div><dt>Pet</dt><dd>{booking.pet_name ? <>{booking.pet_name} · {booking.pet_species}{booking.pet_weight_kg !== null && ` · ${Number(booking.pet_weight_kg)} kg`}<br /><span className="muted small">{booking.has_carrier ? 'Customer has a secure carrier.' : 'Customer does not have a carrier.'}</span></> : booking.pet_details}</dd></div>
        {booking.handling_requirements && <div><dt>Handling notes</dt><dd className="transport-prose">{booking.handling_requirements}</dd></div>}
        {booking.delivery_instructions && <div><dt>Delivery instructions</dt><dd className="transport-prose">{booking.delivery_instructions}</dd></div>}
        {view !== 'customer' && <div><dt>Customer</dt><dd>{booking.customer_name || <span className="muted">Name not on file</span>}</dd></div>}
        <div><dt>Contact at destination</dt><dd>{booking.contact_name && <>{booking.contact_name}<br /></>}{view === 'customer' ? booking.contact_phone : <a className="text-button" href={`tel:${booking.contact_phone.replace(/[^+\d]/g, '')}`}><Phone size={15} />{booking.contact_phone}</a>}</dd></div>
        <div><dt>Preferred schedule</dt><dd>{when(booking.preferred_schedule)}</dd></div>
        {booking.confirmed_schedule && <div><dt>Confirmed schedule</dt><dd>{when(booking.confirmed_schedule)}</dd></div>}
        {(booking.driver_id || booking.vehicle) && <div><dt>Driver and vehicle</dt><dd>{booking.driver_name || 'Assigned driver'}{booking.vehicle && ` · ${booking.vehicle.name} (${booking.vehicle.plate_number})`}</dd></div>}
      </dl>
    </section>

    {view !== 'driver' && <section className="card">
      <h3>Price</h3>
      {booking.estimate_breakdown?.lines?.length ? <div className="transport-estimate transport-estimate-flush"><h4>Estimate shown when the request was made</h4><dl className="transport-lines">{booking.estimate_breakdown.lines.map(line => <div key={line.label}><dt>{line.label}</dt><dd>{money(line.amount_centavos)}</dd></div>)}<div className="transport-total"><dt>Estimated total</dt><dd>{money(booking.estimate_total_centavos ?? 0)}</dd></div></dl></div>
        : <p className="muted">No estimate was shown: pricing was not set up when this request was made.</p>}
      <dl className="transport-recap transport-recap-plain">
        <div><dt>Final quote</dt><dd>{booking.fee_centavos !== null && booking.fee_centavos !== undefined ? <strong>{money(booking.fee_centavos)}</strong> : <span className="muted">{view === 'customer' ? 'Staff will send you a quote after reviewing your request.' : 'Not quoted yet'}</span>}{booking.paid_at && <span className="badge badge-green"> Paid {when(booking.paid_at)}</span>}</dd></div>
        {booking.quotes?.[0] && <div><dt>Quotation</dt><dd>Sent {when(booking.quotes[0].created_at)} · {booking.quotes[0].accepted_at ? `accepted ${when(booking.quotes[0].accepted_at)}` : `valid until ${when(booking.quotes[0].expires_at)}`}</dd></div>}
      </dl>
    </section>}

    <section className="card">
      <h3>History</h3>
      <ol className="transport-history">
        <li><span>Request received</span><time dateTime={booking.created_at}>{when(booking.created_at)}</time></li>
        {booking.history.map(event => <li key={event.id}><span>{statusLabel(event.status)}{event.actor_name && <span className="muted small"> · {event.actor_name}</span>}{event.notes && <span className="transport-prose muted small">{event.notes}</span>}</span><time dateTime={event.created_at}>{when(event.created_at)}</time></li>)}
        {booking.handover && <li><span>Handed over to {booking.handover.recipient_name}<span className="transport-prose muted small">{booking.handover.notes}</span></span><time dateTime={booking.handover.recipient_confirmed_at}>{when(booking.handover.recipient_confirmed_at)}</time></li>}
      </ol>
      {view === 'customer' && <a className="text-button" href={`https://www.google.com/maps/search/?api=1&query=${booking.pickup_latitude},${booking.pickup_longitude}`} target="_blank" rel="noreferrer"><ExternalLink size={15} />View the pickup point on Google Maps</a>}
    </section>
  </div>;
}
