import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './transport-map.css';

export type MapPoint = { latitude: number; longitude: number };
type Props = {
  label: string;
  shelter: MapPoint & { name: string };
  destination?: MapPoint | null;
  /** [latitude, longitude] pairs of the driving route, when one has been calculated. */
  route?: [number, number][] | null;
  /** Given, the destination pin can be placed by clicking the map and moved by dragging. */
  onPick?: (point: MapPoint) => void;
  size?: 'small' | 'medium';
};

// Drawn in the page, so the markers need no image files (Leaflet's default icons break under bundlers).
const paw = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><ellipse cx="6" cy="10" rx="2" ry="2.6"/><ellipse cx="10" cy="6" rx="2" ry="2.6"/><ellipse cx="14" cy="6" rx="2" ry="2.6"/><ellipse cx="18" cy="10" rx="2" ry="2.6"/><path d="M12 11c-2.8 0-5 2.4-5 4.9 0 1.7 1.3 2.6 2.7 2.6 1 0 1.5-.4 2.3-.4s1.3.4 2.3.4c1.4 0 2.7-.9 2.7-2.6C17 13.4 14.8 11 12 11z"/></svg>';
const shelterIcon = L.divIcon({ className: 'transport-marker transport-marker-shelter', html: `<span>${paw}</span>`, iconSize: [36, 36], iconAnchor: [18, 18] });
const destinationIcon = L.divIcon({ className: 'transport-marker transport-marker-destination', html: '<span></span>', iconSize: [28, 28], iconAnchor: [14, 28] });
const round = (value: number) => Math.round(value * 1e6) / 1e6;
const at = (point: MapPoint): L.LatLngTuple => [point.latitude, point.longitude];

export default function TransportMap({ label, shelter, destination, route, onPick, size = 'medium' }: Props) {
  const node = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layers = useRef<{ shelter?: L.Marker; destination?: L.Marker; route?: L.Polyline }>({});
  // Handlers are attached once; this ref lets them call the latest callback.
  const pick = useRef(onPick); pick.current = onPick;

  useEffect(() => {
    if (!node.current) return;
    const instance = L.map(node.current, { center: at(shelter), zoom: 12, scrollWheelZoom: false });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a> contributors' }).addTo(instance);
    instance.on('click', event => pick.current?.({ latitude: round(event.latlng.lat), longitude: round(event.latlng.lng) }));
    map.current = instance;
    // A map created while its box is hidden or still being laid out draws grey; re-measure whenever the box changes.
    const observer = new ResizeObserver(() => instance.invalidateSize());
    observer.observe(node.current);
    return () => { observer.disconnect(); instance.remove(); map.current = null; layers.current = {}; };
    // The map is created once; the effects below keep it in step with the props.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const instance = map.current; if (!instance) return;
    const drawn = layers.current;
    if (drawn.shelter) drawn.shelter.setLatLng(at(shelter));
    else drawn.shelter = L.marker(at(shelter), { icon: shelterIcon, keyboard: false, interactive: false, alt: shelter.name }).addTo(instance);

    if (!destination) { drawn.destination?.remove(); drawn.destination = undefined; }
    else if (drawn.destination) drawn.destination.setLatLng(at(destination));
    else {
      drawn.destination = L.marker(at(destination), { icon: destinationIcon, draggable: Boolean(onPick), keyboard: false, alt: 'Destination', zIndexOffset: 500 }).addTo(instance);
      drawn.destination.on('dragend', () => { const position = drawn.destination!.getLatLng(); pick.current?.({ latitude: round(position.lat), longitude: round(position.lng) }); });
    }

    drawn.route?.remove(); drawn.route = undefined;
    if (route?.length) drawn.route = L.polyline(route, { color: '#1e3a5f', weight: 5, opacity: 0.85 }).addTo(instance);

    // Show everything that matters: the whole route, both ends, or just the shelter.
    if (drawn.route) instance.fitBounds(drawn.route.getBounds().extend(at(shelter)).extend(at(destination ?? shelter)), { padding: [28, 28] });
    else if (destination && !onPick) instance.fitBounds(L.latLngBounds([at(shelter), at(destination)]), { padding: [36, 36], maxZoom: 15 });
    else if (destination) { if (!instance.getBounds().pad(-0.15).contains(at(destination))) instance.setView(at(destination), Math.max(instance.getZoom(), 15)); }
    else instance.setView(at(shelter), onPick ? 12 : 14);
    // Depend on the coordinates themselves, not on object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shelter.latitude, shelter.longitude, destination?.latitude, destination?.longitude, route, Boolean(onPick)]);

  return <div className={`transport-map transport-map-${size}`} ref={node} role="application" aria-label={label} />;
}
