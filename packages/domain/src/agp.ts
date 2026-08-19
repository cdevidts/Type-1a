import type { CGMReading } from '@type1a/schemas';

import { convertGlucose } from './units';

/**
 * Perfil de glucosa ambulatoria (AGP) — el "día promedio ponderado": todas
 * las lecturas del rango se colapsan sobre un único día de 24 h, y en cada
 * franja horaria se resumen con percentiles en vez de un promedio simple.
 *
 * Por qué percentiles y no promedio: un promedio esconde la variabilidad
 * (dos días, uno a 60 y otro a 240 mg/dL, promedian 150 = "en rango"). El
 * estándar internacional de reportes de CGM (AGP, consenso ATTD/ADA —
 * Battelino et al. 2019; Danne et al. 2017) grafica cinco curvas: mediana
 * (p50), rango intercuartil (p25–p75) y rango interdecil (p05–p95). Es lo
 * que muestran LibreView, Dexcom Clarity y los reportes clínicos, así que
 * un endocrinólogo lo lee sin explicación previa.
 *
 * Puro y determinístico, sin IA ni red — misma frontera que `report.ts` y
 * `glucose-metrics.ts`. Describe glucosa ya medida; no infiere parámetros
 * de terapia ni sugiere dosis (AGENTS.md).
 */

/**
 * Ancho de cada franja. 30 min = 48 franjas por día: suficiente resolución
 * para ver el pico post-desayuno sin que cada franja quede con una sola
 * lectura en rangos cortos (con CGM cada 5 min, 14 días dan ~84 lecturas
 * por franja).
 */
export const AGP_BUCKET_MINUTES = 30;

export interface AgpBucket {
  /** Minutos desde la medianoche local en que empieza la franja. */
  startMinute: number;
  p05: number;
  p25: number;
  p50: number;
  p75: number;
  p95: number;
  readingCount: number;
}

export interface AmbulatoryProfile {
  buckets: AgpBucket[];
  bucketMinutes: number;
  daysCovered: number;
  readingCount: number;
  /** Lecturas sintéticas descartadas (ver nota en `glucose-metrics.ts`). */
  excludedSyntheticCount: number;
}

/**
 * Percentil por interpolación lineal sobre una muestra ya ordenada — el
 * mismo método que usan las herramientas estadísticas estándar (tipo 7).
 */
export function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) throw new Error('percentile requires a non-empty sample.');
  if (sortedValues.length === 1) return sortedValues[0]!;
  const position = (sortedValues.length - 1) * fraction;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedValues[lowerIndex]!;
  if (lowerIndex === upperIndex) return lower;
  return lower + (sortedValues[upperIndex]! - lower) * (position - lowerIndex);
}

function minutesOfLocalDay(isoTimestamp: string): number {
  const date = new Date(isoTimestamp);
  return date.getHours() * 60 + date.getMinutes();
}

function localCalendarDayKey(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function buildAmbulatoryProfile(
  readings: readonly CGMReading[],
  bucketMinutes: number = AGP_BUCKET_MINUTES,
): AmbulatoryProfile | null {
  if (!Number.isInteger(bucketMinutes) || bucketMinutes <= 0 || 1440 % bucketMinutes !== 0) {
    throw new Error('bucketMinutes must be a positive integer that divides 1440.');
  }

  const excludedSyntheticCount = readings.filter((r) => r.origin === 'synthetic').length;
  const eligible = readings.filter((r) => r.origin !== 'synthetic');
  if (eligible.length === 0) return null;

  const bucketCount = 1440 / bucketMinutes;
  const samples: number[][] = Array.from({ length: bucketCount }, () => []);
  for (const reading of eligible) {
    const index = Math.floor(minutesOfLocalDay(reading.sourceTimestamp) / bucketMinutes);
    samples[index]!.push(convertGlucose(reading.glucose, reading.unit, 'mg/dL'));
  }

  const buckets: AgpBucket[] = [];
  for (let index = 0; index < bucketCount; index += 1) {
    const sample = samples[index]!;
    if (sample.length === 0) continue;
    const sorted = [...sample].sort((a, b) => a - b);
    buckets.push({
      startMinute: index * bucketMinutes,
      p05: percentile(sorted, 0.05),
      p25: percentile(sorted, 0.25),
      p50: percentile(sorted, 0.5),
      p75: percentile(sorted, 0.75),
      p95: percentile(sorted, 0.95),
      readingCount: sorted.length,
    });
  }

  return {
    buckets,
    bucketMinutes,
    daysCovered: new Set(eligible.map((r) => localCalendarDayKey(r.sourceTimestamp))).size,
    readingCount: eligible.length,
    excludedSyntheticCount,
  };
}
