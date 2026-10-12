import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../config/supabase.js';
import { authenticate } from '../../middleware/auth.js';
import { ApiError, assertDb } from '../../utils/errors.js';
import { uuid } from '../../utils/validation.js';
export const adoptionRouter = Router();
adoptionRouter.use(authenticate);
adoptionRouter.post('/adoption-applications', async (req, res) => {
  const input = z.object({ pet_id: uuid, motivation: z.string().min(20).max(5000), household: z.record(z.unknown()).default({}), document_paths: z.array(z.string().max(300)).max(10).default([]) }).strict().parse(req.body);
  if (input.document_paths.some(path => !path.startsWith(`${req.actor!.id}/`) || path.includes('..'))) throw new ApiError(403, 'INVALID_DOCUMENT', 'Application documents must belong to your account.');
  const pet = assertDb(await db().from('pets').select('id,status,is_sample,is_published').eq('id', input.pet_id).single());
  if (!pet.is_published || pet.status !== 'available' || pet.is_sample) throw new ApiError(409, 'PET_UNAVAILABLE', 'This pet is not currently accepting adoption applications.');
  const data = assertDb(await db().rpc('submit_adoption_application', { p_actor_id: req.actor!.id, p_pet_id: input.pet_id, p_motivation: input.motivation, p_household: input.household, p_document_paths: input.document_paths }));
  res.status(201).json({ data });
});
adoptionRouter.get('/adoption-applications/mine', async (req, res) => {
  res.json({ data: assertDb(await db().from('adoption_applications').select('*,pets(id,name,species,image_url),adoption_appointments(*)').eq('user_id', req.actor!.id).order('created_at', { ascending: false })) });
});
adoptionRouter.post('/adoption-applications/:id/withdraw', async (req, res) => {
  res.json({ data: assertDb(await db().rpc('transition_adoption', { p_actor_id: req.actor!.id, p_application_id: uuid.parse(req.params.id), p_status: 'withdrawn', p_notes: 'Withdrawn by applicant.' })) });
});
