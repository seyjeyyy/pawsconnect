import type { RequestHandler } from 'express';
import { db } from '../config/supabase.js';
import { ApiError, assertDb } from '../utils/errors.js';
import { env } from '../config/env.js';

/** The seeded demonstration accounts, one per role. */
export const isDemoAccount = (email: string | undefined) => Boolean(email?.toLowerCase().endsWith('@pawsconnect.test'));

declare global {
  namespace Express {
    interface Request { actor?: { id: string; email?: string; roles: string[]; permissions?: string[] }; }
  }
}
type Actor = NonNullable<Express.Request['actor']>;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bearerToken = (header: string | undefined) => /^Bearer ([^\s]+)$/i.exec(header || '')?.[1];
// The token check, session check and access lookups are independent, so they run
// together: one network wait instead of three in a row. The lookups are keyed by
// the token's unverified claims and are discarded unless getUser confirms the
// token and returns the same account, so an unverified claim is never trusted.
export async function loadActor(token: string): Promise<Actor> {
  const client = db();
  let claims: { sub?: unknown; session_id?: unknown } = {};
  try { claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')); } catch { /* reject below */ }
  const { sub, session_id: sessionId } = claims;
  if (typeof sub !== 'string' || !uuidPattern.test(sub) || typeof sessionId !== 'string' || !uuidPattern.test(sessionId)) {
    // Malformed claims: still let the provider decide whether the token itself is valid.
    const { data, error } = await client.auth.getUser(token);
    if (error || !data.user) throw new ApiError(401, 'INVALID_SESSION', 'Your session has expired. Please sign in again.');
    throw new ApiError(401, 'INVALID_SESSION', 'Sign in again to establish a current session.');
  }
  const [verified, sessionResult, membershipResult, permissionResult] = await Promise.all([
    client.auth.getUser(token),
    client.rpc('account_session_allowed', { p_user_id: sub, p_session_id: sessionId }),
    client.from('user_roles').select('roles(name)').eq('user_id', sub),
    client.rpc('account_permissions', { p_user_id: sub }),
  ]);
  if (verified.error || !verified.data.user || verified.data.user.id !== sub) throw new ApiError(401, 'INVALID_SESSION', 'Your session has expired. Please sign in again.');
  if (env.DEMO_ACCOUNTS_DISABLED && isDemoAccount(verified.data.user.email)) throw new ApiError(403, 'DEMO_ACCOUNT_DISABLED', 'Demonstration accounts are switched off on this site.');
  // A signed but revoked session must not survive in either the service-role API or direct RLS reads.
  if (!assertDb(sessionResult)) throw new ApiError(401, 'SESSION_REVOKED', 'This session no longer has platform access. Sign in again or contact support.');
  const memberships = assertDb<{ roles: { name: string } | { name: string }[] | null }[]>(membershipResult);
  const roles = memberships.flatMap(row => {
    const role = row.roles;
    return Array.isArray(role) ? role.map(r => r.name) : role ? [role.name] : [];
  });
  return { id: sub, email: verified.data.user.email, roles, permissions: assertDb<string[]>(permissionResult) ?? [] };
}
export const authenticate: RequestHandler = async (req, _res, next) => {
  const token = bearerToken(req.headers.authorization);
  if (!token) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  req.actor = await loadActor(token);
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
