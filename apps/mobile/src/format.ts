import type { CGMTrend } from '@type1a/schemas';

export const trendArrow: Record<CGMTrend, string> = {
  rapid_down: '⇊',
  down: '↓',
  slight_down: '↘',
  stable: '→',
  slight_up: '↗',
  up: '↑',
  rapid_up: '⇈',
  unknown: '·',
};

export function formatClock(timestamp: string): string {
  return new Intl.DateTimeFormat('es-CL', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export function formatDayTime(timestamp: string): string {
  return new Intl.DateTimeFormat('es-CL', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

/**
 * Same as `formatDayTime` but with the year — used in reports (Fase 9),
 * which can span a much wider range than the few-hours-to-days windows
 * everywhere else in the app shows, so dropping the year there would make
 * two Augusts a year apart look identical on the page.
 */
export function formatReportTimestamp(timestamp: string): string {
  return new Intl.DateTimeFormat('es-CL', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

export function relativeAge(timestamp: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(timestamp)) / 60_000));
  if (minutes < 1) return 'ahora';
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return `hace ${hours} h`;
}

export function parsePositiveNumber(value: string): number | null {
  const parsed = Number(value.replace(',', '.').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * **Cuidado: una cadena vacía devuelve `0`, no `null`** — `Number('')` es 0 y
 * 0 es un valor no negativo válido. Si para tu campo "en blanco" significa
 * "no lo anotó" y no "cero", tienes que chequear `value.trim() === ''` antes
 * de llamar acá. Esto ya causó un bug: los macros de `MealModal` se guardaban
 * como `0 g` en cada comida y el reporte al médico los mostraba como dato
 * medido (Fase 13, ítem 7).
 */
export function parseNonNegativeNumber(value: string): number | null {
  const parsed = Number(value.replace(',', '.').trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Parses a comma-separated list of alarm offsets in minutes, e.g. "60, 120,
 * 180". Each value must be a whole number of minutes between 1 and 720
 * (12 h) — a bound generous enough for any real post-meal/post-correction
 * check-in, tight enough to reject an obvious typo (like an extra zero).
 * Returns null on any invalid entry or an empty list, so the caller can
 * reject the whole edit rather than silently drop the bad ones.
 */
export function parseMinuteOffsets(value: string): number[] | null {
  const parts = value.split(',').map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length === 0) return null;
  const offsets: number[] = [];
  for (const part of parts) {
    const parsed = Number(part);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 720) return null;
    offsets.push(parsed);
  }
  return offsets;
}

/** Parses "HH:MM" (24 h) into minutes since midnight, or null if malformed. */
export function parseClockToMinutes(value: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(value.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Formats minutes since midnight back into a zero-padded "HH:MM". */
export function formatMinutesAsClock(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * Spreads `count` capillary-measurement reminders evenly across the awake
 * window [wakeStart, wakeEnd], both "HH:MM". The reminders are anchored at
 * wakeStart and spaced one interval (window / count) apart, so they read as
 * "cada Y horas mientras estás despierto". Returns null on any malformed
 * time, a non-positive window, or a count outside 1..12 — the caller rejects
 * the whole edit rather than schedule a nonsensical set.
 */
export function capillaryReminderTimes(
  wakeStart: string,
  wakeEnd: string,
  count: number,
): { hour: number; minute: number }[] | null {
  if (!Number.isInteger(count) || count < 1 || count > 12) return null;
  const start = parseClockToMinutes(wakeStart);
  const end = parseClockToMinutes(wakeEnd);
  if (start === null || end === null || end <= start) return null;
  const interval = (end - start) / count;
  const times: { hour: number; minute: number }[] = [];
  for (let i = 0; i < count; i += 1) {
    const total = Math.round(start + i * interval);
    times.push({ hour: Math.floor(total / 60) % 24, minute: total % 60 });
  }
  return times;
}

/**
 * Campo numérico opcional donde **en blanco significa "no lo anoté"**.
 *
 * `undefined` = en blanco · `null` = texto inválido · número = el valor.
 *
 * Existe porque `parseNonNegativeNumber('')` devuelve `0`, y ese `0` ya se
 * guardó como dato medido en el reporte al médico una vez. El chequeo del
 * blanco estaba replicado a mano en **53 lugares**, cada uno una oportunidad
 * de olvidarlo; acá está una vez y con test.
 */
export function parseBlankAsUnset(value: string): number | null | undefined {
  return value.trim() === '' ? undefined : parseNonNegativeNumber(value);
}

/**
 * Igual, pero para un formulario de **edición**, donde vaciar un campo es una
 * instrucción de borrar y no una omisión.
 *
 * `null` = en blanco, o sea "borra este valor" · `undefined` = texto inválido
 * · número = el valor. **Los sentinelas están invertidos respecto de
 * `parseBlankAsUnset`**, y esa inversión es deliberada: es el lenguaje que
 * `MealEditPatch` de `db.ts` ya habla (`undefined` = no se tocó, `null` =
 * borrar). Dos funciones con nombre propio en vez de un ternario suelto que
 * hay que leer dos veces para saber cuál convención sigue.
 */
export function parseBlankAsClear(value: string): number | null | undefined {
  if (value.trim() === '') return null;
  const parsed = parseNonNegativeNumber(value);
  return parsed === null ? undefined : parsed;
}

/**
 * Igual que `parseBlankAsUnset`, para campos que además exigen **> 0**:
 * insulina y glucosa. Cero unidades no es una dosis, y cero mg/dL no es una
 * medición.
 */
export function parseBlankAsUnsetPositive(value: string): number | null | undefined {
  return value.trim() === '' ? undefined : parsePositiveNumber(value);
}
