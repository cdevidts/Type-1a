import { z } from 'zod';

import { isHypoglycemic } from './glucose-thresholds';

const CorrectionInputSchema = z.object({
  currentGlucose: z.number().positive().finite(),
  targetGlucose: z.number().positive().finite(),
  correctionFactor: z.number().positive().finite(),
  doseIncrement: z.number().positive().max(1).finite(),
});

export interface CorrectionResult {
  rawUnits: number;
  roundedUnits: number;
  isBelowTarget: boolean;
  /**
   * Glucose is in hypoglycemic range — a different situation from merely
   * sitting under target. Same meaning and same threshold as the flag on
   * `MealBolusResult`, so both dose screens can say "treat the low first"
   * without keeping their own copy of the cutoff.
   */
  isHypoglycemic: boolean;
  formula: string;
}

export function roundToIncrement(value: number, increment: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(increment) || increment <= 0) {
    throw new Error('Value and increment must be finite; increment must be positive.');
  }

  const decimals = Math.max(0, (increment.toString().split('.')[1] ?? '').length);
  return Number((Math.round(value / increment) * increment).toFixed(decimals));
}

/**
 * Standalone correction: the result is floored at 0 U, because there is
 * nothing for a negative value to offset.
 *
 * This deliberately differs from `calculateMealBolus` in `bolus.ts`, where
 * the correction component is allowed to stay negative so that a
 * below-target glucose *reduces* the meal bolus. Do not "harmonize" the two
 * — clamping the component there would return a larger dose to someone who
 * is already low. `bolus.test.ts` asserts the two agree exactly at
 * `carbsG = 0`, which is the only point where they should.
 */
export function calculateCorrection(input: z.input<typeof CorrectionInputSchema>): CorrectionResult {
  const parsed = CorrectionInputSchema.parse(input);
  const raw = (parsed.currentGlucose - parsed.targetGlucose) / parsed.correctionFactor;
  const nonNegativeRaw = Math.max(0, raw);

  return {
    rawUnits: nonNegativeRaw,
    roundedUnits: roundToIncrement(nonNegativeRaw, parsed.doseIncrement),
    isBelowTarget: raw < 0,
    isHypoglycemic: isHypoglycemic(parsed.currentGlucose),
    formula: `(${parsed.currentGlucose} − ${parsed.targetGlucose}) ÷ ${parsed.correctionFactor}`,
  };
}
