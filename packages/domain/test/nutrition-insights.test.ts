import type { CarbEvent, CGMReading, InsulinEvent, MealEvent } from '@type1a/schemas';
import { describe, expect, it } from 'vitest';

import { buildNutritionInsights, MIN_SAMPLE_FOR_RATE, type NutritionInsightsInput } from '../src/index.js';

/** Timestamp local, para no depender del huso del runtime. */
function atLocal(day: number, hour: number, minute = 0): string {
  return new Date(2026, 7, day, hour, minute, 0).toISOString();
}

function reading(atIso: string, glucose: number, overrides: Partial<CGMReading> = {}): CGMReading {
  return {
    id: `r-${atIso}-${glucose}`,
    glucose,
    unit: 'mg/dL',
    timestamp: atIso,
    trend: 'stable',
    trendSource: 'provider',
    source: 'freestyle_libre',
    origin: 'real',
    sourceTimestamp: atIso,
    ingestedAt: atIso,
    ...overrides,
  };
}

function rapid(atIso: string, units: number): InsulinEvent {
  return { id: `i-${atIso}`, timestamp: atIso, type: 'rapid', units, source: 'manual', createdAt: atIso };
}

function basal(atIso: string, units: number): InsulinEvent {
  return { id: `b-${atIso}`, timestamp: atIso, type: 'basal', units, source: 'manual', createdAt: atIso };
}

function carb(atIso: string, carbsG: number): CarbEvent {
  return { id: `c-${atIso}`, timestamp: atIso, carbsG, source: 'manual', createdAt: atIso };
}

function meal(atIso: string, overrides: Partial<MealEvent> = {}): MealEvent {
  return { id: `m-${atIso}`, timestamp: atIso, createdAt: atIso, ...overrides };
}

const EMPTY: NutritionInsightsInput = { readings: [], insulin: [], carbs: [], meals: [] };

function windowNamed(insights: ReturnType<typeof buildNutritionInsights>, key: string) {
  return insights.find((w) => w.key === key)!;
}

describe('buildNutritionInsights', () => {
  it('always returns every window, even with no data', () => {
    const insights = buildNutritionInsights(EMPTY);
    expect(insights.map((w) => w.key)).toEqual(['madrugada', 'mañana', 'mediodía', 'tarde', 'noche']);
    for (const window of insights) {
      expect(window.avgConfirmedCarbsG).toBeUndefined();
      expect(window.avgRapidUnits).toBeUndefined();
      expect(window.outcomes.every((o) => o.inTargetPct === undefined && o.sampleSize === 0)).toBe(true);
    }
  });

  it('buckets carbs and insulin into the right time window and averages them', () => {
    const insights = buildNutritionInsights({
      ...EMPTY,
      carbs: [carb(atLocal(18, 8), 40), carb(atLocal(19, 9), 60)],
      insulin: [rapid(atLocal(18, 8), 5), rapid(atLocal(19, 9), 7), basal(atLocal(18, 22), 12)],
    });
    const morning = windowNamed(insights, 'mañana');
    expect(morning.avgConfirmedCarbsG).toBe(50);
    expect(morning.confirmedCarbsSampleSize).toBe(2);
    expect(morning.avgRapidUnits).toBe(6);
    expect(morning.rapidDoseCount).toBe(2);
    // Basal landed at 22:00 -> the evening window, not the morning one.
    expect(morning.avgBasalUnits).toBeUndefined();
    expect(windowNamed(insights, 'noche').avgBasalUnits).toBe(12);
  });

  it('never averages AI-estimated carbs into the confirmed figure', () => {
    const insights = buildNutritionInsights({
      ...EMPTY,
      meals: [
        meal(atLocal(18, 8), { confirmedCarbsG: 30 }),
        meal(atLocal(18, 9), { aiEstimatedCarbsG: 200 }),
      ],
    });
    const morning = windowNamed(insights, 'mañana');
    expect(morning.mealCount).toBe(2);
    expect(morning.avgConfirmedCarbsG).toBe(30);
    expect(morning.confirmedCarbsSampleSize).toBe(1);
  });

  it('counts a confirmed meal once, not twice, when db.ts also wrote its meal_confirmed carb row', () => {
    // writeMealWithEpisode (db.ts) always writes a CarbEvent at the SAME
    // timestamp as the MealEvent. Counting both would inflate the average
    // and the sample size shown on screen and printed in the medical report.
    const at = atLocal(18, 12);
    const insights = buildNutritionInsights({
      ...EMPTY,
      meals: [meal(at, { confirmedCarbsG: 60 })],
      carbs: [
        { id: 'c-meal', timestamp: at, carbsG: 60, source: 'meal_confirmed', createdAt: at },
        carb(atLocal(18, 13), 15),
      ],
    });
    const midday = windowNamed(insights, 'mediodía');
    expect(midday.confirmedCarbsSampleSize).toBe(2);
    expect(midday.avgConfirmedCarbsG).toBe(37.5);
  });

  it('still counts a meal whose confirmed carbs never became a CarbEvent', () => {
    const insights = buildNutritionInsights({
      ...EMPTY,
      meals: [meal(atLocal(18, 12), { confirmedCarbsG: 40 })],
      carbs: [],
    });
    const midday = windowNamed(insights, 'mediodía');
    expect(midday.confirmedCarbsSampleSize).toBe(1);
    expect(midday.avgConfirmedCarbsG).toBe(40);
  });

  it('separates hypo from hyper instead of collapsing both into "not in range"', () => {
    const insights = buildNutritionInsights({
      ...EMPTY,
      insulin: [rapid(atLocal(17, 8), 5), rapid(atLocal(18, 8), 5), rapid(atLocal(19, 8), 5), rapid(atLocal(20, 8), 5)],
      readings: [
        reading(atLocal(17, 9), 55), // below
        reading(atLocal(18, 9), 60), // below
        reading(atLocal(19, 9), 120), // in range
        reading(atLocal(20, 9), 250), // above
      ],
    });
    const oneHour = windowNamed(insights, 'mañana').outcomes.find((o) => o.horizonHours === 1)!;
    expect(oneHour.belowTargetPct).toBe(50);
    expect(oneHour.inTargetPct).toBe(25);
    expect(oneHour.aboveTargetPct).toBe(25);
    expect(oneHour.belowTargetPct! + oneHour.inTargetPct! + oneHour.aboveTargetPct!).toBeCloseTo(100, 6);
  });

  it('withholds the direction breakdown too when the sample is too small', () => {
    const insights = buildNutritionInsights({
      ...EMPTY,
      insulin: [rapid(atLocal(18, 8), 5)],
      readings: [reading(atLocal(18, 9), 55)],
    });
    const oneHour = windowNamed(insights, 'mañana').outcomes.find((o) => o.horizonHours === 1)!;
    expect(oneHour.inTargetPct).toBeUndefined();
    expect(oneHour.belowTargetPct).toBeUndefined();
    expect(oneHour.aboveTargetPct).toBeUndefined();
  });

  it('withholds a rate below the minimum sample size instead of reporting noise', () => {
    // Two doses, both followed by an in-range reading at +1h. 100% would be
    // technically true and clinically meaningless.
    const insights = buildNutritionInsights({
      ...EMPTY,
      insulin: [rapid(atLocal(18, 8), 5), rapid(atLocal(19, 8), 5)],
      readings: [reading(atLocal(18, 9), 120), reading(atLocal(19, 9), 130)],
    });
    const oneHour = windowNamed(insights, 'mañana').outcomes.find((o) => o.horizonHours === 1)!;
    expect(oneHour.sampleSize).toBe(2);
    expect(oneHour.sampleSize).toBeLessThan(MIN_SAMPLE_FOR_RATE);
    expect(oneHour.inTargetPct).toBeUndefined();
  });

  it('reports the in-target rate once the sample is large enough', () => {
    const insights = buildNutritionInsights({
      ...EMPTY,
      insulin: [rapid(atLocal(17, 8), 5), rapid(atLocal(18, 8), 5), rapid(atLocal(19, 8), 5), rapid(atLocal(20, 8), 5)],
      readings: [
        reading(atLocal(17, 9), 120), // in range
        reading(atLocal(18, 9), 140), // in range
        reading(atLocal(19, 9), 250), // out of range
        reading(atLocal(20, 9), 60), // out of range (low counts as out too)
      ],
    });
    const oneHour = windowNamed(insights, 'mañana').outcomes.find((o) => o.horizonHours === 1)!;
    expect(oneHour.sampleSize).toBe(4);
    expect(oneHour.inTargetPct).toBe(50);
  });

  it('treats the 70 and 180 mg/dL edges as in target', () => {
    const insights = buildNutritionInsights({
      ...EMPTY,
      insulin: [rapid(atLocal(17, 8), 5), rapid(atLocal(18, 8), 5), rapid(atLocal(19, 8), 5)],
      readings: [reading(atLocal(17, 9), 70), reading(atLocal(18, 9), 180), reading(atLocal(19, 9), 181)],
    });
    const oneHour = windowNamed(insights, 'mañana').outcomes.find((o) => o.horizonHours === 1)!;
    expect(oneHour.inTargetPct).toBeCloseTo((2 / 3) * 100, 5);
  });

  it('skips a dose with no reading near the horizon rather than assuming one', () => {
    const insights = buildNutritionInsights({
      ...EMPTY,
      insulin: [rapid(atLocal(18, 8), 5)],
      // 90 min later — outside the +-20 min tolerance around the 1h horizon.
      readings: [reading(atLocal(18, 9, 30), 120)],
    });
    const oneHour = windowNamed(insights, 'mañana').outcomes.find((o) => o.horizonHours === 1)!;
    expect(oneHour.sampleSize).toBe(0);
  });

  it('never lets a synthetic reading decide an outcome', () => {
    const insights = buildNutritionInsights({
      ...EMPTY,
      insulin: [rapid(atLocal(17, 8), 5), rapid(atLocal(18, 8), 5), rapid(atLocal(19, 8), 5)],
      readings: [
        reading(atLocal(17, 9), 120),
        reading(atLocal(18, 9), 120),
        reading(atLocal(19, 9), 120, { origin: 'synthetic' }),
      ],
    });
    const oneHour = windowNamed(insights, 'mañana').outcomes.find((o) => o.horizonHours === 1)!;
    expect(oneHour.sampleSize).toBe(2);
    expect(oneHour.inTargetPct).toBeUndefined();
  });

  it('evaluates the 1h, 2h and 3h horizons independently', () => {
    const insights = buildNutritionInsights({
      ...EMPTY,
      insulin: [rapid(atLocal(17, 8), 5), rapid(atLocal(18, 8), 5), rapid(atLocal(19, 8), 5)],
      readings: [
        // 1h: all out of range. 3h: all back in range.
        reading(atLocal(17, 9), 250), reading(atLocal(17, 11), 120),
        reading(atLocal(18, 9), 250), reading(atLocal(18, 11), 130),
        reading(atLocal(19, 9), 250), reading(atLocal(19, 11), 140),
      ],
    });
    const outcomes = windowNamed(insights, 'mañana').outcomes;
    expect(outcomes.find((o) => o.horizonHours === 1)!.inTargetPct).toBe(0);
    expect(outcomes.find((o) => o.horizonHours === 3)!.inTargetPct).toBe(100);
    // No reading near +2h at all.
    expect(outcomes.find((o) => o.horizonHours === 2)!.sampleSize).toBe(0);
  });
});
