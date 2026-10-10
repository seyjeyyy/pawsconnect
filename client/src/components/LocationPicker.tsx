import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { LocateFixed, MapPin, Search } from 'lucide-react';
import { api } from '../lib/api';

export type LocationValue = { address: string; province: string; city: string; barangay: string; latitude?: number; longitude?: number };
export const emptyLocation = (): LocationValue => ({ address: '', province: 'Bulacan', city: '', barangay: '' });

// Opening view: Bulacan province. Only where the map starts, not a service boundary.
const BULACAN: L.LatLngTuple = [14.85, 120.9];
// Drawn with CSS so the pin needs no image files (Leaflet's default marker icons break under bundlers).
const pin = L.divIcon({ className: 'location-pin', html: '<span></span>', iconSize: [28, 28], iconAnchor: [14, 28] });
const round = (value: number) => Math.round(value * 1e6) / 1e6;

export function LocationPicker({ value, onChange, label = 'Location' }: { value: LocationValue; onChange: (value: LocationValue) => void; label?: string }) {
  const mapNode = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const marker = useRef<L.Marker | null>(null);
  // The map's event handlers are attached once; these refs let them see the latest props.
  const current = useRef(value);
  const change = useRef(onChange);
  current.current = value;
  change.current = onChange;
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!mapNode.current) return;
    const instance = L.map(mapNode.current, { center: BULACAN, zoom: 10, scrollWheelZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors',
    }).addTo(instance);
    instance.on('click', event => change.current({ ...current.current, latitude: round(event.latlng.lat), longitude: round(event.latlng.lng) }));
    map.current = instance;
    return () => { instance.remove(); map.current = null; marker.current = null; };
  }, []);

  // Keep the pin in step with the coordinates, however they were set (click, drag, search, GPS or typing).
  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    if (value.latitude === undefined || value.longitude === undefined || Number.isNaN(value.latitude) || Number.isNaN(value.longitude)) {
      marker.current?.remove();
      marker.current = null;
      return;
    }
    const point: L.LatLngTuple = [value.latitude, value.longitude];
    if (marker.current) marker.current.setLatLng(point);
    else {
      marker.current = L.marker(point, { icon: pin, draggable: true, keyboard: false, alt: 'Selected location' }).addTo(instance);
      marker.current.on('dragend', () => {
        const position = marker.current!.getLatLng();
        change.current({ ...current.current, latitude: round(position.lat), longitude: round(position.lng) });
      });
    }
    if (!instance.getBounds().pad(-0.15).contains(point)) instance.setView(point, Math.max(instance.getZoom(), 15));
  }, [value.latitude, value.longitude]);

  function useMyLocation() {
    if (!navigator.geolocation) { setMessage('Location access is not supported on this device. Click the map or enter coordinates instead.'); return; }
    setBusy(true); setMessage('');
    navigator.geolocation.getCurrentPosition(({ coords }) => {
      onChange({ ...value, latitude: round(coords.latitude), longitude: round(coords.longitude) });
      map.current?.setView([coords.latitude, coords.longitude], 16);
      setMessage('Location found. Drag the pin if it is not quite right.');
      setBusy(false);
    }, () => { setMessage('Location permission was not given. Click the map or enter coordinates instead.'); setBusy(false); }, { timeout: 12000 });
  }
  async function searchAddress() {
    setBusy(true); setMessage('');
    try {
      const query = [value.address, value.barangay, value.city, value.province, 'Philippines'].filter(Boolean).join(', ');
      const results = await api<{ latitude: number; longitude: number; address?: string }[]>(`/maps/geocode?address=${encodeURIComponent(query)}`);
      const result = results[0];
      if (!result) throw new Error('No match found. Try a nearby landmark, or click the map to place the pin.');
      onChange({ ...value, latitude: round(result.latitude), longitude: round(result.longitude) });
      map.current?.setView([result.latitude, result.longitude], 16);
      setMessage(`Located: ${result.address ?? 'address found'}. Drag the pin to adjust.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Address lookup is unavailable. Click the map to place the pin.'); }
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
    <div className="location-actions"><button type="button" className="btn btn-secondary" disabled={busy || !value.address.trim()} onClick={searchAddress}><Search size={16} /> Find address</button><button type="button" className="btn btn-secondary" disabled={busy} onClick={useMyLocation}><LocateFixed size={16} /> Use my location</button></div>
    <div className="location-map" ref={mapNode} role="application" aria-label={`${label} map. Click to place the pin, or drag the pin to adjust. Coordinates can also be typed below.`} />
    <div className="form-grid">
      <label className="field">Latitude<input type="number" min="-90" max="90" step="any" value={value.latitude ?? ''} onChange={(event) => onChange({ ...value, latitude: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="e.g. 14.8433" required /></label>
      <label className="field">Longitude<input type="number" min="-180" max="180" step="any" value={value.longitude ?? ''} onChange={(event) => onChange({ ...value, longitude: event.target.value === '' ? undefined : Number(event.target.value) })} placeholder="e.g. 120.8114" required /></label>
    </div>
    {message && <p className="notice" role="status">{message}</p>}
    <p className="muted small">Click the map to place the pin. Service coverage is checked by the shelter’s configured zones, not by the map. Sharing your device location is optional.</p>
  </fieldset>;
}
