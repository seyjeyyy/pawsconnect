import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../config/supabase.js';
import { authenticate } from '../../middleware/auth.js';
import { assertDb } from '../../utils/errors.js';
import { money } from '../../utils/validation.js';
export const supportRouter = Router();
supportRouter.use(authenticate);
supportRouter.post('/donations', async (req, res) => {
  const input = z.object({ donation_type: z.enum(['monetary', 'in_kind']), amount_centavos: money.positive().optional(), description: z.string().max(3000).optional(), donor_name: z.string().max(120).optional(), is_anonymous: z.boolean().default(false) }).strict().superRefine((value, ctx) => {
    if (value.donation_type === 'monetary' && !value.amount_centavos) ctx.addIssue({ code: 'custom', path: ['amount_centavos'], message: 'Enter a donation amount.' });
    if (value.donation_type === 'in_kind' && (!value.description || value.description.length < 10)) ctx.addIssue({ code: 'custom', path: ['description'], message: 'Describe the donated items.' });
  }).parse(req.body);
  res.status(201).json({ data: assertDb(await db().from('donations').insert({ ...input, amount_centavos: input.donation_type === 'in_kind' ? null : input.amount_centavos, user_id: req.actor!.id, status: input.donation_type === 'in_kind' ? 'pledged' : 'pending' }).select().single()) });
});
supportRouter.get('/donations/mine', async (req, res) => {
  res.json({ data: assertDb(await db().from('donations').select('*').eq('user_id', req.actor!.id).order('created_at', { ascending: false })) });
});
supportRouter.post('/volunteers', async (req, res) => {
  const input = z.object({ motivation: z.string().min(20).max(3000), skills: z.array(z.string().min(1).max(100)).max(20), availability: z.record(z.unknown()) }).strict().parse(req.body);
  res.status(201).json({ data: assertDb(await db().from('volunteer_profiles').insert({ ...input, user_id: req.actor!.id }).select().single()) });
});
supportRouter.get('/volunteers/mine', async (req, res) => {
  const profile = assertDb(await db().from('volunteer_profiles').select('*').eq('user_id', req.actor!.id).maybeSingle());
  const tasks = assertDb(await db().from('volunteer_tasks').select('*').eq('volunteer_id', req.actor!.id).order('created_at', { ascending: false }));
  res.json({ data: profile ? { ...profile, tasks } : null });
});
