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
 * ## El error que cometimos igual, y cómo se ve (2026-09-03)
 *
 * El comentario de arriba estaba escrito y el código igual lo hacía mal. La
 * resta era `mealUnits + (correcciónUnits − IOB)` sin tope, así que cuando el
 * IOB superaba a la corrección **el sobrante seguía viaje y se comía la
 * cobertura de los carbohidratos**. La cuenta era formalmente "solo de la
 * corrección" y el efecto era exactamente el prohibido.
 *
 * Lo encontró Verónica con el caso más cotidiano que hay: comió y se corrigió
 * hace diez minutos, ahora quiere comer 20 g más, y la app le proponía **0 U**
 * porque le quedaban 9 U activas. Los 20 g de carbohidratos nuevos necesitan
 * sus 2 U pase lo que pase.
 *
 * Su regla, que es la correcta y ahora es la del código: **carbohidratos
 * nuevos = siempre te pinchas; corrección nueva = no necesariamente.**
 *
 * El tope va en `correctionAfterActiveUnits`: el IOB puede llevar la
 * corrección hasta 0 y ahí se detiene. Lo que sí puede seguir bajando el total
 * es una **glucosa bajo objetivo**, que es otra cosa y se calcula antes de
 * mirar el IOB — estar en 70 sí es motivo para poner menos insulina de la que
 * pediría el plato, y esa resta ya existía y se conserva.
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
   * La corrección **después** de descontar el IOB, antes de redondear.
   *
   * Nunca baja de 0 por culpa del IOB: tener insulina de sobra significa "no
   * corrijas", no "come sin insulina". Sí puede ser negativa cuando la
   * **glucosa** está bajo objetivo, que es una razón distinta y anterior.
   */
  correctionAfterActiveUnits: number;
  /**
   * Cuánto IOB alcanzó a descontarse de verdad, y cuánto sobró sin usar.
   *
   * Se expone porque la pantalla tiene que poder decir "de tus 9 U activas se
   * usaron 3 para anular la corrección; las otras 6 no tocan tu comida". Sin
   * esto el desglose muestra un −9 que no cuadra con el total y parece un
   * error de la app justo donde menos conviene dudar.
   */
  activeInsulinAppliedUnits: number;
  /** El IOB que quedó sin aplicar porque ya no había corrección que anular. */
  activeInsulinUnusedUnits: number;
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
  // El IOB sale SOLO de la corrección, y **con tope en 0**. Sin ese tope el
  // sobrante se comía la cobertura de los carbohidratos, que es justo lo que
  // el comentario de arriba prohíbe. Ver el bloque "El error que cometimos
  // igual" en la cabecera de este archivo.
  //
  // Cuando la corrección ya es negativa por glucosa baja no hay nada que
  // descontar: el IOB no aplica y esa resta —que sí baja el total— se
  // conserva entera, porque estar en 70 es motivo real para poner menos.
  const activeUnits = parsed.activeInsulinUnits ?? 0;
  const activeInsulinAppliedUnits = correctionUnits <= 0 ? 0 : Math.min(activeUnits, correctionUnits);
  const activeInsulinUnusedUnits = activeUnits - activeInsulinAppliedUnits;
  const correctionAfterActiveUnits = correctionUnits - activeInsulinAppliedUnits;
  const totalRawUnits = Math.max(0, mealUnits + correctionAfterActiveUnits);

  return {
    mealUnits,
    correctionUnits,
    activeInsulinUnits: parsed.activeInsulinUnits,
    activeInsulinAppliedUnits,
    activeInsulinUnusedUnits,
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
        // La resta que se imprime es la que se hizo. Antes decía "− 9 U activas"
      // sobre una corrección de 1.4 que solo perdió 1.4: la expresión daba
      // −7.6 y el desglose de al lado decía lo contrario. Dos relatos del
      // mismo número en una calculadora de dosis, y el falso parecía la
      // fórmula.
      + (activeInsulinAppliedUnits <= 0
        ? ''
        : ` − ${Number(activeInsulinAppliedUnits.toFixed(2))} U activas`),
  };
}
