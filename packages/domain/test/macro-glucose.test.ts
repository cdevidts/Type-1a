import type { ActivityEvent, CarbEvent, CGMReading, MealEvent } from '@type1a/schemas';
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

describe('episodios confundidos: se conservan y se ajustan (2026-08-25)', () => {
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

  it('una colación a las 2 h queda registrada como confusor del horizonte posterior', () => {
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
    // La muestra NO se achica: las tres comidas siguen contando en todos los
    // horizontes. Lo que cambia es `confoundedCount`, que declara cuántas
    // tuvieron algo en el medio para que el promedio no se lea como limpio.
    const n = Object.fromEntries(result!.higher.points.map((p) => [p.horizonHours, p.sampleSize]));
    const sucias = Object.fromEntries(result!.higher.points.map((p) => [p.horizonHours, p.confoundedCount]));
    expect(n[2]).toBe(3);
    expect(n[5]).toBe(3);
    // La comida 0 es de carga alta. A las 2 h todavía está limpia (la colación
    // es un minuto después); a las 3/4/5 h ya no.
    expect(sucias[2]).toBe(0);
    expect(sucias[3]).toBe(1);
    expect(sucias[4]).toBe(1);
    expect(sucias[5]).toBe(1);
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

  it('una corrección tardía queda marcada, aunque el bolo de la comida no', () => {
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
    const n = Object.fromEntries(result!.higher.points.map((p) => [p.horizonHours, p.sampleSize]));
    const sucias = Object.fromEntries(result!.higher.points.map((p) => [p.horizonHours, p.confoundedCount]));
    expect(n[2]).toBe(3);
    expect(n[3]).toBe(3);
    expect(sucias[2]).toBe(0);
    expect(sucias[3]).toBe(1);
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

  it('una SEGUNDA dosis 40 min después queda marcada como confusor', () => {
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
    // Ninguna ventana queda limpia — pero **la muestra se conserva entera**.
    // Éste es el cambio del 2026-08-25: antes acá había `sampleSize === 0` en
    // todos los horizontes, o sea la pantalla vacía, que es lo que Verónica
    // vio en el dispositivo.
    for (const point of comparison!.higher.points) {
      expect(point.sampleSize).toBe(MIN_MEALS_PER_GROUP);
      expect(point.confoundedCount).toBe(MIN_MEALS_PER_GROUP);
    }
    for (const point of comparison!.lower.points) expect(point.sampleSize).toBe(MIN_MEALS_PER_GROUP);
  });

  it('con seis comidas y confusores variados, el promedio sale ajustado', () => {
    // El ajuste necesita variación en las covariables: si todas las comidas
    // tienen exactamente el mismo confusor, el sistema es singular y
    // `fitOls` devuelve null (y `adjusted` queda en false, declarado).
    const comparison = buildMacroGlucoseComparison({
      meals: sixMeals(),
      readings: readingsForAll(),
      insulin: [0, 1, 2, 3, 4, 5].map((i) => insulinAt(i, 0, 6)),
      carbs: [0, 1, 2, 3, 4, 5].map((i) => {
        const at = new Date(START + i * DAY_MS + 100 * 60_000).toISOString();
        return { id: `c-${i}`, timestamp: at, carbsG: 10 + i * 5, source: 'manual' as const, createdAt: at };
      }),
    });
    expect(comparison).not.toBeNull();
    // Seis observaciones por horizonte: por debajo de
    // MIN_OBSERVATIONS_FOR_ADJUSTMENT (8), así que NO se ajusta y se dice.
    for (const point of comparison!.higher.points) expect(point.adjusted).toBe(false);
    // Pero el dato sigue estando.
    for (const point of comparison!.higher.points) expect(point.meanDeltaMgDl).toBeDefined();
  });
});

describe('el ajuste recupera el efecto real, con verdad conocida', () => {
  /**
   * Test de verdad sembrada: se construyen 12 comidas donde se SABE que la
   * alta carga sube +45 mg/dL a las 5 h y la baja +10, y donde además hay una
   * colación de tamaño variable a las 3 h que aporta 0,5 mg/dL por gramo.
   *
   * El promedio crudo tiene que salir inflado por la colación; el ajustado
   * tiene que recuperar el +45 / +10 sembrado.
   *
   * Este test existe porque un chequeo con datos realistas encontró DOS bugs
   * que los tests unitarios no veían:
   *
   * 1. El ajuste no se aplicaba nunca, porque bastaba una covariable
   *    constante (la actividad, que casi nadie registra) para tumbar el
   *    sistema entero.
   * 2. Ajustar sin incluir la carga de grasa+proteína en el modelo metía
   *    sesgo por variable omitida: el efecto de la grasa se filtraba al
   *    coeficiente de los carbohidratos y el promedio se ALEJABA del valor
   *    real en vez de acercarse.
   */
  function buildScenario() {
    const meals: MealEvent[] = [];
    const readings: CGMReading[] = [];
    const carbs: CarbEvent[] = [];
    const activity: ActivityEvent[] = [];

    for (let i = 0; i < 12; i += 1) {
      const t0 = START + i * DAY_MS;
      const at = new Date(t0).toISOString();
      const alto = i < 6;
      meals.push({
        id: `m-${i}`, timestamp: at, createdAt: at, confirmedCarbsG: 50,
        proteinG: alto ? 40 : 8, fatG: alto ? 35 : 6,
      });
      const late = alto ? 45 : 10;
      const snackG = 20 + ((i * 7) % 50);
      for (let h = 0; h <= 6; h += 1) {
        const atMs = t0 + h * 3_600_000;
        const iso = new Date(atMs).toISOString();
        readings.push({
          id: `r-${i}-${h}`, glucose: 120 + late * Math.min(h / 5, 1) + (h >= 3 ? snackG * 0.5 : 0),
          unit: 'mg/dL', timestamp: iso, trend: 'stable', trendSource: 'provider',
          source: 'test', origin: 'real', sourceTimestamp: iso, ingestedAt: iso,
        });
      }
      const snackAt = new Date(t0 + 3 * 3_600_000).toISOString();
      carbs.push({ id: `c-${i}`, timestamp: snackAt, carbsG: snackG, source: 'manual', createdAt: snackAt });
      // Actividad solo algunos días: en la vida real esta columna casi nunca
      // varía, y ése era justamente el bug 1.
      if (i % 4 === 0) {
        const actAt = new Date(t0 + 2 * 3_600_000).toISOString();
        activity.push({ id: `a-${i}`, timestamp: actAt, durationMinutes: 30, source: 'manual', createdAt: actAt });
      }
    }
    return { meals, readings, carbs, activity };
  }

  it('el ajuste se aplica aunque la actividad no varíe', () => {
    const { meals, readings, carbs, activity } = buildScenario();
    const result = buildMacroGlucoseComparison({ meals, readings, carbs, activity })!;
    const late = result.higher.points.find((point) => point.horizonHours === 5)!;
    expect(late.adjusted).toBe(true);
    // Y ninguna comida se perdió por estar confundida.
    expect(late.sampleSize).toBe(6);
    expect(late.confoundedCount).toBe(6);
  });

  it('la DIFERENCIA entre grupos sale exacta: +35 mg/dL a las 5 h', () => {
    // Éste es el invariante que de verdad importa. La pantalla compara dos
    // grupos, y centrar las covariables suma la misma constante a los dos, así
    // que la diferencia queda limpia aunque los niveles incluyan el aporte
    // típico de la colación.
    const { meals, readings, carbs, activity } = buildScenario();
    const ajustado = buildMacroGlucoseComparison({ meals, readings, carbs, activity })!;
    const altaAj = ajustado.higher.points.find((point) => point.horizonHours === 5)!.meanDeltaMgDl!;
    const bajaAj = ajustado.lower.points.find((point) => point.horizonHours === 5)!.meanDeltaMgDl!;
    expect(altaAj - bajaAj).toBeCloseTo(35, 4);
  });

  it('el nivel ajustado NO se va a un régimen que nunca se midió', () => {
    // El error grave que encontró la revisión del 2026-08-26: sin centrar, el
    // "promedio ajustado" era la predicción para cero carbohidratos, cero
    // insulina y cero actividad — un contrafáctico que a las 5 h casi no
    // existe en los datos. Con una verdad de +10 la pantalla llegaba a
    // mostrar +57, y ese número se imprime en el reporte médico.
    //
    // Centrado, el promedio ajustado tiene que quedarse cerca del crudo: el
    // ajuste corrige el desbalance ENTRE episodios, no el nivel general.
    const { meals, readings, carbs, activity } = buildScenario();
    const ajustado = buildMacroGlucoseComparison({ meals, readings, carbs, activity })!;
    const crudo = buildMacroGlucoseComparison({ meals, readings })!;

    for (const horizonHours of [2, 3, 4, 5]) {
      const aj = ajustado.higher.points.find((point) => point.horizonHours === horizonHours)!.meanDeltaMgDl!;
      const cr = crudo.higher.points.find((point) => point.horizonHours === horizonHours)!.meanDeltaMgDl!;
      expect(Math.abs(aj - cr)).toBeLessThan(15);
    }
  });

  it('los cuatro horizontes comparten régimen: o todos ajustados o ninguno', () => {
    // Si 2 h saliera crudo y 4 h ajustado, las barras contiguas —dibujadas
    // contra la misma escala— medirían cosas distintas, y el salto entre una
    // y otra se leería como un patrón cuando es un artefacto del modelo.
    const { meals, readings, carbs, activity } = buildScenario();
    const result = buildMacroGlucoseComparison({ meals, readings, carbs, activity })!;
    const regimenes = new Set(result.higher.points.map((point) => point.adjusted));
    expect(regimenes.size).toBe(1);
    expect([...result.lower.points.map((point) => point.adjusted), ...regimenes].every((v) => v === [...regimenes][0])).toBe(true);
  });
});
