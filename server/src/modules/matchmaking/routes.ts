import { Router } from 'express';
import { z } from 'zod';
import { configured } from '../../config/env.js';
import { db } from '../../config/supabase.js';
import { authenticate, optionalAuth } from '../../middleware/auth.js';
import { assertDb, ApiError } from '../../utils/errors.js';
import { samplePets } from '../products/sample.js';
import { assessmentSchema, calculateMatch, type MatchPet } from './engine.js';

export const matchmakingRouter = Router();
matchmakingRouter.post('/matchmaking/assessments', optionalAuth, async (req, res) => {
  const { answers } = z.object({ answers: assessmentSchema }).strict().parse(req.body);
  const pets = configured ? assertDb(await db().from('pets').select('*,pet_behavior_profiles(*)').eq('is_published', true).eq('status', 'available')) : samplePets;
  const recommendations = (pets as MatchPet[]).map(pet => calculateMatch(answers, pet)).sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  let assessment_id: string | undefined;
  if (req.actor) {
    const assessment = assertDb(await db().from('personality_assessments').insert({ user_id: req.actor.id, answers, engine_version: '1.0.0' }).select().single());
    assessment_id = assessment.id;
    if (recommendations.length) assertDb(await db().from('matching_results').insert(recommendations.map(r => ({ assessment_id, pet_id: r.pet.id, score: r.score, confidence: r.confidence, excluded: r.excluded, reasons: r.reasons, challenges: [...r.exclusions, ...r.challenges], factors: r.factors }))));
  }
  res.status(201).json({ data: { assessment_id, recommendations, sample: !configured }, meta: { sample: !configured, persisted: Boolean(assessment_id) } });
});
matchmakingRouter.get('/matchmaking/recommendations', authenticate, async (req, res) => {
  const assessment = assertDb(await db().from('personality_assessments').select('id').eq('user_id', req.actor!.id).order('created_at', { ascending: false }).limit(1).maybeSingle());
  if (!assessment) throw new ApiError(404, 'ASSESSMENT_REQUIRED', 'Complete your personality assessment to see saved recommendations.');
  const data = assertDb(await db().from('matching_results').select('*,pets(*)').eq('assessment_id', assessment.id).order('score', { ascending: false, nullsFirst: false }));
  res.json({ data });
});
