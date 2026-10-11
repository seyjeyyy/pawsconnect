import { z } from 'zod';

export const assessmentSchema = z.object({
  activity: z.number().int().min(1).max(5),
  home_type: z.enum(['apartment', 'house']),
  outdoor_space: z.boolean(),
  care_hours: z.number().min(0).max(24),
  hours_away: z.number().min(0).max(24),
  experience: z.enum(['first_time', 'some', 'experienced']),
  children: z.boolean(),
  other_pets: z.boolean(),
  preferred_size: z.enum(['any', 'small', 'medium', 'large']),
  temperament: z.enum(['any', 'calm', 'playful', 'independent']),
  grooming_commitment: z.number().int().min(1).max(5),
  exercise_capacity: z.number().int().min(1).max(5),
}).strict();
export type Answers = z.infer<typeof assessmentSchema>;
export interface Behavior {
  energy_level?: number | null; apartment_suitable?: boolean | null; needs_outdoor_space?: boolean | null;
  good_with_children?: boolean | null; good_with_dogs?: boolean | null; good_with_cats?: boolean | null;
  min_care_hours?: number | null; max_hours_alone?: number | null;
  experience_required?: 'first_time' | 'some' | 'experienced' | null;
  grooming_needs?: number | null; temperament?: string[] | null; verified_at?: string | null;
}
/** A pet_behavior_profiles row as stored in the database. Staff and veterinarians record it in these terms. */
export interface BehaviorRow {
  energy_level?: number | null; temperament?: string[] | null; suitable_homes?: string[] | null;
  good_with_children?: boolean | null; good_with_dogs?: boolean | null; good_with_cats?: boolean | null;
  care_hours_daily?: number | string | null; max_hours_alone?: number | string | null;
  experience_required?: number | string | null; grooming_level?: number | null;
  needs_outdoor_space?: boolean | null; verified_at?: string | null;
}
const numeric = (value: number | string | null | undefined) => value == null || value === '' || Number.isNaN(Number(value)) ? null : Number(value);
/**
 * Converts a database row into the terms the scoring uses. Anything the row
 * does not record stays null, which lowers confidence instead of inventing a value.
 * Experience is stored as 1-5: 1-2 suits a first-time owner, 3 needs some experience, 4-5 an experienced one.
 */
export function behaviorFromRow(row: BehaviorRow): Behavior {
  const homes = row.suitable_homes?.length ? row.suitable_homes : null;
  const experience = numeric(row.experience_required);
  return {
    energy_level: row.energy_level ?? null,
    apartment_suitable: homes ? homes.includes('apartment') : null,
    needs_outdoor_space: row.needs_outdoor_space ?? null,
    good_with_children: row.good_with_children ?? null, good_with_dogs: row.good_with_dogs ?? null, good_with_cats: row.good_with_cats ?? null,
    min_care_hours: numeric(row.care_hours_daily), max_hours_alone: numeric(row.max_hours_alone),
    experience_required: experience == null ? null : experience <= 2 ? 'first_time' : experience === 3 ? 'some' : 'experienced',
    grooming_needs: row.grooming_level ?? null,
    temperament: row.temperament?.length ? row.temperament : null,
    verified_at: row.verified_at ?? null,
  };
}
export interface MatchPet { id: string; name: string; size: string; pet_behavior_profiles?: Behavior | BehaviorRow | (Behavior | BehaviorRow)[] | null; [key: string]: unknown }
const experienceRank = { first_time: 0, some: 1, experienced: 2 };
export const weights = { activity: 25, home: 20, household: 20, time: 15, experience: 10, preferences: 10 };

/** Scores only observed, staff-verified factors. Unknown factors reduce confidence, never become a made-up neutral score. */
export function calculateMatch(answers: Answers, pet: MatchPet) {
  const raw = Array.isArray(pet.pet_behavior_profiles) ? pet.pet_behavior_profiles[0] : pet.pet_behavior_profiles;
  // Translate stored behaviour measurements into the scoring engine's terms.
  const isRow = raw != null && ('suitable_homes' in raw || 'care_hours_daily' in raw || 'grooming_level' in raw);
  const profile: Behavior = !raw?.verified_at ? {} : isRow ? behaviorFromRow(raw as BehaviorRow) : raw as Behavior;
  const exclusions: string[] = [], reasons: string[] = [], challenges: string[] = [];
  const factors: { name: string; weight: number; score: number | null }[] = [];
  const add = (name: keyof typeof weights, score: number | null, positive: string, concern: string) => {
    factors.push({ name, weight: weights[name], score });
    if (score === null) challenges.push(`Staff assessment needed: ${name}.`);
    else if (score >= 75) reasons.push(positive);
    else challenges.push(concern);
  };
  if (answers.children && profile.good_with_children === false) exclusions.push('This pet is not currently assessed as suitable for a home with children.');
  if (answers.other_pets && (profile.good_with_dogs === false || profile.good_with_cats === false)) exclusions.push('Other animals in the household require an individual staff compatibility review.');
  if (!answers.outdoor_space && profile.needs_outdoor_space === true) exclusions.push('This pet requires secure outdoor space.');
  if (answers.home_type === 'apartment' && profile.apartment_suitable === false) exclusions.push('The verified care profile requires a different living environment.');

  const energy = profile.energy_level;
  add('activity', energy == null ? null : Math.max(0, 100 - (Math.abs(answers.activity - energy) + Math.max(0, energy - answers.exercise_capacity)) * 20), 'Your activity and exercise capacity suit this pet.', 'This pet may need a different exercise routine.');
  const homeKnown = profile.apartment_suitable != null && profile.needs_outdoor_space != null;
  add('home', homeKnown ? ((answers.home_type !== 'apartment' || profile.apartment_suitable) && (answers.outdoor_space || !profile.needs_outdoor_space) ? 100 : 0) : null, 'Your home fits the verified space needs.', 'Discuss safe housing and outdoor access with the shelter.');
  const householdChecks = [...(answers.children ? [profile.good_with_children] : []), ...(answers.other_pets ? [profile.good_with_dogs, profile.good_with_cats] : [])];
  // With no verified profile there is nothing to compare against, so an empty checklist must not count as a perfect fit.
  add('household', !raw?.verified_at || householdChecks.some(v => v == null) ? null : householdChecks.some(v => v === false) ? 0 : 100, 'Your household fits the known compatibility needs.', 'Introductions and household suitability need staff guidance.');
  add('time', profile.min_care_hours == null || profile.max_hours_alone == null ? null : Math.max(0, 100 - Math.max(0, profile.min_care_hours - answers.care_hours) * 25 - Math.max(0, answers.hours_away - profile.max_hours_alone) * 15), 'Your available care time fits this pet’s routine.', 'Arrange additional care or shorter periods alone.');
  add('experience', profile.experience_required == null ? null : Math.max(0, 100 - Math.max(0, experienceRank[profile.experience_required] - experienceRank[answers.experience]) * 45), 'Your experience fits the care profile.', 'Training support and an experienced caregiver may be needed.');
  add('preferences', profile.grooming_needs == null || !profile.temperament ? null : Math.max(0, 100 - (answers.preferred_size !== 'any' && answers.preferred_size !== pet.size ? 35 : 0) - (answers.temperament !== 'any' && !profile.temperament.includes(answers.temperament) ? 30 : 0) - Math.max(0, profile.grooming_needs - answers.grooming_commitment) * 15), 'Size, temperament, and grooming needs fit your preferences.', 'Consider the size, temperament, or grooming commitments.');
  const knownWeight = factors.reduce((sum, f) => sum + (f.score == null ? 0 : f.weight), 0);
  const score = knownWeight && exclusions.length === 0 ? Math.round(factors.reduce((sum, f) => sum + (f.score ?? 0) * f.weight, 0) / knownWeight) : null;
  return { pet, score, excluded: exclusions.length > 0, exclusions, reasons, challenges, confidence: knownWeight, factors, requires_staff_assessment: knownWeight < 100 || exclusions.length > 0 };
}
