import { expect, it } from 'vitest';
import { estimateTransport, pricingConfigured, sizeBand, type Pricing } from '../../server/src/modules/transport/estimate';
import { classifyCoverage, coverageBlock } from '../../server/src/modules/transport/service';

// The figures here are test inputs, not shelter rates: the shelter enters its own.
const empty: Pricing = { base_fee_centavos: null, rate_per_km_centavos: null, handling_fees: {}, surcharges: [] };
const priced: Pricing = { base_fee_centavos: 10_000, rate_per_km_centavos: 1_500, handling_fees: { species: { dog: 5_000, cat: 3_000, other: null }, size: { small_max_kg: 10, medium_max_kg: 25, small: null, medium: 2_000, large: 6_000 } }, surcharges: [{ label: 'Carrier loan', amount_centavos: 4_000, when: 'no_carrier' }, { label: 'Toll', amount_centavos: 1_200, when: 'always' }] };

it('gives no estimate until both a base fee and a rate per kilometre are set', () => {
  expect(estimateTransport(empty, { distance_km: 20 })).toBeNull();
  expect(estimateTransport({ ...empty, base_fee_centavos: 10_000 }, { distance_km: 20 })).toBeNull();
  expect(estimateTransport({ ...empty, rate_per_km_centavos: 1_500 }, { distance_km: 20 })).toBeNull();
  expect(pricingConfigured(empty)).toBe(false);
  expect(pricingConfigured({ ...empty, base_fee_centavos: 0, rate_per_km_centavos: 0 })).toBe(true);
});

it('is base fee plus road distance times the rate when nothing else is configured', () => {
  const estimate = estimateTransport({ ...empty, base_fee_centavos: 10_000, rate_per_km_centavos: 1_500 }, { distance_km: 18.4, species: 'dog', weight_kg: 12, has_carrier: false })!;
  expect(estimate.lines).toEqual([{ label: 'Base fee', amount_centavos: 10_000 }, { label: 'Distance: 18.4 km × ₱15.00 per km', amount_centavos: 27_600 }]);
  expect(estimate).toMatchObject({ total_centavos: 37_600, pending: [] });
});

it('adds the handling fees and surcharges that apply to this animal', () => {
  const dog = estimateTransport(priced, { distance_km: 10, species: 'dog', weight_kg: 12, has_carrier: false })!;
  expect(dog.lines.map(line => [line.label, line.amount_centavos])).toEqual([['Base fee', 10_000], ['Distance: 10 km × ₱15.00 per km', 15_000], ['Handling: dog', 5_000], ['Handling: medium (12 kg)', 2_000], ['Carrier loan', 4_000], ['Toll', 1_200]]);
  expect(dog.total_centavos).toBe(37_200);
  // A small cat with a carrier: no size fee is set for small, and the carrier surcharge does not apply.
  const cat = estimateTransport(priced, { distance_km: 10, species: 'cat', weight_kg: 4, has_carrier: true })!;
  expect(cat.lines.map(line => line.label)).toEqual(['Base fee', 'Distance: 10 km × ₱15.00 per km', 'Handling: cat', 'Toll']);
  expect(cat.total_centavos).toBe(29_200);
  expect(estimateTransport(priced, { distance_km: 10, species: 'other', weight_kg: 40, has_carrier: true })!.lines.map(line => line.label)).toEqual(['Base fee', 'Distance: 10 km × ₱15.00 per km', 'Handling: large (40 kg)', 'Toll']);
});

it('says what is missing instead of guessing a fee', () => {
  const estimate = estimateTransport(priced, { distance_km: 10, species: 'dog' })!;
  expect(estimate.pending).toEqual(['weight']);
  expect(estimate.lines.map(line => line.label)).not.toContain('Carrier loan');
  expect(estimate.total_centavos).toBe(10_000 + 15_000 + 5_000 + 1_200);
});

it('rounds the distance charge to whole centavos and never invents a size band', () => {
  expect(estimateTransport({ ...empty, base_fee_centavos: 0, rate_per_km_centavos: 333 }, { distance_km: 0.1 })!.total_centavos).toBe(33);
  expect(sizeBand(12, undefined)).toBeNull();
  expect(sizeBand(12, { small_max_kg: null, medium_max_kg: null })).toBeNull();
  expect([5, 10, 10.1, 25, 26].map(weight => sizeBand(weight, { small_max_kg: 10, medium_max_kg: 25 }))).toEqual(['small', 'small', 'medium', 'medium', 'large']);
  expect([5, 30].map(weight => sizeBand(weight, { small_max_kg: 10, medium_max_kg: null }))).toEqual(['small', 'large']);
});

it('classifies coverage from the zones first and the distance limit second', () => {
  expect(classifyCoverage({ status: 'within_coverage' }, 30, { max_distance_km: null })).toEqual({ status: 'within_coverage' });
  expect(classifyCoverage({ status: 'within_coverage' }, 30, { max_distance_km: 30 })).toEqual({ status: 'within_coverage' });
  expect(classifyCoverage({ status: 'within_coverage' }, 30.1, { max_distance_km: 30 })).toEqual({ status: 'outside_coverage', reason: 'beyond_max_distance', max_distance_km: 30 });
  expect(classifyCoverage({ status: 'outside_coverage' }, 5, { max_distance_km: 30 })).toEqual({ status: 'outside_coverage' });
  expect(classifyCoverage({ status: 'manual_review_required' }, 99, { max_distance_km: 30 })).toEqual({ status: 'manual_review_required' });
  expect(coverageBlock({ status: 'within_coverage' })).toBeNull();
  expect(coverageBlock({ status: 'manual_review_required' })).toBeNull();
  expect(coverageBlock({ status: 'outside_coverage' })?.code).toBe('OUTSIDE_COVERAGE');
  expect(coverageBlock({ status: 'temporarily_unavailable' })?.code).toBe('COVERAGE_PAUSED');
});
