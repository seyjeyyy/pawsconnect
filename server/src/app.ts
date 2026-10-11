import cors from 'cors';
import express, { Router } from 'express';
import helmet from 'helmet';
import { env, integrations } from './config/env.js';
import { apiLimiter, authLimiter, formLimiter, mapsLimiter } from './middleware/rateLimit.js';
import { adoptionRouter } from './modules/adoption/routes.js';
import { adminRouter } from './modules/analytics/admin.js';
import { supportRouter } from './modules/donations/routes.js';
import { geoRouter } from './modules/geofencing/routes.js';
import { matchmakingRouter } from './modules/matchmaking/routes.js';
import { commerceRouter } from './modules/orders/routes.js';
import { paymentRouter, webhookRouter } from './modules/payments/routes.js';
import { catalogRouter } from './modules/products/routes.js';
import { rescueRouter } from './modules/rescue/routes.js';
import { transportRouter } from './modules/transport/routes.js';
import { userRouter } from './modules/users/routes.js';
import { connectedRouter } from './modules/users/connected.js';
import { recordSecurityFailure } from './middleware/security.js';
import { ApiError, errorHandler } from './utils/errors.js';
import { operationsPublicRouter, operationsRouter, operationsWorkerRouter } from './modules/operations/routes.js';
import { maintenanceGuard } from './modules/operations/maintenance.js';
import { telemetry } from './modules/operations/telemetry.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY_HOPS) app.set('trust proxy', env.TRUST_PROXY_HOPS);

  app.use(helmet());
  app.use(telemetry);
  // Auth uses bearer tokens, not cookies, so credentials are never sent cross-origin.
  app.use(cors({ origin: env.CLIENT_URL, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] }));

  // Webhooks are verified against the exact bytes the provider signed, so this
  // route must see the raw body and is mounted before the JSON parser.
  app.use('/api/webhooks', express.raw({ type: 'application/json', limit: '1mb' }), webhookRouter);
  app.use(express.json({ limit: '100kb' }));

  const api = Router();
  // Booleans only, never secrets: lets the client report unavailable integrations honestly.
  api.get('/health', (_req, res) => {
    res.json({ data: { status: 'ok', environment: env.NODE_ENV, integrations, payment_mode: !integrations.stripe ? 'unavailable' : env.STRIPE_SECRET_KEY?.startsWith('sk_live_') ? 'live' : 'test' } });
  });
  api.use('/auth/register', authLimiter);
  api.use(['/contact', '/newsletter'], formLimiter);
  // Stray reports may be anonymous, so they get the same abuse limit as the other public forms.
  api.post('/stray-reports', formLimiter);
  api.use('/maps', mapsLimiter);
  api.use('/operations/worker', operationsWorkerRouter);
  api.use(operationsPublicRouter);
  api.use('/admin/operations', operationsRouter);
  api.use(maintenanceGuard);

  // Public and optionally-authenticated routers come first. Routers that begin
  // with `use(authenticate)` reject every request that reaches them, so they
  // are mounted last (and the role-gated admin router under its own prefix).
  api.use(catalogRouter);
  api.use(geoRouter);
  api.use(matchmakingRouter);
  api.use(rescueRouter);
  api.use(userRouter);
  api.use(paymentRouter);
  api.use('/admin', adminRouter);
  api.use(connectedRouter);
  api.use(commerceRouter);
  api.use(adoptionRouter);
  api.use(transportRouter);
  api.use(supportRouter);

  app.use('/api', apiLimiter, api);
  app.use('/api', () => {
    throw new ApiError(404, 'NOT_FOUND', 'This API endpoint does not exist.');
  });
  app.use(recordSecurityFailure, errorHandler);
  return app;
}
