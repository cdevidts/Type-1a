import type {
  CGMReading,
  FoodEstimate,
  InsulinEvent,
  MealEpisodeMetrics,
  MealTotals,
} from '@type1a/schemas';

import { HIGH_THRESHOLD, HYPOGLYCEMIA_THRESHOLD } from './glucose-thresholds.js';
import { convertGlucose } from './units.js';

export function totalFoodEstimates(foods: readonly FoodEstimate[]): MealTotals {
  const totals = foods.reduce(
    (sum, food) => ({
      carbsG: sum.carbsG + food.carbsG,
      proteinG: sum.proteinG + food.proteinG,
      fatG: sum.fatG + food.fatG,
      fiberG: sum.fiberG + food.fiberG,
      caloriesKcal: sum.caloriesKcal + food.caloriesKcal,
    }),
    { carbsG: 0, proteinG: 0, fatG: 0, fiberG: 0, caloriesKcal: 0 },
  );

  return Object.fromEntries(
    Object.entries(totals).map(([key, value]) => [key, Number(value.toFixed(1))]),
  ) as unknown as MealTotals;
}

export interface InsulinAssociation {
  candidateIds: string[];
  recommendedId?: string;
  requiresConfirmation: boolean;
}

export function findRapidInsulinCandidates(
  mealTimestamp: string,
  events: readonly InsulinEvent[],
): InsulinAssociation {
  const mealMs = Date.parse(mealTimestamp);
  const candidates = events
    .filter((event) => event.type === 'rapid')
    .map((event) => ({ event, deltaMinutes: (Date.parse(event.timestamp) - mealMs) / 60_000 }))
    .filter(({ deltaMinutes }) => deltaMinutes >= -90 && deltaMinutes <= 60)
    .sort((a, b) => Math.abs(a.deltaMinutes) - Math.abs(b.deltaMinutes));

  const recommendedId = candidates[0]?.event.id;
  return {
    candidateIds: candidates.map(({ event }) => event.id),
    ...(recommendedId === undefined ? {} : { recommendedId }),
    requiresConfirmation: candidates.length > 1,
  };
}

function nearestReading(
  readings: readonly CGMReading[],
  targetMs: number,
  toleranceMinutes: number,
): CGMReading | undefined {
  return readings
    .map((reading) => ({ reading, distance: Math.abs(Date.parse(reading.sourceTimestamp) - targetMs) }))
    .filter(({ distance }) => distance <= toleranceMinutes * 60_000)
    .sort((a, b) => a.distance - b.distance)[0]?.reading;
}

export interface EpisodeMetricInput {
  mealTimestamp: string;
  readings: readonly CGMReading[];
  confirmedCarbsG?: number;
  proteinG?: number;
  fatG?: number;
  rapidInsulin?: InsulinEvent;
  lowThreshold?: number;
  highThreshold?: number;
}

export function calculateMealEpisodeMetrics(input: EpisodeMetricInput): MealEpisodeMetrics {
  const mealMs = Date.parse(input.mealTimestamp);
  if (!Number.isFinite(mealMs)) throw new Error('Invalid meal timestamp.');

  // Normalizado a mg/dL antes de cualquier cálculo o comparación: las
  // lecturas de origen pueden venir en mmol/L (ej. un CSV de LibreView
  // exportado en esa unidad), y MealEpisodeMetrics no lleva su propio campo
  // de unidad — todo lo que produce esta función es mg/dL siempre, para que
  // coincida con lo que ya asumen sin conversión el resto de las pantallas
  // (TimelineDetailModal) y el prompt de insight de IA. Sin esto, una
  // lectura en mmol/L se guardaba y mostraba tal cual, con la etiqueta
  // "mg/dL" pegada a un número que no lo era.
  const readings = [...input.readings]
    .filter((reading) => {
      const timestamp = Date.parse(reading.sourceTimestamp);
      return timestamp >= mealMs - 15 * 60_000 && timestamp <= mealMs + 240 * 60_000;
    })
    .map((reading) => ({ ...reading, glucose: convertGlucose(reading.glucose, reading.unit, 'mg/dL'), unit: 'mg/dL' as const }))
    .sort((a, b) => Date.parse(a.sourceTimestamp) - Date.parse(b.sourceTimestamp));

  const start = nearestReading(readings, mealMs, 15);
  const at60 = nearestReading(readings, mealMs + 60 * 60_000, 15);
  const at120 = nearestReading(readings, mealMs + 120 * 60_000, 15);
  const at180 = nearestReading(readings, mealMs + 180 * 60_000, 15);
  const postMeal = readings.filter((reading) => Date.parse(reading.sourceTimestamp) >= mealMs);
  const peak = postMeal.reduce<CGMReading | undefined>(
    (best, reading) => (best === undefined || reading.glucose > best.glucose ? reading : best),
    undefined,
  );
  const minimum = postMeal.reduce<CGMReading | undefined>(
    (best, reading) => (best === undefined || reading.glucose < best.glucose ? reading : best),
    undefined,
  );

  const sampleMinutes = postMeal.length > 1
    ? Math.max(
        1,
        Math.round(
          (Date.parse(postMeal[postMeal.length - 1]!.sourceTimestamp) -
            Date.parse(postMeal[0]!.sourceTimestamp)) /
            60_000 /
            (postMeal.length - 1),
        ),
      )
    : 0;
  const lowThreshold = input.lowThreshold ?? HYPOGLYCEMIA_THRESHOLD;
  const highThreshold = input.highThreshold ?? HIGH_THRESHOLD;

  return {
    mealTimestamp: new Date(mealMs).toISOString(),
    ...(start === undefined ? {} : { startingGlucose: start.glucose }),
    ...(at60 === undefined ? {} : { glucose60: at60.glucose }),
    ...(at120 === undefined ? {} : { glucose120: at120.glucose }),
    ...(at180 === undefined ? {} : { glucose180: at180.glucose }),
    ...(peak === undefined ? {} : { peakGlucose: peak.glucose }),
    ...(peak === undefined || start === undefined ? {} : { peakDelta: peak.glucose - start.glucose }),
    ...(peak === undefined
      ? {}
      : { timeToPeakMinutes: Math.max(0, Math.round((Date.parse(peak.sourceTimestamp) - mealMs) / 60_000)) }),
    ...(minimum === undefined ? {} : { minGlucose: minimum.glucose }),
    timeAboveRangeMinutes:
      postMeal.filter((reading) => reading.glucose > highThreshold).length * sampleMinutes,
    timeBelowRangeMinutes:
      postMeal.filter((reading) => reading.glucose < lowThreshold).length * sampleMinutes,
    ...(input.rapidInsulin === undefined ? {} : { rapidInsulinUnits: input.rapidInsulin.units }),
    ...(input.rapidInsulin === undefined
      ? {}
      : { rapidInsulinTimestamp: input.rapidInsulin.timestamp }),
    ...(input.confirmedCarbsG === undefined ? {} : { confirmedCarbsG: input.confirmedCarbsG }),
    ...(input.proteinG === undefined ? {} : { proteinG: input.proteinG }),
    ...(input.fatG === undefined ? {} : { fatG: input.fatG }),
    ...(input.rapidInsulin === undefined
      ? {}
      : {
          insulinToMealMinutes: Math.round(
            (mealMs - Date.parse(input.rapidInsulin.timestamp)) / 60_000,
          ),
        }),
    readingCount: postMeal.length,
  };
}
