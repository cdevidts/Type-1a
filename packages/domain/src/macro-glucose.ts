import type { ActivityEvent, CarbEvent, CGMReading, InsulinEvent, MealEvent } from '@type1a/schemas';

import { collectEpisodeContext } from './episode-context';
import { findRapidInsulinCandidates } from './meal';
import { adjustForNuisance, fitOlsOnVaryingColumns } from './regression';
import { readingNear, toGlucoseSeries } from './nutrition-insights';

/**
 * Grasa + proteína de una comida frente a la glucosa **tardía** (Fase 14).
 *
 * ## Por qué existe
 *
 * Es la pieza que une las dos mitades de esta app. El conteo de carbohidratos
 * explica la subida temprana; la grasa y la proteína explican la tardía, y esa
 * parte hoy no se ve en ningún lado. La evidencia en diabetes tipo 1 es
 * consistente:
 *
 * - Una comida alta en grasa y/o proteína produce una subida **retrasada y
 *   prolongada**, aproximadamente entre 1,5 y 6 h después de comer.
 * - La grasa tiende a hacer pico cerca de las 2 h; la proteína cerca de las
 *   3,5 h y se sostiene hasta las 5 h.
 * - Cuando la comida es alta en ambas, el efecto es **aditivo**, con
 *   excursiones significativamente mayores entre las 3 y las 5 h que con
 *   comidas altas en solo uno de los dos.
 *
 * Por eso los horizontes de este módulo son 2/3/4/5 h y no 1/2/3 h como los de
 * `nutrition-insights.ts`, que miden la respuesta a una dosis rápida.
 *
 * ## Frontera de seguridad — la más estrecha del repo
 *
 * La respuesta que la literatura da a este patrón es **ajustar la insulina**
 * (bolos duales o extendidos). Eso es exactamente lo que `AGENTS.md` prohíbe
 * que la app calcule, infiera o recomiende, y este módulo es el lugar donde
 * sería más tentador hacerlo.
 *
 * Lo que este módulo hace: **describir lo que ya pasó** con los datos de la
 * propia usuaria, separando sus comidas en las de mayor y menor carga de
 * grasa+proteína y mostrando su glucosa a cada horizonte.
 *
 * Lo que **nunca** debe hacer, ni acá ni en la pantalla que lo dibuje:
 * proponer un bolo extendido, un porcentaje de dosis, un tiempo de espera,
 * ni sugerir comer menos grasa o proteína. Es material para conversar con el
 * equipo clínico, no una indicación.
 *
 * También se compara contra la glucosa **al momento de comer**, no en
 * absoluto: una excursión de +40 mg/dL dice algo; "180 mg/dL a las 3 h" sin
 * saber de dónde partió, no.
 */

export const FAT_PROTEIN_HORIZONS_HOURS = [2, 3, 4, 5] as const;

/**
 * Mínimo de comidas elegibles por grupo para publicar un promedio. Con menos,
 * el número es ruido y se presta a leer un patrón donde no lo hay — mismo
 * criterio que `MIN_SAMPLE_FOR_RATE` en `nutrition-insights.ts`.
 */
export const MIN_MEALS_PER_GROUP = 3;

/**
 * Observaciones mínimas (los dos grupos juntos) antes de intentar el ajuste
 * por covariables.
 *
 * Ocho para tres covariables más el intercepto. Por debajo, el ajuste
 * "explica" ruido y puede desplazar el promedio más de lo que lo corrige, así
 * que se muestra el crudo y se dice que no está ajustado. Nunca se muestra un
 * ajuste que no se sostiene.
 */
export const MIN_OBSERVATIONS_FOR_ADJUSTMENT = 8;

export interface MacroGlucosePoint {
  horizonHours: number;
  sampleSize: number;
  /**
   * Cambio promedio de glucosa desde el momento de comer, en mg/dL.
   *
   * **Ajustado por lo que se registró en el medio cuando `adjusted` es
   * `true`** (2026-08-25): a cada episodio se le descuenta la parte que el
   * modelo atribuye a los carbohidratos, la insulina y la actividad de esa
   * ventana, y después se promedia. Cuando no hay material para ajustar
   * honestamente, es el promedio crudo y `adjusted` es `false` — la pantalla
   * tiene que decirlo, no presentar los dos como si fueran lo mismo.
   */
  meanDeltaMgDl?: number | undefined;
  /** `true` si el promedio está ajustado por covariables. */
  adjusted: boolean;
  /**
   * Cuántos de los `sampleSize` episodios tuvieron algo registrado en el
   * medio. Se muestra para que un promedio ajustado no se lea como si viniera
   * de una ventana limpia.
   */
  confoundedCount: number;
}

export interface MacroGlucoseGroup {
  mealCount: number;
  /** Promedio de gramos de grasa + proteína de las comidas del grupo. */
  avgFatProteinG: number;
  points: MacroGlucosePoint[];
}

export interface MacroGlucoseComparison {
  /** Gramos de grasa+proteína que separan los dos grupos (la mediana). */
  splitAtFatProteinG: number;
  higher: MacroGlucoseGroup;
  lower: MacroGlucoseGroup;
  /** Comidas con grasa Y proteína anotadas; las demás no son comparables. */
  eligibleMealCount: number;
}

function median(sorted: readonly number[]): number {
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function mean(values: readonly number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

interface EligibleMeal {
  atMs: number;
  fatProteinG: number;
  /**
   * Cuánto de cada confusor se registró entre la comida y ese horizonte.
   *
   * **Magnitudes, no un sí/no** (2026-08-25). Antes esto era
   * `confoundedWithin(h): boolean` y la comida se descartaba entera. Con
   * comidas cada 4-5 h, a las 4 y 5 h no quedaba ni un episodio: la exclusión
   * no filtraba ruido, vaciaba la pantalla. Ahora la magnitud entra al modelo
   * como covariable y el episodio se conserva.
   */
  confoundersWithin: (horizonHours: number) => Confounders;
}

interface Confounders {
  /** Gramos de carbohidratos registrados en el medio (comida o colación). */
  carbsG: number;
  /** Unidades de rápida en el medio, sin contar el bolo de esta comida. */
  rapidUnits: number;
  /** Minutos de actividad física en el medio. */
  activityMinutes: number;
  /** Si hubo cualquiera de las tres. Solo para poder declararlo en pantalla. */
  any: boolean;
}

/** Una observación cruda de un episodio a un horizonte. */
interface Observation {
  deltaMgDl: number;
  /**
   * La carga de grasa+proteína de esa comida.
   *
   * Entra al modelo aunque NO sea un confusor, y esto es lo que hace que el
   * ajuste sea correcto en vez de contraproducente: si se ajusta por los
   * carbohidratos de la ventana **sin** tener en cuenta la carga de la
   * comida, el efecto de la grasa se filtra al coeficiente de los
   * carbohidratos (sesgo por variable omitida) y el "ajuste" termina
   * moviendo el promedio en la dirección equivocada. Se verificó con datos
   * sintéticos de verdad conocida: sin esta columna, el promedio a 5 h se
   * alejaba del valor real en vez de acercarse.
   *
   * Se incluye en el modelo pero **no** se descuenta: es el efecto que la
   * pantalla quiere mostrar, no ruido a quitar.
   */
  fatProteinG: number;
  confounders: Confounders;
}

function observationsAt(
  meals: readonly EligibleMeal[],
  series: readonly { atMs: number; mgDl: number }[],
  horizonHours: number,
): Observation[] {
  const out: Observation[] = [];
  for (const meal of meals) {
    const atMeal = readingNear(series, meal.atMs);
    const atHorizon = readingNear(series, meal.atMs + horizonHours * 60 * 60_000);
    // Lo único que sigue descartando un episodio es **no tener lecturas**.
    // Sin glucosa no hay observación; con glucosa "sucia" sí la hay, y se
    // ajusta.
    if (atMeal === undefined || atHorizon === undefined) continue;
    out.push({
      deltaMgDl: atHorizon.mgDl - atMeal.mgDl,
      fatProteinG: meal.fatProteinG,
      confounders: meal.confoundersWithin(horizonHours),
    });
  }
  return out;
}

/**
 * Compara las comidas de mayor y menor carga de grasa+proteína.
 *
 * Devuelve `null` cuando no hay material suficiente: menos de
 * `MIN_MEALS_PER_GROUP * 2` comidas con **ambos** macros anotados, o cuando
 * todas tienen la misma carga y no hay nada que comparar. Solo entran comidas
 * con grasa **y** proteína registradas: una comida a la que le falta uno de
 * los dos no tiene una carga comparable, y tratar el ausente como 0 la
 * mandaría al grupo equivocado.
 */
export function buildMacroGlucoseComparison(input: {
  meals: readonly MealEvent[];
  readings: readonly CGMReading[];
  /**
   * Lo demás que pudo mover la glucosa (Fase 23). Opcionales por
   * compatibilidad, pero **sin ellos la comparación no puede excluir
   * episodios confundidos** y vuelve a ser la versión que mezclaba una
   * colación con el efecto tardío de la grasa. Pásalos siempre que existan.
   */
  insulin?: readonly InsulinEvent[];
  carbs?: readonly CarbEvent[];
  activity?: readonly ActivityEvent[];
  /**
   * Cuánto mirar hacia atrás por dosis que siguen actuando, en minutos
   * (2026-08-25). Sale de la insulina que la usuaria eligió en Ajustes —
   * `rapidInsulinLookbackMinutes(profile)` en `insulin-catalog.ts`. Sin
   * elegir, `undefined`: no se mira hacia atrás y no se excluye por una
   * suposición.
   */
  rapidLookbackMinutes?: number | undefined;
  /** Ídem para la basal (24-42 h). Ver `insulin-catalog.ts`. */
  basalLookbackMinutes?: number | undefined;
}): MacroGlucoseComparison | null {
  // ── Los bolos de OTRAS comidas no son confusores ────────────────────────
  //
  // Corregido 2026-08-25 tras la revisión de seguridad. Con MDI, las comidas
  // van cada 4-5 h y una insulina rápida "dura" 5 h, así que mirando hacia
  // atrás **el bolo de la comida anterior cae casi siempre dentro de la
  // ventana**. Sin esta exención, elegir la insulina en Ajustes vaciaba la
  // pantalla de Patrones y las tablas del reporte médico de golpe, sin
  // ningún mensaje: pasaban de tener muestra a `n = 0`.
  //
  // Y conceptualmente la exención es lo correcto, no un parche para tener
  // datos: haber comido y boleado antes es **el fondo normal** de cualquier
  // medición en diabetes tipo 1, no una anomalía. Lo que sí contamina es una
  // dosis *no atribuible a una comida* —una corrección— que siga actuando.
  // Eso es justo lo que Verónica describió, y sigue excluyéndose.
  const otherMealBolusIds = input.meals
    .map((meal) => findRapidInsulinCandidates(meal.timestamp, input.insulin ?? []).recommendedId)
    .filter((id): id is string => id !== undefined);

  const eligible: EligibleMeal[] = input.meals
    .filter((meal) => meal.fatG !== undefined && meal.proteinG !== undefined)
    .map((meal) => {
      // El bolo de esta misma comida no es un confusor. Se reusa la
      // definición que ya existe de "esta dosis es de esta comida"
      // (`findRapidInsulinCandidates`, ventana -90/+60) en vez de inventar
      // una segunda: si divergieran, una comida podría contarse limpia acá y
      // asociada allá.
      //
      // **`recommendedId`, no `candidateIds`** (corregido 2026-08-22 tras la
      // revisión de seguridad). Una comida tiene UN bolo; `candidateIds`
      // devuelve *todas* las dosis rápidas de la ventana — por eso el propio
      // `findRapidInsulinCandidates` marca `requiresConfirmation` cuando hay
      // más de una. Ignorarlas todas hacía que una corrección real 40 min
      // después de comer se tratara como "el bolo de la comida" y no
      // confundiera nada, subestimando justo la subida tardía que esta
      // comparación existe para describir. `episodes.ts` ya ignoraba solo el
      // `rapidInsulinEventId` confirmado; ahora las dos coinciden.
      const own = findRapidInsulinCandidates(meal.timestamp, input.insulin ?? []);
      const ownIds = [meal.id, ...otherMealBolusIds, ...(own.recommendedId === undefined ? [] : [own.recommendedId])];
      return {
        atMs: Date.parse(meal.timestamp),
        fatProteinG: meal.fatG! + meal.proteinG!,
        confoundersWithin: (horizonHours: number): Confounders => {
          const events = collectEpisodeContext({
            anchorTimestamp: meal.timestamp,
            windowMinutes: horizonHours * 60,
            ignoreIds: ownIds,
            ...(input.insulin === undefined ? {} : { insulin: input.insulin }),
            ...(input.carbs === undefined ? {} : { carbs: input.carbs }),
            ...(input.activity === undefined ? {} : { activity: input.activity }),
            ...(input.rapidLookbackMinutes === undefined ? {} : { lookbackMinutes: input.rapidLookbackMinutes }),
            ...(input.basalLookbackMinutes === undefined ? {} : { basalLookbackMinutes: input.basalLookbackMinutes }),
            meals: input.meals,
          });
          let carbsG = 0;
          let rapidUnits = 0;
          let activityMinutes = 0;
          for (const event of events) {
            // Una nota no mueve la glucosa: no es covariable de nada.
            if (event.kind === 'carbs' || event.kind === 'meal') carbsG += event.amount ?? 0;
            else if (event.kind === 'rapid_insulin') rapidUnits += event.amount ?? 0;
            else if (event.kind === 'activity') activityMinutes += event.amount ?? 0;
          }
          const any = carbsG > 0 || rapidUnits > 0 || activityMinutes > 0;
          return { carbsG, rapidUnits, activityMinutes, any };
        },
      };
    })
    .filter((meal) => Number.isFinite(meal.atMs));

  if (eligible.length < MIN_MEALS_PER_GROUP * 2) return null;

  const sortedLoads = [...eligible.map((meal) => meal.fatProteinG)].sort((a, b) => a - b);
  const splitAtFatProteinG = median(sortedLoads);

  const higherMeals = eligible.filter((meal) => meal.fatProteinG > splitAtFatProteinG);
  const lowerMeals = eligible.filter((meal) => meal.fatProteinG <= splitAtFatProteinG);
  // Si toda la muestra tiene la misma carga, `higher` queda vacío y no hay
  // comparación posible — devolver dos grupos donde uno está vacío invitaría
  // a leer una diferencia inexistente.
  if (higherMeals.length < MIN_MEALS_PER_GROUP || lowerMeals.length < MIN_MEALS_PER_GROUP) return null;

  const series = toGlucoseSeries(input.readings);

  // ── Ajuste por covariables, horizonte por horizonte ─────────────────────
  //
  // El modelo se ajusta sobre **los dos grupos juntos**, no uno por grupo: el
  // efecto de 20 g de carbohidratos de más sobre la glucosa a las 3 h es el
  // mismo haya sido la comida alta o baja en grasa, y estimarlo dos veces con
  // la mitad de los datos solo agrega ruido. Después se descuenta ese aporte
  // de cada episodio y recién ahí se separa por grupo.
  const higher = { ...emptyGroup(higherMeals), points: [] as MacroGlucosePoint[] };
  const lower = { ...emptyGroup(lowerMeals), points: [] as MacroGlucosePoint[] };

  for (const horizonHours of FAT_PROTEIN_HORIZONS_HOURS) {
    const higherObs = observationsAt(higherMeals, series, horizonHours);
    const lowerObs = observationsAt(lowerMeals, series, horizonHours);
    const all = [...higherObs, ...lowerObs];

    // Columna 0 = el predictor de interés (no se descuenta); 1..3 = los
    // confusores (sí se descuentan). Ver la nota de `Observation.fatProteinG`
    // para por qué el de interés tiene que estar en el modelo igual.
    const predictors = all.map((observation) => [
      observation.fatProteinG,
      observation.confounders.carbsG,
      observation.confounders.rapidUnits,
      observation.confounders.activityMinutes,
    ]);
    const NUISANCE_COLUMNS = [1, 2, 3];
    // `MIN_OBSERVATIONS_FOR_ADJUSTMENT` es el piso para que el ajuste
    // signifique algo; `fitOls` devuelve `null` además cuando una covariable
    // es constante (nadie registró actividad, por ejemplo) o el sistema queda
    // mal condicionado. En cualquiera de esos casos se cae al promedio crudo
    // y `adjusted` queda en `false`, que la pantalla declara.
    const deltas = all.map((observation) => observation.deltaMgDl);
    // `fitOlsOnVaryingColumns` y no `fitOls`: basta que una covariable no
    // varíe —y la actividad física casi nunca varía, porque poca gente la
    // registra— para que el sistema quede singular y el ajuste no se aplique
    // NUNCA. Descartando esa columna se ajusta con las que sí tienen
    // información. Encontrado con un chequeo sobre datos realistas.
    const fitted = fitOlsOnVaryingColumns(deltas, predictors, MIN_OBSERVATIONS_FOR_ADJUSTMENT);
    const adjustedAll = fitted === null
      ? deltas
      : adjustForNuisance(
        deltas,
        // `adjustForNuisance` indexa contra las columnas que efectivamente
        // entraron al modelo, no contra las cuatro originales.
        predictors.map((row) => fitted.columns.map((column) => row[column]!)),
        // Y solo se descuentan las que son confusor: la carga de
        // grasa+proteína está en el modelo para no sesgar los coeficientes,
        // pero descontarla borraría justo lo que se quiere mostrar.
        fitted.columns
          .map((column, index) => (NUISANCE_COLUMNS.includes(column) ? index : -1))
          .filter((index) => index >= 0),
        fitted.fit,
      );
    const fit = fitted === null ? null : fitted.fit;

    higher.points.push(pointFor(horizonHours, higherObs, adjustedAll.slice(0, higherObs.length), fit !== null));
    lower.points.push(pointFor(horizonHours, lowerObs, adjustedAll.slice(higherObs.length), fit !== null));
  }

  return { splitAtFatProteinG, higher, lower, eligibleMealCount: eligible.length };
}

function emptyGroup(meals: readonly EligibleMeal[]): Omit<MacroGlucoseGroup, 'points'> {
  return {
    mealCount: meals.length,
    avgFatProteinG: mean(meals.map((meal) => meal.fatProteinG)) ?? 0,
  };
}

function pointFor(
  horizonHours: number,
  observations: readonly Observation[],
  adjustedDeltas: readonly number[],
  adjusted: boolean,
): MacroGlucosePoint {
  const reportable = observations.length >= MIN_MEALS_PER_GROUP;
  return {
    horizonHours,
    sampleSize: observations.length,
    confoundedCount: observations.filter((observation) => observation.confounders.any).length,
    adjusted: adjusted && reportable,
    meanDeltaMgDl: reportable ? mean(adjustedDeltas) : undefined,
  };
}
