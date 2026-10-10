import type { RequestHandler } from 'express';
import { db } from '../config/supabase.js';
import { ApiError, assertDb } from '../utils/errors.js';

declare global {
  namespace Express {
    interface Request { actor?: { id: string; email?: string; roles: string[] }; }
  }
}
export const authenticate: RequestHandler = async (req, _res, next) => {
  const client = db();
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '');
  if (!match) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  const { data, error } = await client.auth.getUser(match[1]);
  if (error || !data.user) throw new ApiError(401, 'INVALID_SESSION', 'Your session has expired. Please sign in again.');
  const memberships = assertDb<{ roles: { name: string } | { name: string }[] | null }[]>(await client.from('user_roles').select('roles(name)').eq('user_id', data.user.id));
  const roles = memberships.flatMap(row => {
    const role = row.roles;
    return Array.isArray(role) ? role.map(r => r.name) : role ? [role.name] : [];
  });
  req.actor = { id: data.user.id, email: data.user.email, roles };
  next();
};
export const optionalAuth: RequestHandler = async (req, res, next) => {
  if (!req.headers.authorization) { next(); return; }
  await authenticate(req, res, next);
};
export const authorize = (...roles: string[]): RequestHandler => (req, _res, next) => {
  if (!req.actor) throw new ApiError(401, 'AUTH_REQUIRED', 'Sign in to continue.');
  if (!req.actor.roles.some(role => roles.includes(role))) throw new ApiError(403, 'FORBIDDEN', 'This action requires an authorized shelter role.');
  next();
};
export const staffRoles = ['administrator', 'shelter_staff'];
export const isStaff = (roles: string[]) => roles.some(r => staffRoles.includes(r));
