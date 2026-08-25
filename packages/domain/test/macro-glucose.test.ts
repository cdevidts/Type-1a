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

describe('exclusión de episodios confundidos (Fase 23)', () => {
  /**
   * Seis comidas idénticas en carga y en curva: la comparación existe y sus
   * puntos tienen muestra completa. Es la base contra la que se mide qué
   * cambia al meter un confusor.
   */
  function baseline(): { meals: MealEvent[]; readings: CGMReading[] } {
    const meals: MealEvent[] = [];
    const readings: CGMReading[] = [];
    for (let index = 0; index < 6; index += 1) {
      // Alterna carga alta y baja para que existan los dos grupos.
      const alta = index % 2 === 0;
      meals.push(meal(index, alta ? 40 : 5, alta ? 40 : 5));
      readings.push(...readingsFor(index, (hour) => hour * 10));
    }
    return { meals, readings };
  }

  it('sin confusores, todos los horizontes tienen la muestra completa', () => {
    const { meals, readings } = baseline();
    const result = buildMacroGlucoseComparison({ meals, readings });
    expect(result).not.toBeNull();
    expect(result!.higher.points.every((point) => point.sampleSize === 3)).toBe(true);
  });

  it('una colación a las 2 h saca esa comida de los horizontes posteriores, no de los previos', () => {
    // Es el caso que motivó la fase: sin esto, la subida a las 3 h de la
    // colación se leía como efecto tardío de la grasa de la comida original.
    const { meals, readings } = baseline();
    const colacionAt = new Date(START + 0 * DAY_MS + 2 * 60 * 60_000 + 60_000).toISOString();

    const result = buildMacroGlucoseComparison({
      meals,
      readings,
      carbs: [{ id: 'colacion', timestamp: colacionAt, carbsG: 20, source: 'manual', createdAt: colacionAt }],
    });

    expect(result).not.toBeNull();
    const puntos = Object.fromEntries(result!.higher.points.map((p) => [p.horizonHours, p.sampleSize]));
    // La comida 0 es de carga alta. A las 2 h todavía está limpia (la colación
    // es un minuto después); a las 3/4/5 h ya no.
    expect(puntos[2]).toBe(3);
    expect(puntos[3]).toBe(2);
    expect(puntos[4]).toBe(2);
    expect(puntos[5]).toBe(2);
  });

  it('el bolo de la propia comida no la confunde', () => {
    // Se reusa la ventana de asociación de findRapidInsulinCandidates
    // (-90/+60): una dosis ahí dentro es el bolo de esta comida, no una
    // corrección aparte. Sin esto, pre-bolear o bolear tarde sacaría del
    // promedio a casi todas las comidas.
    const { meals, readings } = baseline();
    const boloAt = new Date(START + 0 * DAY_MS + 30 * 60_000).toISOString();

    const result = buildMacroGlucoseComparison({
      meals,
      readings,
      insulin: [{ id: 'bolo', timestamp: boloAt, type: 'rapid', units: 6, source: 'manual', createdAt: boloAt }],
    });

    expect(result).not.toBeNull();
    expect(result!.higher.points.every((point) => point.sampleSize === 3)).toBe(true);
  });

  it('una corrección tardía sí confunde, aunque el bolo de la comida no', () => {
    const { meals, readings } = baseline();
    const boloAt = new Date(START + 0 * DAY_MS).toISOString();
    const correccionAt = new Date(START + 0 * DAY_MS + 150 * 60_000).toISOString();

    const result = buildMacroGlucoseComparison({
      meals,
      readings,
      insulin: [
        { id: 'bolo', timestamp: boloAt, type: 'rapid', units: 6, source: 'manual', createdAt: boloAt },
        { id: 'correccion', timestamp: correccionAt, type: 'rapid', units: 2, source: 'manual', createdAt: correccionAt },
      ],
    });

    expect(result).not.toBeNull();
    const puntos = Object.fromEntries(result!.higher.points.map((p) => [p.horizonHours, p.sampleSize]));
    expect(puntos[2]).toBe(3);
    expect(puntos[3]).toBe(2);
  });
});

describe('el bolo propio de la comida vs. una corrección posterior', () => {
  function insulinAt(index: number, minutesAfterMeal: number, units: number) {
    const at = new Date(START + index * DAY_MS + minutesAfterMeal * 60_000).toISOString();
    return { id: `i-${index}-${minutesAfterMeal}`, timestamp: at, type: 'rapid' as const, units, source: 'manual' as const, createdAt: at };
  }

  /** Seis comidas con ambos macros, tres altas y tres bajas en grasa+proteína. */
  function sixMeals(): MealEvent[] {
    return [0, 1, 2].map((i) => meal(i, 40, 40)).concat([3, 4, 5].map((i) => meal(i, 5, 5)));
  }

  function readingsForAll(): CGMReading[] {
    return [0, 1, 2, 3, 4, 5].flatMap((i) => readingsFor(i, (hour) => hour * 10));
  }

  it('el bolo de la comida no confunde', () => {
    const comparison = buildMacroGlucoseComparison({
      meals: sixMeals(),
      readings: readingsForAll(),
      insulin: [0, 1, 2, 3, 4, 5].map((i) => insulinAt(i, 0, 6)),
    });
    expect(comparison).not.toBeNull();
    // Las tres comidas de cada grupo siguen contando en todos los horizontes.
    for (const point of comparison!.higher.points) expect(point.sampleSize).toBe(MIN_MEALS_PER_GROUP);
  });

  it('una SEGUNDA dosis 40 min después sí confunde', () => {
    // Éste es el bug que encontró la revisión de seguridad: `ownIds` usaba
    // `candidateIds` (TODAS las dosis rápidas de la ventana -90/+60) en vez
    // del bolo recomendado, así que una corrección real 40 min después se
    // trataba como "el bolo de esta comida" y no confundía nada — subestimando
    // justo la subida tardía que esta comparación existe para describir.
    const comparison = buildMacroGlucoseComparison({
      meals: sixMeals(),
      readings: readingsForAll(),
      insulin: [0, 1, 2, 3, 4, 5].flatMap((i) => [insulinAt(i, 0, 6), insulinAt(i, 40, 2)]),
    });
    expect(comparison).not.toBeNull();
    // Con la segunda dosis dentro de la ventana, ningún horizonte queda limpio.
    for (const point of comparison!.higher.points) expect(point.sampleSize).toBe(0);
    for (const point of comparison!.lower.points) expect(point.sampleSize).toBe(0);
  });
});
