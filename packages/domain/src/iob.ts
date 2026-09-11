import type { InsulinEvent } from '@type1a/schemas';

import { findCatalogInsulin, isPlausibleInsulinDuration } from './insulin-catalog';
import { durationHoursAt, type DaySegmentKey } from './insulin-duration';

/**
 * Insulina activa (IOB): cuánta de la insulina rápida ya inyectada **sigue
 * actuando** en este momento.
 *
 * ## Por qué existe, cuando `AGENTS.md` lo prohibía
 *
 * Lo prohibía, y se levantó a propósito el 2026-09-02 — ver `docs/adr/0005`.
 * La razón no fue querer más funciones: fue que **no tenerlo era el riesgo
 * mayor**. Sin IOB, registrar una comida chica con corrección y otra comida
 * cinco minutos después producía **dos correcciones completas** por la misma
 * glucosa alta, porque la segunda no sabía nada de la primera. Eso es
 * *stacking*, y la app lo estaba proponiendo con toda confianza.
 *
 * Las condiciones bajo las que se permite están escritas en `AGENTS.md` y se
 * respetan acá:
 *
 * 1. **Modelo publicado y citado**, no uno inventado (ver abajo).
 * 2. **Parámetros de la usuaria**: la duración sale de lo que ella configuró
 *    en Ajustes → Terapia, nunca de un default silencioso.
 * 3. **Sin configuración no hay IOB.** Esta función devuelve `undefined`, no
 *    cero: "no lo sé" y "no queda nada actuando" son afirmaciones opuestas, y
 *    confundirlas restaría 0 U con cara de certeza.
 * 4. **Nunca dosifica sola.** Devuelve unidades; quien calcula una dosis las
 *    resta *solo de la parte de corrección* y muestra el desglose entero.
 *
 * ## El modelo
 *
 * Curva exponencial de LoopKit/OpenAPS, el estándar de facto en los sistemas
 * de código abierto (Loop, AndroidAPS, OpenAPS). Se eligió sobre la lineal
 * —"resta un cuarto por hora"— porque la insulina no se agota a ritmo
 * constante: casi no baja los primeros minutos, cae rápido alrededor del
 * pico, y arrastra una cola larga. Una recta sobreestima lo activo temprano y
 * lo subestima tarde, que es justo al revés de lo que conviene.
 *
 * Con `td` = duración y `tp` = tiempo al pico:
 *
 * ```
 * τ = tp·(1 − tp/td) / (1 − 2·tp/td)
 * a = 2τ/td
 * S = 1 / (1 − a + (1+a)·e^(−td/τ))
 * restante(t) = 1 − S·(1−a)·((t²/(τ·td·(1−a)) − t/τ − 1)·e^(−t/τ) + 1)
 * ```
 *
 * Fuente: Dragan Maksimović, vía LoopKit; documentado en OpenAPS
 * ("Understanding Insulin on Board Calculations"). Ver
 * `memory-bank/reference/clinical-sources.md`.
 *
 * ## Lo que este módulo NO hace
 *
 * No estima sensibilidad, no propone un factor de corrección, no decide una
 * dosis y no toca la basal — una basal plana de 24-42 h no es "insulina
 * activa" en el sentido de esta cuenta, y restarla de un bolo sería un error
 * grave. Solo entra la **rápida**.
 */

/** Tiempo al pico de actividad, en minutos, por insulina del catálogo. */
export interface InsulinActionModel {
  /** Duración total de acción, en minutos. */
  durationMinutes: number;
  /** Minutos hasta el pico de actividad. */
  peakMinutes: number;
}

/**
 * Pico por insulina, en minutos. Son los presets de Loop/OpenAPS, que a su vez
 * salen de la ficha técnica de cada familia:
 *
 * - Análogas rápidas clásicas (aspart, lispro, glulisina): **75 min**.
 * - Aceleradas (Fiasp, Lyumjev): **55 min** — entran antes, mismo `td`.
 * - Humana regular: **150 min**, mucho más lenta.
 *
 * El pico **no** es configurable por ahora, a diferencia de la duración: es
 * una propiedad de la molécula bastante estable entre personas, mientras que
 * la duración sí varía y por eso ella la puede sobrescribir.
 */
const PEAK_MINUTES_BY_INSULIN: Readonly<Record<string, number>> = {
  novorapid: 75,
  humalog: 75,
  apidra: 75,
  fiasp: 55,
  lyumjev: 55,
  regular: 150,
};

/** El pico por defecto de una análoga rápida, si el id no está en la tabla. */
const DEFAULT_RAPID_PEAK_MINUTES = 75;

/**
 * El modelo de acción de la insulina rápida que la usuaria configuró.
 *
 * `undefined` cuando no eligió insulina **ni** escribió una duración: sin eso
 * no hay curva, y no se inventa una. Es la misma regla que ya gobierna
 * `rapidInsulinLookbackMinutes`.
 *
 * La duración escrita a mano gana sobre la del catálogo: es la que le dio su
 * equipo clínico, o la que ella observó.
 */
export function rapidInsulinActionModel(
  profile: {
    rapidInsulinId?: string | undefined;
    rapidInsulinDurationHours?: number | undefined;
    /** Overrides por tramo que ella fijó. Ver `insulin-duration.ts`. */
    segmentDurationHours?: { [K in DaySegmentKey]?: number | undefined } | undefined;
  },
  /**
   * Cuándo se calcula, para elegir el tramo. Omitido = ahora.
   *
   * Existe porque la duración puede ser distinta a las 8 de la mañana que a
   * las 3 de la tarde, y la dosis que se propone tiene que usar la del
   * momento en que se está dosificando, no un promedio del día.
   */
  at: string = new Date().toISOString(),
): InsulinActionModel | undefined {
  const catalogEntry = findCatalogInsulin(profile.rapidInsulinId);
  const rapidEntry = catalogEntry?.category === 'rapid' ? catalogEntry : undefined;
  const configured = durationHoursAt(at, profile);
  const hours = configured ?? rapidEntry?.durationHours;
  if (hours === undefined || !isPlausibleInsulinDuration(hours)) return undefined;

  const durationMinutes = Math.round(hours * 60);
  const peak = rapidEntry === undefined
    ? DEFAULT_RAPID_PEAK_MINUTES
    : (PEAK_MINUTES_BY_INSULIN[rapidEntry.id] ?? DEFAULT_RAPID_PEAK_MINUTES);

  // El modelo exponencial exige tp < td/2; si alguien configura una duración
  // muy corta (el piso son 60 min) el pico tiene que caber debajo. Se acota
  // en vez de devolver NaN, y el techo del 40 % deja la curva bien formada.
  const peakMinutes = Math.min(peak, Math.floor(durationMinutes * 0.4));
  if (peakMinutes <= 0) return undefined;
  return { durationMinutes, peakMinutes };
}

/**
 * Qué fracción de una dosis **sigue actuando** `minutes` después de ponerla.
 *
 * Devuelve 1 en el instante de la dosis y 0 al cumplirse la duración. Entre
 * medio, la curva exponencial de arriba.
 */
export function fractionRemaining(minutes: number, model: InsulinActionModel): number {
  const td = model.durationMinutes;
  const tp = model.peakMinutes;
  if (!Number.isFinite(minutes)) throw new Error('Minutes must be finite.');
  if (minutes <= 0) return 1;
  if (minutes >= td) return 0;

  const tau = (tp * (1 - tp / td)) / (1 - (2 * tp) / td);
  const a = (2 * tau) / td;
  const s = 1 / (1 - a + (1 + a) * Math.exp(-td / tau));
  const remaining = 1 - s * (1 - a) * (
    ((minutes * minutes) / (tau * td * (1 - a)) - minutes / tau - 1) * Math.exp(-minutes / tau) + 1
  );
  // Acotado a [0, 1]: la fórmula es continua y bien comportada dentro del
  // rango, pero un redondeo de punto flotante en los extremos no puede
  // producir una fracción negativa que después *sume* insulina a una dosis.
  return Math.min(1, Math.max(0, remaining));
}

/** Una dosis ya puesta, con lo mínimo para saber cuánta sigue actuando. */
export interface ActiveInsulinDose {
  timestamp: string;
  units: number;
}

export interface ActiveInsulinResult {
  /** Unidades que siguen actuando, redondeadas a 2 decimales. */
  units: number;
  /** Cuántas dosis aportan algo. Se muestra: un total sin su n no se audita. */
  doseCount: number;
  /** La dosis que más aporta, para poder decir "de tu bolo de las 14:30". */
  latestContributingAt: string | undefined;
}

/**
 * Cuánta insulina rápida sigue actuando en el instante `at`.
 *
 * Suma la contribución de cada dosis por separado — no promedia ni toma solo
 * la última: dos bolos seguidos dejan más activo que uno, y ese es justamente
 * el caso que este módulo viene a resolver.
 *
 * **Solo entra la rápida.** El filtro por `type` va acá y no en quien llama,
 * porque olvidarlo sumaría una basal de 24 h a un bolo de comida.
 *
 * Una dosis con hora futura se ignora en vez de contarse entera: un registro
 * con la hora mal tecleada no puede inflar el activo y reducir la dosis que
 * la app propone.
 */
export function activeInsulinUnits(
  doses: readonly Pick<InsulinEvent, 'type' | 'timestamp' | 'units'>[],
  at: string,
  model: InsulinActionModel,
): ActiveInsulinResult {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) throw new Error('Invalid reference timestamp.');

  let units = 0;
  let doseCount = 0;
  let latestContributingAt: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;

  for (const dose of doses) {
    if (dose.type !== 'rapid') continue;
    const doseMs = Date.parse(dose.timestamp);
    if (!Number.isFinite(doseMs) || doseMs > atMs) continue;
    if (!Number.isFinite(dose.units) || dose.units <= 0) continue;

    const remaining = fractionRemaining((atMs - doseMs) / 60_000, model) * dose.units;
    if (remaining <= 0) continue;
    units += remaining;
    doseCount += 1;
    if (doseMs > latestMs) { latestMs = doseMs; latestContributingAt = dose.timestamp; }
  }

  return {
    units: Number(units.toFixed(2)),
    doseCount,
    ...(latestContributingAt === undefined ? {} : { latestContributingAt }),
  } as ActiveInsulinResult;
}
