import type { CGMReading, InsulinEvent, MealEvent } from '@type1a/schemas';

import { convertGlucose } from './units';

/**
 * Cuánto **dura de verdad** tu insulina, medido en tus datos, por tramo del
 * día.
 *
 * ## De dónde sale la pregunta
 *
 * De Verónica, el 2026-09-02: *"que te diga cuál es la curva de efecto de las
 * insulinas en los distintos rangos de tiempo del día, así puedes ver que tu
 * curva de efecto se alarga bastante en la mañana, por ejemplo"*.
 *
 * Es una pregunta legítima y medible. Lo que la literatura describe variando
 * por hora del día es sobre todo la **sensibilidad** —por eso las bombas
 * traen factores de corrección por tramo— pero cuánto tarda la glucosa en
 * dejar de bajar tras una corrección es un hecho observable de sus datos, y
 * ahora importa el doble: desde el ADR 0005 esa duración **cambia una dosis
 * propuesta**, así que poder contrastarla con la realidad deja de ser
 * curiosidad y pasa a ser control de calidad de un parámetro clínico.
 *
 * ## Qué mide, exactamente
 *
 * Para cada **corrección aislada** —una dosis rápida sin comida cerca, que es
 * la única situación donde la bajada se puede atribuir a la insulina— busca
 * cuándo la glucosa **dejó de bajar**: el primer momento, después del mínimo,
 * en que deja de descender de forma sostenida. Ese tiempo es la duración
 * observada de ese episodio.
 *
 * ## Lo que NO es
 *
 * - **No es la duración farmacológica.** Es cuándo dejó de verse el efecto en
 *   *su* glucosa, que llega antes que el final teórico de la molécula.
 * - **No se aplica sola.** Devuelve una observación; cambiar la duración que
 *   alimenta el IOB es un acto explícito de la usuaria (`AGENTS.md`: never
 *   infer therapy parameters). La app mide y propone; ella decide.
 * - **No publica un tramo con muestra insuficiente.** Un "tu insulina dura
 *   2 h en la mañana" sacado de un episodio es peor que no decir nada: se
 *   lee como patrón y aquí puede terminar cambiando una dosis.
 */

/** Los cuatro tramos. Fijos y no configurables: comparar exige un eje estable. */
export const DAY_SEGMENTS = [
  { key: 'madrugada', label: 'Madrugada', fromHour: 0, toHour: 6 },
  { key: 'manana', label: 'Mañana', fromHour: 6, toHour: 12 },
  { key: 'tarde', label: 'Tarde', fromHour: 12, toHour: 18 },
  { key: 'noche', label: 'Noche', fromHour: 18, toHour: 24 },
] as const;

export type DaySegmentKey = (typeof DAY_SEGMENTS)[number]['key'];

/** En qué tramo cae una hora local. Usa la zona del dispositivo, como el timeline. */
export function segmentOf(iso: string): DaySegmentKey | undefined {
  const hour = new Date(iso).getHours();
  if (!Number.isFinite(hour)) return undefined;
  return DAY_SEGMENTS.find((segment) => hour >= segment.fromHour && hour < segment.toHour)?.key;
}

/**
 * Cuántos episodios hacen falta en un tramo para publicar su número.
 *
 * Tres es poco para un promedio clínico y se sabe — por eso el resultado
 * siempre lleva su `n` al lado. Pero uno o dos no es una observación, es una
 * anécdota, y esta cifra puede terminar cambiando una dosis.
 */
export const MIN_EPISODES_PER_SEGMENT = 3;

/** Ventana máxima que se mira tras una corrección, en minutos. */
const MAX_OBSERVATION_MINUTES = 480;
/**
 * Cuánto tiene que subir la glucosa desde el mínimo para decir "ya dejó de
 * bajar". Sin un umbral, el ruido del sensor (±2-3 mg/dL entre lecturas)
 * marcaría el final en cuanto la curva se aplana.
 */
const REBOUND_MG_DL = 5;

export interface CorrectionObservation {
  /** Cuándo se puso la corrección. */
  timestamp: string;
  /** Minutos hasta que la glucosa dejó de bajar. */
  observedMinutes: number;
  /** Cuánto bajó, en mg/dL. Se declara: una bajada de 8 mg/dL no dice mucho. */
  dropMgDl: number;
}

export interface SegmentDuration {
  segment: DaySegmentKey;
  label: string;
  /** Mediana de los episodios del tramo, en minutos. `undefined` si no alcanza. */
  medianMinutes: number | undefined;
  /** Cuántos episodios lo sostienen. Se muestra SIEMPRE, alcance o no. */
  episodeCount: number;
  /** Los extremos observados, para que un promedio no esconda su dispersión. */
  rangeMinutes: { min: number; max: number } | undefined;
}

export interface ObservedDurationResult {
  segments: SegmentDuration[];
  /** Mediana de todo, cuando hay suficiente. Es el número comparable global. */
  overallMedianMinutes: number | undefined;
  totalEpisodes: number;
}

/** Una corrección aislada y las lecturas que la siguen. */
export interface CorrectionEpisodeInput {
  timestamp: string;
  units: number;
  readings: readonly CGMReading[];
}

/**
 * Cuándo dejó de bajar la glucosa después de una corrección.
 *
 * Devuelve `null` cuando el episodio no permite decirlo: sin lecturas, sin
 * una bajada real, o sin un repunte que marque el final dentro de la ventana.
 * Un episodio que no se puede medir **se descarta**, no se rellena con el
 * máximo de la ventana — eso alargaría la mediana con datos inventados.
 */
export function observeCorrectionEpisode(input: CorrectionEpisodeInput): CorrectionObservation | null {
  const startMs = Date.parse(input.timestamp);
  if (!Number.isFinite(startMs)) return null;

  const series = [...input.readings]
    .map((reading) => ({
      ms: Date.parse(reading.sourceTimestamp),
      glucose: convertGlucose(reading.glucose, reading.unit, 'mg/dL'),
    }))
    .filter(({ ms }) => Number.isFinite(ms) && ms >= startMs && ms <= startMs + MAX_OBSERVATION_MINUTES * 60_000)
    .sort((a, b) => a.ms - b.ms);
  if (series.length < 3) return null;

  const start = series[0]!;
  let lowest = start;
  for (const point of series) if (point.glucose < lowest.glucose) lowest = point;

  const dropMgDl = start.glucose - lowest.glucose;
  // Sin una bajada real no hay efecto que medir: puede haber comido, puede
  // haber sido una dosis chica. Descartar es más honesto que contar un 0.
  if (dropMgDl < REBOUND_MG_DL * 2) return null;

  // El final es el primer punto DESPUÉS del mínimo que repunta lo suficiente
  // como para no ser ruido. Si nunca repunta dentro de la ventana, no se
  // puede afirmar que terminó.
  const rebound = series.find((point) => point.ms > lowest.ms && point.glucose >= lowest.glucose + REBOUND_MG_DL);
  if (rebound === undefined) return null;

  return {
    timestamp: input.timestamp,
    observedMinutes: Math.round((lowest.ms - startMs) / 60_000),
    dropMgDl: Math.round(dropMgDl),
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : sorted[middle]!;
}

/**
 * Agrupa las observaciones por tramo del día.
 *
 * **Mediana y no promedio**: un episodio raro —comió a mitad de la bajada, el
 * sensor se despegó— corre un promedio entero y no mueve una mediana. Con
 * muestras chicas esa diferencia es la que decide si el número es usable.
 */
export function summarizeObservedDuration(
  observations: readonly CorrectionObservation[],
): ObservedDurationResult {
  const bySegment = new Map<DaySegmentKey, number[]>();
  for (const observation of observations) {
    const segment = segmentOf(observation.timestamp);
    if (segment === undefined) continue;
    bySegment.set(segment, [...(bySegment.get(segment) ?? []), observation.observedMinutes]);
  }

  const segments = DAY_SEGMENTS.map<SegmentDuration>((segment) => {
    const minutes = bySegment.get(segment.key) ?? [];
    const enough = minutes.length >= MIN_EPISODES_PER_SEGMENT;
    return {
      segment: segment.key,
      label: segment.label,
      // El `n` va siempre; la cifra solo cuando la sostiene.
      medianMinutes: enough ? median(minutes) : undefined,
      episodeCount: minutes.length,
      rangeMinutes: enough
        ? { min: Math.min(...minutes), max: Math.max(...minutes) }
        : undefined,
    };
  });

  const all = observations.map((observation) => observation.observedMinutes);
  return {
    segments,
    overallMedianMinutes: all.length >= MIN_EPISODES_PER_SEGMENT ? median(all) : undefined,
    totalEpisodes: all.length,
  };
}

/**
 * La duración que se usa para el IOB en un instante dado.
 *
 * Los overrides por tramo son **de la usuaria**: la pantalla le muestra lo
 * observado y ella decide si lo adopta. Sin override para ese tramo se usa la
 * duración general que ya tenía configurada — nunca lo observado directamente.
 * Medir es de la app; fijar un parámetro de terapia es de ella.
 */
export function durationHoursAt(
  iso: string,
  profile: {
    rapidInsulinDurationHours?: number | undefined;
    segmentDurationHours?: { [K in DaySegmentKey]?: number | undefined } | undefined;
  },
): number | undefined {
  const segment = segmentOf(iso);
  const override = segment === undefined ? undefined : profile.segmentDurationHours?.[segment];
  return override ?? profile.rapidInsulinDurationHours;
}

/**
 * Minutos alrededor de una dosis en los que una comida la descalifica.
 *
 * Una corrección con comida cerca ya no mide la insulina: mide la insulina
 * *menos* los carbohidratos, y la glucosa deja de bajar porque empezó a subir
 * la comida, no porque se acabó el efecto. Ese episodio no dice nada sobre la
 * duración y se descarta entero.
 */
const MEAL_EXCLUSION_MINUTES = 90;

/**
 * Las correcciones **aisladas** de un rango, ya observadas.
 *
 * Vive acá y no en el `.tsx` que lo dibuja porque decidir qué episodio cuenta
 * es justamente la parte que puede producir un número equivocado, y
 * `systemPatterns.md` § Regla 1 es explícita: el dominio calcula, la pantalla
 * formatea.
 *
 * Qué se excluye, y por qué cada cosa:
 *
 * - **Lo que no es rápida**: una basal no produce una bajada atribuible.
 * - **Lo que no es corrección**: un bolo de comida baja y sube a la vez.
 * - **Lo que tiene una comida cerca**, aunque esté etiquetado corrección.
 * - **Lo que tiene otra dosis dentro de la ventana**: con dos dosis
 *   solapadas no se sabe cuál dejó de actuar, y atribuirlo a la primera
 *   alargaría la duración observada sin motivo.
 */
export function observeCorrectionsFrom(input: {
  insulin: readonly InsulinEvent[];
  meals: readonly MealEvent[];
  readings: readonly CGMReading[];
}): CorrectionObservation[] {
  const mealMs = input.meals.map((meal) => Date.parse(meal.timestamp)).filter(Number.isFinite);
  const rapidMs = input.insulin
    .filter((dose) => dose.type === 'rapid')
    .map((dose) => Date.parse(dose.timestamp))
    .filter(Number.isFinite);

  const out: CorrectionObservation[] = [];
  for (const dose of input.insulin) {
    if (dose.type !== 'rapid' || dose.purpose !== 'correction') continue;
    const doseMs = Date.parse(dose.timestamp);
    if (!Number.isFinite(doseMs)) continue;

    const window = MEAL_EXCLUSION_MINUTES * 60_000;
    if (mealMs.some((ms) => Math.abs(ms - doseMs) <= window)) continue;
    // Otra rápida dentro de la ventana de observación: no se sabe de cuál es
    // la bajada. `> doseMs` deja pasar la propia dosis.
    if (rapidMs.some((ms) => ms > doseMs && ms <= doseMs + MAX_OBSERVATION_MINUTES * 60_000)) continue;

    const observation = observeCorrectionEpisode({
      timestamp: dose.timestamp,
      units: dose.units,
      readings: input.readings,
    });
    if (observation !== null) out.push(observation);
  }
  return out;
}
