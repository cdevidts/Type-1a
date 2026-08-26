import type { CGMReading } from '@type1a/schemas';

import {
  HIGH_THRESHOLD,
  HYPOGLYCEMIA_THRESHOLD,
  VERY_HIGH_THRESHOLD,
  VERY_LOW_THRESHOLD,
} from './glucose-thresholds';
import { convertGlucose } from './units';

/**
 * Fase 11 — resumen clínico descriptivo (Time in Range + HbA1c estimada).
 * Puro y determinístico, sin IA ni red, igual que `report.ts`. Esto NO es
 * inferencia de parámetros de terapia ni dosis (prohibido por AGENTS.md):
 * es una descripción estadística de glucosa ya medida, del mismo tipo que
 * cualquier reporte de CGM comercial (AGP/TIR).
 *
 * Decisión de seguridad: las lecturas `origin: 'synthetic'` se excluyen del
 * resumen. Son datos fabricados para desarrollo/demo (`MockCGMProvider`) —
 * mezclarlas en un promedio o TIR real corrompería silenciosamente el
 * número mostrado, incluso si cada fila individual ya está rotulada como
 * "Sintético" en el reporte tabular. `manual`, `imported` y `real` sí se
 * incluyen: representan glucosa efectivamente medida, aunque no todas
 * vengan del sensor.
 */

export interface GlucoseRangeBreakdown {
  /** % de lecturas < 54 mg/dL */
  veryLowPct: number;
  /** % de lecturas 54–69 mg/dL */
  lowPct: number;
  /** % de lecturas 70–180 mg/dL (rango objetivo estándar) */
  targetPct: number;
  /** % de lecturas 181–250 mg/dL */
  highPct: number;
  /** % de lecturas > 250 mg/dL */
  veryHighPct: number;
}

export interface GlucoseSummary {
  readingCount: number;
  /** Lecturas sintéticas excluidas del cálculo (ver nota de seguridad arriba). */
  excludedSyntheticCount: number;
  /** Días distintos (calendario, hora local) cubiertos por las lecturas incluidas. */
  daysCovered: number;
  meanGlucoseMgDl: number;
  standardDeviationMgDl: number;
  coefficientOfVariationPct: number;
  /**
   * HbA1c ESTIMADA (GMI — Glucose Management Indicator), calculada a partir
   * del promedio de glucosa. NO es una medición de laboratorio: separada a
   * propósito de `HbA1cLabResultSchema` (AGENTS.md).
   * Más confiable con `daysCovered >= 14` (consenso ADA/ATTD) — con menos
   * días, mostrar igual pero con una advertencia de cobertura limitada.
   */
  estimatedA1cPct: number;
  range: GlucoseRangeBreakdown;
}

/**
 * GMI (%) = 3.31 + 0.02392 × [promedio de glucosa en mg/dL].
 * Fórmula de Bergenstal et al., "Glucose Management Indicator (GMI): A New
 * Term for Estimating A1C From Continuous Glucose Monitoring", Diabetes
 * Care 2018;41(11):2275–2280 — sucesora formal de las fórmulas "eA1c"
 * anteriores.
 */
export function estimateA1cFromMeanGlucose(meanGlucoseMgDl: number): number {
  if (!Number.isFinite(meanGlucoseMgDl) || meanGlucoseMgDl <= 0) {
    throw new Error('meanGlucoseMgDl must be a positive finite number.');
  }
  return 3.31 + 0.02392 * meanGlucoseMgDl;
}

function localCalendarDayKey(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function summarizeGlucose(readings: readonly CGMReading[]): GlucoseSummary | null {
  const excludedSyntheticCount = readings.filter((r) => r.origin === 'synthetic').length;
  const eligible = readings.filter((r) => r.origin !== 'synthetic');
  if (eligible.length === 0) return null;

  const mgDlValues = eligible.map((r) => convertGlucose(r.glucose, r.unit, 'mg/dL'));
  const mean = mgDlValues.reduce((sum, v) => sum + v, 0) / mgDlValues.length;
  const variance = mgDlValues.reduce((sum, v) => sum + (v - mean) ** 2, 0) / mgDlValues.length;
  const standardDeviation = Math.sqrt(variance);
  const coefficientOfVariationPct = mean === 0 ? 0 : (standardDeviation / mean) * 100;

  const bandCounts = { veryLow: 0, low: 0, target: 0, high: 0, veryHigh: 0 };
  for (const value of mgDlValues) {
    if (value < VERY_LOW_THRESHOLD) bandCounts.veryLow += 1;
    else if (value < HYPOGLYCEMIA_THRESHOLD) bandCounts.low += 1;
    else if (value <= HIGH_THRESHOLD) bandCounts.target += 1;
    else if (value <= VERY_HIGH_THRESHOLD) bandCounts.high += 1;
    else bandCounts.veryHigh += 1;
  }
  const total = mgDlValues.length;
  const range: GlucoseRangeBreakdown = {
    veryLowPct: (bandCounts.veryLow / total) * 100,
    lowPct: (bandCounts.low / total) * 100,
    targetPct: (bandCounts.target / total) * 100,
    highPct: (bandCounts.high / total) * 100,
    veryHighPct: (bandCounts.veryHigh / total) * 100,
  };

  const daysCovered = new Set(eligible.map((r) => localCalendarDayKey(r.sourceTimestamp))).size;

  return {
    readingCount: total,
    excludedSyntheticCount,
    daysCovered,
    meanGlucoseMgDl: mean,
    standardDeviationMgDl: standardDeviation,
    coefficientOfVariationPct,
    estimatedA1cPct: estimateA1cFromMeanGlucose(mean),
    range,
  };
}
