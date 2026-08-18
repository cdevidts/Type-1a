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
