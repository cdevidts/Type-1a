import type {
  ActivityEvent,
  CarbEvent,
  EpisodeContextEvent,
  InsulinEvent,
  MealEvent,
  NoteEvent,
} from '@type1a/schemas';

/**
 * Qué más pasó mientras un episodio post-comida estaba siendo medido
 * (Fase 23).
 *
 * ## Por qué existe
 *
 * Un episodio mide la glucosa desde una comida hasta 3-4 h después, y hasta
 * ahora solo sabía de **una** cosa además de la comida: el bolo asociado
 * (`rapidInsulin`). Todo lo demás que pasara en esas horas —una corrección a
 * los 90 min, una colación a las 2 h, una caminata— era invisible.
 *
 * Eso rompe dos cosas distintas, y por eso este módulo tiene dos funciones:
 *
 * 1. **La descripción queda incompleta.** El insight post-comida puede decir
 *    "la glucosa bajó a las 3 h" sin saber que hubo una corrección de por
 *    medio. `collectEpisodeContext` lo resuelve.
 * 2. **Las correlaciones quedan contaminadas, que es lo grave.**
 *    `buildMacroGlucoseComparison` promedia la glucosa a 2/3/4/5 h para
 *    describir la subida tardía de grasa y proteína. Si a las 2 h se comió
 *    otra cosa, la subida a las 3 h puede ser de esa colación y no del efecto
 *    tardío que se está midiendo — y hoy entraría al promedio igual, sin que
 *    nadie lo sepa. `hasConfoundingEvent` lo resuelve.
 *
 * Vive en `packages/domain` porque es un cálculo que decide qué entra a un
 * promedio que la usuaria lee como patrón: puro, determinístico y con test,
 * como pide `AGENTS.md`.
 */

/**
 * Ventana después del ancla dentro de la cual un evento se considera **parte
 * del mismo acto**, no algo que pasó después.
 *
 * Al registrar una comida se escriben varias filas casi simultáneas: el
 * `MealEvent`, su `CarbEvent` espejo (`writeMealWithEpisode` usa el mismo
 * timestamp), el bolo, y a veces una nota. Sin esta gracia, la comida se
 * contaría a sí misma como su propio confusor y **ningún** episodio sería
 * limpio jamás.
 *
 * 15 minutos es deliberadamente corto: cubre "registré la comida y después
 * anoté la dosis" sin llegar a tapar una corrección real, que se da cuando la
 * glucosa ya se movió — bastante más tarde.
 */
export const EPISODE_GRACE_MINUTES = 15;

/**
 * Las clases a las que —y **solo** a las que— se les puede aplicar una gracia
 * larga (`mealGraceMinutes`).
 *
 * La distinción es una frontera de seguridad, no una optimización. Cuando el
 * ancla es una **dosis**, "su comida" puede haberse registrado hasta una hora
 * después (pre-bolear es práctica estándar), así que comida y carbohidratos
 * necesitan una gracia ancha para no marcar como confundida toda dosis bien
 * pre-boleada. Pero **una segunda dosis, o una caminata, dentro de esa misma
 * hora NO son "parte del acto": son exactamente el confusor que se está
 * buscando.** Aplicarles la gracia larga las volvía invisibles — que es el
 * bug que la revisión de seguridad encontró el 2026-08-22: con
 * `graceMinutes = 60` y horizonte de 1 h la ventana quedaba vacía y ningún
 * episodio podía marcarse confundido a esa hora.
 */
const MEAL_KINDS: ReadonlySet<EpisodeContextEvent['kind']> = new Set(['meal', 'carbs']);

/** Las clases a las que aplica `lookbackMinutes` (mirar hacia atrás). */
const INSULIN_KINDS: ReadonlySet<EpisodeContextEvent['kind']> = new Set([
  'rapid_insulin',
  'basal_insulin',
]);

/**
 * Qué clase de evento puede **confundir** una correlación, y cuál es solo
 * contexto.
 *
 * Una nota no mueve la glucosa: es texto que la usuaria escribió. Por eso
 * aparece en el contexto descriptivo pero **no** invalida un promedio —
 * excluir episodios por haber escrito una nota tiraría datos buenos a la
 * basura. La actividad física sí mueve la glucosa, y fuerte, así que sí
 * confunde.
 */
const CONFOUNDING_KINDS: ReadonlySet<EpisodeContextEvent['kind']> = new Set([
  'rapid_insulin',
  'basal_insulin',
  'carbs',
  'meal',
  'activity',
]);

export interface EpisodeContextInput {
  /** Comida (o dosis) desde la que se mide. */
  anchorTimestamp: string;
  /** Cuánto dura la ventana medida, en minutos desde el ancla. */
  windowMinutes: number;
  /**
   * Gracia base, aplicada a **todas** las clases. Cubre las filas espejo que
   * se escriben al guardar (comparten timestamp con el ancla).
   */
  graceMinutes?: number;
  /**
   * Gracia ampliada, aplicada **solo** a `meal`/`carbs` (ver `MEAL_KINDS`).
   * La usa `nutrition-insights` cuando el ancla es una dosis y la comida de
   * esa dosis puede haberse registrado después. Nunca se aplica a insulina
   * ni a actividad.
   */
  mealGraceMinutes?: number;
  /**
   * Cuánto mirar **hacia atrás** para la insulina, en minutos.
   *
   * Sale de la duración de la insulina que la usuaria eligió en Ajustes
   * (`rapidInsulinLookbackMinutes` en `insulin-catalog.ts`), nunca de una
   * suposición de la app. `undefined` = no mirar hacia atrás, que es el
   * comportamiento correcto mientras no haya elegido: sin dato no se excluye
   * por una suposición que nadie confirmó.
   *
   * Solo aplica a insulina. Para comida, carbohidratos y actividad no hay un
   * número de ficha técnica equivalente, así que no se inventa uno.
   */
  lookbackMinutes?: number;
  insulin?: readonly InsulinEvent[];
  carbs?: readonly CarbEvent[];
  meals?: readonly MealEvent[];
  activity?: readonly ActivityEvent[];
  notes?: readonly NoteEvent[];
  /**
   * Filas que son del propio episodio y no deben contarse como algo
   * adicional — típicamente el bolo ya asociado (`rapidInsulinEventId`) y el
   * `MealEvent` ancla. La gracia de arriba cubre el caso común; esto cubre el
   * caso en que el bolo se registró bastante antes de comer, que es normal.
   */
  ignoreIds?: readonly string[];
}

interface Candidate {
  kind: EpisodeContextEvent['kind'];
  id: string;
  timestamp: string;
  amount?: number | undefined;
}

function candidatesFrom(input: EpisodeContextInput): Candidate[] {
  const candidates: Candidate[] = [];
  for (const event of input.insulin ?? []) {
    candidates.push({
      kind: event.type === 'rapid' ? 'rapid_insulin' : 'basal_insulin',
      id: event.id,
      timestamp: event.timestamp,
      amount: event.units,
    });
  }
  // Guardar una comida escribe **dos filas del mismo hecho**: el `MealEvent`
  // y un `CarbEvent` espejo con el mismo timestamp (`writeMealWithEpisode`).
  // Contar las dos mostraría "Otra comida 30 g" y "Carbohidratos 30 g" para
  // un solo plato, y le mandaría 60 g al modelo donde se comieron 30.
  // `buildNutritionInsights` ya de-duplica por timestamp exactamente por esto.
  const mealTimestamps = new Set((input.meals ?? []).map((event) => event.timestamp));
  for (const event of input.carbs ?? []) {
    if (mealTimestamps.has(event.timestamp)) continue;
    candidates.push({ kind: 'carbs', id: event.id, timestamp: event.timestamp, amount: event.carbsG });
  }
  for (const event of input.meals ?? []) {
    candidates.push({
      kind: 'meal',
      id: event.id,
      timestamp: event.timestamp,
      amount: event.confirmedCarbsG,
    });
  }
  for (const event of input.activity ?? []) {
    candidates.push({
      kind: 'activity',
      id: event.id,
      timestamp: event.timestamp,
      amount: event.durationMinutes,
    });
  }
  // Las notas entran como contexto y nunca como confusor — ver
  // `CONFOUNDING_KINDS`. **El texto de la nota no se copia a propósito**: este
  // objeto viaja al servicio de IA dentro de `MealEpisodeMetrics`, y el texto
  // libre de una nota es justo la clase de dato personal que `AGENTS.md`
  // manda no enviar afuera ("send the minimum necessary data"). Que el tipo
  // no tenga dónde ponerlo es la frontera; no una promesa de no hacerlo.
  for (const event of input.notes ?? []) {
    candidates.push({ kind: 'note', id: event.id, timestamp: event.timestamp });
  }
  return candidates;
}

/**
 * Todo lo registrado dentro de la ventana, después de la gracia, ordenado
 * cronológicamente. Descriptivo: no evalúa ni pondera nada.
 */
export function collectEpisodeContext(input: EpisodeContextInput): EpisodeContextEvent[] {
  const anchorMs = Date.parse(input.anchorTimestamp);
  if (!Number.isFinite(anchorMs)) return [];
  const baseGraceMs = (input.graceMinutes ?? EPISODE_GRACE_MINUTES) * 60_000;
  const mealGraceMs = input.mealGraceMinutes === undefined
    ? baseGraceMs
    : input.mealGraceMinutes * 60_000;
  const windowEndMs = anchorMs + input.windowMinutes * 60_000;
  const lookbackMs = input.lookbackMinutes === undefined || input.lookbackMinutes <= 0
    ? undefined
    : input.lookbackMinutes * 60_000;
  const ignore = new Set(input.ignoreIds ?? []);

  return candidatesFrom(input)
    .filter((candidate) => !ignore.has(candidate.id))
    .map((candidate) => ({ candidate, atMs: Date.parse(candidate.timestamp) }))
    .filter(({ candidate, atMs }) => {
      if (!Number.isFinite(atMs)) return false;
      // Hacia atrás, solo insulina y solo si la usuaria configuró su
      // duración. Una dosis que empezó antes del ancla y sigue actuando
      // contamina la curva igual que una posterior — era la limitación
      // conocida de la Fase 23, y se cierra con un dato elegido, no supuesto.
      if (atMs < anchorMs) {
        if (lookbackMs === undefined) return false;
        if (!INSULIN_KINDS.has(candidate.kind)) return false;
        return atMs >= anchorMs - lookbackMs;
      }
      const graceMs = MEAL_KINDS.has(candidate.kind) ? mealGraceMs : baseGraceMs;
      return atMs > anchorMs + graceMs && atMs <= windowEndMs;
    })
    .sort((a, b) => a.atMs - b.atMs)
    .map(({ candidate, atMs }) => ({
      kind: candidate.kind,
      timestamp: candidate.timestamp,
      minutesAfterAnchor: Math.round((atMs - anchorMs) / 60_000),
      ...(candidate.amount === undefined ? {} : { amount: candidate.amount }),
    }));
}

/**
 * ¿Pasó algo dentro de la ventana que haga que la glucosa al final ya no
 * describa solo al evento ancla?
 *
 * Es la pregunta que decide si una comida entra o no al promedio de una
 * correlación. Barata a propósito: corta en el primer hallazgo, porque se
 * llama una vez por comida y por horizonte.
 */
/**
 * **Hacia atrás solo con `lookbackMinutes`, y solo para insulina.**
 *
 * Una dosis anterior al ancla que todavía está actuando contamina la curva
 * igual que una posterior. Esto era la limitación conocida de la Fase 23 y se
 * cerró el 2026-08-25: la ventana hacia atrás sale de **la insulina que la
 * usuaria eligió en Ajustes** y su duración de ficha técnica
 * (`insulin-catalog.ts`), no de una suposición de la app — que es lo que
 * `AGENTS.md` prohíbe al decir "never infer therapy parameters".
 *
 * Mientras no haya elegido, `lookbackMinutes` es `undefined` y no se mira
 * hacia atrás: sin dato es preferible no excluir a excluir por una
 * suposición. Comida, carbohidratos y actividad siguen contando solo hacia
 * adelante, porque para ellos no hay un número de ficha técnica equivalente.
 */
export function hasConfoundingEvent(input: EpisodeContextInput): boolean {
  return collectEpisodeContext(input).some((event) => CONFOUNDING_KINDS.has(event.kind));
}
