import type { InsulinEvent } from '@type1a/schemas';

/**
 * La dosis reciente que fue **solo de comida**, si la hay.
 *
 * ## Por qué existe
 *
 * Verónica: *"solo me había pinchado 6 hasta ahí, y era solo por la comida. No
 * había NADA que descontar."* Tenía razón sobre el hecho. Lo que le pasó fue
 * que su glucosa no alcanzó a cargar, calculó el bolo **solo por los
 * carbohidratos**, y al abrir la corrección un minuto después esas 6 U
 * aparecieron como insulina activa y la corrección salió 0 U.
 *
 * Con la glucosa cargada, **un solo cálculo** habría dado 8 U (6 de comida +
 * 2,37 de corrección). El error no fue la resta: fue quedar partido en dos
 * actos lo que era uno.
 *
 * ## Lo que esto NO cambia
 *
 * `docs/adr/0006` sigue en pie: la insulina de comida cuenta como activa. Ella
 * eligió mantenerlo —contarla de más da una corrección menor, reevaluable en
 * una hora; no contarla da una de más, y eso se descubre en una hipoglucemia—.
 * Lo que se agrega es reconocer el caso y **ofrecerle sumar la corrección a esa
 * misma dosis** en vez de restársela: sumar a una dosis que aún no terminó de
 * definirse no es apilar, es completar el mismo acto.
 *
 * ## Qué cuenta como "solo de comida"
 *
 * El desglose está guardado por dosis (`mealUnits` / `correctionUnits`).
 * **Ausente significa "no se sabe", nunca cero**, así que una dosis escrita a
 * mano o importada no califica: sin desglose no se puede afirmar que no traía
 * corrección.
 */
export interface MealOnlyDose {
  readonly event: InsulinEvent;
  readonly minutesAgo: number;
}

/**
 * Cuánto puede haber pasado y seguir siendo "el mismo acto".
 *
 * Veinte minutos es lo que tarda buscar la glucosa, sacar la foto o que el
 * sensor se ponga al día. Más allá de eso ya son dos decisiones distintas, y
 * sumarle unidades a una dosis vieja sería reescribir el pasado.
 */
export const SAME_ACT_WINDOW_MINUTES = 20;

export function recentMealOnlyDose(
  doses: readonly InsulinEvent[],
  nowIso: string,
  withinMinutes: number = SAME_ACT_WINDOW_MINUTES,
): MealOnlyDose | null {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) return null;

  let best: MealOnlyDose | null = null;
  for (const event of doses) {
    if (event.type !== 'rapid') continue;
    // Sin desglose no se sabe si traía corrección: no se afirma que no.
    if (event.mealUnits === undefined || event.correctionUnits === undefined) continue;
    // Con corrección adentro, la resta del ADR 0006 es la correcta y no hay
    // nada que ofrecer.
    if (event.correctionUnits > 0) continue;
    if (event.mealUnits <= 0) continue;

    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at)) continue;
    const minutesAgo = (now - at) / 60_000;
    if (minutesAgo < 0 || minutesAgo > withinMinutes) continue;

    if (best === null || minutesAgo < best.minutesAgo) {
      best = { event, minutesAgo: Math.round(minutesAgo) };
    }
  }
  return best;
}

/**
 * La insulina activa que sí corresponde descontar al **sumar** a esa dosis.
 *
 * Se excluye la dosis que se está por completar: restarla de la corrección que
 * se le va a sumar sería contarla dos veces. Todo lo demás sigue contando.
 */
export function dosesExcluding(
  doses: readonly InsulinEvent[],
  excludeId: string,
): readonly InsulinEvent[] {
  return doses.filter((event) => event.id !== excludeId);
}
