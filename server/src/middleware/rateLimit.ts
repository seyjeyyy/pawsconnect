import { rateLimit } from 'express-rate-limit';
import { env } from '../config/env.js';

const limiter = (windowMinutes: number, limit: number, message: string) => rateLimit({
  windowMs: windowMinutes * 60_000,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => env.NODE_ENV === 'test',
  handler: (_req, res) => {
    res.status(429).json({ error: { code: 'RATE_LIMITED', message } });
  },
});

export const apiLimiter = limiter(15, 600, 'Too many requests. Please slow down and try again shortly.');
/** Sign-up, password and other credential-adjacent endpoints. */
export const authLimiter = limiter(15, 20, 'Too many attempts. Please wait a few minutes before trying again.');
/** Address search and routing are proxied to shared OpenStreetMap services, so they are rationed per visitor. */
export const mapsLimiter = limiter(10, 40, 'Too many map lookups. Please wait a few minutes, or place the pin on the map instead.');
/** Unauthenticated public forms (contact, newsletter). */
export const formLimiter = limiter(60, 10, 'You have sent several messages recently. Please try again later.');
/** Workers poll every 30 seconds; form limits would disable polling after ten requests. */
export const workerLimiter = limiter(1, 20, 'Worker request limit reached. Retry after the indicated delay.');
