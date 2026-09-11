import { describe, expect, it } from 'vitest';

import type { CGMReading, InsulinEvent } from '@type1a/schemas';

import {
  CURVE_HOURS,
  doseEffectSeries,
  insulinEffectCurveFrom,
} from '../src/insulin-effect-curve';

/** Lecturas cada 5 min desde `startIso`, en mg/dL. */
function series(startIso: string, values: readonly number[]): CGMReading[] {
  const startMs = Date.parse(startIso);
  return values.map((glucose, index) => {
    const iso = new Date(startMs + index * 5 * 60_000).toISOString();
    return {
      id: `${startIso}-${index}`, glucose, unit: 'mg/dL' as const, timestamp: iso,
      trend: 'unknown' as const, trendSource: 'unknown' as const, source: 'test',
      origin: 'real' as const, sourceTimestamp: iso, ingestedAt: iso,
    };
  });
}

/** Una serie de `hours` horas que va de `from` a `to` en línea recta. */
function ramp(from: number, to: number, hours: number): number[] {
  const points = hours * 12 + 1;
  return Array.from({ length: points }, (_, i) => Math.round(from + ((to - from) * i) / (points - 1)));
}

describe('doseEffectSeries — el delta contra el momento de inyectarse', () => {
  const at = '2026-09-03T09:00:00.000Z';

  it('recupera una verdad sembrada: −20 mg/dL por hora durante 5 h', () => {
    // Regla 1, corolario: el test siembra la verdad y comprueba que el código
    // la recupera, en vez de repetir lo que la implementación devuelva.
    const result = doseEffectSeries({ timestamp: at, readings: series(at, ramp(200, 100, 5)) });
    expect(result).not.toBeNull();
    expect(result!.deltas.slice(0, 5)).toEqual([-20, -40, -60, -80, -100]);
    // Más allá de donde hay lecturas, no inventa.
    expect(result!.deltas[5]).toBeUndefined();
  });

  it('EL CASO DE VERÓNICA: sube primero y recién baja a las 4-5 h', () => {
    // "Me inyecto a las 6 am, tomo desayuno, y recién me baja a las 10-11."
    // La curva tiene que mostrar exactamente esa forma, no un solo número.
    const readings = [
      ...series(at, ramp(120, 220, 3)),
      ...series('2026-09-03T12:05:00.000Z', ramp(220, 130, 3)),
    ];
    const result = doseEffectSeries({ timestamp: at, readings });
    expect(result).not.toBeNull();
    // A la hora y a las dos todavía está por encima de donde empezó.
    expect(result!.deltas[0]!).toBeGreaterThan(0);
    expect(result!.deltas[1]!).toBeGreaterThan(0);
    // A las 5-6 h ya bajó por debajo del punto de partida.
    expect(result!.deltas[5]!).toBeLessThan(20);
  });

  it('sin lectura al momento de inyectarse no hay línea base ni curva', () => {
    const late = series('2026-09-03T10:00:00.000Z', ramp(200, 120, 3));
    expect(doseEffectSeries({ timestamp: at, readings: late })).toBeNull();
  });

  it('marca hasta qué hora el episodio venía limpio', () => {
    const mealMs = Date.parse('2026-09-03T12:30:00.000Z');
    const result = doseEffectSeries({
      timestamp: at, readings: series(at, ramp(200, 120, 8)), interruptionsMs: [mealMs],
    });
    expect(result).not.toBeNull();
    // La comida cae a las 3,5 h: hasta la hora 3 está limpio, desde la 4 no.
    expect(result!.clean.slice(0, 3)).toEqual([true, true, true]);
    expect(result!.clean[3]).toBe(false);
  });

  it('una lectura lejana no se estira para rellenar un punto', () => {
    // Hueco del sensor entre la hora 1 y la 4: esos puntos quedan vacíos en
    // vez de tomar prestada una lectura de otro momento del día.
    const readings = [...series(at, ramp(200, 180, 1)), ...series('2026-09-03T13:00:00.000Z', ramp(150, 120, 2))];
    const result = doseEffectSeries({ timestamp: at, readings });
    expect(result!.deltas[1]).toBeUndefined();
    expect(result!.deltas[2]).toBeUndefined();
    expect(result!.deltas[3]).toBeDefined();
  });
});

describe('insulinEffectCurveFrom — agrupa por la hora en que EMPEZÓ la inyección', () => {
  const dose = (iso: string, id: string): InsulinEvent => ({
    id, timestamp: iso, type: 'rapid', units: 5, source: 'manual', createdAt: iso,
  } as InsulinEvent);

  it('LA DUDA DE VERÓNICA: un episodio de la mañana NO se cuenta en la tarde', () => {
    // Inyección a las 8:00 cuyo efecto se extiende hasta las 16:00. Todo el
    // episodio pertenece a la mañana, porque el tramo lo decide el momento de
    // la inyección y no el del efecto.
    const at = new Date(2026, 8, 3, 8, 0).toISOString();
    const result = insulinEffectCurveFrom({
      insulin: [dose(at, 'd1')], meals: [], readings: series(at, ramp(220, 120, 8)),
    });
    const manana = result.segments.find((s) => s.segment === 'manana')!;
    const tarde = result.segments.find((s) => s.segment === 'tarde')!;
    expect(manana.doseCount).toBe(1);
    expect(tarde.doseCount).toBe(0);
    // Y la curva de la mañana llega hasta las 8 h, cruzando a la tarde.
    expect(manana.points[7]!.sampleSize).toBe(1);
  });

  it('cada punto horario tiene su propio n: un episodio corto no distorsiona los largos', () => {
    // Es la propiedad que hace que esta curva no sufra la censura que sí
    // afecta a la "duración observada": ahí un tramo con ventanas más cortas
    // sale sistemáticamente más corto.
    const largo = new Date(2026, 8, 3, 8, 0).toISOString();
    const corto = new Date(2026, 8, 4, 9, 0).toISOString();
    const result = insulinEffectCurveFrom({
      insulin: [dose(largo, 'd1'), dose(corto, 'd2')],
      meals: [],
      readings: [...series(largo, ramp(220, 120, 8)), ...series(corto, ramp(200, 160, 2))],
    });
    const manana = result.segments.find((s) => s.segment === 'manana')!;
    expect(manana.points[0]!.sampleSize).toBe(2);
    expect(manana.points[7]!.sampleSize).toBe(1);
  });

  it('la basal no entra', () => {
    const at = new Date(2026, 8, 3, 8, 0).toISOString();
    const basal = { ...dose(at, 'b1'), type: 'basal' } as InsulinEvent;
    const result = insulinEffectCurveFrom({
      insulin: [basal], meals: [], readings: series(at, ramp(220, 120, 8)),
    });
    expect(result.totalDoses).toBe(0);
  });

  it('siempre devuelve los cuatro tramos y las ocho horas', () => {
    const result = insulinEffectCurveFrom({ insulin: [], meals: [], readings: [] });
    expect(result.segments).toHaveLength(4);
    expect(result.segments.every((s) => s.points.length === CURVE_HOURS.length)).toBe(true);
    expect(result.totalDoses).toBe(0);
    expect(result.extremeDeltaMgDl).toBe(0);
  });

  it('la mediana no se corre por un episodio raro', () => {
    const hours = [8, 8, 8];
    const days = [3, 4, 5];
    const doses = days.map((day, i) => dose(new Date(2026, 8, day, hours[i]!, 0).toISOString(), `d${i}`));
    const readings = days.flatMap((day, i) => {
      const at = new Date(2026, 8, day, hours[i]!, 0).toISOString();
      // Dos bajan 40 en 2 h (−20 a la hora); el tercero se dispara +200
      // (sensor despegado, o una hipo tratada con jugo).
      return series(at, i === 2 ? ramp(150, 350, 2) : ramp(200, 160, 2));
    });
    const result = insulinEffectCurveFrom({ insulin: doses, meals: [], readings });
    const manana = result.segments.find((s) => s.segment === 'manana')!;
    expect(manana.points[0]!.sampleSize).toBe(3);
    // Mediana de [−20, −20, +100] = −20. Un promedio habría dado +20 y la
    // curva entera se leería al revés.
    expect(manana.points[0]!.medianDeltaMgDl).toBe(-20);
  });
});

describe('la curva no publica lo que no sostiene (2026-09-03)', () => {
  const dose = (iso: string, id: string): InsulinEvent => ({
    id, timestamp: iso, type: 'rapid', units: 5, source: 'manual', createdAt: iso,
  } as InsulinEvent);
  const flatRamp = (from: number, to: number, hours: number): number[] => ramp(from, to, hours);

  it('un punto con n=1 NO se dibuja, pero su n se sigue informando', () => {
    // El botón que adopta una duración está justo encima de este gráfico, y
    // una duración adoptada alimenta el IOB. Una cola de −120 mg/dL sostenida
    // por un episodio es un camino de un gráfico sin respaldo a un parámetro
    // de terapia.
    const at = new Date(2026, 8, 3, 8, 0).toISOString();
    const result = insulinEffectCurveFrom({
      insulin: [dose(at, 'd1')], meals: [], readings: series(at, flatRamp(220, 120, 8)),
    });
    const manana = result.segments.find((s) => s.segment === 'manana')!;
    expect(manana.points[0]!.sampleSize).toBe(1);
    expect(manana.points[0]!.medianDeltaMgDl).toBeUndefined();
  });

  it('con tres episodios sí se dibuja', () => {
    const days = [3, 4, 5];
    const doses = days.map((day, i) => dose(new Date(2026, 8, day, 8, 0).toISOString(), `d${i}`));
    const readings = days.flatMap((day) =>
      series(new Date(2026, 8, day, 8, 0).toISOString(), flatRamp(220, 120, 8)));
    const result = insulinEffectCurveFrom({ insulin: doses, meals: [], readings });
    const manana = result.segments.find((s) => s.segment === 'manana')!;
    expect(manana.points[0]!.sampleSize).toBe(3);
    expect(manana.points[0]!.medianDeltaMgDl).toBeDefined();
  });

  it('LA GLUCOSA SINTÉTICA NO ENTRA: no es su respuesta a la insulina', () => {
    // Todo agregado clínico de este repo excluye `synthetic`; graficarla bajo
    // "Tu curva de efecto" sería dato de demo leído como propio.
    const at = new Date(2026, 8, 3, 8, 0).toISOString();
    const synthetic = series(at, flatRamp(220, 120, 8)).map((r) => ({ ...r, origin: 'synthetic' as const }));
    const result = insulinEffectCurveFrom({ insulin: [dose(at, 'd1')], meals: [], readings: synthetic });
    expect(result.totalDoses).toBe(0);
  });
});
