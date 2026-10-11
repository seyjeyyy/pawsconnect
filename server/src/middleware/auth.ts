import type { RequestHandler } from 'express';
import { db } from '../config/supabase.js';
import { ApiError, assertDb } from '../utils/errors.js';

declare global {
  namespace Express {
    interface Request { actor?: { id: string; email?: string; roles: string[]; permissions?: string[] }; }
  }
}
export const authenticate: RequestHandler = async (req, _res, next) => {
  const client = db();
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
  if (!match) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  const { data, error } = await client.auth.getUser(match[1]);
  if (error || !data.user) throw new ApiError(401, 'INVALID_SESSION', 'Your session has expired. Please sign in again.');
  // getUser validates the JWT before any claim is read. A signed but revoked
  // session must not survive in either the service-role API or direct RLS reads.
  let sessionId: string | null = null;
  try { sessionId = JSON.parse(Buffer.from(match[1].split('.')[1], 'base64url').toString('utf8')).session_id; } catch { /* reject below */ }
  if (typeof sessionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId)) throw new ApiError(401,'INVALID_SESSION','Sign in again to establish a current session.');
  const sessionAllowed=assertDb(await client.rpc('account_session_allowed',{p_user_id:data.user.id,p_session_id:sessionId}));
  if(!sessionAllowed) throw new ApiError(401,'SESSION_REVOKED','This session no longer has platform access. Sign in again or contact support.');
  const [membershipResult, permissionResult] = await Promise.all([
    client.from('user_roles').select('roles(name)').eq('user_id', data.user.id),
    client.rpc('account_permissions',{p_user_id:data.user.id}),
  ]);
  const memberships = assertDb<{ roles: { name: string } | { name: string }[] | null }[]>(membershipResult);
  const roles = memberships.flatMap(row => {
    const role = row.roles;
    return Array.isArray(role) ? role.map(r => r.name) : role ? [role.name] : [];
  });
  req.actor = { id: data.user.id, email: data.user.email, roles, permissions: assertDb<string[]>(permissionResult) ?? [] };
  next();
};
export const optionalAuth: RequestHandler = async (req, res, next) => {
  if (!req.headers.authorization) { next(); return; }
  await authenticate(req, res, next);
};
export const authorize = (...roles: string[]): RequestHandler => (req, _res, next) => {
  if (!req.actor) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  if (!req.actor.roles.some(role => roles.includes(role))) throw new ApiError(403, 'FORBIDDEN', 'This action requires an authorized role.');
  next();
};
// Two separate lines of authority, neither of which implies the other:
// - shelter operations (store, animals, rescue, transport, money): administrator and shelter staff;
// - system administration (accounts and access, audit trail, security): super administrator.
export const staffRoles = ['administrator', 'shelter_staff'];
export const isStaff = (roles: string[]) => roles.some(r => staffRoles.includes(r));
export const isSystemAdministrator = (roles: string[]) => roles.includes('super_administrator');
