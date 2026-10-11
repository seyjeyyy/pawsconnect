import { Navigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../contexts/AuthContext';
import { signInPath } from '../lib/roles';

export function SessionDestination({next = null}: {next?: string | null}) {
  const {loading, rolesLoading, rolesError, roles} = useAuth();
  const cache = useQueryClient();
  if (loading || rolesLoading) return <main className="page container" role="status">Opening your workspace…</main>;
  if (rolesError) return <main className="page container"><div className="notice error" role="alert">{rolesError.message} <button className="text-button" onClick={() => void cache.invalidateQueries({queryKey:['identity']})}>Retry</button></div></main>;
  return <Navigate to={signInPath(roles, next)} replace />;
}
