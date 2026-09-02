import { z } from 'zod';

import { isHypoglycemic } from './glucose-thresholds';

const CorrectionInputSchema = z.object({
  currentGlucose: z.number().positive().finite(),
  targetGlucose: z.number().positive().finite(),
  correctionFactor: z.number().positive().finite(),
  doseIncrement: z.number().positive().max(1).finite(),
  /**
   * Insulina rápida que sigue actuando (`activeInsulinUnits` en `iob.ts`).
   * Omitida = no se sabe, y entonces no se resta nada. Ver la nota de
   * `bolus.ts`: sin insulina configurada el resultado es el de siempre.
   */
  activeInsulinUnits: z.number().nonnegative().max(100).finite().optional(),
});

export interface CorrectionResult {
  rawUnits: number;
  roundedUnits: number;
  /** La corrección antes de descontar el IOB, para poder mostrar el desglose. */
  beforeActiveUnits: number;
  /** Lo descontado, o `undefined` si no se sabía cuánta insulina hay activa. */
  activeInsulinUnits: number | undefined;
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
  const beforeActive = (parsed.currentGlucose - parsed.targetGlucose) / parsed.correctionFactor;
  // Acá sí se resta del total, porque acá el total **es** la corrección: no
  // hay carbohidratos que cubrir. Sigue con piso en 0 — una corrección
  // negativa no tiene nada que compensar, y ese es justo el caso en que ya
  // tienes suficiente insulina actuando.
  const raw = beforeActive - (parsed.activeInsulinUnits ?? 0);
  const nonNegativeRaw = Math.max(0, raw);

  return {
    rawUnits: nonNegativeRaw,
    roundedUnits: roundToIncrement(nonNegativeRaw, parsed.doseIncrement),
    beforeActiveUnits: beforeActive,
    activeInsulinUnits: parsed.activeInsulinUnits,
    // Describe la GLUCOSA, no el resultado de la resta: "estás bajo objetivo"
    // y "ya tienes insulina de sobra" son dos cosas distintas y la pantalla
    // las dice distinto.
    isBelowTarget: beforeActive < 0,
    isHypoglycemic: isHypoglycemic(parsed.currentGlucose),
    formula: `(${parsed.currentGlucose} − ${parsed.targetGlucose}) ÷ ${parsed.correctionFactor}`
      + (parsed.activeInsulinUnits === undefined ? '' : ` − ${parsed.activeInsulinUnits} U activas`),
  };
}
