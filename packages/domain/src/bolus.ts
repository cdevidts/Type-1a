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
 * ## Insulina activa (IOB) — desde el 2026-09-02 SÍ se descuenta
 *
 * Antes no, y ese era el problema: registrar una comida chica con corrección
 * y otra comida cinco minutos después producía **dos correcciones completas**
 * por la misma glucosa alta. La app proponía el stacking con toda confianza.
 * Ver `iob.ts` y `docs/adr/0005`.
 *
 * La regla que gobierna la resta y que **no se puede relajar**: el IOB se
 * descuenta **solo de la parte de corrección, nunca de la de comida**. Los
 * carbohidratos que vas a comer necesitan su insulina completa aunque tengas
 * activa; restarla ahí te deja corta y es el error clásico de quien
 * implementa esto por primera vez.
 *
 * `activeInsulinUnits` es **opcional**. Sin insulina configurada no hay curva
 * y no hay IOB: el resultado es exactamente el de antes y la pantalla lo dice.
 * "No lo sé" nunca se convierte en "no queda nada".
 */
import { isHypoglycemic } from './glucose-thresholds';

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
  /**
   * Insulina rápida que sigue actuando, de `activeInsulinUnits` en `iob.ts`.
   * Omitida = no se sabe (sin insulina configurada), y entonces no se resta
   * nada — no es lo mismo que saber que hay 0 U activas.
   */
  activeInsulinUnits: z.number().nonnegative().max(100).finite().optional(),
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
  /**
   * Insulina activa que se descontó, o `undefined` si no se sabía. Se expone
   * para que la pantalla pueda mostrar el desglose entero: un total que baja
   * sin decir por qué es peor que no bajarlo.
   */
  activeInsulinUnits: number | undefined;
  /**
   * La corrección **después** de descontar el IOB, antes de redondear. Puede
   * quedar negativa —ya tienes de sobra para lo que estás alta— y en ese caso
   * reduce el bolo de comida, igual que estar bajo objetivo.
   */
  correctionAfterActiveUnits: number;
  /** `mealUnits + correctionAfterActiveUnits`, floored at 0. */
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
  // El IOB sale SOLO de la corrección. Restarlo del total mezclaría las dos
  // mitades y dejaría corta la cobertura de los carbohidratos.
  const correctionAfterActiveUnits = correctionUnits - (parsed.activeInsulinUnits ?? 0);
  const totalRawUnits = Math.max(0, mealUnits + correctionAfterActiveUnits);

  return {
    mealUnits,
    correctionUnits,
    activeInsulinUnits: parsed.activeInsulinUnits,
    correctionAfterActiveUnits,
    totalRawUnits,
    totalRoundedUnits: roundToIncrement(totalRawUnits, parsed.doseIncrement),
    correctionApplied: parsed.currentGlucose !== undefined,
    // Sigue describiendo la glucosa, no el resultado de la resta: "estás bajo
    // objetivo" y "ya tienes insulina de sobra" son dos avisos distintos.
    isBelowTarget: correctionUnits < 0,
    isHypoglycemic: parsed.currentGlucose !== undefined && isHypoglycemic(parsed.currentGlucose),
    mealFormula: `${parsed.carbsG} g ÷ ${parsed.carbRatio} g/U`,
    correctionFormula: parsed.currentGlucose === undefined
      ? null
      : `(${parsed.currentGlucose} − ${parsed.targetGlucose}) ÷ ${parsed.correctionFactor}`
        + (parsed.activeInsulinUnits === undefined ? '' : ` − ${parsed.activeInsulinUnits} U activas`),
  };
}
