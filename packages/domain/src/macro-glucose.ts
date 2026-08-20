import type { CGMReading, MealEvent } from '@type1a/schemas';

import { readingNear, toGlucoseSeries } from './nutrition-insights';

/**
 * Grasa + proteína de una comida frente a la glucosa **tardía** (Fase 14).
 *
 * ## Por qué existe
 *
 * Es la pieza que une las dos mitades de esta app. El conteo de carbohidratos
 * explica la subida temprana; la grasa y la proteína explican la tardía, y esa
 * parte hoy no se ve en ningún lado. La evidencia en diabetes tipo 1 es
 * consistente:
 *
 * - Una comida alta en grasa y/o proteína produce una subida **retrasada y
 *   prolongada**, aproximadamente entre 1,5 y 6 h después de comer.
 * - La grasa tiende a hacer pico cerca de las 2 h; la proteína cerca de las
 *   3,5 h y se sostiene hasta las 5 h.
 * - Cuando la comida es alta en ambas, el efecto es **aditivo**, con
 *   excursiones significativamente mayores entre las 3 y las 5 h que con
 *   comidas altas en solo uno de los dos.
 *
 * Por eso los horizontes de este módulo son 2/3/4/5 h y no 1/2/3 h como los de
 * `nutrition-insights.ts`, que miden la respuesta a una dosis rápida.
 *
 * ## Frontera de seguridad — la más estrecha del repo
 *
 * La respuesta que la literatura da a este patrón es **ajustar la insulina**
 * (bolos duales o extendidos). Eso es exactamente lo que `AGENTS.md` prohíbe
 * que la app calcule, infiera o recomiende, y este módulo es el lugar donde
 * sería más tentador hacerlo.
 *
 * Lo que este módulo hace: **describir lo que ya pasó** con los datos de la
 * propia usuaria, separando sus comidas en las de mayor y menor carga de
 * grasa+proteína y mostrando su glucosa a cada horizonte.
 *
 * Lo que **nunca** debe hacer, ni acá ni en la pantalla que lo dibuje:
 * proponer un bolo extendido, un porcentaje de dosis, un tiempo de espera,
 * ni sugerir comer menos grasa o proteína. Es material para conversar con el
 * equipo clínico, no una indicación.
 *
 * También se compara contra la glucosa **al momento de comer**, no en
 * absoluto: una excursión de +40 mg/dL dice algo; "180 mg/dL a las 3 h" sin
 * saber de dónde partió, no.
 */

export const FAT_PROTEIN_HORIZONS_HOURS = [2, 3, 4, 5] as const;

/**
 * Mínimo de comidas elegibles por grupo para publicar un promedio. Con menos,
 * el número es ruido y se presta a leer un patrón donde no lo hay — mismo
 * criterio que `MIN_SAMPLE_FOR_RATE` en `nutrition-insights.ts`.
 */
export const MIN_MEALS_PER_GROUP = 3;

export interface MacroGlucosePoint {
  horizonHours: number;
  sampleSize: number;
  /** Cambio promedio de glucosa desde el momento de comer, en mg/dL. */
  meanDeltaMgDl?: number | undefined;
}

export interface MacroGlucoseGroup {
  mealCount: number;
  /** Promedio de gramos de grasa + proteína de las comidas del grupo. */
  avgFatProteinG: number;
  points: MacroGlucosePoint[];
}

export interface MacroGlucoseComparison {
  /** Gramos de grasa+proteína que separan los dos grupos (la mediana). */
  splitAtFatProteinG: number;
  higher: MacroGlucoseGroup;
  lower: MacroGlucoseGroup;
  /** Comidas con grasa Y proteína anotadas; las demás no son comparables. */
  eligibleMealCount: number;
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function groupFor(
  meals: readonly { atMs: number; fatProteinG: number }[],
  series: readonly { atMs: number; mgDl: number }[],
): MacroGlucoseGroup {
  const points: MacroGlucosePoint[] = FAT_PROTEIN_HORIZONS_HOURS.map((horizonHours) => {
    const deltas: number[] = [];
    for (const meal of meals) {
      const atMeal = readingNear(series, meal.atMs);
      const atHorizon = readingNear(series, meal.atMs + horizonHours * 60 * 60_000);
      if (atMeal === undefined || atHorizon === undefined) continue;
      deltas.push(atHorizon.mgDl - atMeal.mgDl);
    }
    const reportable = deltas.length >= MIN_MEALS_PER_GROUP;
    return {
      horizonHours,
      sampleSize: deltas.length,
      meanDeltaMgDl: reportable ? mean(deltas) : undefined,
    };
  });

  return {
    mealCount: meals.length,
    avgFatProteinG: mean(meals.map((meal) => meal.fatProteinG)) ?? 0,
    points,
  };
}

/**
 * Compara las comidas de mayor y menor carga de grasa+proteína.
 *
 * Devuelve `null` cuando no hay material suficiente: menos de
 * `MIN_MEALS_PER_GROUP * 2` comidas con **ambos** macros anotados, o cuando
 * todas tienen la misma carga y no hay nada que comparar. Solo entran comidas
 * con grasa **y** proteína registradas: una comida a la que le falta uno de
 * los dos no tiene una carga comparable, y tratar el ausente como 0 la
 * mandaría al grupo equivocado.
 */
export function buildMacroGlucoseComparison(input: {
  meals: readonly MealEvent[];
  readings: readonly CGMReading[];
}): MacroGlucoseComparison | null {
  const eligible = input.meals
    .filter((meal) => meal.fatG !== undefined && meal.proteinG !== undefined)
    .map((meal) => ({
      atMs: Date.parse(meal.timestamp),
      fatProteinG: meal.fatG! + meal.proteinG!,
    }))
    .filter((meal) => Number.isFinite(meal.atMs));

  if (eligible.length < MIN_MEALS_PER_GROUP * 2) return null;

  const sortedLoads = [...eligible.map((meal) => meal.fatProteinG)].sort((a, b) => a - b);
  const splitAtFatProteinG = median(sortedLoads);

  const higherMeals = eligible.filter((meal) => meal.fatProteinG > splitAtFatProteinG);
  const lowerMeals = eligible.filter((meal) => meal.fatProteinG <= splitAtFatProteinG);
  // Si toda la muestra tiene la misma carga, `higher` queda vacío y no hay
  // comparación posible — devolver dos grupos donde uno está vacío invitaría
  // a leer una diferencia inexistente.
  if (higherMeals.length < MIN_MEALS_PER_GROUP || lowerMeals.length < MIN_MEALS_PER_GROUP) return null;

  const series = toGlucoseSeries(input.readings);

  return {
    splitAtFatProteinG,
    higher: groupFor(higherMeals, series),
    lower: groupFor(lowerMeals, series),
    eligibleMealCount: eligible.length,
  };
}
