import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, MapPin, Search } from 'lucide-react';
import { api } from '../lib/api';
import { ErrorState } from '../components/common';
import { useConfirmation } from '../components/Confirm';
import './shelter-location.css';

// The official shelter location. Every shelter-operated service starts from this one
// record, so it is edited here only, behind a confirmation, and each change is audited.
export type ShelterLocation = { code: string; name: string; latitude: number; longitude: number; google_maps_url: string | null; formatted_address: string | null; address_verified_at: string | null; updated_at: string };
type Draft = { name: string; latitude: string; longitude: string; google_maps_url: string; formatted_address: string };
const draftOf = (location: ShelterLocation): Draft => ({ name: location.name, latitude: String(location.latitude), longitude: String(location.longitude), google_maps_url: location.google_maps_url ?? '', formatted_address: location.formatted_address ?? '' });
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Unable to complete the request. Please try again.';
const when = (value: string) => new Intl.DateTimeFormat('en-PH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Manila' }).format(new Date(value));

export default function ShelterLocationSettings() {
  const cache = useQueryClient(); const confirm = useConfirmation();
  const location = useQuery({ queryKey: ['shelter-location'], queryFn: ({ signal }) => api<ShelterLocation>('/shelter-location', { signal }) });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const [looking, setLooking] = useState(false); const [saving, setSaving] = useState(false);
  const [error, setError] = useState(''); const [success, setSuccess] = useState('');
  useEffect(() => { if (location.data) setDraft(draftOf(location.data)); }, [location.data]);

  if (location.isLoading) return <div className="dashboard-skeleton" aria-label="Loading the shelter location"><div /><div /><div /></div>;
  if (location.error || !location.data || !draft) return <ErrorState error={location.error} retry={() => location.refetch()} />;
  const saved = location.data;
  const latitude = Number(draft.latitude), longitude = Number(draft.longitude);
  const validPoint = draft.latitude.trim() !== '' && draft.longitude.trim() !== '' && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  const moved = latitude !== saved.latitude || longitude !== saved.longitude;
  const changed = JSON.stringify(draft) !== JSON.stringify(draftOf(saved));
  const set = (key: keyof Draft, value: string) => { setDraft({ ...draft, [key]: value }); setSuccess(''); if (key === 'latitude' || key === 'longitude') setSuggestion(null); };

  async function lookUp() {
    setLooking(true); setError(''); setSuggestion(null);
    try {
      const result = await api<{ suggested_address: string | null }>(`/settings/shelter-location/address-lookup?latitude=${latitude}&longitude=${longitude}`);
      if (result.suggested_address) setSuggestion(result.suggested_address);
      else setError('The map service has no address for these coordinates. Enter the address yourself once you have verified it.');
    } catch (failure) { setError(messageOf(failure)); } finally { setLooking(false); }
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (saving) return;
    const address = draft!.formatted_address.trim();
    const answer = await confirm({
      title: 'Change the official shelter location?',
      description: `Every new shelter transport request will start from this location. Bookings already saved keep the pickup they were made with.${address ? ' By saving, you confirm that the address below is the shelter’s correct address.' : ''}`,
      resource: `${draft!.name.trim()} · ${latitude}, ${longitude}${address ? ` · ${address}` : ' · address not confirmed'}`,
      reason: true, confirmLabel: 'Save shelter location',
    });
    if (!answer.confirmed) return;
    setSaving(true); setError(''); setSuccess('');
    try {
      await api('/settings/shelter-location', { method: 'PUT', body: JSON.stringify({ name: draft!.name.trim(), latitude, longitude, google_maps_url: draft!.google_maps_url.trim() || null, formatted_address: address || null, reason: answer.reason.trim() }) });
      await cache.invalidateQueries({ queryKey: ['shelter-location'] });
      setSuggestion(null); setSuccess('The shelter location has been saved and the change recorded in the audit trail.');
    } catch (failure) { setError(messageOf(failure)); } finally { setSaving(false); }
  }

  return <div className="shelter-location">
    <article className="card shelter-location-current">
      <h2><MapPin size={20} />{saved.name}</h2>
      <dl>
        <div><dt>Address</dt><dd>{saved.formatted_address ? <>{saved.formatted_address} <span className="badge">Confirmed {when(saved.address_verified_at!)}</span></> : <span className="muted">Not confirmed yet. Customers are shown the map pin only until an administrator confirms the address.</span>}</dd></div>
        <div><dt>Coordinates</dt><dd>{saved.latitude}, {saved.longitude}</dd></div>
        <div><dt>Used for</dt><dd>The fixed starting point of every shelter transport request.</dd></div>
        <div><dt>Last changed</dt><dd>{when(saved.updated_at)}</dd></div>
      </dl>
      {saved.google_maps_url && <a className="btn btn-secondary" href={saved.google_maps_url} target="_blank" rel="noreferrer"><ExternalLink size={16} />View on Google Maps</a>}
    </article>

    <form className="card service-form" onSubmit={save}>
      <div><h2>Edit the shelter location</h2><p className="muted small">Only administrators can change this. You will be asked to confirm and give a reason, and the change is recorded in the audit trail.</p></div>
      <label className="field">Shelter name<input value={draft.name} onChange={event => set('name', event.target.value)} required minLength={2} maxLength={150} /></label>
      <div className="form-grid">
        <label className="field">Latitude<input type="number" inputMode="decimal" min="-90" max="90" step="any" value={draft.latitude} onChange={event => set('latitude', event.target.value)} required /></label>
        <label className="field">Longitude<input type="number" inputMode="decimal" min="-180" max="180" step="any" value={draft.longitude} onChange={event => set('longitude', event.target.value)} required /></label>
      </div>
      {validPoint && <a className="text-button" href={`https://www.google.com/maps?q=${latitude},${longitude}`} target="_blank" rel="noreferrer"><ExternalLink size={15} />Check these coordinates on a map</a>}
      <label className="field">Google Maps link<input type="url" value={draft.google_maps_url} onChange={event => set('google_maps_url', event.target.value)} placeholder="https://maps.app.goo.gl/…" maxLength={500} pattern="https://.*" /></label>
      <label className="field">Shelter address<textarea rows={3} value={draft.formatted_address} onChange={event => set('formatted_address', event.target.value)} minLength={5} maxLength={500} placeholder="Leave empty until the address has been verified" /></label>
      <p className="muted small">Saving an address here confirms it as correct. Look it up from the coordinates, compare it with the shelter’s real address, and correct it before you save.{moved && saved.formatted_address ? ' The coordinates have changed, so check that the address still describes this spot.' : ''}</p>
      <button type="button" className="btn btn-secondary" onClick={lookUp} disabled={looking || !validPoint}><Search size={16} />{looking ? 'Looking up…' : 'Look up address from coordinates'}</button>
      {suggestion && <div className="notice shelter-location-suggestion" role="status"><p><strong>The map service suggests:</strong> {suggestion}</p><p className="small">This is a suggestion from OpenStreetMap, not a verified address.</p><button type="button" className="btn btn-secondary" onClick={() => { set('formatted_address', suggestion); setSuggestion(null); }}>Use as a starting point</button></div>}
      {error && <div className="notice error" role="alert">{error}</div>}
      {success && <div className="notice success" role="status"><Check size={17} />{success}</div>}
      <button className="btn btn-primary" disabled={saving || !changed || !validPoint}>{saving ? 'Saving…' : 'Review and save'}</button>
    </form>
  </div>;
}
