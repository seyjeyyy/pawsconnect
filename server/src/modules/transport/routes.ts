import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../config/supabase.js';
import { authenticate } from '../../middleware/auth.js';
import { ApiError, assertDb } from '../../utils/errors.js';
import { uuid } from '../../utils/validation.js';
import { shelterLocation } from '../shelter/location.js';
export const transportRouter = Router();
transportRouter.use(authenticate);
export const transportInput = z.object({ pet_id: uuid.optional(), adoption_application_id: uuid.optional(), pet_details: z.string().min(5).max(3000), dropoff_address: z.string().min(5).max(500),
  // Shelter transport always starts at the official shelter. Pickup values from the browser are accepted so older pages keep working, and never used.
  pickup_address: z.unknown().optional(), pickup_latitude: z.unknown().optional(), pickup_longitude: z.unknown().optional(),
  dropoff_latitude: z.number().min(-90).max(90), dropoff_longitude: z.number().min(-180).max(180), preferred_schedule: z.string().datetime({ offset: true }).refine(v => Date.parse(v) > Date.now(), 'Choose a future schedule.'), contact_phone: z.string().min(7).max(30), handling_requirements: z.string().max(2000).optional() }).strict();
transportRouter.post('/transport/requests', async (req, res) => {
  const { pickup_address: _address, pickup_latitude: _latitude, pickup_longitude: _longitude, ...input } = transportInput.parse(req.body);
  if (input.adoption_application_id) assertDb(await db().from('adoption_applications').select('id').eq('id', input.adoption_application_id).eq('user_id', req.actor!.id).single());
  const shelter = await shelterLocation();
  // Saved on the request itself, so a later change to the shelter record does not rewrite this booking.
  const pickup = { pickup_address: [shelter.name, shelter.formatted_address].filter(Boolean).join(', '), pickup_latitude: shelter.latitude, pickup_longitude: shelter.longitude };
  // The database classifies coverage when the row is saved; the answer below is what it stored.
  const data = assertDb<{ coverage_status: string }>(await db().from('transport_requests').insert({ ...input, ...pickup, user_id: req.actor!.id }).select().single());
  const coverage_status = data.coverage_status;
  res.status(201).json({ data, meta: { alternative_available: coverage_status === 'outside_coverage', message: coverage_status === 'outside_coverage' ? 'Your location is outside our shelter-operated transportation area. You may request an alternative transportation arrangement.' : 'The shelter must review availability, handling requirements, and the route before confirming.' } });
});
transportRouter.get('/transport/requests/mine', async (req, res) => {
  res.json({ data: assertDb(await db().from('transport_requests').select('*,transport_quotes(*),transport_tracking_events(*),transport_handovers(*)').eq('user_id', req.actor!.id).order('created_at', { ascending: false })) });
});
transportRouter.get('/transport/requests/:id', async (req, res) => {
  res.json({ data: assertDb(await db().from('transport_requests').select('*,transport_quotes(*),transport_tracking_events(*),transport_handovers(*)').eq('id', uuid.parse(req.params.id)).eq('user_id', req.actor!.id).single()) });
});
transportRouter.post('/transport/requests/:id/confirm', async (req, res) => {
  res.json({ data: assertDb(await db().rpc('transition_transport', { p_actor_id: req.actor!.id, p_request_id: uuid.parse(req.params.id), p_status: 'confirmed' })) });
});
transportRouter.post('/transport/requests/:id/handover', async (req, res) => {
  const input = z.object({ recipient_name: z.string().min(2).max(120), notes: z.string().min(5).max(2000) }).strict().parse(req.body);
  res.json({ data: assertDb(await db().rpc('confirm_transport_handover', { p_actor_id: req.actor!.id, p_request_id: uuid.parse(req.params.id), p_recipient_name: input.recipient_name, p_notes: input.notes })) });
});
transportRouter.post('/transport/alternative-requests', async (req, res) => {
  const input = z.object({ transport_request_id: uuid.optional(), adoption_application_id: uuid.optional(), arrangement_type: z.enum(['self_pickup', 'customer_arranged', 'shelter_assisted']), details: z.string().min(20).max(3000), transporter_name: z.string().max(150).optional(), transporter_contact: z.string().max(150).optional() }).strict().parse(req.body);
  if (input.transport_request_id) assertDb(await db().from('transport_requests').select('id').eq('id', input.transport_request_id).eq('user_id', req.actor!.id).single());
  if (input.adoption_application_id) assertDb(await db().from('adoption_applications').select('id').eq('id', input.adoption_application_id).eq('user_id', req.actor!.id).single());
  res.status(201).json({ data: assertDb(await db().from('alternative_transport_requests').insert({ ...input, user_id: req.actor!.id }).select().single()) });
});
transportRouter.get('/transport/alternative-requests/mine', async (req, res) => {
  res.json({ data: assertDb(await db().from('alternative_transport_requests').select('*').eq('user_id', req.actor!.id).order('created_at', { ascending: false })) });
});
