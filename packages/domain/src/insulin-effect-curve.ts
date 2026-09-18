import type { CGMReading, InsulinEvent, MealEvent } from '@type1a/schemas';

import { DAY_SEGMENTS, segmentOf, type DaySegmentKey } from './insulin-duration';
import { convertGlucose } from './units';

/**
 * La curva de efecto: **cuánto se movió tu glucosa a 1, 2, 3… horas de
 * inyectarte**, promediada por la hora en que empezó la inyección.
 *
 * ## De dónde sale, y qué problema resuelve
 *
 * De Verónica, el 2026-09-03: *"me gustaría que agregues gráficos de la curva
 * de efecto de la insulina que promedie cuánto bajó la glucosa a 1,2,3,4,5,6,7
 * horas después de inyectarme. Los tramos horarios son 'cuando la inyección
 * inició en este rango de horas' y así normalizamos el posible asunto de que
 * un dato pase a otro tramo por demorarse en hacer efecto."*
 *
 * Su sospecha era que un episodio de la mañana se contaba en la tarde. **No
 * pasaba**: `insulin-duration.ts` ya agrupa por el timestamp de la dosis, no
 * por el del efecto. Pero el número que la hizo dudar sí estaba sesgado, y por
 * un motivo más difícil de ver:
 *
 * **La duración observada sufre censura por la dosis siguiente.** Esa métrica
 * busca cuándo la glucosa dejó de bajar dentro de una ventana que se corta en
 * el bolo siguiente. En la mañana el almuerzo llega a las 5 h; de noche no
 * llega nada y la ventana son 8 h. Un tramo con más espacio tiene más
 * oportunidades de encontrar un mínimo tardío, así que **la noche y la tarde
 * salen sistemáticamente más largas** aunque la insulina se comporte igual.
 * Ella lo notó desde el otro lado: sabe que a las 6 am recién le baja a las
 * 10-11, y el número decía lo contrario.
 *
 * Esta curva no tiene ese problema. No busca un evento (el nadir): mide el
 * **mismo instante en todos los episodios** —una hora después, dos horas
 * después— así que cada punto se compara con su igual. Un episodio que no
 * llega a las 6 h no distorsiona el punto de las 2 h: simplemente no está en
 * el de las 6, y su `n` lo dice.
 *
 * ## Lo que muestra y lo que no
 *
 * Muestra el **cambio de glucosa respecto del momento de la inyección**, en
 * mg/dL, mediana entre episodios. Negativo = bajó.
 *
 * No aísla la insulina: si desayunaste al inyectarte, la curva de la mañana
 * sube primero y baja después, y **eso es justamente lo que ella quiere ver**
 * ("me inyecto a las 6 y recién me baja a las 10-11"). Por eso cada punto
 * declara además cuántos de sus episodios venían **sin comida ni otra dosis**
 * hasta ahí: el `n` limpio al lado del `n` total, nunca uno sin el otro.
 *
 * No propone nada. No hay botón de adoptar acá: esto describe, y la duración
 * que alimenta el IOB se sigue fijando donde siempre.
 */

/** Las horas que se miden después de la inyección. */
export const CURVE_HOURS = [1, 2, 3, 4, 5, 6, 7, 8] as const;

/**
 * Cuánto puede alejarse una lectura de la hora exacta para contar como "la de
 * esa hora". El sensor entrega cada ~5 min, así que ±15 min casi siempre
 * encuentra una y no estira el punto hasta otro momento del día.
 */
const MATCH_TOLERANCE_MINUTES = 15;

/** Cuánto antes de la dosis se acepta una lectura como línea base. */
const BASELINE_TOLERANCE_MINUTES = 15;

/**
 * Episodios mínimos para dibujar un punto.
 *
 * Igual que `MIN_EPISODES_PER_SEGMENT` en `insulin-duration.ts`, y por el mismo
 * motivo: la pantalla que muestra esta curva tiene, justo encima, un botón que
 * adopta una duración y **esa duración alimenta el IOB**. Una cola que baja a
 * −120 mg/dL en la hora 8 sostenida por un solo episodio se lee como patrón y
 * empuja a adoptar un número que después resta insulina de cada corrección.
 *
 * Tres es poco y se sabe: por eso cada punto lleva su `n` en pantalla.
 */
export const MIN_EPISODES_PER_CURVE_POINT = 3;

export interface CurvePoint {
  hour: number;
  /** Mediana del cambio de glucosa respecto de la inyección, en mg/dL. */
  medianDeltaMgDl: number | undefined;
  /** Episodios que llegaron a esta hora con una lectura utilizable. */
  sampleSize: number;
  /** De esos, cuántos no tenían comida ni otra dosis rápida hasta acá. */
  cleanSampleSize: number;
}

export interface SegmentCurve {
  segment: DaySegmentKey;
  label: string;
  /** Cuántas inyecciones empezaron en este tramo y aportaron algún punto. */
  doseCount: number;
  points: CurvePoint[];
}

export interface InsulinEffectCurveResult {
  segments: SegmentCurve[];
  /** Cuántas dosis rápidas se pudieron usar en total. */
  totalDoses: number;
  /** El delta más extremo de toda la matriz, para escalar un gráfico. */
  extremeDeltaMgDl: number;
}

/** Una inyección con su serie ya resuelta. Puro, para poder testear. */
interface DoseSeries {
  timestamp: string;
  /** Deltas por hora; `undefined` donde no hubo lectura cerca. */
  deltas: (number | undefined)[];
  /** Por hora: si hasta ahí no hubo comida ni otra dosis. */
  clean: boolean[];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : Math.round(sorted[middle]!);
}

/** La lectura más cercana a `targetMs` dentro de la tolerancia, o `undefined`. */
function nearest(
  series: readonly { ms: number; glucose: number }[],
  targetMs: number,
  toleranceMinutes: number,
): number | undefined {
  const tolerance = toleranceMinutes * 60_000;
  let best: { distance: number; glucose: number } | undefined;
  for (const point of series) {
    const distance = Math.abs(point.ms - targetMs);
    if (distance > tolerance) continue;
    if (best === undefined || distance < best.distance) best = { distance, glucose: point.glucose };
  }
  return best?.glucose;
}

/**
 * La curva de una sola inyección.
 *
 * Exportada para poder probar un episodio contra una verdad sembrada, que es
 * lo que la Regla 1 pide de todo número que se lea como patrón clínico.
 */
export function doseEffectSeries(input: {
  timestamp: string;
  readings: readonly CGMReading[];
  /** Instantes de otras dosis rápidas y de comidas, para marcar lo limpio. */
  interruptionsMs?: readonly number[] | undefined;
}): DoseSeries | null {
  const startMs = Date.parse(input.timestamp);
  if (!Number.isFinite(startMs)) return null;

  const series = input.readings
    // Sin datos sintéticos, igual que `glucose-metrics`, `agp`,
    // `nutrition-insights` y el reporte PDF. Una glucosa del modo demo
    // graficada bajo el título "Tu curva de efecto" sería exactamente lo que
    // `AGENTS.md` prohíbe: dato sintético leído como propio.
    .filter((reading) => reading.origin !== 'synthetic')
    .map((reading) => ({
      ms: Date.parse(reading.sourceTimestamp),
      glucose: convertGlucose(reading.glucose, reading.unit, 'mg/dL'),
    }))
    .filter(({ ms, glucose }) => Number.isFinite(ms) && Number.isFinite(glucose))
    .sort((a, b) => a.ms - b.ms);

  // Sin línea base no hay delta que calcular: un episodio sin glucosa al
  // momento de inyectarse no dice nada sobre lo que la insulina hizo.
  const baseline = nearest(series, startMs, BASELINE_TOLERANCE_MINUTES);
  if (baseline === undefined) return null;

  const interruptions = (input.interruptionsMs ?? []).filter((ms) => ms > startMs);
  const deltas: (number | undefined)[] = [];
  const clean: boolean[] = [];
  for (const hour of CURVE_HOURS) {
    const targetMs = startMs + hour * 60 * 60_000;
    const glucose = nearest(series, targetMs, MATCH_TOLERANCE_MINUTES);
    deltas.push(glucose === undefined ? undefined : Math.round(glucose - baseline));
    clean.push(!interruptions.some((ms) => ms <= targetMs));
  }
  if (deltas.every((delta) => delta === undefined)) return null;
  return { timestamp: input.timestamp, deltas, clean };
}

/** Agrupa las curvas por el tramo en que **empezó la inyección**. */
export function summarizeEffectCurves(doses: readonly DoseSeries[]): InsulinEffectCurveResult {
  const bySegment = new Map<DaySegmentKey, DoseSeries[]>();
  for (const dose of doses) {
    const segment = segmentOf(dose.timestamp);
    if (segment === undefined) continue;
    bySegment.set(segment, [...(bySegment.get(segment) ?? []), dose]);
  }

  let extreme = 0;
  const segments = DAY_SEGMENTS.map<SegmentCurve>((segment) => {
    const group = bySegment.get(segment.key) ?? [];
    const points = CURVE_HOURS.map<CurvePoint>((hour, index) => {
      const values: number[] = [];
      let cleanSampleSize = 0;
      for (const dose of group) {
        const delta = dose.deltas[index];
        if (delta === undefined) continue;
        values.push(delta);
        if (dose.clean[index] === true) cleanSampleSize += 1;
      }
      // Bajo el mínimo no se dibuja. `sampleSize` se sigue reportando entero,
      // para que la pantalla pueda decir "hay 1, hacen falta 3" en vez de
      // callar el punto sin explicación.
      const medianDeltaMgDl = values.length < MIN_EPISODES_PER_CURVE_POINT ? undefined : median(values);
      if (medianDeltaMgDl !== undefined) extreme = Math.max(extreme, Math.abs(medianDeltaMgDl));
      return { hour, medianDeltaMgDl, sampleSize: values.length, cleanSampleSize };
    });
    return { segment: segment.key, label: segment.label, doseCount: group.length, points };
  });

  return { segments, totalDoses: doses.length, extremeDeltaMgDl: extreme };
}

/**
 * La curva de efecto de un rango, de punta a punta.
 *
 * Entran **todas** las dosis rápidas. La basal no: no produce un efecto
 * atribuible a un instante. Y no se descarta nada por tener una comida cerca
 * —la comida es parte de lo que se quiere ver— pero cada punto lleva su
 * conteo limpio al lado.
 */
export function insulinEffectCurveFrom(input: {
  insulin: readonly InsulinEvent[];
  meals: readonly MealEvent[];
  readings: readonly CGMReading[];
}): InsulinEffectCurveResult {
  const rapid = input.insulin.filter((dose) => dose.type === 'rapid');
  const rapidMs = rapid.map((dose) => Date.parse(dose.timestamp)).filter(Number.isFinite);
  const mealMs = input.meals.map((meal) => Date.parse(meal.timestamp)).filter(Number.isFinite);

  const series: DoseSeries[] = [];
  for (const dose of rapid) {
    const doseMs = Date.parse(dose.timestamp);
    if (!Number.isFinite(doseMs)) continue;
    const resolved = doseEffectSeries({
      timestamp: dose.timestamp,
      readings: input.readings,
      // La propia dosis no se cuenta como interrupción de sí misma.
      interruptionsMs: [...rapidMs.filter((ms) => ms !== doseMs), ...mealMs],
    });
    if (resolved !== null) series.push(resolved);
  }
  return summarizeEffectCurves(series);
}
