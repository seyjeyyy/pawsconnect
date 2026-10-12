import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../config/supabase.js';
import { authenticate } from '../../middleware/auth.js';
import { ApiError, assertDb } from '../../utils/errors.js';
import { uuid } from '../../utils/validation.js';
import { point } from '../../utils/validation.js';
import { coverageBlock, planTransport } from './service.js';
import { estimateTransport } from './estimate.js';
import { transportDetail } from './detail.js';
export const transportRouter = Router();
transportRouter.use(authenticate);
// What the customer tells us. Everything about the pickup, the route, coverage and price is worked out here, not sent in.
export const transportInput = z.object({
  pet_id: uuid.optional(), adoption_application_id: uuid.optional(),
  pet_name: z.string().trim().min(1).max(100), pet_species: z.enum(['dog', 'cat', 'other']), pet_weight_kg: z.number().min(0.1).max(150), has_carrier: z.boolean(),
  handling_requirements: z.string().trim().max(2000).optional(),
  preferred_schedule: z.string().datetime({ offset: true }).refine(v => Date.parse(v) > Date.now(), 'Choose a future schedule.'),
  dropoff_street: z.string().trim().min(3).max(300), dropoff_barangay: z.string().trim().max(100).default(''), dropoff_city: z.string().trim().min(2).max(100), dropoff_province: z.string().trim().min(2).max(100),
  dropoff_latitude: z.number().min(-90).max(90), dropoff_longitude: z.number().min(-180).max(180),
  contact_name: z.string().trim().min(2).max(120), contact_phone: z.string().trim().regex(/^\+639\d{9}$/, 'Enter a Philippine mobile number as +639XXXXXXXXX.'),
  delivery_instructions: z.string().trim().max(1000).optional(),
  destination_confirmed: z.literal(true, { errorMap: () => ({ message: 'Confirm the destination before submitting.' }) }),
  policy_accepted: z.literal(true, { errorMap: () => ({ message: 'Accept the transport policy before submitting.' }) }),
  // Shelter transport always starts at the official shelter. Pickup values from the browser are accepted and never used.
  pickup_address: z.unknown().optional(), pickup_latitude: z.unknown().optional(), pickup_longitude: z.unknown().optional(),
}).strict();
// The route, coverage and estimate for a destination, for the form's summary panel. Always from the official shelter.
transportRouter.post('/transport/preview', async (req, res) => {
  const { destination, pet } = z.object({ destination: point, pet: z.object({ species: z.enum(['dog', 'cat', 'other']).optional(), weight_kg: z.number().min(0.1).max(150).optional(), has_carrier: z.boolean().optional() }).strict().optional() }).strict().parse(req.body);
  const plan = await planTransport(destination);
  res.json({ data: {
    origin: { name: plan.shelter.name, formatted_address: plan.shelter.formatted_address, latitude: plan.shelter.latitude, longitude: plan.shelter.longitude, google_maps_url: plan.shelter.google_maps_url },
    route: plan.route,
    coverage: { ...plan.coverage, message: coverageBlock(plan.coverage)?.message ?? null },
    // Null until an administrator has entered a base fee and a rate per kilometre. An uncovered destination gets no estimate.
    estimate: coverageBlock(plan.coverage) ? null : estimateTransport(plan.settings, { distance_km: plan.route.distance_km, ...pet }),
  } });
});
transportRouter.post('/transport/requests', async (req, res) => {
  const input = transportInput.parse(req.body);
  let petId = input.pet_id;
  if (input.adoption_application_id) petId ??= assertDb<{ pet_id: string }>(await db().from('adoption_applications').select('id,pet_id').eq('id', input.adoption_application_id).eq('user_id', req.actor!.id).single()).pet_id;
  // Worked out again here from the destination alone; nothing the browser showed or sent is reused.
  const plan = await planTransport({ latitude: input.dropoff_latitude, longitude: input.dropoff_longitude });
  const blocked = coverageBlock(plan.coverage);
  if (blocked) throw new ApiError(409, blocked.code, blocked.message);
  const { shelter, route } = plan;
  const estimate = estimateTransport(plan.settings, { distance_km: route.distance_km, species: input.pet_species, weight_kg: input.pet_weight_kg, has_carrier: input.has_carrier });
  const data = assertDb<{ reference: string; coverage_status: string }>(await db().from('transport_requests').insert({
    user_id: req.actor!.id, pet_id: petId, adoption_application_id: input.adoption_application_id,
    pet_name: input.pet_name, pet_species: input.pet_species, pet_weight_kg: input.pet_weight_kg, has_carrier: input.has_carrier,
    pet_details: `${input.pet_name} — ${input.pet_species}, ${input.pet_weight_kg} kg. ${input.has_carrier ? 'Customer has a secure carrier.' : 'Customer does not have a carrier.'}`,
    // A copy saved on the booking, so a later change to the shelter record does not rewrite it.
    shelter_location_id: shelter.id, pickup_name: shelter.name, pickup_address: shelter.formatted_address ?? shelter.name, pickup_latitude: shelter.latitude, pickup_longitude: shelter.longitude,
    dropoff_street: input.dropoff_street, dropoff_barangay: input.dropoff_barangay, dropoff_city: input.dropoff_city, dropoff_province: input.dropoff_province,
    dropoff_address: [input.dropoff_street, input.dropoff_barangay, input.dropoff_city, input.dropoff_province].filter(Boolean).join(', '),
    dropoff_latitude: input.dropoff_latitude, dropoff_longitude: input.dropoff_longitude,
    route_distance_km: route.distance_km, route_duration_minutes: route.duration_minutes, route_geometry: route.geometry,
    // What the customer was shown. The final price is the staff quotation, saved separately.
    estimate_breakdown: estimate ? { lines: estimate.lines, distance_km: route.distance_km } : null, estimate_total_centavos: estimate?.total_centavos ?? null,
    preferred_schedule: input.preferred_schedule, contact_name: input.contact_name, contact_phone: input.contact_phone,
    handling_requirements: input.handling_requirements, delivery_instructions: input.delivery_instructions,
  }).select().single());
  res.status(201).json({ data, meta: { reference: data.reference, message: 'The shelter must review availability, handling requirements, and the route before confirming.' } });
});
transportRouter.get('/transport/requests/mine', async (req, res) => {
  res.json({ data: assertDb(await db().from('transport_requests').select('id,reference,user_id,status,coverage_status,pet_details,pet_name,pet_species,pet_weight_kg,dropoff_address,dropoff_city,preferred_schedule,confirmed_schedule,route_distance_km,route_duration_minutes,estimate_total_centavos,fee_centavos,paid_at,driver_id,vehicle_id,shelter_location_id,created_at,updated_at,transport_quotes(id,amount_centavos,expires_at,accepted_at,created_at)').eq('user_id', req.actor!.id).order('created_at', { ascending: false })) });
});
transportRouter.get('/transport/requests/:id', async (req, res) => {
  res.json({ data: await transportDetail(uuid.parse(req.params.id), 'customer', req.actor!.id) });
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
