import { useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

/**
 * Goes to the page the visitor came from, keeping its filters and scroll position.
 * When this page was opened directly (a link, a refresh, a new tab) there is nothing
 * to go back to inside the app, so it opens `fallback` instead of leaving the site.
 */
export function useGoBack(fallback: string) {
  const navigate = useNavigate();
  const { key } = useLocation();
  // React Router gives the first entry of a visit the key "default".
  return () => { if (key !== 'default') navigate(-1); else navigate(fallback, { replace: true }); };
}

export function BackButton({ fallback, label = 'Back', iconOnly = false }: { fallback: string; label?: string; iconOnly?: boolean }) {
  const goBack = useGoBack(fallback);
  return iconOnly
    ? <button type="button" className="icon-button back-button" onClick={goBack} aria-label={label} title={label}><ArrowLeft size={19} /></button>
    : <button type="button" className="back-link" onClick={goBack}><ArrowLeft size={16} />{label}</button>;
}
