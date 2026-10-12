import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';

export type ShelterPickupLocation = { name: string; latitude: number; longitude: number; google_maps_url: string | null; formatted_address: string | null };
/** The official shelter location, shared by every screen that shows where a shelter transport starts. */
export const useShelterLocation = () => useQuery({ queryKey: ['shelter-location'], queryFn: ({ signal }) => api<ShelterPickupLocation>('/shelter-location', { signal }), staleTime: 5 * 60_000 });
