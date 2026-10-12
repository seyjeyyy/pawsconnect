import { lazy, Suspense, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import './launcher.css';

// Only this button ships with every page. The chat panel, its styles and its
// requests load the first time someone opens it.
const AssistantPanel = lazy(() => import('./AssistantPanel'));

export default function AssistantLauncher() {
  const { user, rolesLoading, rolesError } = useAuth();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false), [loaded, setLoaded] = useState(false);
  if (!user || rolesLoading || rolesError || pathname.startsWith('/auth')) return null;
  return <>
    {!open && <button type="button" className="assistant-launcher" aria-label="Open PawsConnect AI Assistant" title="PawsConnect AI Assistant" onClick={() => { setLoaded(true); setOpen(true); }}><MessageCircle size={24} /></button>}
    {loaded && <Suspense fallback={null}><AssistantPanel open={open} onClose={() => setOpen(false)} /></Suspense>}
  </>;
}
