import { Router } from 'express';
import { z } from 'zod';
import { point } from '../../utils/validation.js';
import { eligibility } from './service.js';
import { maps } from '../../integrations/maps.js';
export const geoRouter = Router();
geoRouter.post('/geofencing/check', async (req, res) => {
  const input = point.extend({ service_type: z.enum(['delivery', 'rescue', 'transport', 'donation_pickup', 'adoption']) }).strict().parse(req.body);
  res.json({ data: await eligibility(input.service_type, input.latitude, input.longitude) });
});
geoRouter.post('/geofencing/rescue-coverage', async (req, res) => {
  const input = point.parse(req.body);
  res.json({ data: await eligibility('rescue', input.latitude, input.longitude) });
});
geoRouter.post('/geofencing/transport-coverage', async (req, res) => {
  const { origin, destination } = z.object({ origin: point, destination: point }).parse(req.body);
  const [pickup, dropoff] = await Promise.all([eligibility('transport', origin.latitude, origin.longitude), eligibility('transport', destination.latitude, destination.longitude)]);
  res.json({ data: { eligible: pickup.eligible && dropoff.eligible, pickup, dropoff, alternative_available: !pickup.eligible || !dropoff.eligible } });
});
geoRouter.get('/maps/geocode', async (req, res) => {
  const { address } = z.object({ address: z.string().min(5).max(500) }).parse(req.query);
  res.json({ data: await maps.geocode(address) });
});
geoRouter.post('/maps/route', async (req, res) => {
  const { origin, destination } = z.object({ origin: point, destination: point }).strict().parse(req.body);
  res.json({ data: await maps.route(origin, destination) });
});
