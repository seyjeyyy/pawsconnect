import { lazy, Suspense } from 'react';
import type { LocationValue } from './location';
export { emptyLocation, type LocationValue } from './location';

// The map library is loaded only when a picker is about to be shown, so the rest of the page appears first.
const LocationPickerMap = lazy(() => import('./LocationPickerMap'));
export function LocationPicker(props: { value: LocationValue; onChange: (value: LocationValue) => void; label?: string }) {
  return <Suspense fallback={<fieldset className="location-picker" aria-busy="true"><legend>{props.label ?? 'Location'}</legend><p className="muted" role="status">Loading the map…</p></fieldset>}><LocationPickerMap {...props} /></Suspense>;
}
