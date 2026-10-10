import { useEffect, useRef, useState } from 'react';
import { LocateFixed, MapPin, Search } from 'lucide-react';
import { api } from '../lib/api';

export type LocationValue = { address: string; province: string; city: string; barangay: string; latitude?: number; longitude?: number };
export const emptyLocation = (): LocationValue => ({ address: '', province: 'Bulacan', city: '', barangay: '' });

type MapPoint = { lat(): number; lng(): number };
type GoogleMap = { addListener(name: string, fn: (event: { latLng: MapPoint }) => void): { remove(): void }; setCenter(point: { lat: number; lng: number }): void };
type GoogleMarker = { setPosition(point: { lat: number; lng: number }): void; setMap(map: GoogleMap | null): void };
type GoogleApi = { maps: { Map: new (node: HTMLElement, options: object) => GoogleMap; Marker: new (options: object) => GoogleMarker } };
let mapsPromise: Promise<GoogleApi> | undefined;
function loadMaps(key: string): Promise<GoogleApi> {
  if (!mapsPromise) mapsPromise = new Promise((resolve, reject) => {
    const existing = (window as unknown as { google?: GoogleApi }).google;
    if (existing?.maps) return resolve(existing);
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`;
    script.async = true;
    script.onload = () => {
      const google = (window as unknown as { google?: GoogleApi }).google;
      if (google?.maps) resolve(google); else reject(new Error('The map could not be initialized. Enter your location manually.'));
    };
    script.onerror = () => { mapsPromise = undefined; reject(new Error('The map could not load. You can still enter your location manually.')); };
    document.head.append(script);
  });
  return mapsPromise;
}

export function LocationPicker({ value, onChange, label = 'Location' }: { value: LocationValue; onChange: (value: LocationValue) => void; label?: string }) {
  const mapNode = useRef<HTMLDivElement>(null);
  const map = useRef<GoogleMap | null>(null);
  const marker = useRef<GoogleMarker | null>(null);
  const current = useRef(value);
  const change = useRef(onChange);
  current.current = value;
  change.current = onChange;
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const key = import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined;

  useEffect(() => {
    if (!key || !mapNode.current) return;
    let alive = true;
    let listener: { remove(): void } | undefined;
    loadMaps(key).then((google) => {
      if (!alive || !mapNode.current) return;
      map.current = new google.maps.Map(mapNode.current, { center: { lat: 14.8, lng: 120.9 }, zoom: 11, mapTypeControl: false, streetViewControl: false });
      listener = map.current.addListener('click', (event) => change.current({ ...current.current, latitude: event.latLng.lat(), longitude: event.latLng.lng() }));
      if (current.current.latitude !== undefined && current.current.longitude !== undefined) {
        marker.current = new google.maps.Marker({ map: map.current, position: { lat: current.current.latitude, lng: current.current.longitude } });
      }
    }).catch((error: Error) => setMessage(error.message));
    return () => { alive = false; listener?.remove(); marker.current?.setMap(null); };
  }, [key]);

  useEffect(() => {
    if (!map.current || value.latitude === undefined || value.longitude === undefined) return;
    const point = { lat: value.latitude, lng: value.longitude };
    const google = (window as unknown as { google?: GoogleApi }).google;
    if (marker.current) marker.current.setPosition(point);
    else if (google) marker.current = new google.maps.Marker({ map: map.current, position: point });
    map.current.setCenter(point);
  }, [value.latitude, value.longitude]);

  function useLocation() {
    if (!navigator.geolocation) { setMessage('Location access is not supported. Enter your coordinates manually.'); return; }
    setBusy(true); setMessage('');
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      onChange({ ...value, latitude: coords.latitude, longitude: coords.longitude }); setBusy(false);
    }, () => { setMessage('Location permission was unavailable. You can enter your location manually.'); setBusy(false); }, { timeout: 12000 });
  }
  async function searchAddress() {
    setBusy(true); setMessage('');
    try {
      const results = await api<{ latitude: number; longitude: number; address?: string }[]>(`/maps/geocode?address=${encodeURIComponent([value.address, value.barangay, value.city, value.province, 'Philippines'].filter(Boolean).join(', '))}`);
      const result = results[0];
      if (!result) throw new Error('No location found. Try a nearby landmark or enter coordinates.');
      onChange({ ...value, latitude: result.latitude, longitude: result.longitude });
      setMessage(result.address ? `Located: ${result.address}. Please confirm the pin.` : 'Location found. Please confirm the pin.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Address lookup is unavailable. Enter coordinates manually.'); }
    finally { setBusy(false); }
  }
  return <fieldset className="location-picker">
    <legend><MapPin size={17} /> {label}</legend>
    <label className="field">Street address or landmark<input value={value.address} onChange={(event) => onChange({ ...value, address: event.target.value })} placeholder="Street, building, or nearby landmark" required /></label>
    <div className="form-grid">
      <label className="field">Barangay<input value={value.barangay} onChange={(event) => onChange({ ...value, barangay: event.target.value })} required /></label>
      <label className="field">City / municipality<input value={value.city} onChange={(event) => onChange({ ...value, city: event.target.value })} required /></label>
      <label className="field">Province<input value={value.province} onChange={(event) => onChange({ ...value, province: event.target.value })} required /></label>
    </div>
    <div className="location-actions"><button type="button" className="btn btn-secondary" disabled={busy || !value.address.trim()} onClick={searchAddress}><Search size={16} /> Find address</button><button type="button" className="btn btn-secondary" disabled={busy} onClick={useLocation}><LocateFixed size={16} /> Use my location</button></div>
    {key ? <div className="location-map" ref={mapNode} aria-label={`${label} interactive map. Click to choose a point.`} /> : <div className="map-placeholder"><MapPin size={26} /><span>Enter coordinates or use your location.<small>Interactive maps become available when Google Maps is configured.</small></span></div>}
    <div className="form-grid">
      <label className="field">Latitude<input type="number" min="-90" max="90" step="any" value={value.latitude ?? ''} onChange={(event) => onChange({ ...value, latitude: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="e.g. 14.8" required /></label>
      <label className="field">Longitude<input type="number" min="-180" max="180" step="any" value={value.longitude ?? ''} onChange={(event) => onChange({ ...value, longitude: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="e.g. 120.9" required /></label>
    </div>
    {message && <p className="notice" role="status">{message}</p>}
    <p className="muted small">Coverage is verified by the shelter's configured service zones. GPS access is optional.</p>
  </fieldset>;
}
