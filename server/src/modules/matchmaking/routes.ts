import { Router } from 'express';
import { z } from 'zod';
import { db } from '../../config/supabase.js';
import { authenticate, optionalAuth } from '../../middleware/auth.js';
import { assertDb, ApiError } from '../../utils/errors.js';
import { publicBehaviorColumns } from '../products/routes.js';
import { assessmentSchema, calculateMatch, type MatchPet } from './engine.js';

export const matchmakingRouter = Router();
matchmakingRouter.post('/matchmaking/assessments', optionalAuth, async (req, res) => {
  const { answers } = z.object({ answers: assessmentSchema }).strict().parse(req.body);
  const pets = assertDb(await db().from('pets').select(`*,pet_behavior_profiles(${publicBehaviorColumns})`).eq('is_published', true).eq('is_sample', false).eq('status', 'available')); 
  const recommendations = (pets as MatchPet[]).map(pet => calculateMatch(answers, pet)).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  let assessment_id: string | undefined;
  if (req.actor) {
    assessment_id = assertDb(await db().rpc('save_assessment', { p_actor_id: req.actor.id, p_answers: answers, p_results: recommendations.map(r => ({ pet_id: r.pet.id, score: r.score, confidence: r.confidence, excluded: r.excluded, reasons: r.reasons, challenges: [...r.exclusions, ...r.challenges], factors: r.factors })) }));
  }
  res.status(201).json({ data: { assessment_id, recommendations }, meta: { persisted: Boolean(assessment_id) } });
});
matchmakingRouter.get('/matchmaking/recommendations', authenticate, async (req, res) => {
  const assessment = assertDb(await db().from('personality_assessments').select('id').eq('user_id', req.actor!.id).order('created_at', { ascending: false }).limit(1).maybeSingle());
  if (!assessment) throw new ApiError(404, 'ASSESSMENT_REQUIRED', 'Complete your personality assessment to see saved recommendations.');
  const data = assertDb(await db().from('matching_results').select('*,pets!inner(*)').eq('assessment_id', assessment.id).eq('pets.is_published', true).eq('pets.is_sample', false).eq('pets.status', 'available').order('score', { ascending: false, nullsFirst: false }));
  res.json({ data: { assessment_id: assessment.id, recommendations: data.map((row: Record<string, any>) => ({ ...row, pet: row.pets, exclusions: row.excluded ? row.challenges : [], reasons: row.reasons || [], challenges: row.challenges || [] })) } });
});
