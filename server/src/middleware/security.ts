import type { ErrorRequestHandler } from 'express';
import { db } from '../config/supabase.js';
import { ApiError } from '../utils/errors.js';

// Authenticated denials only: never attribute a guessed identity from a failed token.
// No tokens, addresses, request bodies, or URL query strings enter the event log.
export const recordSecurityFailure: ErrorRequestHandler = async (error, req, _res, next) => {
  if (error instanceof ApiError && error.status === 403 && req.actor) {
    try {
      const result = await db().rpc('record_authorization_denial', {
        p_actor_id: req.actor.id,
        p_route: `${req.method} ${req.originalUrl.split('?')[0].replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id')}`,
      });
      if (result.error) console.error('Security event could not be recorded:', result.error.code);
    } catch { console.error('Security event storage unavailable'); }
  }
  next(error);
};
