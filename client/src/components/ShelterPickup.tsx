import { useQuery } from '@tanstack/react-query';
import { ExternalLink, MapPin, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';

export type ShelterPickupLocation = { name: string; latitude: number; longitude: number; google_maps_url: string | null; formatted_address: string | null };
/** The official shelter location, shared by every screen that shows where a shelter transport starts. */
export const useShelterLocation = () => useQuery({ queryKey: ['shelter-location'], queryFn: ({ signal }) => api<ShelterPickupLocation>('/shelter-location', { signal }), staleTime: 5 * 60_000 });

/** Read-only pickup for shelter transport. The API sets the pickup itself; nothing here is sent with the request. */
export function ShelterPickup() {
  const shelter = useShelterLocation();
  return <fieldset className="location-picker shelter-pickup">
    <legend><MapPin size={17} /> Pickup location</legend>
    {shelter.isLoading ? <p className="muted" role="status">Loading the shelter location…</p>
      : shelter.error || !shelter.data ? <div className="notice error" role="alert"><p>We couldn’t load the shelter location. Please try again.</p><button type="button" className="btn btn-secondary" onClick={() => shelter.refetch()}><RefreshCw size={16} />Retry</button></div>
      : <>
        <div><strong>{shelter.data.name}</strong>{shelter.data.formatted_address ? <p>{shelter.data.formatted_address}</p> : <p className="muted small">The street address is being confirmed by the shelter. The map link shows the exact spot.</p>}</div>
        {shelter.data.google_maps_url && <a className="text-button" href={shelter.data.google_maps_url} target="_blank" rel="noreferrer"><ExternalLink size={15} />View on Google Maps</a>}
        <p className="muted small">Every shelter transport starts at the shelter, so you only need to choose the destination.</p>
      </>}
  </fieldset>;
}
