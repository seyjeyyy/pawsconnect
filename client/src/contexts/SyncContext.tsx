import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { supabase } from '../lib/supabase';
import { useAuth } from './AuthContext';
import { affectedQuery, isPrivateQuery } from '../lib/queryPolicy';

const Context = createContext('Connecting');
export function SyncProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const cache = useQueryClient();
  const [connection, setConnection] = useState('Periodic refresh');
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = (event: Event) => { setOnline(navigator.onLine); if (!navigator.onLine) return;
      const path = (event as CustomEvent<{path?:string}>).detail?.path;
      void cache.invalidateQueries({predicate: query => path ? affectedQuery(query.queryKey,path) : isPrivateQuery(query.queryKey)});
    };
    window.addEventListener('pawsconnect:changed', update); window.addEventListener('online', update); window.addEventListener('offline', update);
    return () => { window.removeEventListener('pawsconnect:changed', update); window.removeEventListener('online', update); window.removeEventListener('offline', update); };
  }, [cache]);
  useEffect(() => {
    if (!supabase || !user) { setConnection('Periodic refresh'); return; }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Subscribe only to INSERT/UPDATE: DELETE events cannot be checked against RLS.
    const refresh = (payload?: {new?:Record<string,unknown>}) => {
      clearTimeout(timer);
      const entity = String(payload?.new?.entity_type || '');
      const links: Record<string,string> = {profiles:'users',adoption_applications:'adoptions',stray_reports:'rescue',transport_requests:'transport',volunteer_tasks:'volunteers',volunteer_profiles:'volunteers',orders:'orders',donations:'donations',payment_transactions:'payments'};
      // Access changes fail closed immediately, before another private screen can render.
      if (entity === 'profiles' || entity === 'user_roles' || entity === 'staff_access' || entity === 'volunteer_profiles') {
        void cache.cancelQueries({predicate:q=>isPrivateQuery(q.queryKey)}).then(()=>cache.resetQueries({predicate:q=>isPrivateQuery(q.queryKey)}));
        return;
      }
      timer = setTimeout(() => { if (active) void cache.invalidateQueries({predicate:query=>links[entity] ? affectedQuery(query.queryKey,`/admin/${links[entity]}`) || query.queryKey[1] === 'notifications' : isPrivateQuery(query.queryKey)}); }, 200);
    };
    const channel = supabase.channel(`updates:${user.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` }, refresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'notifications', filter: `user_id=eq.${user.id}` }, refresh)
      .subscribe(status => {
        if (!active) return;
        setConnection(status === 'SUBSCRIBED' ? 'Live updates with periodic refresh' : 'Periodic refresh · live connection unavailable');
        if (status === 'SUBSCRIBED') refresh();
      });
    return () => { active = false; clearTimeout(timer); void supabase!.removeChannel(channel); };
  }, [user?.id, cache]);
  useEffect(() => {
    if (!user) return;
    const timer = setInterval(() => {
      if (navigator.onLine && document.visibilityState === 'visible') void cache.invalidateQueries({predicate:q=>isPrivateQuery(q.queryKey) && q.isActive()});
    }, 60000);
    return () => clearInterval(timer);
  }, [user?.id, cache]);
  return <Context.Provider value={online ? connection : 'Offline · updates paused'}>{children}</Context.Provider>;
}
export function SyncStatus() {
  const state = useContext(Context);
  const fetching = useIsFetching();
  const cache = useQueryClient();
  const health = useQuery({ queryKey: ['health'], queryFn: ({signal}) => api<{ payment_mode: string }>('/health',{signal}) });
  const failed = cache.getQueryCache().getAll().some(query => query.isActive() && query.state.status === 'error');
  return <div className="container small muted" role="status">{state}{fetching ? ' · refreshing' : failed ? ' · some records could not be refreshed' : ''} <button className="text-button" onClick={() => void cache.invalidateQueries()}>Refresh</button>{health.data?.payment_mode === 'test' && <span> · Stripe test mode: no real money moves.</span>}</div>;
}
