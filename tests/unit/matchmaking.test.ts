import { describe, expect, it } from 'vitest';
import { assessmentSchema, calculateMatch, weights, type Answers, type Behavior, type MatchPet } from '../../server/src/modules/matchmaking/engine';

const answers: Answers = { activity: 3, home_type: 'house', outdoor_space: true, care_hours: 3, hours_away: 4, experience: 'some', children: false, other_pets: false, preferred_size: 'any', temperament: 'any', grooming_commitment: 3, exercise_capacity: 3 };
const verified: Behavior = { energy_level: 3, apartment_suitable: true, needs_outdoor_space: false, good_with_children: true, good_with_dogs: true, good_with_cats: true, min_care_hours: 2, max_hours_alone: 6, experience_required: 'first_time', grooming_needs: 2, temperament: ['calm'], verified_at: '2026-01-01T00:00:00Z' };
const pet = (behavior: Behavior | null, size = 'medium'): MatchPet => ({ id: 'p1', name: 'Test', size, pet_behavior_profiles: behavior });

describe('compatibility engine', () => {
  it('uses the specified weights, which total 100', () => {
    expect(weights).toEqual({ activity: 25, home: 20, household: 20, time: 15, experience: 10, preferences: 10 });
    expect(Object.values(weights).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('scores a fully compatible, fully verified profile at 100 with full confidence', () => {
    const result = calculateMatch(answers, pet(verified));
    expect(result).toMatchObject({ score: 100, confidence: 100, excluded: false, requires_staff_assessment: false });
  });

  it('is deterministic: the same inputs always give the same result', () => {
    const mismatch = { ...answers, activity: 1, exercise_capacity: 1, hours_away: 10 };
    const first = calculateMatch(mismatch, pet({ ...verified, energy_level: 5 }));
    for (let i = 0; i < 20; i++) expect(calculateMatch(mismatch, pet({ ...verified, energy_level: 5 }))).toEqual(first);
    expect(first.score).toBeLessThan(100);
  });

  it('computes the weighted score from the individual factors', () => {
    // Energy 5 vs activity 3 / capacity 3: activity factor = 100 - (2 + 2) * 20 = 20. All other factors 100.
    const result = calculateMatch(answers, pet({ ...verified, energy_level: 5 }));
    expect(result.factors.find(f => f.name === 'activity')?.score).toBe(20);
    expect(result.score).toBe(Math.round((20 * 25 + 100 * 75) / 100));
  });

  it.each([
    ['children at home', { children: true }, { good_with_children: false }],
    ['other animals at home', { other_pets: true }, { good_with_dogs: false }],
    ['no outdoor space', { outdoor_space: false }, { needs_outdoor_space: true }],
    ['apartment living', { home_type: 'apartment' as const }, { apartment_suitable: false }],
  ])('applies the critical exclusion for %s before scoring', (_label, answer, behavior) => {
    const result = calculateMatch({ ...answers, ...answer }, pet({ ...verified, ...behavior }));
    expect(result.excluded).toBe(true);
    expect(result.score).toBeNull();
    expect(result.exclusions.length).toBeGreaterThan(0);
    expect(result.requires_staff_assessment).toBe(true);
  });

  it('does not invent a score when temperament data is missing', () => {
    const result = calculateMatch(answers, pet(null));
    expect(result.score).toBeNull();
    expect(result.confidence).toBe(0);
    expect(result.requires_staff_assessment).toBe(true);
    expect(result.challenges.every(c => c.startsWith('Staff assessment needed'))).toBe(true);
  });

  it('ignores a behaviour profile that staff have not verified', () => {
    const { verified_at: _unverified, ...draft } = verified;
    expect(calculateMatch(answers, pet(draft)).score).toBeNull();
  });

  it('lowers confidence, not the score, for a single unknown factor', () => {
    const result = calculateMatch({ ...answers, children: true }, pet({ ...verified, good_with_children: null }));
    expect(result.confidence).toBe(80);
    expect(result.score).toBe(100);
    expect(result.requires_staff_assessment).toBe(true);
  });

  it('rejects out-of-range and unexpected quiz answers', () => {
    expect(assessmentSchema.safeParse({ ...answers, activity: 9 }).success).toBe(false);
    expect(assessmentSchema.safeParse({ ...answers, score: 100 }).success).toBe(false);
  });
});
