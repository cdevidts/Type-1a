import type { ActivityEvent, CarbEvent, CGMReading, InsulinEvent, MealEvent } from '@type1a/schemas';

import { hasConfoundingEvent } from './episode-context';
import { findRapidInsulinCandidates } from './meal';
import { HIGH_THRESHOLD, HYPOGLYCEMIA_THRESHOLD } from './glucose-thresholds';
import { convertGlucose } from './units';

/**
 * Insights alimentarios — patrones DESCRIPTIVOS por franja horaria del día:
 * cuántos carbohidratos y cuánta insulina rápida se registran típicamente en
 * cada franja, y con qué frecuencia la glucosa quedó en rango objetivo 1, 2 y
 * 3 horas después de una dosis rápida.
 *
 * ────────────────────────────────────────────────────────────────────────
 * FRONTERA DE SEGURIDAD (AGENTS.md) — leer antes de tocar este archivo.
 *
 * Esto es estadística observacional sobre datos ya registrados, NO una
 * evaluación de si una dosis fue correcta ni una base para cambiarla. Por
 * eso el módulo:
 *
 *  - **No calcula, sugiere ni "corrige" ninguna dosis.** No hay ninguna
 *    salida en unidades de insulina. Devuelve promedios de lo ya registrado
 *    y porcentajes de resultados observados, nada más.
 *  - **No infiere parámetros de terapia.** Nunca deriva un factor de
 *    corrección, un ratio de carbohidratos ni un objetivo a partir de estos
 *    porcentajes — eso sería exactamente la inferencia que AGENTS.md
 *    prohíbe. El "% en rango a las N horas" es un resultado observado, no
 *    una medida de qué tan adecuada fue la dosis.
 *  - **Exige tamaño de muestra.** Por debajo de `MIN_SAMPLE_FOR_RATE`
 *    episodios no devuelve porcentaje (`inTargetPct: undefined`) — con 1 o 2
 *    dosis, "50% en rango" es ruido presentado como patrón, y en una app de
 *    salud eso es peligroso, no solo impreciso. `sampleSize` viaja siempre
 *    junto al porcentaje para que la UI pueda mostrar el n.
 *  - **Correlación, no causalidad.** La glucosa a las N horas depende
 *    también de la comida, la actividad, el estrés, la insulina basal y el
 *    sitio de inyección. Quien muestre estos números debe decirlo (ver
 *    `SummaryModal`), y nunca presentarlos como "la insulina rindió X%".
 *  - **Nunca mezcla carbohidratos estimados por IA con los confirmados.**
 *    Solo se promedian los `confirmedCarbsG` (AGENTS.md).
 *  - **Excluye lecturas sintéticas**, igual que `glucose-metrics.ts` y
 *    `agp.ts`.
 * ────────────────────────────────────────────────────────────────────────
 */

/**
 * Mínimo de episodios antes de mostrar un porcentaje. Tres es el piso: por
 * debajo, un solo episodio mueve el resultado entre 0% y 100%.
 */
export const MIN_SAMPLE_FOR_RATE = 3;

/**
 * Cuánto puede alejarse una lectura del horizonte exacto (1/2/3 h) para
 * contar como "la glucosa a esa hora". ±20 min tolera el intervalo real de
 * un CGM (5–15 min) y algún hueco, sin llegar a estirar una lectura de otra
 * franja horaria.
 */
export const HORIZON_TOLERANCE_MINUTES = 20;

export const RESPONSE_HORIZONS_HOURS = [1, 2, 3] as const;
export type ResponseHorizonHours = (typeof RESPONSE_HORIZONS_HOURS)[number];

/**
 * Franjas horarias. Se eligieron alrededor de los horarios de comida reales
 * en vez de bloques uniformes de 6 h, porque la pregunta que responde esta
 * pantalla es "¿cómo me va en el desayuno vs. la cena?", no "¿cómo me va
 * entre las 00 y las 06?". `endHour` es exclusivo.
 */
export interface MealTimeWindow {
  key: string;
  label: string;
  startHour: number;
  endHour: number;
}

export const MEAL_TIME_WINDOWS: readonly MealTimeWindow[] = [
  { key: 'madrugada', label: 'Madrugada', startHour: 0, endHour: 6 },
  { key: 'mañana', label: 'Mañana', startHour: 6, endHour: 11 },
  { key: 'mediodía', label: 'Mediodía', startHour: 11, endHour: 15 },
  { key: 'tarde', label: 'Tarde', startHour: 15, endHour: 19 },
  { key: 'noche', label: 'Noche', startHour: 19, endHour: 24 },
];

export interface HorizonOutcome {
  horizonHours: ResponseHorizonHours;
  /**
   * % de dosis rápidas de la franja tras las cuales había una lectura en
   * rango objetivo (70–180 mg/dL) a esa hora. `undefined` cuando
   * `sampleSize < MIN_SAMPLE_FOR_RATE` — no es cero, es "todavía no se
   * puede decir".
   */
  inTargetPct?: number | undefined;
  /**
   * Los dos lados del "no en rango", separados a propósito.
   *
   * Un único "% en rango" colapsa una hipoglucemia y una hiperglucemia en el
   * mismo número, y al lado del promedio de insulina de la franja eso invita
   * a leer "poco porcentaje = me falta insulina" cuando los fallos pueden
   * haber sido hipos. La dirección del fallo es justamente lo que no se
   * puede perder acá. Misma razón por la que `GlucoseRangeBreakdown` nunca
   * muestra un solo número de Time in Range.
   */
  belowTargetPct?: number | undefined;
  aboveTargetPct?: number | undefined;
  /** Dosis con una lectura utilizable en ese horizonte. */
  sampleSize: number;
  /**
   * Cuántas de esas dosis tuvieron algo registrado en el medio (otra comida,
   * carbohidratos, otra dosis, actividad).
   *
   * **Se declara en vez de descartarse** (2026-08-25). Excluirlas vaciaba la
   * pantalla, porque en diabetes tipo 1 con múltiples dosis casi ninguna
   * ventana de 3 h queda limpia. Quien muestre el porcentaje tiene que
   * mostrar también este número: sin él, un resultado mezclado se lee como
   * uno limpio.
   */
  confoundedCount: number;
}

export interface MealWindowInsight {
  key: string;
  label: string;
  startHour: number;
  endHour: number;
  /** Comidas registradas en la franja (con o sin carbohidratos confirmados). */
  mealCount: number;
  /** Promedio de carbohidratos CONFIRMADOS por el usuario. Nunca los estimados por IA. */
  avgConfirmedCarbsG?: number | undefined;
  /** Registros que aportaron al promedio de carbohidratos. */
  confirmedCarbsSampleSize: number;
  avgRapidUnits?: number | undefined;
  rapidDoseCount: number;
  avgBasalUnits?: number | undefined;
  basalDoseCount: number;
  /**
   * Promedios de macronutrientes de las comidas de la franja (Fase 13,
   * ítem 7). Solo entran las comidas donde la usuaria efectivamente cargó ese
   * macro — una comida sin proteína anotada no cuenta como "0 g de proteína",
   * porque no lo es: es un dato ausente. Por eso cada macro lleva su propio
   * `sampleSize` en vez de compartir `mealCount`.
   *
   * Es descriptivo, igual que el resto del módulo: grasa y proteína influyen
   * en cuándo sube la glucosa después de comer, y verlo por franja ayuda a
   * conversarlo con el equipo clínico. La app **no** deriva de acá ningún
   * ajuste de dosis ni de tiempos de insulina.
   */
  avgProteinG?: number | undefined;
  proteinSampleSize: number;
  avgFatG?: number | undefined;
  fatSampleSize: number;
  avgFiberG?: number | undefined;
  fiberSampleSize: number;
  outcomes: HorizonOutcome[];
}

export interface NutritionInsightsInput {
  readings: readonly CGMReading[];
  insulin: readonly InsulinEvent[];
  carbs: readonly CarbEvent[];
  meals: readonly MealEvent[];
  /**
   * Actividad física, solo para detectar episodios confundidos (Fase 23).
   * No entra en ningún promedio; mueve la glucosa lo suficiente como para
   * que una caminata a las 2 h invalide el "% en rango" de esa dosis.
   */
  activity?: readonly ActivityEvent[];
  /**
   * Cuánto mirar hacia atrás por dosis que siguen actuando, en minutos
   * (2026-08-25). Sale de la insulina elegida en Ajustes; sin elegir,
   * `undefined` y no se mira hacia atrás. Ver `insulin-catalog.ts`.
   */
  rapidLookbackMinutes?: number | undefined;
  /** Ídem para la basal (24-42 h). Ver `insulin-catalog.ts`. */
  basalLookbackMinutes?: number | undefined;
}

/**
 * Cuánto después de una dosis se sigue considerando "la comida de esa dosis"
 * y no una intervención nueva (Fase 23).
 *
 * 60 minutos, igual que la ventana de asociación de
 * `findRapidInsulinCandidates` — no un número nuevo. Pre-bolear 20 min antes
 * de comer es práctica estándar: con una gracia corta, **toda** comida bien
 * pre-boleada quedaría marcada como confundida y el patrón se quedaría sin
 * muestra.
 *
 * ⚠️ Se pasa como `mealGraceMinutes`, **no** como `graceMinutes` (corregido
 * 2026-08-22 tras la revisión de seguridad). Aplicado a todas las clases,
 * volvía invisible una corrección real dentro de la primera hora —
 * exactamente el confusor que esta exclusión existe para detectar— y con el
 * horizonte de 1 h dejaba la ventana vacía, así que esa hora **nunca** podía
 * marcarse confundida. Insulina y actividad se quedan con la gracia base
 * corta (`EPISODE_GRACE_MINUTES`).
 */
const DOSE_OWN_MEAL_MINUTES = 60;

function localHour(isoTimestamp: string): number {
  return new Date(isoTimestamp).getHours();
}

function windowForHour(hour: number): MealTimeWindow | undefined {
  return MEAL_TIME_WINDOWS.find((w) => hour >= w.startHour && hour < w.endHour);
}

/**
 * Serie de glucosa normalizada a mg/dL, ordenada y sin sintéticas — la forma
 * que esperan `readingNear` y todo lo que mide una respuesta post-comida.
 * Exportada para que `macro-glucose.ts` no repita el mismo preprocesado (y
 * con él la exclusión de sintéticas, que es una regla de seguridad).
 */
export function toGlucoseSeries(readings: readonly CGMReading[]): TimedGlucose[] {
  return readings
    .filter((r) => r.origin !== 'synthetic')
    .map((r) => ({
      atMs: Date.parse(r.sourceTimestamp),
      mgDl: convertGlucose(r.glucose, r.unit, 'mg/dL'),
    }))
    .sort((a, b) => a.atMs - b.atMs);
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export interface TimedGlucose {
  atMs: number;
  mgDl: number;
}

/**
 * Lectura más cercana a `targetMs` dentro de la tolerancia, o `undefined`.
 * Recibe la serie ya ordenada y ya libre de sintéticas.
 *
 * Búsqueda binaria, no lineal: esto corre una vez por dosis y por horizonte
 * dentro de un `useMemo` síncrono mientras se renderiza la pantalla, y con
 * el rango de 90 días la serie ronda las 26.000 lecturas — recorrerla entera
 * cada vez bloquearía el hilo de JS al abrir el Resumen.
 */
export function readingNear(series: readonly TimedGlucose[], targetMs: number): TimedGlucose | undefined {
  const toleranceMs = HORIZON_TOLERANCE_MINUTES * 60_000;
  let low = 0;
  let high = series.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (series[mid]!.atMs < targetMs) low = mid + 1;
    else high = mid;
  }
  // `low` es el primer punto >= targetMs; el más cercano es ese o el previo.
  let best: TimedGlucose | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const index of [low - 1, low]) {
    const point = series[index];
    if (point === undefined) continue;
    const distance = Math.abs(point.atMs - targetMs);
    if (distance <= toleranceMs && distance < bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

export function buildNutritionInsights(input: NutritionInsightsInput): MealWindowInsight[] {
  const series = toGlucoseSeries(input.readings);

  return MEAL_TIME_WINDOWS.map((window) => {
    const inWindow = (timestamp: string): boolean => {
      const hour = localHour(timestamp);
      return hour >= window.startHour && hour < window.endHour;
    };

    const meals = input.meals.filter((meal) => inWindow(meal.timestamp));
    const windowCarbs = input.carbs.filter((carb) => inWindow(carb.timestamp));
    // Carbohidratos: los `CarbEvent` son la fuente principal — ahí queda todo
    // lo confirmado, incluido lo que confirma una comida (`writeMealWithEpisode`
    // en db.ts escribe un `CarbEvent` con `source:'meal_confirmed'` al MISMO
    // timestamp que el `MealEvent`, y el importador de MySugr hace lo mismo
    // con `source:'imported'`).
    //
    // Por eso una comida solo aporta su `confirmedCarbsG` cuando NO existe ya
    // un `CarbEvent` a su timestamp: sumar ambos contaría dos veces el mismo
    // plato, inflando el promedio y el `n` que se muestran en pantalla y se
    // imprimen en el reporte que va al control médico. Nunca `aiEstimatedCarbsG`.
    const carbTimestamps = new Set(windowCarbs.map((carb) => carb.timestamp));
    const carbValues = [
      ...windowCarbs.map((carb) => carb.carbsG),
      ...meals
        .filter((meal) => meal.confirmedCarbsG !== undefined && !carbTimestamps.has(meal.timestamp))
        .map((meal) => meal.confirmedCarbsG!),
    ];

    // Un macro ausente se omite; no se cuenta como 0. Ver la nota en
    // `MealWindowInsight`.
    const macroValues = (pick: (meal: MealEvent) => number | undefined): number[] =>
      meals.map(pick).filter((value): value is number => value !== undefined);
    const proteinValues = macroValues((meal) => meal.proteinG);
    const fatValues = macroValues((meal) => meal.fatG);
    const fiberValues = macroValues((meal) => meal.fiberG);

    const rapidDoses = input.insulin.filter((dose) => dose.type === 'rapid' && inWindow(dose.timestamp));
    const basalDoses = input.insulin.filter((dose) => dose.type === 'basal' && inWindow(dose.timestamp));

    // Ver la nota homónima en `macro-glucose.ts`: el bolo de una comida
    // anterior es el fondo normal de cualquier medición, no un confusor. Sin
    // esta exención, con comidas cada 4-5 h y una rápida de 5 h, la ventana
    // hacia atrás descartaba prácticamente todas las dosis y esta pantalla
    // quedaba vacía apenas la usuaria elegía su insulina.
    const mealBolusIds = input.meals
      .map((meal) => findRapidInsulinCandidates(meal.timestamp, input.insulin).recommendedId)
      .filter((id): id is string => id !== undefined);

    const outcomes: HorizonOutcome[] = RESPONSE_HORIZONS_HOURS.map((horizonHours) => {
      let sampleSize = 0;
      let confoundedCount = 0;
      let belowCount = 0;
      let inTargetCount = 0;
      let aboveCount = 0;
      for (const dose of rapidDoses) {
        // ── Se DECLARA, no se descarta (2026-08-25) ──────────────────────
        //
        // Acá la salida es un porcentaje, no un promedio, así que no se le
        // puede descontar la contribución de un confusor como hace
        // `macro-glucose.ts`. La alternativa honesta no es excluir —con
        // comidas cada 4-5 h eso vaciaba la pantalla— sino **contar aparte**
        // cuántas dosis tuvieron algo registrado en el medio y mostrarlo al
        // lado del porcentaje.
        //
        // Un "% en rango" acompañado de "de 12 dosis, 7 con eventos de por
        // medio" es información; el mismo número sin esa línea invita a leer
        // como patrón limpio lo que no lo es; y no mostrar nada no le sirve a
        // nadie. Verónica lo pidió textualmente: nada de obviar el dato que
        // no viene en formato fácil.
        const confounded = hasConfoundingEvent({
          anchorTimestamp: dose.timestamp,
          windowMinutes: horizonHours * 60,
          mealGraceMinutes: DOSE_OWN_MEAL_MINUTES,
          ignoreIds: [dose.id, ...mealBolusIds],
          insulin: input.insulin,
          carbs: input.carbs,
          meals: input.meals,
          ...(input.activity === undefined ? {} : { activity: input.activity }),
          ...(input.rapidLookbackMinutes === undefined ? {} : { lookbackMinutes: input.rapidLookbackMinutes }),
          ...(input.basalLookbackMinutes === undefined ? {} : { basalLookbackMinutes: input.basalLookbackMinutes }),
        });
        const targetMs = Date.parse(dose.timestamp) + horizonHours * 60 * 60_000;
        const point = readingNear(series, targetMs);
        // El conteo va DESPUÉS del `continue`, no antes (corregido
        // 2026-08-26 tras la revisión de seguridad). Contándolo antes, una
        // dosis sin lectura cerca —un hueco de sensor— sumaba al confusor
        // pero no a la muestra, y la franja terminaba declarando cosas como
        // "10 de 3 con eventos de por medio". Un número aritméticamente
        // imposible al lado de un porcentaje hace que un médico descarte la
        // tabla entera, con razón.
        if (point === undefined) continue;
        sampleSize += 1;
        if (confounded) confoundedCount += 1;
        if (point.mgDl < HYPOGLYCEMIA_THRESHOLD) belowCount += 1;
        else if (point.mgDl > HIGH_THRESHOLD) aboveCount += 1;
        else inTargetCount += 1;
      }
      const reportable = sampleSize >= MIN_SAMPLE_FOR_RATE;
      return {
        horizonHours,
        sampleSize,
        confoundedCount,
        inTargetPct: reportable ? (inTargetCount / sampleSize) * 100 : undefined,
        belowTargetPct: reportable ? (belowCount / sampleSize) * 100 : undefined,
        aboveTargetPct: reportable ? (aboveCount / sampleSize) * 100 : undefined,
      };
    });

    return {
      key: window.key,
      label: window.label,
      startHour: window.startHour,
      endHour: window.endHour,
      mealCount: meals.length,
      avgConfirmedCarbsG: mean(carbValues),
      confirmedCarbsSampleSize: carbValues.length,
      avgRapidUnits: mean(rapidDoses.map((dose) => dose.units)),
      rapidDoseCount: rapidDoses.length,
      avgBasalUnits: mean(basalDoses.map((dose) => dose.units)),
      basalDoseCount: basalDoses.length,
      avgProteinG: mean(proteinValues),
      proteinSampleSize: proteinValues.length,
      avgFatG: mean(fatValues),
      fatSampleSize: fatValues.length,
      avgFiberG: mean(fiberValues),
      fiberSampleSize: fiberValues.length,
      outcomes,
    };
  });
}

/** Franja horaria a la que pertenece un timestamp, para etiquetar un evento suelto. */
export function mealWindowForTimestamp(isoTimestamp: string): MealTimeWindow | undefined {
  return windowForHour(localHour(isoTimestamp));
}
