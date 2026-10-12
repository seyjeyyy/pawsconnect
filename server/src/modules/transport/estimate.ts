// The estimate shown to a customer before staff quote. It is arithmetic on rates an administrator
// entered: with no base fee or no rate per kilometre there is no estimate at all. The final price
// is always the staff quotation.
export type HandlingFees = {
  /** Flat handling fee for the kind of animal. */
  species?: Partial<Record<'dog' | 'cat' | 'other', number | null>>;
  /** Handling fee by weight band. The bands exist only once an administrator has entered their limits. */
  size?: { small_max_kg?: number | null; medium_max_kg?: number | null; small?: number | null; medium?: number | null; large?: number | null };
};
export type Surcharge = { label: string; amount_centavos: number; when: 'always' | 'no_carrier' };
export type Pricing = { base_fee_centavos: number | null; rate_per_km_centavos: number | null; handling_fees: HandlingFees; surcharges: Surcharge[] };
export type EstimateInput = { distance_km: number; species?: 'dog' | 'cat' | 'other'; weight_kg?: number; has_carrier?: boolean };
export type Estimate = { total_centavos: number; lines: { label: string; amount_centavos: number }[]; /** What is still needed for the estimate to include every configured fee. */ pending: string[] };

export const pricingConfigured = (pricing: Pricing) => pricing.base_fee_centavos !== null && pricing.rate_per_km_centavos !== null;
const pesos = (centavos: number) => `₱${(centavos / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Which weight band an animal falls in, or null when no bands are set up. */
export function sizeBand(weightKg: number, size: HandlingFees['size']): 'small' | 'medium' | 'large' | null {
  const small = size?.small_max_kg ?? null, medium = size?.medium_max_kg ?? null;
  if (small === null && medium === null) return null;
  if (small !== null && weightKg <= small) return 'small';
  if (medium !== null && weightKg <= medium) return 'medium';
  // With only a small limit there is no medium band: everything heavier is large.
  return 'large';
}

export function estimateTransport(pricing: Pricing, input: EstimateInput): Estimate | null {
  if (pricing.base_fee_centavos === null || pricing.rate_per_km_centavos === null) return null;
  const lines = [
    { label: 'Base fee', amount_centavos: pricing.base_fee_centavos },
    { label: `Distance: ${input.distance_km} km × ${pesos(pricing.rate_per_km_centavos)} per km`, amount_centavos: Math.round(input.distance_km * pricing.rate_per_km_centavos) },
  ];
  const pending: string[] = [];
  const bySpecies = pricing.handling_fees.species ?? {}, bySize = pricing.handling_fees.size;
  if (Object.values(bySpecies).some(fee => fee)) {
    if (!input.species) pending.push('species');
    else if (bySpecies[input.species]) lines.push({ label: `Handling: ${input.species}`, amount_centavos: bySpecies[input.species]! });
  }
  if (bySize && (bySize.small || bySize.medium || bySize.large) && sizeBand(1, bySize) !== null) {
    if (input.weight_kg === undefined) pending.push('weight');
    else { const band = sizeBand(input.weight_kg, bySize)!; if (bySize[band]) lines.push({ label: `Handling: ${band} (${input.weight_kg} kg)`, amount_centavos: bySize[band]! }); }
  }
  for (const surcharge of pricing.surcharges) {
    if (surcharge.when === 'always' || (surcharge.when === 'no_carrier' && input.has_carrier === false)) lines.push({ label: surcharge.label, amount_centavos: surcharge.amount_centavos });
  }
  return { total_centavos: lines.reduce((sum, line) => sum + line.amount_centavos, 0), lines, pending };
}
