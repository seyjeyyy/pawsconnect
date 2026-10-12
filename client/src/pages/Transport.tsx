import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, CheckCircle2, LogIn, Truck } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../contexts/AuthContext';
import { LocationPicker, emptyLocation, type LocationValue } from '../components/LocationPicker';
import { CoverageCheck, Feedback, ServiceHeading, messageOf, post } from './Services';
import { ShelterTransportForm, type TransportApplication } from './transport/ShelterTransportForm';
import './features.css';
import './transport/transport.css';

export function TransportPage() {
  const { user, loading } = useAuth();
  const [alternative, setAlternative] = useState(false);
  // A destination carried over from the Shelter transport tab when it turned out to be outside the delivery area.
  const [carried, setCarried] = useState<LocationValue | null>(null);
  const applications = useQuery({ queryKey: ['my-applications', user?.id], queryFn: () => api<TransportApplication[]>('/adoption-applications/mine'), enabled: !!user });
  return <div className="page"><div className="container">
    <ServiceHeading eyebrow="SAFE JOURNEYS. HAPPY ARRIVALS." title="A little help getting there." description="Request careful, shelter-managed transportation for your pet within approved Bulacan service areas." />
    {loading ? <div className="dashboard-skeleton" aria-label="Loading"><div /><div /></div>
      : !user ? <div className="card transport-guest">
        <Truck size={28} />
        <h2>Sign in to request pet transport</h2>
        <p>Transport requests are tied to your account so the shelter can send you a quotation and you can follow the trip.</p>
        <ul><li>Your pet’s name, species and weight</li><li>The destination address</li><li>A contact name and mobile number</li></ul>
        <div className="table-actions"><Link className="btn btn-primary" to="/auth/login?next=/transport"><LogIn size={17} />Sign in</Link><Link className="btn btn-secondary" to="/auth/register?next=/transport">Create an account</Link></div>
      </div>
      : <>
        <div className="feature-toolbar transport-toolbar"><div className="tabs"><button type="button" className={!alternative ? 'active' : ''} onClick={() => setAlternative(false)}>Shelter transport</button><button type="button" className={alternative ? 'active' : ''} onClick={() => setAlternative(true)}>Alternative request</button></div><Link className="text-button" to="/account/transport">Track my transport requests <ArrowRight size={15} /></Link></div>
        {alternative ? <AlternativeRequest applications={applications.data ?? []} destination={carried} /> : <ShelterTransportForm applications={applications.data ?? []} onAlternative={destination => { setCarried(destination); setAlternative(true); window.scrollTo({ top: 0 }); }} />}
      </>}
    <div className="transport-notes">
      <div className="card sidebar-tint"><div className="feature-icon"><Truck /></div><h3>Handled with care, every step of the way.</h3><p>Live pets travel through shelter-managed arrangements with appropriate handling, never through an ordinary parcel booking.</p></div>
      <div className="card"><h3>Before your journey</h3><ul className="check-list"><li><CheckCircle2 size={18} />Provide accurate pet and location details.</li><li><CheckCircle2 size={18} />Wait for staff confirmation and a quotation.</li><li><CheckCircle2 size={18} />Prepare a secure carrier and care instructions.</li><li><CheckCircle2 size={18} />Be available for a verified handover.</li></ul></div>
    </div>
  </div></div>;
}

/** A request for an arrangement other than shelter-operated transport. Staff assess each one; nothing is automatic. */
function AlternativeRequest({ applications, destination }: { applications: TransportApplication[]; destination: LocationValue | null }) {
  const [pickup, setPickup] = useState<LocationValue>(emptyLocation); const [dropoff, setDropoff] = useState<LocationValue>(() => destination ?? emptyLocation());
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [success, setSuccess] = useState('');
  const [route, setRoute] = useState<{ distance_meters?: number; duration_seconds?: number } | null>(null);
  async function previewRoute() { setError(''); try { setRoute(await api('/maps/route', post({ origin: { latitude: pickup.latitude, longitude: pickup.longitude }, destination: { latitude: dropoff.latitude, longitude: dropoff.longitude } }))); } catch (failure) { setError(messageOf(failure)); } }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const data = Object.fromEntries(new FormData(event.currentTarget)); setBusy(true); setError(''); setSuccess('');
    try {
      const where = (place: LocationValue) => [place.address, place.barangay, place.city, place.province].filter(Boolean).join(', ');
      const text = (value: unknown) => String(value ?? '').trim() || undefined;
      const schedule = new Date(String(data.scheduled_at)).toISOString();
      const petDetails = `${data.pet_name} — ${data.species}, ${data.pet_weight_kg} kg. ${data.crate_available === 'on' ? 'Customer has a secure carrier.' : 'Customer does not have a carrier.'}`;
      const result = await api<{ id: string }>('/transport/alternative-requests', post({ arrangement_type: data.arrangement_type, adoption_application_id: text(data.adoption_application_id), transporter_name: text(data.transporter_name), transporter_contact: text(data.transporter_contact), details: [petDetails, `Pickup: ${where(pickup)}`, `Destination: ${where(dropoff)}`, `Preferred schedule: ${schedule}`, `Contact: ${data.contact_phone}`, text(data.notes)].filter(Boolean).join('\n') }));
      setSuccess(`Alternative request ${result.id.slice(0, 8).toUpperCase()} received. A shelter administrator will assess the arrangement; nothing is approved until you hear back.`);
    } catch (failure) { setError(messageOf(failure)); } finally { setBusy(false); }
  }
  return <form className="card service-form" onSubmit={submit}>
    <div className="feature-toolbar"><h2>Alternative transport request</h2><Truck size={25} /></div>
    <div className="notice">Outside shelter coverage or need another arrangement? Staff can review your request. No carrier acceptance or availability is guaranteed.</div>
    {destination && <div className="notice" role="status">Your destination has been carried over from the shelter transport form. Please add the pickup and the remaining details.</div>}
    <label className="field">How would you like to arrange transport?<select name="arrangement_type" required><option value="self_pickup">I will pick up the pet myself</option><option value="customer_arranged">I will arrange a qualified pet transporter</option><option value="shelter_assisted">I would like the shelter to help coordinate</option></select></label>
    <div className="form-grid"><label className="field">Transporter name (if arranged)<input name="transporter_name" maxLength={150} /></label><label className="field">Transporter contact (if arranged)<input name="transporter_contact" maxLength={150} /></label></div>
    <p className="small muted">An animal is released only to a person or transporter the shelter has verified.</p>
    <div className="form-grid"><label className="field">Pet name<input name="pet_name" required maxLength={100} /></label><label className="field">Species<select name="species"><option value="dog">Dog</option><option value="cat">Cat</option><option value="other">Other</option></select></label><label className="field">Weight in kilograms<input name="pet_weight_kg" type="number" min="0.1" max="150" step="0.1" required /></label><label className="field">Preferred date and time<input name="scheduled_at" type="datetime-local" min={new Date().toISOString().slice(0, 16)} required /></label></div>
    <label className="field">Related adoption (if applicable)<select name="adoption_application_id" defaultValue=""><option value="">Not related to an adoption</option>{applications.map(application => <option value={application.id} key={application.id}>{application.pets?.name || 'Adoption'} · {application.status.replaceAll('_', ' ')}</option>)}</select></label>
    <LocationPicker value={pickup} onChange={setPickup} label="Pickup location" />
    <LocationPicker value={dropoff} onChange={setDropoff} label="Destination" />
    <div className="location-actions"><CoverageCheck location={pickup} service="transport" /><button type="button" className="btn btn-secondary" onClick={previewRoute} disabled={pickup.latitude === undefined || dropoff.latitude === undefined}>Preview route</button></div>
    {route && <div className="notice">Route estimate: {((route.distance_meters ?? 0) / 1000).toFixed(1)} km{route.duration_seconds ? ` · approximately ${Math.ceil(route.duration_seconds / 60)} minutes` : ''}. Final scheduling and charges are confirmed by staff.</div>}
    <label className="field">Contact number<input name="contact_phone" type="tel" required /></label>
    <label className="field">Care requirements and instructions<textarea name="notes" rows={3} placeholder="Crate size, temperament, health considerations, and pickup instructions" maxLength={5000} /></label>
    <label className="checkbox-label"><input type="checkbox" name="crate_available" />I have a suitable, secure pet carrier or crate.</label>
    <Feedback error={error} success={success} />
    <button className="btn btn-primary" disabled={busy}>{busy ? 'Sending request…' : 'Submit for staff assessment'}<ArrowRight size={17} /></button>
  </form>;
}
