/**
 * Fechas y horas de un registro, resueltas fuera de React.
 *
 * ## Por qué es un módulo puro
 *
 * Todo lo que hay acá decide **cuándo pasó** algo, y "cuándo" es la columna
 * por la que se agrupan episodios, se recortan ventanas de patrones y se
 * ordena el reporte que va al control médico. Un error de un día no se ve en
 * pantalla: se ve tres semanas después, en un promedio.
 *
 * Además nada de esto se puede verificar dentro de un `.tsx` sin montar
 * React, y la mitad son casos de borde de calendario —fin de mes, cambio de
 * año, el día de hoy a las 23:59— que hay que probar y no mirar.
 *
 * ## Zona horaria
 *
 * Todo es **hora local del teléfono**, a propósito. Un "día" para quien
 * registra lo que comió es su día, no un rango UTC; construir los límites con
 * `new Date(y, m, d)` los ancla al huso del dispositivo, que es el mismo con
 * el que se escribió cada registro.
 */

/** L M X J V S D — las iniciales en español de Chile, empezando por lunes. */
export const WEEKDAY_LETTERS = ['D', 'L', 'M', 'X', 'J', 'V', 'S'] as const;

export function weekdayLetter(date: Date): string {
  return WEEKDAY_LETTERS[date.getDay()] ?? '';
}

/** Inicio del día local que contiene a `date`. */
export function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * El rango [desde, hasta) de un día local.
 *
 * Semiabierto a propósito: con `to` en el inicio del día siguiente, un
 * registro de las 23:59:59.999 entra y ninguno se cuenta dos veces en la
 * frontera. Un `to` en "hoy a las 23:59:59" pierde el último segundo, y ese
 * segundo existe.
 */
export function dayRange(date: Date): { from: Date; to: Date } {
  const from = startOfDay(date);
  const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1);
  return { from, to };
}

export function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/**
 * True si `date` cae en un día **posterior** a hoy.
 *
 * Compara días completos y no instantes: seleccionar hoy a las 00:00 cuando
 * son las 14:00 no es futuro, y rechazarlo dejaría el propio día de hoy sin
 * poder registrarse desde el calendario.
 */
export function isFutureDay(date: Date, now: Date = new Date()): boolean {
  return startOfDay(date).getTime() > startOfDay(now).getTime();
}

export interface StripCalendarDay {
  date: Date;
  /** Número del día, para la etiqueta del círculo. */
  dayOfMonth: number;
  /** L, M, X, J, V, S o D. */
  letter: string;
  isToday: boolean;
  /** Los días futuros existen en la fila, pero no se pueden registrar. */
  isFuture: boolean;
}

/**
 * Los días de un mes, para la fila horizontal del Strip Calendar.
 *
 * `month` es 0-11, como en `Date`. Devuelve el mes **completo** —incluidos los
 * días futuros— porque una fila que se corta en el día de hoy se lee como si
 * el mes terminara ahí; los futuros van marcados y deshabilitados.
 */
export function monthDays(year: number, month: number, now: Date = new Date()): StripCalendarDay[] {
  // Día 0 del mes siguiente = último día de este mes. Sirve para cualquier
  // mes sin tabla de longitudes ni caso especial para febrero bisiesto.
  const total = new Date(year, month + 1, 0).getDate();
  const days: StripCalendarDay[] = [];
  for (let day = 1; day <= total; day += 1) {
    const date = new Date(year, month, day);
    days.push({
      date,
      dayOfMonth: day,
      letter: weekdayLetter(date),
      isToday: isSameDay(date, now),
      isFuture: isFutureDay(date, now),
    });
  }
  return days;
}

/**
 * Mueve el mes mostrado, arrastrando el año cuando corresponde.
 *
 * Se devuelve `{ year, month }` y no un `Date` a propósito: un `Date` del mes
 * navegado tendría que llevar un día, y elegir "el mismo día del mes" salta de
 * enero 31 a marzo 3.
 */
export function shiftMonth(year: number, month: number, delta: number): { year: number; month: number } {
  const shifted = new Date(year, month + delta, 1);
  return { year: shifted.getFullYear(), month: shifted.getMonth() };
}

/**
 * Qué día seleccionar al cambiar de mes.
 *
 * Conserva el día del mes cuando existe (pasar de un 15 a otro 15) y cae al
 * último día disponible cuando no (del 31 de enero a febrero). Nunca devuelve
 * una fecha futura: si el mes navegado es el actual, se topa en hoy.
 */
export function clampDayToMonth(year: number, month: number, day: number, now: Date = new Date()): Date {
  const lastDay = new Date(year, month + 1, 0).getDate();
  const candidate = new Date(year, month, Math.min(Math.max(day, 1), lastDay));
  return isFutureDay(candidate, now) ? startOfDay(now) : candidate;
}

export const MONTH_NAMES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
] as const;

export function monthLabel(year: number, month: number): string {
  return `${MONTH_NAMES[month] ?? ''} ${year}`;
}

/**
 * Combina un día elegido con una hora escrita como "HH:MM", en hora local.
 *
 * Devuelve el ISO del instante, o `null` si la hora no es válida. **No cae a
 * un default**: registrar en el pasado sin hora exacta produciría un mediodía
 * inventado, y ese invento después se lee como el momento en que comió.
 */
export function combineDayAndTime(day: Date, time: string): string | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(time.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute, 0, 0).toISOString();
}

/** "HH:MM" local de un instante ISO, para sembrar el campo de hora. */
export function timeOfDay(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** "AAAA-MM-DD" local de un instante ISO, para sembrar el campo de fecha. */
export function dayOfMonthISO(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/**
 * Lee un "AAAA-MM-DD" local escrito a mano. `null` si no es una fecha real.
 *
 * Construye con los tres números por separado y **no** con `new Date(texto)`:
 * un ISO de solo fecha se interpreta como UTC, así que en Chile "2026-08-27"
 * se convertiría en el 26 a las 20:00 y el registro caería el día anterior.
 */
export function parseDayISO(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value.trim());
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, month, day);
  // Rebote: "2026-02-31" construye el 3 de marzo. Comparar de vuelta lo
  // detecta sin tabla de longitudes de mes.
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}
