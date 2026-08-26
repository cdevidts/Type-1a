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

describe('macronutrientes por franja (Fase 13, ítem 7)', () => {
  const base = { readings: [], insulin: [], carbs: [] };

  // `atLocal`, no un literal UTC: las franjas se calculan con la hora LOCAL,
  // así que un timestamp en Z caería en otra franja según el huso del runtime
  // y el test pasaría o fallaría según la máquina.
  function meal(hour: number, macros: Partial<MealEvent>): MealEvent {
    const at = atLocal(18, hour);
    return {
      id: `m-${hour}-${JSON.stringify(macros)}`,
      timestamp: at,
      source: 'manual',
      createdAt: at,
      ...macros,
    } as MealEvent;
  }

  it('promedia solo las comidas que traen ese macro', () => {
    const insights = buildNutritionInsights({
      ...base,
      meals: [
        meal(13, { proteinG: 30, fatG: 10 }),
        meal(14, { proteinG: 50 }),
        meal(15, {}),
      ],
    });
    const midday = insights.find((window) => window.startHour <= 13 && window.endHour > 13);
    expect(midday).toBeDefined();
    // Proteína: (30 + 50) / 2 — la comida sin proteína NO cuenta como 0.
    expect(midday!.avgProteinG).toBe(40);
    expect(midday!.proteinSampleSize).toBe(2);
    // Grasa: solo una comida la trae.
    expect(midday!.avgFatG).toBe(10);
    expect(midday!.fatSampleSize).toBe(1);
  });

  it('deja el promedio indefinido cuando ninguna comida trae el macro', () => {
    const insights = buildNutritionInsights({ ...base, meals: [meal(13, { proteinG: 20 })] });
    const midday = insights.find((window) => window.startHour <= 13 && window.endHour > 13);
    expect(midday!.avgFiberG).toBeUndefined();
    expect(midday!.fiberSampleSize).toBe(0);
  });

  it('un macro en 0 sí cuenta como dato', () => {
    // "0 g de fibra" es una afirmación; "sin anotar" no lo es. La diferencia
    // importa para no inventar un promedio.
    const insights = buildNutritionInsights({ ...base, meals: [meal(13, { fiberG: 0 })] });
    const midday = insights.find((window) => window.startHour <= 13 && window.endHour > 13);
    expect(midday!.avgFiberG).toBe(0);
    expect(midday!.fiberSampleSize).toBe(1);
  });
});

describe('dosis confundidas: se declaran, no se descartan (2026-08-25)', () => {
  // Serie de lecturas cada 15 min alrededor de cada dosis, para que
  // `readingNear` siempre encuentre punto y el `n` refleje solo la exclusión.
  function seriesAround(day: number, hour: number, mgDl: number): CGMReading[] {
    const out: CGMReading[] = [];
    for (let minutes = 0; minutes <= 240; minutes += 15) {
      out.push(reading(atLocal(day, hour, minutes), mgDl));
    }
    return out;
  }

  it('una corrección DENTRO de la primera hora sí confunde: la gracia larga es solo para la comida', () => {
    // Éste es el bug que encontró la revisión de seguridad del 2026-08-22.
    // `DOSE_OWN_MEAL_MINUTES` (60) se aplicaba a TODAS las clases, así que
    // una segunda dosis a los 45 min quedaba tratada como "parte de la
    // comida" y no confundía nada — ni siquiera a 2 h o 3 h.
    const doseAt = atLocal(18, 13);
    const input: NutritionInsightsInput = {
      ...EMPTY,
      readings: seriesAround(18, 13, 140),
      insulin: [rapid(doseAt, 6), rapid(atLocal(18, 13, 45), 2)],
    };
    const midday = windowNamed(buildNutritionInsights(input), 'mediodía');
    // La primera dosis queda MARCADA en todos los horizontes: la segunda cae
    // dentro de su ventana. Antes del arreglo de la gracia, los 60 min la
    // tapaban y la primera dosis se contaba como si fuera limpia.
    //
    // Las dos siguen en la muestra (2, no 1): desde el 2026-08-25 una dosis
    // confundida se **declara**, no se descarta.
    expect(midday.outcomes.every((outcome) => outcome.sampleSize === 2)).toBe(true);
    expect(midday.outcomes.every((outcome) => outcome.confoundedCount === 1)).toBe(true);
  });

  it('el horizonte de 1 h puede marcarse confundido (antes era imposible)', () => {
    // Con grace = window = 60 min el intervalo (anchor+60, anchor+60] era
    // vacío por construcción: el horizonte de 1 h NUNCA podía excluir nada.
    // La detección a 1 h existe: antes `grace === window` dejaba el intervalo
    // vacío por construcción y esa hora no podía marcarse nunca. Ahora se
    // marca — y se cuenta, sin sacar la dosis de la muestra.
    const oneHour = buildNutritionInsights({
      ...EMPTY,
      readings: seriesAround(18, 13, 140),
      insulin: [rapid(atLocal(18, 13), 6), rapid(atLocal(18, 13, 30), 2)],
    }).find((w) => w.key === 'mediodía')!.outcomes.find((o) => o.horizonHours === 1);
    expect(oneHour!.sampleSize).toBe(2);
    expect(oneHour!.confoundedCount).toBeGreaterThan(0);
  });

  it('la comida de la propia dosis NO confunde, aunque se registre 45 min después', () => {
    // El otro lado de la moneda: pre-bolear y registrar la comida más tarde
    // es normal. Si esto confundiera, el patrón se quedaría sin muestra.
    const midday = windowNamed(
      buildNutritionInsights({
        ...EMPTY,
        readings: seriesAround(18, 13, 140),
        insulin: [rapid(atLocal(18, 13), 6)],
        meals: [meal(atLocal(18, 13, 45), { confirmedCarbsG: 40 })],
        carbs: [carb(atLocal(18, 13, 45), 40)],
      }),
      'mediodía',
    );
    expect(midday.outcomes.every((outcome) => outcome.sampleSize === 1)).toBe(true);
  });

  it('una actividad a los 30 min confunde, igual que una dosis', () => {
    const midday = windowNamed(
      buildNutritionInsights({
        ...EMPTY,
        readings: seriesAround(18, 13, 140),
        insulin: [rapid(atLocal(18, 13), 6)],
        activity: [{
          id: 'a1',
          timestamp: atLocal(18, 13, 30),
          durationMinutes: 40,
          source: 'manual',
          createdAt: atLocal(18, 13, 30),
        }],
      }),
      'mediodía',
    );
    expect(midday.outcomes.every((outcome) => outcome.confoundedCount > 0)).toBe(true);
    // Y la dosis NO se pierde: sigue contando en la muestra.
    expect(midday.outcomes.every((outcome) => outcome.sampleSize === 1)).toBe(true);
  });

  it('el mínimo de muestra sigue mandando sobre el porcentaje', () => {
    // Aunque la exclusión deje 1 sola dosis limpia, `MIN_SAMPLE_FOR_RATE`
    // sigue mandando: el número que se lee como patrón no puede nacer de n=1.
    const midday = windowNamed(
      buildNutritionInsights({
        ...EMPTY,
        readings: seriesAround(18, 13, 140),
        insulin: [rapid(atLocal(18, 13), 6)],
      }),
      'mediodía',
    );
    for (const outcome of midday.outcomes) {
      expect(outcome.sampleSize).toBeLessThan(MIN_SAMPLE_FOR_RATE);
      expect(outcome.inTargetPct).toBeUndefined();
    }
  });
});

describe('el lookback llega de verdad hasta collectEpisodeContext', () => {
  // La revisión de seguridad del 2026-08-25 marcó este hueco: se podía borrar
  // el spread de `rapidLookbackMinutes` en nutrition-insights.ts o en
  // macro-glucose.ts y los 238 tests del dominio seguían pasando. La
  // exclusión dejaba de funcionar en silencio.
  function seriesAround(day: number, hour: number, mgDl: number): CGMReading[] {
    const out: CGMReading[] = [];
    for (let minutes = -360; minutes <= 240; minutes += 15) {
      out.push(reading(atLocal(day, hour, minutes), mgDl));
    }
    return out;
  }

  const base = {
    ...EMPTY,
    readings: seriesAround(18, 13, 140),
    // Una CORRECCIÓN 2 h antes: no está asociada a ninguna comida, así que
    // es exactamente el confusor que el lookback existe para detectar.
    insulin: [rapid(atLocal(18, 11), 2), rapid(atLocal(18, 13), 6)],
  };

  it('sin lookback, la dosis anterior no se marca', () => {
    const midday = windowNamed(buildNutritionInsights(base), 'mediodía');
    const oneHour = midday.outcomes.find((outcome) => outcome.horizonHours === 1);
    expect(oneHour!.sampleSize).toBe(2);
    expect(oneHour!.confoundedCount).toBe(0);
  });

  it('con lookback, la corrección anterior sí confunde', () => {
    const midday = windowNamed(
      buildNutritionInsights({ ...base, rapidLookbackMinutes: 300 }),
      'mediodía',
    );
    // La dosis de las 13:00 queda MARCADA por la corrección de las 11:00 —
    // marcada, no borrada: las dos siguen en la muestra.
    const oneHour = midday.outcomes.find((outcome) => outcome.horizonHours === 1);
    expect(oneHour!.sampleSize).toBe(2);
    expect(oneHour!.confoundedCount).toBe(1);
  });

  it('el bolo de una comida anterior NO confunde, aunque caiga en la ventana', () => {
    // Con MDI las comidas van cada 4-5 h y la rápida "dura" 5 h, así que el
    // bolo de la comida anterior cae casi siempre dentro del lookback. Si
    // contara, elegir la insulina en Ajustes vaciaría la pantalla entera.
    const midday = windowNamed(
      buildNutritionInsights({
        ...base,
        meals: [meal(atLocal(18, 11), { confirmedCarbsG: 40 })],
        rapidLookbackMinutes: 300,
      }),
      'mediodía',
    );
    // El bolo de las 11:00 pasó a ser "de una comida" y dejó de marcarse.
    const oneHour = midday.outcomes.find((outcome) => outcome.horizonHours === 1);
    expect(oneHour!.sampleSize).toBe(2);
    expect(oneHour!.confoundedCount).toBe(0);
  });
});
