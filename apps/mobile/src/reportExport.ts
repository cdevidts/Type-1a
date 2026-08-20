import {
  buildAmbulatoryProfile,
  buildMacroGlucoseComparison,
  buildNutritionInsights,
  convertGlucose,
  HIGH_THRESHOLD,
  HYPOGLYCEMIA_THRESHOLD,
  MIN_SAMPLE_FOR_RATE,
  summarizeGlucose,
  type AmbulatoryProfile,
  type GlucoseSummary,
  type MacroGlucoseComparison,
  type MealWindowInsight,
} from '@type1a/domain';
import type { CGMReading } from '@type1a/schemas';
import * as XLSX from 'xlsx';

import type { ReportRow } from '@type1a/domain';
import type { MealEvent } from '@type1a/schemas';
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

  // Cualquier lectura que no salió del feed del sensor (importada o manual)
  // recibe el mismo trato "esto no es dato de sensor en vivo" — misma
  // definición que `GlucoseChart`/`SummaryCharts`. Y la distinción vive
  // también en el trazo, no solo en los puntos: una tirada larga de
  // historial importado unida por una línea sólida se leería, en la
  // consulta médica, como cobertura continua de sensor.
  const points = dayReadings.map((reading) => {
    const mgDl = convertGlucose(reading.glucose, reading.unit, 'mg/dL');
    return {
      x: xForMinutes(minutesOfLocalDay(reading.sourceTimestamp)),
      y: yForGlucose(mgDl),
      mgDl,
      nonSensor: reading.origin === 'imported' || reading.origin === 'manual',
    };
  });

  const segments: string[] = [];
  let runStart = 0;
  for (let i = 1; i <= points.length; i += 1) {
    const atEnd = i === points.length;
    if (atEnd || points[i]!.nonSensor !== points[runStart]!.nonSensor) {
      const runEnd = atEnd ? i - 1 : i;
      const run = points.slice(runStart, runEnd + 1);
      if (run.length > 1) {
        const nonSensor = points[runStart]!.nonSensor;
        segments.push(
          `<polyline points="${run.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}" fill="none" stroke="${nonSensor ? colors.muted : colors.navy}" stroke-width="1.1" opacity="${nonSensor ? 0.55 : 0.4}"${nonSensor ? ' stroke-dasharray="3,3"' : ''} />`,
        );
      }
      runStart = runEnd;
    }
  }
  const polyline = segments.join('');

  const dots = points
    .map((p) => p.nonSensor
      ? `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.1" fill="#FFFFFF" stroke="${colorForGlucose(p.mgDl)}" stroke-width="1" opacity="0.85" />`
      : `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.1" fill="${colorForGlucose(p.mgDl)}" />`)
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
  const hasImported = bucket.readings.some((r) => r.origin === 'imported' || r.origin === 'manual');
  const stats = summary === null
    ? `${bucket.readings.length} lectura(s)`
    : `Promedio ${summary.meanGlucoseMgDl.toFixed(0)} mg/dL · En rango ${summary.range.targetPct.toFixed(0)}% · ${summary.readingCount} lectura(s)${hasImported ? ' · incluye manual/importado' : ''}`;
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

function summaryHtml(summary: GlucoseSummary | null, unreadableCount: number): string {
  // Se declara aunque no haya resumen: el médico tiene que saber que el
  // rango venía incompleto, exista o no un número que mostrarle.
  const unreadableCaveat = unreadableCount > 0
    ? `${unreadableCount} registro(s) del historial en este rango no se pudieron leer y quedaron fuera del reporte. Todo lo que sigue está calculado sin ellos.`
    : null;
  if (summary === null) {
    return `<div class="summary"><p class="summary-empty">Sin lecturas de glucosa reales, manuales o importadas en este rango — no se puede calcular un resumen.</p>${
      unreadableCaveat === null ? '' : `<p class="summary-caveat">${escapeHtml(unreadableCaveat)}</p>`
    }</div>`;
  }
  const caveats: string[] = [];
  if (unreadableCaveat !== null) caveats.push(unreadableCaveat);
  if (summary.daysCovered < 14) {
    caveats.push(`Cobertura de ${summary.daysCovered} día(s) — la estimación de HbA1c es más confiable con 14 o más días de datos continuos.`);
  }
  if (summary.excludedSyntheticCount > 0) {
    caveats.push(`Se excluyeron ${summary.excludedSyntheticCount} lectura(s) sintética(s) (modo desarrollo) de todo este reporte: del resumen, del día promedio, de los gráficos diarios y de los patrones por franja.`);
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

/**
 * Perfil ambulatorio (AGP) para el PDF: el "día promedio ponderado", en el
 * mismo formato de percentiles que la pantalla Resumen y que los reportes
 * de CGM estándar, para que el equipo clínico lo lea sin explicación.
 */
function agpChartSvg(profile: AmbulatoryProfile): string {
  const { buckets, bucketMinutes } = profile;
  if (buckets.length === 0) return '';
  const centre = (b: AmbulatoryProfile['buckets'][number]): number =>
    xForMinutes(b.startMinute + bucketMinutes / 2);

  const band = (lower: (b: typeof buckets[number]) => number, upper: (b: typeof buckets[number]) => number): string => {
    const top = buckets.map((b) => `${centre(b).toFixed(1)},${yForGlucose(upper(b)).toFixed(1)}`);
    const bottom = [...buckets].reverse().map((b) => `${centre(b).toFixed(1)},${yForGlucose(lower(b)).toFixed(1)}`);
    return `M${top.join('L')}L${bottom.join('L')}Z`;
  };

  const yLow = yForGlucose(HYPOGLYCEMIA_THRESHOLD);
  const yHigh = yForGlucose(HIGH_THRESHOLD);
  const hourMarks = HOUR_TICKS.map((hour) => {
    const x = xForMinutes(hour * 60).toFixed(1);
    return `<line x1="${x}" y1="${PAD_TOP}" x2="${x}" y2="${PAD_TOP + PLOT_HEIGHT}" stroke="${colors.line}" stroke-width="0.75" />` +
      `<text x="${x}" y="${CHART_HEIGHT - 4}" font-size="9" fill="${colors.muted}" text-anchor="middle">${String(hour % 24).padStart(2, '0')}:00</text>`;
  }).join('');

  return `<svg width="${CHART_WIDTH}" height="${CHART_HEIGHT}" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${PAD_LEFT}" y="${PAD_TOP}" width="${PLOT_WIDTH}" height="${PLOT_HEIGHT}" fill="#FFFFFF" stroke="${colors.line}" />
    <rect x="${PAD_LEFT}" y="${yHigh.toFixed(1)}" width="${PLOT_WIDTH}" height="${(yLow - yHigh).toFixed(1)}" fill="${colors.tealSoft}" />
    ${hourMarks}
    <text x="${PAD_LEFT - 4}" y="${(yLow + 3).toFixed(1)}" font-size="9" fill="${colors.muted}" text-anchor="end">70</text>
    <text x="${PAD_LEFT - 4}" y="${(yHigh + 3).toFixed(1)}" font-size="9" fill="${colors.muted}" text-anchor="end">180</text>
    <path d="${band((b) => b.p05, (b) => b.p95)}" fill="${colors.navy}" opacity="0.12" />
    <path d="${band((b) => b.p25, (b) => b.p75)}" fill="${colors.navy}" opacity="0.26" />
    <polyline points="${buckets.map((b) => `${centre(b).toFixed(1)},${yForGlucose(b.p50).toFixed(1)}`).join(' ')}" fill="none" stroke="${colors.navy}" stroke-width="1.6" />
  </svg>`;
}

function agpSectionHtml(profile: AmbulatoryProfile | null): string {
  if (profile === null || profile.buckets.length === 0) {
    return '<p class="summary-empty">Sin lecturas suficientes para construir el perfil de día promedio.</p>';
  }
  return `<p class="chart-legend">Todas las lecturas de ${profile.daysCovered} día(s) superpuestas sobre 24 h. Línea = mediana; franja oscura = 50% central (p25–p75); franja clara = 90% central (p05–p95). Formato de perfil ambulatorio (AGP), el estándar de los reportes de CGM.</p>
    ${agpChartSvg(profile)}`;
}

function nutritionSectionHtml(insights: MealWindowInsight[], meals: readonly MealEvent[]): string {
  const withData = insights.filter(
    (w) => w.mealCount > 0 || w.rapidDoseCount > 0 || w.confirmedCarbsSampleSize > 0,
  );
  if (withData.length === 0) {
    return '<p class="summary-empty">Sin comidas ni insulina registradas en este rango.</p>';
  }
  // Las columnas de macros solo aparecen si se anotó alguno: si nadie los
  // registra, tres columnas de guiones le restan legibilidad al reporte que
  // lee el médico. Un "—" con las columnas presentes significa "no anotado en
  // esa franja", nunca 0 g.
  const anyMacros = withData.some(
    (w) => w.proteinSampleSize > 0 || w.fatSampleSize > 0 || w.fiberSampleSize > 0,
  );
  const rows = withData
    .map((w) => {
      const outcome = (hours: number): string => {
        const found = w.outcomes.find((o) => o.horizonHours === hours);
        if (found === undefined || found.inTargetPct === undefined) {
          return `<td class="num muted">n=${found?.sampleSize ?? 0}</td>`;
        }
        // Los tres lados, no solo el "en rango": un único porcentaje al lado
        // del promedio de insulina de la franja se lee como una nota de
        // desempeño, y esconde si los fallos fueron hipos o hipers.
        return `<td class="num">${found.inTargetPct.toFixed(0)}%<br /><span class="muted">↓${found.belowTargetPct!.toFixed(0)} ↑${found.aboveTargetPct!.toFixed(0)} · n=${found.sampleSize}</span></td>`;
      };
      return `<tr>
        <td>${escapeHtml(w.label)} <span class="muted">${String(w.startHour).padStart(2, '0')}–${String(w.endHour % 24).padStart(2, '0')} h</span></td>
        <td class="num">${w.avgConfirmedCarbsG === undefined ? '—' : `${w.avgConfirmedCarbsG.toFixed(0)} g`}</td>
        ${anyMacros ? `<td class="num">${w.avgProteinG === undefined ? '—' : `${w.avgProteinG.toFixed(0)} g`}</td>
        <td class="num">${w.avgFatG === undefined ? '—' : `${w.avgFatG.toFixed(0)} g`}</td>
        <td class="num">${w.avgFiberG === undefined ? '—' : `${w.avgFiberG.toFixed(0)} g`}</td>` : ''}
        <td class="num">${w.avgRapidUnits === undefined ? '—' : `${w.avgRapidUnits.toFixed(1)} U`}</td>
        <td class="num">${w.avgBasalUnits === undefined ? '—' : `${w.avgBasalUnits.toFixed(1)} U`}</td>
        ${outcome(1)}${outcome(2)}${outcome(3)}
      </tr>`;
    })
    .join('');
  return `<table>
    <thead><tr>
      <th>Franja</th><th class="num">Carbos confirmados</th>${anyMacros ? '<th class="num">Proteína</th><th class="num">Grasa</th><th class="num">Fibra</th>' : ''}<th class="num">Rápida</th><th class="num">Basal</th>
      <th class="num">Glucosa a 1 h</th><th class="num">a 2 h</th><th class="num">a 3 h</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="summary-footnote">Promedios de lo registrado por franja horaria. "En rango" = porcentaje de dosis rápidas tras las cuales había una lectura entre 70 y 180 mg/dL a esa hora; ↓ y ↑ son el porcentaje que quedó por debajo de 70 y por encima de 180, y se muestran a propósito porque quedar fuera de rango por abajo y por arriba son cosas opuestas. Es una observación descriptiva, no una medida de si la dosis fue adecuada, y depende también de comida, actividad, estrés y basal. Solo se muestra un porcentaje con al menos ${MIN_SAMPLE_FOR_RATE} dosis.${anyMacros ? ' Proteína, grasa y fibra son promedios de las comidas donde la usuaria los anotó: un guion significa que no los registró en esa franja, no que fueran cero.' + macroProvenanceNote(meals) : ''} Type 1A nunca decide ni sugiere una dosis por su cuenta: su calculadora solo aplica los parámetros que cargó la propia usuaria.</p>`;
}

/**
 * Fase 14. La subida tardía por grasa/proteína es justo lo que el conteo de
 * carbohidratos no explica, así que es información útil para una consulta —
 * pero **descriptiva**: la respuesta clínica a este patrón (bolo extendido)
 * es una decisión del equipo médico, nunca de la app. Ver la cabecera de
 * `packages/domain/src/macro-glucose.ts`.
 */
/**
 * De dónde vienen los macros del período.
 *
 * Sin esta frase, un equipo clínico lee "proteína promedio 38 g" como ingesta
 * anotada por la paciente, cuando puede ser enteramente una estimación de IA a
 * partir de una foto. No son el mismo dato y la diferencia importa para
 * decidir cuánto peso darle. Ver `MealEvent.macrosSource`.
 */
export function macroProvenanceNote(meals: readonly MealEvent[]): string {
  const withMacros = meals.filter((meal) => meal.proteinG !== undefined || meal.fatG !== undefined);
  if (withMacros.length === 0) return '';
  const counts: Record<'ai' | 'user' | 'mixed' | 'unknown', number> = { ai: 0, user: 0, mixed: 0, unknown: 0 };
  for (const meal of withMacros) {
    counts[meal.macrosSource ?? 'unknown'] += 1;
  }
  const parts: string[] = [];
  if (counts.ai > 0) parts.push(`${counts.ai} estimada(s) por IA sin corregir`);
  if (counts.mixed > 0) parts.push(`${counts.mixed} estimada(s) por IA y corregida(s) por la usuaria`);
  if (counts.user > 0) parts.push(`${counts.user} anotada(s) por la usuaria`);
  if (counts.unknown > 0) parts.push(`${counts.unknown} de procedencia no registrada`);
  return ` Procedencia de esos macros, sobre ${withMacros.length} comida(s) con macros: ${parts.join(', ')}.`;
}

function macroGlucoseSectionHtml(comparison: MacroGlucoseComparison | null): string {
  if (comparison === null) {
    return '<p class="summary-empty">Todavía no hay suficientes comidas con grasa y proteína anotadas para comparar.</p>';
  }
  const cell = (group: MacroGlucoseComparison['higher'], hours: number): string => {
    const point = group.points.find((p) => p.horizonHours === hours);
    if (point === undefined || point.meanDeltaMgDl === undefined) {
      return `<td class="num muted">n=${point?.sampleSize ?? 0}</td>`;
    }
    const sign = point.meanDeltaMgDl >= 0 ? '+' : '';
    return `<td class="num">${sign}${point.meanDeltaMgDl.toFixed(0)}<br /><span class="muted">n=${point.sampleSize}</span></td>`;
  };
  const row = (label: string, group: MacroGlucoseComparison['higher']): string =>
    `<tr>
      <td>${escapeHtml(label)} <span class="muted">≈${group.avgFatProteinG.toFixed(0)} g · ${group.mealCount} comidas</span></td>
      ${[2, 3, 4, 5].map((hours) => cell(group, hours)).join('')}
    </tr>`;
  return `<table>
    <thead><tr>
      <th>Grupo de comidas</th><th class="num">+2 h</th><th class="num">+3 h</th><th class="num">+4 h</th><th class="num">+5 h</th>
    </tr></thead>
    <tbody>${row('Más grasa + proteína', comparison.higher)}${row('Menos', comparison.lower)}</tbody>
  </table>
  <p class="summary-footnote">Cambio promedio de glucosa respecto del momento de comer, en mg/dL, según la carga de grasa más proteína de la comida (corte en ${comparison.splitAtFatProteinG.toFixed(0)} g, la mediana de ${comparison.eligibleMealCount} comidas con ambos macros anotados). En diabetes tipo 1 la grasa y la proteína tienden a mover la glucosa de forma retrasada y prolongada, entre 1,5 y 6 h, con efecto aditivo cuando la comida es alta en ambas — por eso se miran estos horizontes y no la primera hora. Es una descripción de lo ya ocurrido, no una medida de si una dosis fue adecuada. Type 1A nunca decide ni sugiere una dosis por su cuenta: su calculadora solo aplica los parámetros que cargó la propia usuaria.</p>`;
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
  const profile = buildAmbulatoryProfile(data.readings);
  const insights = buildNutritionInsights(data);
  const macroGlucose = buildMacroGlucoseComparison({ meals: data.meals, readings: data.readings });
  const dayBuckets = groupReadingsByDay(data.readings);
  const chartsSection = dayBuckets.length === 0
    ? '<p class="summary-empty">Sin lecturas de glucosa en este rango.</p>'
    : `<p class="chart-legend">Cada punto es una lectura de glucosa (rojo &lt;70, teal 70–180, naranjo &gt;180 mg/dL). Los puntos huecos unidos por línea punteada no vienen del sensor: son lecturas manuales o historial importado.</p>${dayBuckets.map(dayCardHtml).join('')}`;

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
  td.num, th.num { text-align: right; white-space: nowrap; }
  .muted { color: ${colors.muted}; font-weight: 400; }
</style>
</head>
<body>
  <h1>Type 1A — Reporte</h1>
  <p class="range">${escapeHtml(rangeLabel)} · generado ${escapeHtml(formatReportTimestamp(new Date().toISOString()))}</p>
  <h2>Resumen clínico</h2>
  ${summaryHtml(summary, data.unreadableCount)}
  <h2>Día promedio (perfil ambulatorio)</h2>
  ${agpSectionHtml(profile)}
  <h2>Patrones por franja horaria</h2>
  ${nutritionSectionHtml(insights, data.meals)}
  <h2>Grasa y proteína frente a la glucosa tardía</h2>
  ${macroGlucoseSectionHtml(macroGlucose)}
  <h2>Glucosa por día</h2>
  ${chartsSection}
  <h2>Insulina, carbohidratos y otros eventos</h2>
  ${eventTableHtml(data.rows)}
</body>
</html>`;
}

export function reportWorkbookBytes(data: ReportExport): Uint8Array {
  const summary = summarizeGlucose(data.readings);
  // La declaración de registros ilegibles va en LAS DOS ramas. Es justamente
  // en la rama sin resumen donde más importa: si las lecturas del rango eran
  // las corruptas, el médico leería "sin lecturas en este rango" y concluiría
  // que la paciente no midió, cuando en realidad había N que no se pudieron
  // leer. Mismo criterio que `summaryHtml`.
  const unreadableRow: (string | number)[][] = data.unreadableCount > 0
    ? [['Registros ilegibles excluidos', data.unreadableCount]]
    : [];
  const summarySheetData: (string | number)[][] = summary === null
    ? [
      ['Resumen clínico (Type 1A)'],
      ['Sin lecturas de glucosa reales, manuales o importadas en este rango.'],
      ...unreadableRow,
    ]
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
      ['Registros ilegibles excluidos', data.unreadableCount],
      [],
      ['* Estimación calculada por Type 1A a partir del promedio de glucosa (fórmula GMI). No reemplaza una medición de laboratorio.'],
    ];

  const reportSheetData = [
    ['Fecha', 'Tipo', 'Detalle', 'Origen'],
    ...data.rows.map((row) => [formatReportTimestamp(row.timestamp), row.kindLabel, row.detail, row.provenance]),
  ];

  const insights = buildNutritionInsights(data);
  const macroGlucose = buildMacroGlucoseComparison({ meals: data.meals, readings: data.readings });
  const outcomeCell = (window: MealWindowInsight, hours: number): string => {
    const found = window.outcomes.find((o) => o.horizonHours === hours);
    if (found === undefined || found.inTargetPct === undefined) return `sin dato (n=${found?.sampleSize ?? 0})`;
    return `en rango ${found.inTargetPct.toFixed(0)}% / bajo ${found.belowTargetPct!.toFixed(0)}% / alto ${found.aboveTargetPct!.toFixed(0)}% (n=${found.sampleSize})`;
  };
  const patternsSheetData: (string | number)[][] = [
    ['Franja', 'Horario', 'Carbos confirmados prom. (g)', 'Proteína prom. (g)', 'Grasa prom. (g)', 'Fibra prom. (g)', 'Rápida prom. (U)', 'Basal prom. (U)', 'Glucosa a 1 h', 'Glucosa a 2 h', 'Glucosa a 3 h'],
    ...insights.map((w) => [
      w.label,
      `${String(w.startHour).padStart(2, '0')}:00-${String(w.endHour % 24).padStart(2, '0')}:00`,
      w.avgConfirmedCarbsG === undefined ? '—' : Number(w.avgConfirmedCarbsG.toFixed(0)),
      w.avgProteinG === undefined ? '—' : Number(w.avgProteinG.toFixed(0)),
      w.avgFatG === undefined ? '—' : Number(w.avgFatG.toFixed(0)),
      w.avgFiberG === undefined ? '—' : Number(w.avgFiberG.toFixed(0)),
      w.avgRapidUnits === undefined ? '—' : Number(w.avgRapidUnits.toFixed(1)),
      w.avgBasalUnits === undefined ? '—' : Number(w.avgBasalUnits.toFixed(1)),
      outcomeCell(w, 1),
      outcomeCell(w, 2),
      outcomeCell(w, 3),
    ]),
    [],
    ['"En rango" = % de dosis rápidas tras las cuales había una lectura entre 70 y 180 mg/dL a esa hora.'],
    ['"Bajo" (<70) y "alto" (>180) se muestran por separado: quedar fuera de rango por abajo y por arriba son cosas opuestas.'],
    [`Observación descriptiva, no una medida de si la dosis fue adecuada. Solo se muestra con al menos ${MIN_SAMPLE_FOR_RATE} dosis.`],
    ['Proteína, grasa y fibra: promedio de las comidas donde se anotaron. Un guion significa que no se registraron, no que fueran cero.'],
    [macroProvenanceNote(data.meals).trim() || 'Sin comidas con macros en este rango.'],
    ['Type 1A nunca decide ni sugiere una dosis por su cuenta: su calculadora solo aplica los parámetros que cargó la propia usuaria.'],
  ];

  // Fase 14: la misma comparación que el PDF. Un dato que solo existe en la
  // app no llega a la consulta médica.
  const macroGlucoseRow = (label: string, group: MacroGlucoseComparison['higher']): (string | number)[] => [
    label,
    Number(group.avgFatProteinG.toFixed(0)),
    group.mealCount,
    ...[2, 3, 4, 5].map((hours) => {
      const point = group.points.find((p) => p.horizonHours === hours);
      if (point === undefined || point.meanDeltaMgDl === undefined) return `sin dato (n=${point?.sampleSize ?? 0})`;
      const sign = point.meanDeltaMgDl >= 0 ? '+' : '';
      return `${sign}${point.meanDeltaMgDl.toFixed(0)} (n=${point.sampleSize})`;
    }),
  ];
  const macroGlucoseSheetData: (string | number)[][] = macroGlucose === null
    ? [
      ['Grasa y proteína frente a la glucosa tardía'],
      ['Todavía no hay suficientes comidas con grasa y proteína anotadas para comparar.'],
    ]
    : [
      ['Grasa y proteína frente a la glucosa tardía'],
      ['Cambio promedio de glucosa (mg/dL) respecto del momento de comer'],
      [],
      ['Grupo', 'Grasa+proteína prom. (g)', 'Comidas', '+2 h', '+3 h', '+4 h', '+5 h'],
      macroGlucoseRow('Más grasa + proteína', macroGlucose.higher),
      macroGlucoseRow('Menos', macroGlucose.lower),
      [],
      [`Corte en ${macroGlucose.splitAtFatProteinG.toFixed(0)} g, la mediana de ${macroGlucose.eligibleMealCount} comidas con ambos macros anotados.`],
      ['En diabetes tipo 1 la grasa y la proteína tienden a mover la glucosa de forma retrasada y prolongada (1,5-6 h), con efecto aditivo cuando la comida es alta en ambas.'],
      ['Descripción de lo ya ocurrido, no una medida de si una dosis fue adecuada.'],
      ['Type 1A nunca decide ni sugiere una dosis por su cuenta: su calculadora solo aplica los parámetros que cargó la propia usuaria.'],
    ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(summarySheetData), 'Resumen');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(patternsSheetData), 'Patrones');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(macroGlucoseSheetData), 'Grasa y proteína');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(reportSheetData), 'Reporte');
  return XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }) as Uint8Array;
}
