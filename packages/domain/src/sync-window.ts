/**
 * Desde cuándo pedirle lecturas al sensor.
 *
 * ## El agujero que cierra
 *
 * La sincronización pedía **siempre las últimas 4 horas fijas**. Android decide
 * cuándo despierta a una app en segundo plano, y con Doze puede pasar de largo
 * varias horas — de noche, casi siempre. Si la app estuvo dormida 9 horas, lo
 * ocurrido entre la hora 9 y la hora 4 **no se pedía nunca**: no es que llegara
 * tarde, es que no se pedía. Verónica lo describió como *"a veces no guarda
 * hasta que yo la abra, y ahí se pierden muchas cosas"*.
 *
 * La ventana ahora arranca en **la última lectura que ya está guardada**, así
 * que cubre el hueco entero, dure lo que dure.
 */

/** Ventana mínima: sirve de piso incluso con lecturas muy recientes. */
export const MIN_SYNC_WINDOW_MS = 4 * 60 * 60_000;

/**
 * Tope de cuánto se pide hacia atrás.
 *
 * No es una decisión clínica sino de proveedor: LibreLinkUp sirve un tramo
 * reciente y pedirle una semana no la devuelve. Lo que hace este tope es
 * impedir una petición absurda tras meses sin abrir la app.
 */
export const MAX_SYNC_WINDOW_MS = 24 * 60 * 60_000;

/**
 * @param lastStoredIso La lectura más nueva que ya está en la base, o `null`
 *   si no hay ninguna (instalación nueva).
 */
export function syncWindowFrom(lastStoredIso: string | null, now: Date): Date {
  const nowMs = now.getTime();
  const floor = nowMs - MIN_SYNC_WINDOW_MS;
  const ceiling = nowMs - MAX_SYNC_WINDOW_MS;
  if (lastStoredIso === null) return new Date(floor);

  const last = Date.parse(lastStoredIso);
  // Una fecha ilegible no puede encoger la ventana en silencio: se cae al piso.
  if (!Number.isFinite(last)) return new Date(floor);
  // Una lectura en el futuro (reloj movido) tampoco: nunca se pide menos que
  // la ventana mínima.
  if (last > floor) return new Date(floor);
  return new Date(Math.max(last, ceiling));
}
