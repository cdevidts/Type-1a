import type { CGMReading, MealEvent } from '@type1a/schemas';
import { describe, expect, it } from 'vitest';

import { buildMacroGlucoseComparison, MIN_MEALS_PER_GROUP } from '../src/macro-glucose';

const DAY_MS = 24 * 60 * 60_000;
const START = Date.UTC(2026, 7, 1, 12, 0, 0);

function meal(index: number, fatG: number | undefined, proteinG: number | undefined): MealEvent {
  const at = new Date(START + index * DAY_MS).toISOString();
  return {
    id: `meal-${index}`,
    timestamp: at,
    createdAt: at,
    confirmedCarbsG: 60,
    ...(fatG === undefined ? {} : { fatG }),
    ...(proteinG === undefined ? {} : { proteinG }),
  } as MealEvent;
}

/** Lecturas cada 15 min durante 6 h desde la comida `index`, con la curva dada. */
function readingsFor(index: number, deltaAtHour: (hour: number) => number): CGMReading[] {
  const out: CGMReading[] = [];
  for (let step = 0; step <= 24; step += 1) {
    const hour = step / 4;
    const atMs = START + index * DAY_MS + hour * 60 * 60_000;
    const at = new Date(atMs).toISOString();
    out.push({
      id: `r-${index}-${step}`,
      glucose: 120 + deltaAtHour(hour),
      unit: 'mg/dL',
      timestamp: at,
      trend: 'stable',
      trendSource: 'provider',
      source: 'test',
      origin: 'real',
      sourceTimestamp: at,
      ingestedAt: at,
    });
  }
  return out;
}

describe('buildMacroGlucoseComparison', () => {
  it('devuelve null sin comidas suficientes con ambos macros', () => {
    const meals = [meal(0, 20, 30), meal(1, 20, 30)];
    expect(buildMacroGlucoseComparison({ meals, readings: [] })).toBeNull();
  });

  it('ignora las comidas a las que les falta grasa o proteína', () => {
    // 6 comidas, pero solo 2 tienen los dos macros: no alcanza.
    const meals = [
      meal(0, 20, 30), meal(1, 20, 30),
      meal(2, undefined, 30), meal(3, 20, undefined),
      meal(4, undefined, undefined), meal(5, undefined, 10),
    ];
    expect(buildMacroGlucoseComparison({ meals, readings: [] })).toBeNull();
  });

  it('devuelve null si todas las comidas tienen la misma carga', () => {
    // Sin dispersión no hay dos grupos que comparar.
    const meals = Array.from({ length: 8 }, (_, i) => meal(i, 20, 30));
    expect(buildMacroGlucoseComparison({ meals, readings: [] })).toBeNull();
  });

  it('separa por la mediana y cuenta las comidas elegibles', () => {
    const meals = [
      meal(0, 5, 5), meal(1, 5, 5), meal(2, 5, 5),
      meal(3, 50, 50), meal(4, 50, 50), meal(5, 50, 50),
    ];
    const result = buildMacroGlucoseComparison({ meals, readings: [] });
    expect(result).not.toBeNull();
    expect(result!.eligibleMealCount).toBe(6);
    expect(result!.lower.mealCount).toBe(3);
    expect(result!.higher.mealCount).toBe(3);
    expect(result!.lower.avgFatProteinG).toBe(10);
    expect(result!.higher.avgFatProteinG).toBe(100);
  });

  it('detecta la subida tardía de las comidas altas en grasa y proteína', () => {
    // Comidas bajas: vuelven a la línea base a las 2 h.
    // Comidas altas: siguen subiendo entre las 3 y las 5 h, que es el patrón
    // que describe la literatura para el efecto aditivo grasa+proteína.
    const lowMeals = [0, 1, 2].map((i) => meal(i, 5, 5));
    const highMeals = [3, 4, 5].map((i) => meal(i, 50, 50));
    const readings = [
      ...[0, 1, 2].flatMap((i) => readingsFor(i, (h) => (h <= 1 ? 20 * h : 0))),
      ...[3, 4, 5].flatMap((i) => readingsFor(i, (h) => h * 16)),
    ];

    const result = buildMacroGlucoseComparison({ meals: [...lowMeals, ...highMeals], readings });
    expect(result).not.toBeNull();

    const deltaAt = (group: 'higher' | 'lower', hour: number): number =>
      result![group].points.find((p) => p.horizonHours === hour)!.meanDeltaMgDl!;

    // A las 2 h las bajas ya volvieron; las altas siguen arriba.
    expect(deltaAt('lower', 2)).toBeCloseTo(0, 0);
    expect(deltaAt('higher', 2)).toBeGreaterThan(25);
    // Y la diferencia se ensancha hacia las 5 h.
    expect(deltaAt('higher', 5) - deltaAt('lower', 5)).toBeGreaterThan(deltaAt('higher', 2) - deltaAt('lower', 2));
  });

  it('mide el cambio desde el momento de comer, no la glucosa absoluta', () => {
    // Mismas excursiones, distinta línea base. El resultado debe ser igual:
    // "180 mg/dL a las 3 h" no dice nada sin saber de dónde partió.
    const meals = [
      meal(0, 5, 5), meal(1, 5, 5), meal(2, 5, 5),
      meal(3, 50, 50), meal(4, 50, 50), meal(5, 50, 50),
    ];
    const flat = [
      ...[0, 1, 2].flatMap((i) => readingsFor(i, () => 0)),
      ...[3, 4, 5].flatMap((i) => readingsFor(i, (h) => h * 10)),
    ];
    const shifted = flat.map((r) => ({ ...r, glucose: r.glucose + 60 }));

    const a = buildMacroGlucoseComparison({ meals, readings: flat })!;
    const b = buildMacroGlucoseComparison({ meals, readings: shifted })!;
    const deltaA = a.higher.points.find((p) => p.horizonHours === 3)!.meanDeltaMgDl;
    const deltaB = b.higher.points.find((p) => p.horizonHours === 3)!.meanDeltaMgDl;
    expect(deltaA).toBeCloseTo(deltaB!, 5);
  });

  it('no publica un promedio con muestra insuficiente', () => {
    // Comidas suficientes para formar grupos, pero sin lecturas: cada punto
    // queda con sampleSize 0 y sin promedio, nunca con 0 mg/dL.
    const meals = [
      meal(0, 5, 5), meal(1, 5, 5), meal(2, 5, 5),
      meal(3, 50, 50), meal(4, 50, 50), meal(5, 50, 50),
    ];
    const result = buildMacroGlucoseComparison({ meals, readings: [] })!;
    for (const point of result.higher.points) {
      expect(point.sampleSize).toBeLessThan(MIN_MEALS_PER_GROUP);
      expect(point.meanDeltaMgDl).toBeUndefined();
    }
  });

  it('excluye las lecturas sintéticas del cálculo', () => {
    const meals = [
      meal(0, 5, 5), meal(1, 5, 5), meal(2, 5, 5),
      meal(3, 50, 50), meal(4, 50, 50), meal(5, 50, 50),
    ];
    const synthetic = [0, 1, 2, 3, 4, 5]
      .flatMap((i) => readingsFor(i, (h) => h * 50))
      .map((r) => ({ ...r, origin: 'synthetic' as const }));
    const result = buildMacroGlucoseComparison({ meals, readings: synthetic })!;
    for (const point of result.higher.points) {
      expect(point.meanDeltaMgDl).toBeUndefined();
    }
  });
});
