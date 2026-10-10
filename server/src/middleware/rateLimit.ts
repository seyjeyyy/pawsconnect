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
/** Unauthenticated public forms (contact, newsletter). */
export const formLimiter = limiter(60, 10, 'You have sent several messages recently. Please try again later.');
