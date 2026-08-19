import {
  convertGlucose,
  HIGH_THRESHOLD,
  HYPOGLYCEMIA_THRESHOLD,
  summarizeGlucose,
  type GlucoseSummary,
} from '@type1a/domain';
import type { CGMReading } from '@type1a/schemas';
import * as XLSX from 'xlsx';

import type { ReportRow } from '@type1a/domain';
import type { ReportExport } from './types';
import { formatReportTimestamp } from './format';
import { colors } from './theme';

/**
 * Fase 9 (gráficos) + Fase 11 (resumen clínico) — construye el PDF/Excel
 * exportable desde `SettingsModal`. Vive fuera del componente porque genera
 * HTML/SVG y un workbook, no JSX: nada de esto se renderiza en la app, solo
 * se imprime/comparte.
 *
 * Antes (Fase 9 original) el PDF listaba cada lectura de glucosa como una
 * fila de tabla — con CGM cada 5-15 min, 7 días ya eran ~11 páginas solo de
 * glucosa, e ilegible. Ahora la glucosa se muestra como un gráfico diario
 * (hora en X, glucosa en Y, banda de rango objetivo) y el resto de eventos
 * (insulina, carbohidratos, comidas, actividad, notas, vitales, HbA1c de
 * laboratorio) sigue en una tabla, mucho más corta sin las filas de glucosa.
 */

const CHART_WIDTH = 680;
const CHART_HEIGHT = 140;
const PAD_LEFT = 34;
const PAD_RIGHT = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 18;
const PLOT_WIDTH = CHART_WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
const MIN_GLUCOSE = 40;
const MAX_GLUCOSE = 300;
const MINUTES_PER_DAY = 24 * 60;
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface DayBucket {
  midnightMs: number;
  heading: string;
  readings: CGMReading[];
}

function localMidnightMs(isoTimestamp: string): number {
  const date = new Date(isoTimestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formatDayHeading(midnightMs: number): string {
  return new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' })
    .format(new Date(midnightMs));
}

/**
 * Agrupa lecturas por día calendario (hora local del dispositivo), excluye
 * `origin: 'synthetic'` (mismo criterio que `summarizeGlucose` — un reporte
 * para el equipo médico no debe graficar datos fabricados de desarrollo,
 * ni siquiera atenuados) y ordena cada balde cronológicamente.
 */
function groupReadingsByDay(readings: readonly CGMReading[]): DayBucket[] {
  const eligible = readings.filter((r) => r.origin !== 'synthetic');
  const buckets = new Map<number, CGMReading[]>();
  for (const reading of eligible) {
    const key = localMidnightMs(reading.sourceTimestamp);
    const list = buckets.get(key);
    if (list) list.push(reading);
    else buckets.set(key, [reading]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([midnightMs, dayReadings]) => ({
      midnightMs,
      heading: formatDayHeading(midnightMs),
      readings: [...dayReadings].sort((a, b) => Date.parse(a.sourceTimestamp) - Date.parse(b.sourceTimestamp)),
    }));
}

function xForMinutes(minutes: number): number {
  return PAD_LEFT + (minutes / MINUTES_PER_DAY) * PLOT_WIDTH;
}

function yForGlucose(mgDl: number): number {
  const clamped = Math.max(MIN_GLUCOSE, Math.min(MAX_GLUCOSE, mgDl));
  return PAD_TOP + ((MAX_GLUCOSE - clamped) / (MAX_GLUCOSE - MIN_GLUCOSE)) * PLOT_HEIGHT;
}

function colorForGlucose(mgDl: number): string {
  if (mgDl < HYPOGLYCEMIA_THRESHOLD) return colors.red;
  if (mgDl > HIGH_THRESHOLD) return colors.orange;
  return colors.teal;
}

function minutesOfLocalDay(isoTimestamp: string): number {
  const date = new Date(isoTimestamp);
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

function dailyChartSvg(dayReadings: readonly CGMReading[]): string {
  const yLow = yForGlucose(HYPOGLYCEMIA_THRESHOLD);
  const yHigh = yForGlucose(HIGH_THRESHOLD);

  const targetBand = `<rect x="${PAD_LEFT}" y="${yHigh.toFixed(1)}" width="${PLOT_WIDTH}" height="${(yLow - yHigh).toFixed(1)}" fill="${colors.tealSoft}" />`;

  const hourMarks = HOUR_TICKS.map((hour) => {
    const x = xForMinutes(hour * 60).toFixed(1);
    const label = `${String(hour % 24).padStart(2, '0')}:00`;
    return `<line x1="${x}" y1="${PAD_TOP}" x2="${x}" y2="${PAD_TOP + PLOT_HEIGHT}" stroke="${colors.line}" stroke-width="0.75" />` +
      `<text x="${x}" y="${CHART_HEIGHT - 4}" font-size="9" fill="${colors.muted}" text-anchor="middle">${label}</text>`;
  }).join('');

  const axisLabels = `<text x="${PAD_LEFT - 4}" y="${(yLow + 3).toFixed(1)}" font-size="9" fill="${colors.muted}" text-anchor="end">70</text>` +
    `<text x="${PAD_LEFT - 4}" y="${(yHigh + 3).toFixed(1)}" font-size="9" fill="${colors.muted}" text-anchor="end">180</text>`;

  const points = dayReadings.map((reading) => {
    const mgDl = convertGlucose(reading.glucose, reading.unit, 'mg/dL');
    return {
      x: xForMinutes(minutesOfLocalDay(reading.sourceTimestamp)),
      y: yForGlucose(mgDl),
      mgDl,
      imported: reading.origin === 'imported',
    };
  });

  const polyline = points.length > 1
    ? `<polyline points="${points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="${colors.navy}" stroke-width="1.1" opacity="0.4" />`
    : '';

  const dots = points
    .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.1" fill="${colorForGlucose(p.mgDl)}" opacity="${p.imported ? 0.5 : 1}" />`)
    .join('');

  return `<svg width="${CHART_WIDTH}" height="${CHART_HEIGHT}" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${PAD_LEFT}" y="${PAD_TOP}" width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" fill="#FFFFFF" stroke="${colors.line}" />
    ${targetBand}
    ${hourMarks}
    ${axisLabels}
    <line x1="${PAD_LEFT}" y1="${yLow.toFixed(1)}" x2="${PAD_LEFT + PLOT_WIDTH}" y2="${yLow.toFixed(1)}" stroke="${colors.red}" stroke-width="0.75" stroke-dasharray="3,2" />
    <line x1="${PAD_LEFT}" y1="${yHigh.toFixed(1)}" x2="${PAD_LEFT + PLOT_WIDTH}" y2="${yHigh.toFixed(1)}" stroke="${colors.orange}" stroke-width="0.75" stroke-dasharray="3,2" />
    ${polyline}
    ${dots}
  </svg>`;
}

function dayCardHtml(bucket: DayBucket): string {
  const summary = summarizeGlucose(bucket.readings);
  const hasImported = bucket.readings.some((r) => r.origin === 'imported');
  const stats = summary === null
    ? `${bucket.readings.length} lectura(s)`
    : `Promedio ${summary.meanGlucoseMgDl.toFixed(0)} mg/dL · En rango ${summary.range.targetPct.toFixed(0)}% · ${summary.readingCount} lectura(s)${hasImported ? ' · incluye historial importado' : ''}`;
  return `<div class="day-card">
    <div class="day-header">
      <span class="day-date">${escapeHtml(bucket.heading)}</span>
      <span class="day-stats">${escapeHtml(stats)}</span>
    </div>
    ${dailyChartSvg(bucket.readings)}
  </div>`;
}

const RANGE_BAR_SEGMENTS: { key: keyof GlucoseSummary['range']; color: string; opacity: number }[] = [
  { key: 'veryLowPct', color: colors.red, opacity: 1 },
  { key: 'lowPct', color: colors.red, opacity: 0.55 },
  { key: 'targetPct', color: colors.teal, opacity: 1 },
  { key: 'highPct', color: colors.orange, opacity: 0.55 },
  { key: 'veryHighPct', color: colors.orange, opacity: 1 },
];

function rangeBarHtml(summary: GlucoseSummary): string {
  const segments = RANGE_BAR_SEGMENTS
    .map(({ key, color, opacity }) => `<div style="width:${summary.range[key].toFixed(1)}%; background:${color}; opacity:${opacity};"></div>`)
    .join('');
  return `<div class="range-bar">${segments}</div>
    <p class="range-legend">Muy bajo &lt;54 · Bajo 54–69 · Objetivo 70–180 · Alto 181–250 · Muy alto &gt;250 mg/dL</p>`;
}

function summaryHtml(summary: GlucoseSummary | null): string {
  if (summary === null) {
    return `<div class="summary"><p class="summary-empty">Sin lecturas de glucosa reales, manuales o importadas en este rango — no se puede calcular un resumen.</p></div>`;
  }
  const caveats: string[] = [];
  if (summary.daysCovered < 14) {
    caveats.push(`Cobertura de ${summary.daysCovered} día(s) — la estimación de HbA1c es más confiable con 14 o más días de datos continuos.`);
  }
  if (summary.excludedSyntheticCount > 0) {
    caveats.push(`Se excluyeron ${summary.excludedSyntheticCount} lectura(s) sintética(s) (modo desarrollo) de este resumen y de los gráficos diarios.`);
  }
  return `<div class="summary">
    <div class="summary-grid">
      <div class="summary-stat"><span class="summary-value">${summary.estimatedA1cPct.toFixed(1)}%</span><span class="summary-label">HbA1c estimada (GMI)*</span></div>
      <div class="summary-stat"><span class="summary-value">${summary.meanGlucoseMgDl.toFixed(0)}</span><span class="summary-label">Promedio (mg/dL)</span></div>
      <div class="summary-stat"><span class="summary-value">${summary.range.targetPct.toFixed(0)}%</span><span class="summary-label">Tiempo en rango 70–180</span></div>
      <div class="summary-stat"><span class="summary-value">${summary.coefficientOfVariationPct.toFixed(0)}%</span><span class="summary-label">Variabilidad (CV)</span></div>
    </div>
    ${rangeBarHtml(summary)}
    <p class="summary-footnote">* Estimación calculada por Type 1A a partir del promedio de glucosa (fórmula GMI — Bergenstal et al., Diabetes Care 2018), sobre ${summary.readingCount} lectura(s) en ${summary.daysCovered} día(s). No reemplaza una medición de laboratorio: si hay alguna registrada en este rango, aparece por separado como "HbA1c (laboratorio)" en el detalle.</p>
    ${caveats.map((c) => `<p class="summary-caveat">${escapeHtml(c)}</p>`).join('')}
  </div>`;
}

function eventTableHtml(rows: ReportRow[]): string {
  const nonGlucose = rows.filter((row) => row.kind !== 'glucose');
  if (nonGlucose.length === 0) {
    return '<p class="summary-empty">Sin insulina, carbohidratos, comidas u otros eventos registrados en este rango.</p>';
  }
  const body = nonGlucose
    .map((row) => `<tr>
      <td>${escapeHtml(formatReportTimestamp(row.timestamp))}</td>
      <td>${escapeHtml(row.kindLabel)}</td>
      <td>${escapeHtml(row.detail)}</td>
      <td>${escapeHtml(row.provenance)}</td>
    </tr>`)
    .join('');
  return `<table>
    <thead><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th>Origen</th></tr></thead>
    <tbody>${body}</tbody>
  </table>`;
}

export function reportHtml(data: ReportExport, rangeLabel: string): string {
  const summary = summarizeGlucose(data.readings);
  const dayBuckets = groupReadingsByDay(data.readings);
  const chartsSection = dayBuckets.length === 0
    ? '<p class="summary-empty">Sin lecturas de glucosa en este rango.</p>'
    : `<p class="chart-legend">Cada punto es una lectura de glucosa (rojo &lt;70, teal 70–180, naranjo &gt;180 mg/dL). Puntos atenuados = historial importado.</p>${dayBuckets.map(dayCardHtml).join('')}`;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #17212B; padding: 24px; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  h2 { font-size: 14px; margin: 20px 0 8px; }
  p.range { color: #667784; font-size: 12px; margin-top: 0; margin-bottom: 16px; }
  .summary { margin-bottom: 12px; }
  .summary-grid { display: flex; gap: 12px; margin-bottom: 8px; }
  .summary-stat { flex: 1; border: 1px solid ${colors.line}; border-radius: 8px; padding: 8px; text-align: center; }
  .summary-value { display: block; font-size: 16px; font-weight: 800; color: ${colors.navy}; }
  .summary-label { display: block; font-size: 9px; color: ${colors.muted}; margin-top: 2px; }
  .range-bar { display: flex; width: 100%; height: 12px; border-radius: 6px; overflow: hidden; }
  .range-legend { font-size: 9px; color: ${colors.muted}; margin: 4px 0 0; }
  .summary-footnote { font-size: 9px; color: ${colors.muted}; margin: 8px 0 0; }
  .summary-caveat { font-size: 9px; color: ${colors.warning}; margin: 4px 0 0; }
  .summary-empty { font-size: 11px; color: ${colors.muted}; }
  .chart-legend { font-size: 9px; color: ${colors.muted}; margin: 0 0 8px; }
  .day-card { page-break-inside: avoid; margin-bottom: 10px; border: 1px solid ${colors.line}; border-radius: 8px; padding: 8px; }
  .day-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 4px; }
  .day-date { font-size: 12px; font-weight: 700; text-transform: capitalize; }
  .day-stats { font-size: 10px; color: ${colors.muted}; }
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  th, td { border-bottom: 1px solid ${colors.line}; padding: 6px 8px; text-align: left; vertical-align: top; }
  th { background: #F4F7F8; font-weight: 700; }
</style>
</head>
<body>
  <h1>Type 1A — Reporte</h1>
  <p class="range">${escapeHtml(rangeLabel)} · generado ${escapeHtml(formatReportTimestamp(new Date().toISOString()))}</p>
  <h2>Resumen clínico</h2>
  ${summaryHtml(summary)}
  <h2>Glucosa por día</h2>
  ${chartsSection}
  <h2>Insulina, carbohidratos y otros eventos</h2>
  ${eventTableHtml(data.rows)}
</body>
</html>`;
}

export function reportWorkbookBytes(data: ReportExport): Uint8Array {
  const summary = summarizeGlucose(data.readings);
  const summarySheetData: (string | number)[][] = summary === null
    ? [['Resumen clínico (Type 1A)'], ['Sin lecturas de glucosa reales, manuales o importadas en este rango.']]
    : [
      ['Resumen clínico (Type 1A)'],
      ['HbA1c estimada (GMI)*', `${summary.estimatedA1cPct.toFixed(1)}%`],
      ['Promedio de glucosa (mg/dL)', Number(summary.meanGlucoseMgDl.toFixed(0))],
      ['Tiempo en rango 70-180 (%)', Number(summary.range.targetPct.toFixed(1))],
      ['Muy bajo <54 (%)', Number(summary.range.veryLowPct.toFixed(1))],
      ['Bajo 54-69 (%)', Number(summary.range.lowPct.toFixed(1))],
      ['Alto 181-250 (%)', Number(summary.range.highPct.toFixed(1))],
      ['Muy alto >250 (%)', Number(summary.range.veryHighPct.toFixed(1))],
      ['Variabilidad, CV (%)', Number(summary.coefficientOfVariationPct.toFixed(1))],
      ['Días cubiertos', summary.daysCovered],
      ['Lecturas incluidas', summary.readingCount],
      ['Lecturas sintéticas excluidas', summary.excludedSyntheticCount],
      [],
      ['* Estimación calculada por Type 1A a partir del promedio de glucosa (fórmula GMI). No reemplaza una medición de laboratorio.'],
    ];

  const reportSheetData = [
    ['Fecha', 'Tipo', 'Detalle', 'Origen'],
    ...data.rows.map((row) => [formatReportTimestamp(row.timestamp), row.kindLabel, row.detail, row.provenance]),
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summarySheetData), 'Resumen');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(reportSheetData), 'Reporte');
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}
