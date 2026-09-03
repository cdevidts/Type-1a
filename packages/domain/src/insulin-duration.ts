import type { CGMReading, InsulinEvent, MealEvent } from '@type1a/schemas';

import { adjustForNuisance, adjustmentIsPlausible, fitOlsOnVaryingColumns } from './regression';
import { convertGlucose } from './units';

/**
 * Cuánto **dura de verdad** tu insulina y **cuánto tarda en pegar**, medido en
 * tus datos, por tramo del día.
 *
 * ## De dónde sale la pregunta
 *
 * De Verónica: *"que te diga cuál es la curva de efecto de las insulinas en
 * los distintos rangos de tiempo del día, así puedes ver que tu curva de
 * efecto se alarga bastante en la mañana"*.
 *
 * ## Por qué se rehizo (2026-09-03)
 *
 * La primera versión no mostraba **nada**, y ella lo dijo con el diagnóstico
 * puesto: *"obviamente que ningún dato va a entrar si no pueden haber comidas
 * en rangos de 5 horas"*. Tenía razón. Exigía una corrección etiquetada como
 * tal, sin comida a ±90 min y **sin ninguna otra rápida en las 8 h
 * siguientes**. Quien usa múltiples dosis diarias no tiene esa ventana
 * despierta nunca: solo la madrugada podía calificar, y comparar mañana con
 * tarde era justamente el punto.
 *
 * Es el mismo error que ya se había cometido y documentado en
 * `macro-glucose.ts`: excluir todo episodio con un confusor deja una muestra
 * sesgada, no una muestra limpia. La regla que salió de ahí —**truncar y
 * ajustar, nunca obviar**— ahora gobierna también acá.
 *
 * ## El método, y de dónde sale
 *
 * Tres cosas, en orden de cuánto sostienen el número:
 *
 * 1. **Toda dosis rápida cuenta**, de comida o de corrección. Lo que se mide
 *    es cuándo la glucosa dejó de bajar, y eso se ve igual detrás de un bolo
 *    de comida — más tarde y más plano, que es exactamente para lo que existe
 *    el ajuste del punto 3.
 * 2. **La ventana se trunca en la dosis siguiente**, no se descarta el
 *    episodio. Es lo que hace la literatura de CGM con comidas solapadas
 *    (`reference/clinical-sources.md` § respuesta post-prandial): se recorta
 *    para contar cada excursión una sola vez. Se piden **2 h** de ventana
 *    útil, que es el punto de control del test de factor de corrección
 *    estándar —"revisa 2-3 h después"— y no las 8 h del final teórico.
 * 3. **Los carbohidratos entran como covariable**, no como criterio de
 *    exclusión. Con muestra suficiente se descuenta su aporte por OLS
 *    centrado (`regression.ts`); sin ella se muestra el crudo **y se
 *    declara**, con cuántos episodios traían comida.
 *
 * El tramo horario (6-12 / 12-18 / 18-24) es el mismo corte que usa la
 * literatura de ISF diurna y el que traen las bombas para el factor de
 * corrección por franja.
 *
 * ## Lo que NO es
 *
 * - **No es la duración farmacológica.** Es cuándo dejó de verse el efecto en
 *   *su* glucosa, que llega antes que el final teórico de la molécula.
 * - **No se aplica sola.** `AGENTS.md`: never infer therapy parameters. La
 *   app mide y propone; adoptar una duración es un acto de ella.
 * - **No publica un tramo con muestra insuficiente**: el `n` va siempre, la
 *   cifra solo cuando la sostiene.
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

/** Ventana máxima que se mira tras una dosis, en minutos. */
const MAX_OBSERVATION_MINUTES = 480;
/**
 * Ventana mínima útil. Dos horas es el punto de control del test de factor de
 * corrección de manual: "revisa tu glucosa 2-3 h después". Con menos no se
 * puede afirmar que la bajada terminó.
 */
const MIN_WINDOW_MINUTES = 120;
/**
 * Cuánto tiene que haber bajado la glucosa para que haya efecto que cronometrar.
 * Por debajo de esto la "bajada" es indistinguible del ruido del sensor y de
 * la deriva normal.
 */
const MIN_DROP_MG_DL = 15;
/** Repunte que marca el final. ±3-4 mg/dL es el ruido típico entre lecturas. */
const REBOUND_MG_DL = 4;
/** O, sin repunte, este rato sin volver a bajar también cierra el episodio. */
const FLAT_MINUTES = 30;
/** Carbohidratos contados desde un poco antes de la dosis: se bolea y luego se come. */
const CARB_LOOKBACK_MINUTES = 30;

export interface CorrectionObservation {
  /** Cuándo se puso la dosis. */
  timestamp: string;
  /** Minutos hasta que la glucosa dejó de bajar. */
  observedMinutes: number;
  /** Minutos hasta el momento de bajada más rápida: el pico de acción visible. */
  peakMinutes: number;
  /** Cuánto bajó, en mg/dL. Se declara: una bajada de 8 mg/dL no dice mucho. */
  dropMgDl: number;
  /** Unidades de la dosis. Covariable: 6 U bajan más y más rato que 2 U. */
  units: number;
  /** Carbohidratos dentro de la ventana. **Covariable, no criterio de exclusión.** */
  carbsInWindowG: number;
}

export interface SegmentDuration {
  segment: DaySegmentKey;
  label: string;
  /** Mediana de los episodios del tramo, en minutos. `undefined` si no alcanza. */
  medianMinutes: number | undefined;
  /** Mediana del tiempo hasta la bajada más rápida. Responde "¿tarda más en pegar?". */
  medianPeakMinutes: number | undefined;
  /** Cuántos episodios lo sostienen. Se muestra SIEMPRE, alcance o no. */
  episodeCount: number;
  /** De esos, cuántos no tenían comida en la ventana. */
  cleanCount: number;
  /**
   * Mediana **solo de los episodios sin comida**, sin ajustar. Es la única
   * cifra que se puede adoptar como duración.
   *
   * `medianMinutes` sirve para **comparar** tramos: el ajuste está centrado,
   * así que conserva las diferencias entre tramos pero también conserva el
   * nivel promedio — y ese nivel incluye lo que aportó la comida. Adoptar ese
   * número metería la digestión dentro de la duración de la insulina y la
   * app descontaría IOB de más. Comparar y adoptar no son la misma cifra.
   */
  cleanMedianMinutes: number | undefined;
  /** Los extremos observados, para que una mediana no esconda su dispersión. */
  rangeMinutes: { min: number; max: number } | undefined;
}

export interface ObservedDurationResult {
  segments: SegmentDuration[];
  /** Mediana de todo, cuando hay suficiente. Es el número comparable global. */
  overallMedianMinutes: number | undefined;
  totalEpisodes: number;
  /** Episodios sin comida en la ventana: los más limpios de todos. */
  cleanEpisodes: number;
  /**
   * Si las medianas están descontadas por carbohidratos y unidades.
   * `false` = son crudas, y la pantalla **tiene que decirlo**.
   */
  adjusted: boolean;
}

/** Una dosis rápida y las lecturas que la siguen. */
export interface CorrectionEpisodeInput {
  timestamp: string;
  units: number;
  readings: readonly CGMReading[];
  /** Fin de la ventana: la dosis siguiente, o el máximo. Omitido = el máximo. */
  windowEndMs?: number | undefined;
  /** Carbohidratos dentro de la ventana. Se arrastra, no se usa para filtrar. */
  carbsInWindowG?: number | undefined;
}

/**
 * Cuándo dejó de bajar la glucosa después de una dosis, y cuándo pegó más fuerte.
 *
 * Devuelve `null` cuando el episodio no permite decirlo: sin lecturas
 * suficientes, sin una bajada real, o sin final confirmado dentro de la
 * ventana. Un episodio que no se puede medir **se descarta**, no se rellena
 * con el máximo — eso alargaría la mediana con datos inventados.
 */
export function observeCorrectionEpisode(input: CorrectionEpisodeInput): CorrectionObservation | null {
  const startMs = Date.parse(input.timestamp);
  if (!Number.isFinite(startMs)) return null;
  const hardEnd = startMs + MAX_OBSERVATION_MINUTES * 60_000;
  const endMs = Math.min(input.windowEndMs ?? hardEnd, hardEnd);
  if (endMs - startMs < MIN_WINDOW_MINUTES * 60_000) return null;

  const series = [...input.readings]
    .map((reading) => ({
      ms: Date.parse(reading.sourceTimestamp),
      glucose: convertGlucose(reading.glucose, reading.unit, 'mg/dL'),
    }))
    // El fin es EXCLUSIVO: la lectura del instante de la dosis siguiente ya
    // pertenece a ese episodio. Incluirla ponía el mínimo en el último punto
    // de la ventana —una glucosa pre-comida, baja por definición— y el
    // episodio se descartaba por no poder confirmar el final. En un día con
    // tres comidas eso dejaba fuera las dos primeras.
    .filter(({ ms, glucose }) => Number.isFinite(ms) && Number.isFinite(glucose) && ms >= startMs && ms < endMs)
    .sort((a, b) => a.ms - b.ms);
  if (series.length < 4) return null;

  const start = series[0]!;
  const last = series[series.length - 1]!;
  // La ventana tiene que estar realmente cubierta por lecturas: un sensor con
  // un hueco de dos horas no mide nada aunque la ventana sea larga.
  if (last.ms - start.ms < MIN_WINDOW_MINUTES * 60_000) return null;

  // La bajada se mide desde el MÁXIMO de la ventana, no desde el instante de
  // la dosis. En una corrección son el mismo punto; en un bolo de comida no,
  // porque la glucosa sube primero y recién después baja. Anclar en el
  // instante de la dosis hacía que casi toda dosis de comida diera una
  // "bajada" de 0 y se descartara — el segundo motivo, después del filtro de
  // aislamiento, de que la pantalla saliera vacía.
  let peak = start;
  for (const point of series) if (point.glucose > peak.glucose) peak = point;
  const afterPeak = series.filter((point) => point.ms >= peak.ms);
  if (afterPeak.length < 3) return null;

  let lowest = afterPeak[0]!;
  for (const point of afterPeak) if (point.glucose < lowest.glucose) lowest = point;

  const dropMgDl = peak.glucose - lowest.glucose;
  if (dropMgDl < MIN_DROP_MG_DL) return null;

  // El final se confirma de dos maneras, y basta una: un repunte por encima
  // del ruido, o un rato largo sin volver a bajar. La primera versión pedía
  // solo el repunte, y eso descartaba justo los episodios que terminan en una
  // meseta — que son la mayoría cuando la dosis acertó.
  const after = afterPeak.filter((point) => point.ms > lowest.ms);
  const rebounded = after.some((point) => point.glucose >= lowest.glucose + REBOUND_MG_DL);
  const flattened = after.length > 0 && (last.ms - lowest.ms) >= FLAT_MINUTES * 60_000;
  if (!rebounded && !flattened) return null;

  // Pico de acción visible: el punto medio del tramo de ~30 min en que la
  // glucosa cayó más rápido. Es lo que responde "¿en la mañana tarda más en
  // empezar a pegar?", que es una pregunta distinta de cuánto dura.
  let steepest = { rate: 0, midMs: lowest.ms };
  for (let i = 0; i < afterPeak.length; i += 1) {
    for (let j = i + 1; j < afterPeak.length; j += 1) {
      const span = afterPeak[j]!.ms - afterPeak[i]!.ms;
      if (span < 20 * 60_000) continue;
      if (span > 40 * 60_000) break;
      const rate = (afterPeak[j]!.glucose - afterPeak[i]!.glucose) / (span / 60_000);
      if (rate < steepest.rate) steepest = { rate, midMs: (afterPeak[i]!.ms + afterPeak[j]!.ms) / 2 };
    }
  }

  return {
    timestamp: input.timestamp,
    observedMinutes: Math.round((lowest.ms - startMs) / 60_000),
    peakMinutes: Math.round((steepest.midMs - startMs) / 60_000),
    dropMgDl: Math.round(dropMgDl),
    units: Number.isFinite(input.units) ? input.units : 0,
    carbsInWindowG: input.carbsInWindowG ?? 0,
  };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
    : Math.round(sorted[middle]!);
}

/**
 * Descuenta de cada episodio el desbalance en carbohidratos y unidades.
 *
 * Devuelve los minutos crudos cuando el ajuste no se sostiene —muestra chica,
 * covariables constantes, o un ajuste que mueve el promedio más de lo que
 * puede justificar—, y quien llama lo declara. Es la misma cadena y los
 * mismos frenos que `macro-glucose.ts`, incluido el criterio de
 * `adjustmentIsPlausible`, que existe porque un β disparatado ya publicó una
 * vez un número movido en esta app.
 */
function adjustMinutes(observations: readonly CorrectionObservation[]): { minutes: number[]; adjusted: boolean } {
  const raw = observations.map((observation) => observation.observedMinutes);
  const predictors = observations.map((observation) => [observation.carbsInWindowG, observation.units]);
  const fitted = fitOlsOnVaryingColumns(raw, predictors, 8);
  if (fitted === null) return { minutes: raw, adjusted: false };

  const reduced = predictors.map((row) => fitted.columns.map((column) => row[column]!));
  const nuisance = fitted.columns.map((_, index) => index);
  const adjusted = adjustForNuisance(raw, reduced, nuisance, fitted.fit);
  if (!adjustmentIsPlausible(raw, adjusted)) return { minutes: raw, adjusted: false };
  return { minutes: adjusted.map((value) => Math.max(0, Math.round(value))), adjusted: true };
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
  const { minutes, adjusted } = adjustMinutes(observations);

  type Bucket = { minutes: number[]; peaks: number[]; clean: number[] };
  const empty = (): Bucket => ({ minutes: [], peaks: [], clean: [] });
  const bySegment = new Map<DaySegmentKey, Bucket>();
  observations.forEach((observation, index) => {
    const segment = segmentOf(observation.timestamp);
    if (segment === undefined) return;
    const bucket = bySegment.get(segment) ?? empty();
    bucket.minutes.push(minutes[index] ?? observation.observedMinutes);
    bucket.peaks.push(observation.peakMinutes);
    // Los limpios van SIN ajustar: no tienen carbohidratos que descontar, y
    // son los únicos que se pueden adoptar como duración.
    if (observation.carbsInWindowG === 0) bucket.clean.push(observation.observedMinutes);
    bySegment.set(segment, bucket);
  });

  const segments = DAY_SEGMENTS.map<SegmentDuration>((segment) => {
    const bucket = bySegment.get(segment.key) ?? empty();
    const enough = bucket.minutes.length >= MIN_EPISODES_PER_SEGMENT;
    return {
      segment: segment.key,
      label: segment.label,
      // El `n` va siempre; la cifra solo cuando la sostiene.
      medianMinutes: enough ? median(bucket.minutes) : undefined,
      medianPeakMinutes: enough ? median(bucket.peaks) : undefined,
      episodeCount: bucket.minutes.length,
      cleanCount: bucket.clean.length,
      cleanMedianMinutes: bucket.clean.length >= MIN_EPISODES_PER_SEGMENT ? median(bucket.clean) : undefined,
      rangeMinutes: enough
        ? { min: Math.min(...bucket.minutes), max: Math.max(...bucket.minutes) }
        : undefined,
    };
  });

  return {
    segments,
    overallMedianMinutes: minutes.length >= MIN_EPISODES_PER_SEGMENT ? median(minutes) : undefined,
    totalEpisodes: observations.length,
    cleanEpisodes: observations.filter((observation) => observation.carbsInWindowG === 0).length,
    adjusted,
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
 * Las dosis rápidas de un rango, ya observadas.
 *
 * Vive acá y no en el `.tsx` que lo dibuja porque decidir qué episodio cuenta
 * es justamente la parte que puede producir un número equivocado, y
 * `systemPatterns.md` § Regla 1 es explícita: el dominio calcula, la pantalla
 * formatea.
 *
 * Qué queda fuera, y por qué **solo** esto:
 *
 * - **Lo que no es rápida**: una basal no produce una bajada atribuible.
 * - **Lo que no alcanza a medirse**: menos de 2 h de ventana hasta la dosis
 *   siguiente, o sin lecturas que la cubran.
 *
 * Lo que **ya no** queda fuera, y era el error de la primera versión: las
 * dosis de comida, y las dosis con otra dosis más adelante en el día. La
 * ventana se **recorta** en la siguiente en vez de tirar el episodio.
 */
export function observeCorrectionsFrom(input: {
  insulin: readonly InsulinEvent[];
  meals: readonly MealEvent[];
  readings: readonly CGMReading[];
}): CorrectionObservation[] {
  const meals = input.meals
    .map((meal) => ({ ms: Date.parse(meal.timestamp), carbs: meal.confirmedCarbsG ?? 0 }))
    .filter(({ ms }) => Number.isFinite(ms));
  const rapidMs = input.insulin
    .filter((dose) => dose.type === 'rapid')
    .map((dose) => Date.parse(dose.timestamp))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);

  const out: CorrectionObservation[] = [];
  for (const dose of input.insulin) {
    if (dose.type !== 'rapid') continue;
    const doseMs = Date.parse(dose.timestamp);
    if (!Number.isFinite(doseMs)) continue;

    // La ventana termina en la dosis siguiente: a partir de ahí la bajada ya
    // no es solo de esta. Recortar, no descartar.
    const next = rapidMs.find((ms) => ms > doseMs);
    const windowEndMs = Math.min(next ?? Number.POSITIVE_INFINITY, doseMs + MAX_OBSERVATION_MINUTES * 60_000);
    const carbsInWindowG = meals
      .filter(({ ms }) => ms >= doseMs - CARB_LOOKBACK_MINUTES * 60_000 && ms <= windowEndMs)
      .reduce((sum, { carbs }) => sum + carbs, 0);

    const observation = observeCorrectionEpisode({
      timestamp: dose.timestamp,
      units: dose.units,
      readings: input.readings,
      windowEndMs,
      carbsInWindowG,
    });
    if (observation !== null) out.push(observation);
  }
  return out;
}
