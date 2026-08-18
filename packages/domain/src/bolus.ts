import { z } from 'zod';

import { roundToIncrement } from './correction';

/**
 * Combined meal + correction bolus arithmetic.
 *
 * This is deliberately plain arithmetic over values the user configured with
 * their clinical team (`carbRatio`, `correctionFactor`, `targetGlucose`,
 * `doseIncrement`) — never an LLM, never a value the app inferred on its own.
 * It is a calculator, not a recommendation: the caller must present the result
 * as something the user edits and confirms before any insulin is logged.
 *
 * Explicitly NOT modelled (see AGENTS.md): insulin on board. Nothing here
 * subtracts insulin still acting from an earlier dose, so a result computed
 * shortly after another bolus will overstate what the user should take. The
 * UI has to say so.
 */
/**
 * Standard hypoglycemia cutoff (mg/dL). Not a therapy parameter the user
 * configures — it is the widely used clinical threshold for "this is a low",
 * used here only to decide whether to warn, never to alter a dose.
 */
const HYPOGLYCEMIA_THRESHOLD = 70;

const MealBolusInputSchema = z.object({
  carbsG: z.number().nonnegative().max(500).finite(),
  /** Grams of carbohydrate covered by one unit of rapid insulin. */
  carbRatio: z.number().positive().finite(),
  /**
   * Omitted when the user has no trustworthy current glucose to work from —
   * the correction half is then skipped entirely rather than guessed at.
   */
  currentGlucose: z.number().positive().finite().optional(),
  targetGlucose: z.number().positive().finite(),
  correctionFactor: z.number().positive().finite(),
  doseIncrement: z.number().positive().max(1).finite(),
});

export interface MealBolusResult {
  /** Carb coverage alone, before rounding. Always >= 0. */
  mealUnits: number;
  /**
   * Correction alone, before rounding. **Negative when glucose is under
   * target** — unlike `calculateCorrection`, which clamps a standalone
   * correction at 0. Here the negative value is kept on purpose so that
   * being low reduces the meal dose instead of being silently ignored,
   * which would hand back a larger total than the numbers justify.
   */
  correctionUnits: number;
  /** `mealUnits + correctionUnits`, floored at 0. */
  totalRawUnits: number;
  totalRoundedUnits: number;
  /** False when no `currentGlucose` was supplied — the total is carbs only. */
  correctionApplied: boolean;
  isBelowTarget: boolean;
  /**
   * Glucose is in hypoglycemic range, which is a different situation from
   * merely sitting under target: the answer is to treat the low first and
   * dose afterwards, not to take a slightly smaller bolus now. Callers must
   * surface this differently from `isBelowTarget`.
   */
  isHypoglycemic: boolean;
  mealFormula: string;
  correctionFormula: string | null;
}

export function calculateMealBolus(input: z.input<typeof MealBolusInputSchema>): MealBolusResult {
  const parsed = MealBolusInputSchema.parse(input);

  const mealUnits = parsed.carbsG / parsed.carbRatio;
  const correctionUnits = parsed.currentGlucose === undefined
    ? 0
    : (parsed.currentGlucose - parsed.targetGlucose) / parsed.correctionFactor;
  const totalRawUnits = Math.max(0, mealUnits + correctionUnits);

  return {
    mealUnits,
    correctionUnits,
    totalRawUnits,
    totalRoundedUnits: roundToIncrement(totalRawUnits, parsed.doseIncrement),
    correctionApplied: parsed.currentGlucose !== undefined,
    isBelowTarget: correctionUnits < 0,
    isHypoglycemic: parsed.currentGlucose !== undefined && parsed.currentGlucose < HYPOGLYCEMIA_THRESHOLD,
    mealFormula: `${parsed.carbsG} g ÷ ${parsed.carbRatio} g/U`,
    correctionFormula: parsed.currentGlucose === undefined
      ? null
      : `(${parsed.currentGlucose} − ${parsed.targetGlucose}) ÷ ${parsed.correctionFactor}`,
  };
}
