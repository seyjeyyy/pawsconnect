import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../config/supabase.js';
import { authenticate, optionalAuth } from '../../middleware/auth.js';
import { ApiError, assertDb } from '../../utils/errors.js';
import { point } from '../../utils/validation.js';
import { eligibility } from '../geofencing/service.js';
export const rescueRouter = Router();
export const strayInput = point.extend({ animal_type: z.enum(['dog', 'cat', 'other']), animal_count: z.number().int().min(1).max(1000), description: z.string().min(10).max(5000), condition: z.string().min(2).max(500), observed_at: z.string().datetime({ offset: true }).refine(v => Date.parse(v) <= Date.now() + 60000, 'Observation time cannot be in the future.'), province: z.string().min(2).max(100), city: z.string().min(2).max(100), barangay: z.string().max(100).default(''), address: z.string().min(5).max(500), reporter_contact: z.string().max(150).optional(), notes: z.string().max(2000).optional(), photo_paths: z.array(z.string().max(300)).max(6).default([]) }).strict();
rescueRouter.post('/stray-reports', optionalAuth, async (req, res) => {
  const { photo_paths, ...input } = strayInput.parse(req.body);
  if (photo_paths.some(path => !req.actor || !path.startsWith(`${req.actor.id}/`) || path.includes('..'))) throw new ApiError(403, 'INVALID_PHOTO', 'Report photos must belong to your account.');
  const coverage = await eligibility('rescue', input.latitude, input.longitude);
  const report = assertDb(await db().from('stray_reports').insert({ ...input, user_id: req.actor?.id ?? null, coverage_status: coverage.status }).select().single());
  if (photo_paths.length) assertDb(await db().from('stray_report_photos').insert(photo_paths.map(storage_path => ({ report_id: report.id, storage_path }))));
  res.status(201).json({ data: { id: report.id, status: report.status, coverage_status: coverage.status, message: 'Report saved for staff verification. Submission does not dispatch a rescue team.' } });
});
rescueRouter.get('/stray-reports/mine', authenticate, async (req, res) => {
  res.json({ data: assertDb(await db().from('stray_reports').select('*,stray_report_photos(*)').eq('user_id', req.actor!.id).order('created_at', { ascending: false })) });
});
