import type { MealEpisodeMetrics } from '@type1a/schemas';

/**
 * La hora que el resumen post-comida tiene derecho a citar.
 *
 * ## El bug que arregla
 *
 * Todo lo que la app guarda es un **instante en UTC**
 * (`new Date().toISOString()`), y las pantallas lo formatean en la zona del
 * teléfono: por eso el timeline siempre mostró la hora correcta. Pero las
 * métricas del episodio viajan al servicio de IA tal cual, en JSON, y el
 * modelo no tiene forma de saber en qué zona vive quien las registró. Recibía
 * `2026-09-01T21:30:00.000Z` y escribía "el episodio empezó a las 21:30",
 * cuando en Chile (UTC−4) eran las 17:30.
 *
 * No era un error de formato: era el resumen contradiciendo al timeline sobre
 * el mismo hecho, y la hora de una comida es justo lo que se mira para
 * entender una curva.
 *
 * ## El arreglo
 *
 * Antes de mandar las métricas afuera, cada marca de tiempo se reescribe con
 * el **desfase local explícito** — `2026-09-01T17:30:00.000-04:00` — sin
 * mover el instante. Así la hora de pared que el modelo lee es la misma que
 * el timeline dibuja, y no queda ninguna conversión que pueda equivocarse.
 * El prompt además le prohíbe convertir a otra zona.
 *
 * ## Por qué el desfase se pide y no se lee
 *
 * `packages/domain` es puro: leer la zona del dispositivo acá haría que la
 * misma entrada diera salidas distintas según dónde corra, y eso no se puede
 * testear. El resolvedor lo pone quien sabe en qué teléfono está
 * (`apps/mobile/src/api.ts`), y se pide **por marca de tiempo** a propósito:
 * Chile cambia de horario, así que un episodio de marzo y uno de julio no
 * comparten desfase, y usar el de hoy para una comida vieja reintroduce el
 * mismo error una hora más chico.
 *
 * Lo que se guarda en SQLite **no cambia**: sigue siendo UTC canónico. Esto
 * es una traducción de salida, no un cambio de representación.
 *
 * ## Privacidad — un dato nuevo que sale del teléfono, aceptado a conciencia
 *
 * `AGENTS.md` pide mandar el mínimo necesario a un servicio de IA, así que
 * conviene decirlo en vez de que aparezca solo: antes viajaban instantes UTC y
 * ahora viaja, además, **el desfase horario del dispositivo** —una banda de
 * longitud aproximada— y con él la hora de pared real de las comidas.
 *
 * Es el mínimo posible para este arreglo: `IsoTimestampSchema` exige `Z` o un
 * desfase, y mandar el desfase en un campo aparte transmitiría exactamente lo
 * mismo. No agrega glucosa, insulina ni identidad; nada que no viajara ya.
 *
 * Lo que **sí** cambia es lo que el modelo puede decir: una hora en UTC no
 * significaba nada sobre la vida de quien registró la comida, y una hora local
 * sí. Por eso el mismo cambio amplía la prohibición del prompt y agrega
 * patrones de "juicio o consejo sobre la hora de comer" a `ai-safety.ts`.
 */

/** ±14 h es el rango real de zonas horarias; fuera de eso es un dato corrupto. */
const MAX_OFFSET_MINUTES = 14 * 60;

/** `-240` → `-04:00`. El cero se escribe `+00:00` y no `Z`: acá el punto es que el desfase esté dicho. */
export function offsetSuffix(offsetMinutes: number): string {
  if (!Number.isInteger(offsetMinutes) || Math.abs(offsetMinutes) > MAX_OFFSET_MINUTES) {
    throw new Error('Offset must be an integer number of minutes within ±14 h.');
  }
  const sign = offsetMinutes < 0 ? '-' : '+';
  const total = Math.abs(offsetMinutes);
  const hours = String(Math.floor(total / 60)).padStart(2, '0');
  const minutes = String(total % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

/**
 * El mismo instante, escrito como hora local con su desfase.
 *
 * `2026-09-01T21:30:00.000Z` con `-240` → `2026-09-01T17:30:00.000-04:00`.
 * `Date.parse` de las dos devuelve exactamente el mismo número: lo único que
 * cambia es qué hora de pared se lee al mirarla.
 */
export function isoWithOffset(iso: string, offsetMinutes: number): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error('Invalid timestamp.');
  const suffix = offsetSuffix(offsetMinutes);
  const wall = new Date(ms + offsetMinutes * 60_000).toISOString();
  return `${wall.slice(0, -1)}${suffix}`;
}

/**
 * Las métricas de un episodio con todas sus marcas de tiempo en hora local.
 *
 * Toca las tres que existen —la comida, el bolo asociado y cada evento de
 * contexto— porque el pedido fue sobre "cualquier hora que diga el resumen",
 * no solo la del inicio. `minutesAfterAnchor` no se toca: es una diferencia
 * entre dos instantes y no depende de la zona.
 */
export function localizeEpisodeMetrics(
  metrics: MealEpisodeMetrics,
  offsetMinutesAt: (iso: string) => number,
): MealEpisodeMetrics {
  const local = (iso: string): string => isoWithOffset(iso, offsetMinutesAt(iso));
  return {
    ...metrics,
    mealTimestamp: local(metrics.mealTimestamp),
    ...(metrics.rapidInsulinTimestamp === undefined
      ? {}
      : { rapidInsulinTimestamp: local(metrics.rapidInsulinTimestamp) }),
    ...(metrics.contextEvents === undefined
      ? {}
      : { contextEvents: metrics.contextEvents.map((event) => ({ ...event, timestamp: local(event.timestamp) })) }),
  };
}
