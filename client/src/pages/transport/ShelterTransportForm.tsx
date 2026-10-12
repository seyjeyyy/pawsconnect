import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2, ExternalLink, LocateFixed, MapPin, RefreshCw, Search } from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../contexts/AuthContext';
import { useShelterLocation } from '../../components/ShelterPickup';
import './transport.css';

// Leaflet is loaded only when a map is about to be shown, so the form itself appears first.
const TransportMap = lazy(() => import('../../components/transport/TransportMap'));

export type TransportApplication = { id: string; status: string; pets?: { name?: string; species?: string } | null };
type Destination = { landmark: string; street: string; barangay: string; city: string; province: string; latitude?: number; longitude?: number };
type Place = { address: string; street: string; barangay: string; city: string; province: string };
type SearchResult = { address: string; latitude: number; longitude: number; place_id: string };
type Preview = { route: { distance_km: number; duration_minutes: number; geometry: [number, number][] }; coverage: { status: string }; estimate: { total_centavos: number } | null };
type PreviewState = { state: 'idle' } | { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: Preview };

const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const speciesOptions = ['dog', 'cat', 'other'];
const coverageText: Record<string, string> = { within_coverage: 'Within our delivery area', outside_coverage: 'Outside our delivery area', temporarily_unavailable: 'Delivery to this area is paused for now', manual_review_required: 'Needs a staff review' };
// The schedule is entered and shown in Philippine time, whatever the device's own time zone is.
const manilaNow = () => new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 16);
const manilaToIso = (local: string) => new Date(`${local}:00+08:00`).toISOString();
const scheduleText = (local: string) => local ? new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' }).format(new Date(`${local}:00+08:00`)) : '';
const travelTime = (minutes: number) => minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
const addressLine = (place: Destination) => [place.landmark, place.street, place.barangay, place.city, place.province].map(part => part.trim()).filter(Boolean).join(', ');
const MapFrame = ({ size, children }: { size: 'small' | 'medium'; children: React.ReactNode }) => <Suspense fallback={<div className={`transport-map-loading transport-map-${size}`} role="status">Loading the map…</div>}>{children}</Suspense>;

export function ShelterTransportForm({ applications }: { applications: TransportApplication[] }) {
  const { profile } = useAuth();
  const shelter = useShelterLocation();
  const [adoptionId, setAdoptionId] = useState('');
  const [pet, setPet] = useState({ name: '', species: 'dog', weight: '', notes: '', schedule: '', carrier: false });
  const [destination, setDestination] = useState<Destination>({ landmark: '', street: '', barangay: '', city: '', province: 'Bulacan' });
  const [contact, setContact] = useState({ name: '', phone: '', instructions: '' });
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [nearby, setNearby] = useState<{ point: { latitude: number; longitude: number }; place: Place | null } | null>(null);
  const [locating, setLocating] = useState<'' | 'search' | 'gps' | 'pin'>('');
  const [locationNote, setLocationNote] = useState('');
  const [preview, setPreview] = useState<PreviewState>({ state: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const [confirmed, setConfirmed] = useState(false); const [policy, setPolicy] = useState(false);
  const [submitting, setSubmitting] = useState(false); const [error, setError] = useState('');
  const [done, setDone] = useState<{ reference: string } | null>(null);
  const sending = useRef(false);
  const pinLookup = useRef<{ timer?: ReturnType<typeof setTimeout>; controller?: AbortController }>({});
  const top = useRef<HTMLDivElement>(null);
  // After submitting, bring the confirmation into view and move focus to it.
  useEffect(() => { if (done) { top.current?.scrollIntoView({ block: 'center' }); top.current?.focus({ preventScroll: true }); } }, [done]);

  // The name on the account is a sensible starting point for the contact; the customer can change it.
  useEffect(() => { if (profile?.full_name) setContact(current => current.name ? current : { ...current, name: profile.full_name }); }, [profile?.full_name]);
  useEffect(() => () => { clearTimeout(pinLookup.current.timer); pinLookup.current.controller?.abort(); }, []);

  const linked = applications.find(application => application.id === adoptionId);
  function chooseAdoption(id: string) {
    setAdoptionId(id);
    const animal = applications.find(application => application.id === id)?.pets;
    if (animal) setPet(current => ({ ...current, name: animal.name ?? current.name, species: animal.species && speciesOptions.includes(animal.species) ? animal.species : current.species }));
  }

  const hasPin = destination.latitude !== undefined && destination.longitude !== undefined;
  /** Every way of choosing the destination ends here: one pin, and the confirmation is asked for again. */
  function movePin(point: { latitude: number; longitude: number }, place?: Place | null) {
    setDestination(current => ({ ...current, ...point, ...(place ? { landmark: '', street: place.street, barangay: place.barangay, city: place.city || current.city, province: place.province || current.province } : {}) }));
    setConfirmed(false); setResults(null); setNearby(null);
  }
  const typed = (key: keyof Destination, value: string) => { setDestination(current => ({ ...current, [key]: value })); setConfirmed(false); };

  async function findAddress() {
    setLocating('search'); setLocationNote(''); setResults(null); setNearby(null);
    try {
      const found = await api<SearchResult[]>(`/maps/geocode?address=${encodeURIComponent(addressLine(destination))}`);
      if (found.length) setResults(found);
      else setLocationNote('We couldn’t find that address. Check the spelling, or place the pin on the map yourself.');
    } catch (failure) { setLocationNote(messageOf(failure)); } finally { setLocating(''); }
  }
  function pickOnMap(point: { latitude: number; longitude: number }) {
    movePin(point); setLocationNote('');
    // Dragging fires often; look the address up once the pin has settled, and drop any earlier lookup.
    clearTimeout(pinLookup.current.timer); pinLookup.current.controller?.abort();
    const controller = new AbortController(); pinLookup.current.controller = controller;
    pinLookup.current.timer = setTimeout(async () => {
      setLocating('pin');
      try {
        const place = await api<Place | null>(`/maps/reverse?latitude=${point.latitude}&longitude=${point.longitude}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (place) { movePin(point, place); setLocationNote('We filled in the address for this spot. Please check it and correct anything that is wrong.'); }
        else setLocationNote('We couldn’t find an address for this spot. Please type it in.');
      } catch { if (!controller.signal.aborted) setLocationNote('We couldn’t look up the address for this spot. Please type it in.'); }
      finally { if (!controller.signal.aborted) setLocating(''); }
    }, 700);
  }
  function useMyLocation() {
    setLocationNote(''); setResults(null); setNearby(null);
    if (!navigator.geolocation) { setLocationNote('This device can’t share its location. Search for the address or place the pin on the map instead.'); return; }
    setLocating('gps');
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      const point = { latitude: Math.round(coords.latitude * 1e6) / 1e6, longitude: Math.round(coords.longitude * 1e6) / 1e6 };
      // The customer decides whether to use it: a located position never replaces a destination by itself.
      try { setNearby({ point, place: await api<Place | null>(`/maps/reverse?latitude=${point.latitude}&longitude=${point.longitude}`) }); }
      catch { setNearby({ point, place: null }); }
      finally { setLocating(''); }
    }, failure => {
      setLocating('');
      setLocationNote(failure.code === failure.PERMISSION_DENIED ? 'Location access was not allowed. You can still search for the address or place the pin on the map.' : 'We couldn’t get your location. You can still search for the address or place the pin on the map.');
    }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 });
  }

  // Route, coverage and estimate follow the pin: recalculated once it settles, and an answer for an older pin is dropped.
  useEffect(() => {
    if (destination.latitude === undefined || destination.longitude === undefined) { setPreview({ state: 'idle' }); return; }
    setPreview({ state: 'loading' });
    const controller = new AbortController();
    const body = JSON.stringify({ destination: { latitude: destination.latitude, longitude: destination.longitude } });
    const timer = setTimeout(async () => {
      try { setPreview({ state: 'ready', data: await api<Preview>('/transport/preview', { method: 'POST', body, signal: controller.signal }) }); }
      catch (failure) { if (!controller.signal.aborted) setPreview({ state: 'error', message: messageOf(failure) }); }
    }, 600);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [destination.latitude, destination.longitude, attempt]);

  const ready = preview.state === 'ready' ? preview.data : null;
  const phoneValid = /^9\d{9}$/.test(contact.phone);
  const missing = [
    !hasPin && 'place the destination pin',
    hasPin && preview.state !== 'ready' && 'wait for the route to be calculated',
    !confirmed && 'confirm the destination',
    !policy && 'accept the transport policy',
  ].filter(Boolean) as string[];

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending.current || missing.length) return;
    if (!pet.schedule || Date.parse(manilaToIso(pet.schedule)) <= Date.now()) { setError('Choose a date and time in the future.'); return; }
    sending.current = true; setSubmitting(true); setError('');
    try {
      const saved = await api<{ id: string }>('/transport/requests', { method: 'POST', body: JSON.stringify({
        adoption_application_id: adoptionId || undefined,
        pet_name: pet.name.trim(), pet_species: pet.species, pet_weight_kg: Number(pet.weight), has_carrier: pet.carrier,
        handling_requirements: pet.notes.trim() || undefined, preferred_schedule: manilaToIso(pet.schedule),
        dropoff_street: [destination.landmark, destination.street].map(part => part.trim()).filter(Boolean).join(', '), dropoff_barangay: destination.barangay.trim(), dropoff_city: destination.city.trim(), dropoff_province: destination.province.trim(),
        dropoff_latitude: destination.latitude, dropoff_longitude: destination.longitude,
        contact_name: contact.name.trim(), contact_phone: `+63${contact.phone}`, delivery_instructions: contact.instructions.trim() || undefined,
        destination_confirmed: true, policy_accepted: true,
      }) });
      setDone({ reference: saved.id.slice(0, 8).toUpperCase() });
    } catch (failure) { setError(messageOf(failure)); }
    finally { sending.current = false; setSubmitting(false); }
  }

  if (done) return <div className="card transport-done" ref={top} role="status" tabIndex={-1}>
    <CheckCircle2 size={34} />
    <h2>Request received</h2>
    <p className="transport-reference">Reference <strong>{done.reference}</strong></p>
    <ol>
      <li>Shelter staff review the pet’s needs, the route and the schedule.</li>
      <li>They send you a quotation. Nothing is charged before you accept it.</li>
      <li>Once you accept and pay, the trip is scheduled and you can follow it in your account.</li>
    </ol>
    <div className="table-actions"><Link className="btn btn-primary" to="/account/transport">View my transport requests <ArrowRight size={16} /></Link></div>
  </div>;

  return <form className="transport-form" onSubmit={submit}>
    <fieldset className="card transport-section">
      <legend><span>1</span>Pet</legend>
      <label className="field">Related adoption (if any)<select value={adoptionId} onChange={event => chooseAdoption(event.target.value)}><option value="">Not related to an adoption</option>{applications.map(application => <option value={application.id} key={application.id}>{application.pets?.name || 'Adoption'} · {application.status.replaceAll('_', ' ')}</option>)}</select></label>
      {linked?.pets && <p className="muted small">Name and species come from the shelter’s record for {linked.pets.name}. The record has no weight, so please enter it.</p>}
      <div className="form-grid">
        <label className="field">Pet name<input value={pet.name} onChange={event => setPet({ ...pet, name: event.target.value })} required maxLength={100} readOnly={Boolean(linked?.pets?.name)} /></label>
        <label className="field">Species<select value={pet.species} onChange={event => setPet({ ...pet, species: event.target.value })} disabled={Boolean(linked?.pets?.species)}>{speciesOptions.map(option => <option value={option} key={option}>{option[0].toUpperCase() + option.slice(1)}</option>)}</select></label>
        <label className="field">Weight in kilograms<input type="number" inputMode="decimal" min="0.1" max="150" step="0.1" value={pet.weight} onChange={event => setPet({ ...pet, weight: event.target.value })} required /></label>
        <label className="field">Preferred date and time (Philippine time)<input type="datetime-local" min={manilaNow()} value={pet.schedule} onChange={event => setPet({ ...pet, schedule: event.target.value })} required /></label>
      </div>
      <label className="field">Handling notes<textarea rows={3} value={pet.notes} onChange={event => setPet({ ...pet, notes: event.target.value })} maxLength={2000} placeholder="Temperament, health considerations, crate size" /></label>
    </fieldset>

    <fieldset className="card transport-section">
      <legend><span>2</span>Pickup</legend>
      {shelter.isLoading ? <p className="muted" role="status">Loading the shelter location…</p>
        : shelter.error || !shelter.data ? <div className="notice error" role="alert"><p>We couldn’t load the shelter location. Please try again.</p><button type="button" className="btn btn-secondary" onClick={() => shelter.refetch()}><RefreshCw size={16} />Retry</button></div>
        : <div className="transport-pickup">
          <div><strong>{shelter.data.name}</strong>{shelter.data.formatted_address ? <p>{shelter.data.formatted_address}</p> : <p className="muted small">The street address is being confirmed by the shelter. The map shows the exact spot.</p>}
            <p className="muted small">Every shelter transport starts here. You only choose the destination.</p>
            {shelter.data.google_maps_url && <a className="text-button" href={shelter.data.google_maps_url} target="_blank" rel="noreferrer"><ExternalLink size={15} />View on Google Maps</a>}</div>
          <MapFrame size="small"><TransportMap size="small" label={`Map showing ${shelter.data.name}, the pickup point`} shelter={shelter.data} /></MapFrame>
        </div>}
    </fieldset>

    <fieldset className="card transport-section">
      <legend><span>3</span>Destination</legend>
      <p className="muted small">Search for the address, use your current location, or click the map to place the pin. You can drag the pin to adjust it.</p>
      <div className="form-grid">
        <label className="field">House no., building or landmark<input value={destination.landmark} onChange={event => typed('landmark', event.target.value)} maxLength={120} /></label>
        <label className="field">Street<input value={destination.street} onChange={event => typed('street', event.target.value)} required minLength={3} maxLength={170} /></label>
        <label className="field">Barangay<input value={destination.barangay} onChange={event => typed('barangay', event.target.value)} required maxLength={100} /></label>
        <label className="field">City / municipality<input value={destination.city} onChange={event => typed('city', event.target.value)} required minLength={2} maxLength={100} /></label>
        <label className="field">Province<input value={destination.province} onChange={event => typed('province', event.target.value)} required minLength={2} maxLength={100} /></label>
      </div>
      <div className="location-actions">
        <button type="button" className="btn btn-secondary" onClick={findAddress} disabled={Boolean(locating) || addressLine(destination).length < 8}><Search size={16} />{locating === 'search' ? 'Searching…' : 'Find address'}</button>
        <button type="button" className="btn btn-secondary" onClick={useMyLocation} disabled={Boolean(locating)}><LocateFixed size={16} />{locating === 'gps' ? 'Locating…' : 'Use my location'}</button>
      </div>
      {results && <div className="transport-choices" role="group" aria-label="Matching places"><p className="small"><strong>Choose the matching place</strong> to put the pin there. Your typed address stays as it is.</p>{results.map(result => <button type="button" key={result.place_id} onClick={() => { movePin({ latitude: result.latitude, longitude: result.longitude }); setLocationNote('Pin placed. Drag it if the spot is not exact.'); }}><MapPin size={15} />{result.address}</button>)}</div>}
      {nearby && <div className="notice transport-nearby" role="status"><p><strong>Your current location{nearby.place ? ':' : ' was found.'}</strong> {nearby.place?.address ?? 'We couldn’t find an address for it, so you would need to type it in.'}</p><div className="table-actions"><button type="button" className="btn btn-primary" onClick={() => { movePin(nearby.point, nearby.place); setLocationNote('Pin placed at your location. Please check the address.'); }}>{hasPin ? 'Replace my destination with this' : 'Use this as the destination'}</button><button type="button" className="btn btn-secondary" onClick={() => setNearby(null)}>{hasPin ? 'Keep my destination' : 'Cancel'}</button></div></div>}
      {locationNote && <p className="notice" role="status">{locationNote}</p>}
      {shelter.data && <MapFrame size="medium"><TransportMap label="Destination map. Click to place the pin, or drag the pin to adjust it." shelter={shelter.data} destination={hasPin ? { latitude: destination.latitude!, longitude: destination.longitude! } : null} onPick={pickOnMap} /></MapFrame>}
      <p className="muted small" role="status">{locating === 'pin' ? 'Looking up the address for this spot…' : hasPin ? 'The blue pin marks the destination.' : 'No pin yet. The orange marker is the shelter.'}</p>
      <div className="form-grid">
        <label className="field">Contact name at the destination<input value={contact.name} onChange={event => setContact({ ...contact, name: event.target.value })} required minLength={2} maxLength={120} autoComplete="name" /></label>
        <label className="field">Mobile number<span className="transport-phone"><span aria-hidden="true">+63</span><input type="tel" inputMode="numeric" aria-label="Mobile number, ten digits after +63" value={contact.phone} onChange={event => setContact({ ...contact, phone: event.target.value.replace(/\D/g, '').replace(/^(63|0)(?=9)/, '').slice(0, 10) })} placeholder="9XXXXXXXXX" required pattern="9[0-9]{9}" title="Ten digits starting with 9" autoComplete="tel-national" /></span></label>
      </div>
      <label className="field">Delivery instructions<textarea rows={2} value={contact.instructions} onChange={event => setContact({ ...contact, instructions: event.target.value })} maxLength={1000} placeholder="Gate colour, who to ask for, where to park" /></label>
    </fieldset>

    <details className="card transport-summary" open>
      <summary><span><span className="transport-step">4</span>Route and estimate</span>{ready && <span className="muted small">{ready.route.distance_km} km · {travelTime(ready.route.duration_minutes)}</span>}</summary>
      {shelter.data && hasPin && <MapFrame size="medium"><TransportMap label="Route from the shelter to the destination" shelter={shelter.data} destination={{ latitude: destination.latitude!, longitude: destination.longitude! }} route={ready?.route.geometry ?? null} /></MapFrame>}
      <div aria-live="polite">
        {preview.state === 'idle' && <p className="muted">Choose a destination to see the route, travel time and coverage.</p>}
        {preview.state === 'loading' && <p className="muted" role="status">Calculating the route…</p>}
        {preview.state === 'error' && <div className="notice error" role="alert"><p>{preview.message}</p><button type="button" className="btn btn-secondary" onClick={() => setAttempt(count => count + 1)}><RefreshCw size={16} />Retry</button></div>}
        {ready && <>
          <dl className="transport-facts">
            <div><dt>Road distance</dt><dd>{ready.route.distance_km} km</dd></div>
            <div><dt>Travel time</dt><dd>About {travelTime(ready.route.duration_minutes)}</dd></div>
            <div><dt>Coverage</dt><dd><span className={`badge transport-coverage-${ready.coverage.status}`}>{coverageText[ready.coverage.status] ?? ready.coverage.status.replaceAll('_', ' ')}</span></dd></div>
          </dl>
          <div className="transport-estimate"><h3>Price</h3><p>Staff will send you a quote after reviewing your request.</p></div>
        </>}
      </div>
      <dl className="transport-recap">
        <div><dt>Pet</dt><dd>{pet.name ? `${pet.name} · ${pet.species}${pet.weight ? ` · ${pet.weight} kg` : ''}` : <span className="muted">Not entered yet</span>}</dd></div>
        <div><dt>When</dt><dd>{scheduleText(pet.schedule) || <span className="muted">Not chosen yet</span>}</dd></div>
        <div><dt>From</dt><dd>{shelter.data?.name ?? <span className="muted">Loading…</span>}</dd></div>
        <div><dt>To</dt><dd>{destination.street || destination.city ? addressLine(destination) : <span className="muted">Not chosen yet</span>}</dd></div>
      </dl>
    </details>

    <fieldset className="card transport-section">
      <legend><span>5</span>Review and submit</legend>
      <label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={!hasPin} />I confirm the destination: the address and the pin on the map are correct.</label>
      <label className="checkbox-label"><input type="checkbox" checked={policy} onChange={event => setPolicy(event.target.checked)} /><span>I have read and accept the <Link to="/terms" target="_blank">pet transport policy</Link>.</span></label>
      <label className="checkbox-label"><input type="checkbox" checked={pet.carrier} onChange={event => setPet({ ...pet, carrier: event.target.checked })} />I have a suitable, secure pet carrier or crate.</label>
      {error && <div className="notice error" role="alert">{error}</div>}
      {missing.length > 0 && <p className="muted small">Before you can submit: {missing.join(', ')}.</p>}
      <button className="btn btn-primary" disabled={submitting || missing.length > 0}>{submitting ? 'Sending request…' : 'Submit transport request'}<ArrowRight size={17} /></button>
    </fieldset>
  </form>;
}
