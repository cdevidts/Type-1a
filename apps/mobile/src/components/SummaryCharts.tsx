import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line, Path, Polyline, Rect, Text as SvgText } from 'react-native-svg';

import {
  convertGlucose,
  HIGH_THRESHOLD,
  HYPOGLYCEMIA_THRESHOLD,
  VERY_HIGH_THRESHOLD,
  VERY_LOW_THRESHOLD,
  type AmbulatoryProfile,
  type GlucoseRangeBreakdown,
} from '@type1a/domain';
import type { CGMReading } from '@type1a/schemas';

import { colors, glucoseBands, radius, spacing } from '../theme';

/**
 * Gráficos de la pantalla "Resumen". Todos son SVG con `react-native-svg`,
 * el mismo motor que ya usa `GlucoseChart` — sin dependencias nuevas.
 *
 * Reglas de diseño aplicadas (skill `dataviz` + `docs/UX_GUIDELINES.md`):
 * eje único, grilla y ejes recesivos (`colors.line`/`colors.muted`), marcas
 * finas, leyenda presente siempre que haya más de una serie, y **ninguna
 * identidad codificada solo por color** — cada banda lleva su etiqueta y su
 * rango en mg/dL. Los umbrales 70/180/54/250 vienen de `packages/domain`,
 * nunca se re-declaran acá.
 */

const CHART_HEIGHT = 190;
const PAD_TOP = 12;
const PAD_BOTTOM = 26;
const AXIS_WIDTH = 34;
const MIN_GLUCOSE = 40;
const MAX_GLUCOSE = 320;
const MINUTES_PER_DAY = 1440;
const HOUR_TICKS = [0, 6, 12, 18, 24];
/** Etiquetas del eje Y: solo los umbrales que importan clínicamente. */
const Y_LABELS = [HYPOGLYCEMIA_THRESHOLD, HIGH_THRESHOLD, VERY_HIGH_THRESHOLD];

function plotHeight(): number {
  return CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
}

function yFor(mgDl: number): number {
  const clamped = Math.max(MIN_GLUCOSE, Math.min(MAX_GLUCOSE, mgDl));
  return PAD_TOP + ((MAX_GLUCOSE - clamped) / (MAX_GLUCOSE - MIN_GLUCOSE)) * plotHeight();
}

function xFor(minuteOfDay: number, plotWidth: number): number {
  return AXIS_WIDTH + (minuteOfDay / MINUTES_PER_DAY) * plotWidth;
}

export function bandColorFor(mgDl: number): string {
  if (mgDl < VERY_LOW_THRESHOLD) return glucoseBands.veryLow;
  if (mgDl < HYPOGLYCEMIA_THRESHOLD) return glucoseBands.low;
  if (mgDl <= HIGH_THRESHOLD) return glucoseBands.target;
  if (mgDl <= VERY_HIGH_THRESHOLD) return glucoseBands.high;
  return glucoseBands.veryHigh;
}

function minutesOfLocalDay(isoTimestamp: string): number {
  const date = new Date(isoTimestamp);
  return date.getHours() * 60 + date.getMinutes();
}

/** Grilla horaria + banda objetivo + etiquetas de eje, común a los dos gráficos de 24 h. */
function ChartFrame({ plotWidth }: { plotWidth: number }) {
  return (
    <G>
      <Rect
        x={AXIS_WIDTH}
        y={PAD_TOP}
        width={plotWidth}
        height={plotHeight()}
        fill={colors.surface}
        stroke={colors.line}
        strokeWidth={1}
      />
      {/* Banda objetivo 70-180: el área que el usuario quiere habitar. */}
      <Rect
        x={AXIS_WIDTH}
        y={yFor(HIGH_THRESHOLD)}
        width={plotWidth}
        height={yFor(HYPOGLYCEMIA_THRESHOLD) - yFor(HIGH_THRESHOLD)}
        fill={colors.tealSoft}
      />
      {HOUR_TICKS.map((hour) => (
        <G key={`h-${hour}`}>
          <Line
            x1={xFor(hour * 60, plotWidth)}
            y1={PAD_TOP}
            x2={xFor(hour * 60, plotWidth)}
            y2={PAD_TOP + plotHeight()}
            stroke={colors.line}
            strokeWidth={1}
          />
          <SvgText
            x={xFor(hour * 60, plotWidth)}
            y={CHART_HEIGHT - 8}
            fontSize={10}
            fill={colors.muted}
            textAnchor="middle"
          >
            {`${String(hour % 24).padStart(2, '0')}:00`}
          </SvgText>
        </G>
      ))}
      {Y_LABELS.map((value) => (
        <G key={`y-${value}`}>
          <Line
            x1={AXIS_WIDTH}
            y1={yFor(value)}
            x2={AXIS_WIDTH + plotWidth}
            y2={yFor(value)}
            stroke={value === VERY_HIGH_THRESHOLD ? colors.line : bandColorFor(value === HYPOGLYCEMIA_THRESHOLD ? 60 : 200)}
            strokeWidth={1}
            strokeDasharray="4,3"
          />
          <SvgText x={AXIS_WIDTH - 5} y={yFor(value) + 3} fontSize={10} fill={colors.muted} textAnchor="end">
            {value}
          </SvgText>
        </G>
      ))}
    </G>
  );
}

/**
 * Cualquier lectura que no salió del feed del sensor recibe el mismo trato
 * "esto no es dato de sensor en vivo" — misma definición que `GlucoseChart`
 * (`origin === 'imported' || origin === 'manual'`). Un capilar tecleado a
 * mano no puede verse idéntico a una lectura del CGM (AGENTS.md).
 */
export function isNonSensorReading(reading: CGMReading): boolean {
  return reading.origin === 'imported' || reading.origin === 'manual';
}

/**
 * Un día concreto: cada lectura en su hora real. Igual que `GlucoseChart`,
 * la distinción sensor/no-sensor vive **también en el trazo**, no solo en
 * los puntos: una tirada larga de historial importado unida por una línea
 * sólida se leería como cobertura continua de sensor aunque los puntos
 * estén atenuados.
 */
export function DayGlucoseChart({ readings, width }: { readings: readonly CGMReading[]; width: number }) {
  const plotWidth = Math.max(120, width - AXIS_WIDTH - 6);

  const { points, segments } = useMemo(() => {
    const coordinates = [...readings]
      .sort((a, b) => Date.parse(a.sourceTimestamp) - Date.parse(b.sourceTimestamp))
      .map((reading) => {
        const mgDl = convertGlucose(reading.glucose, reading.unit, 'mg/dL');
        return {
          key: reading.id,
          x: xFor(minutesOfLocalDay(reading.sourceTimestamp), plotWidth),
          y: yFor(mgDl),
          mgDl,
          nonSensor: isNonSensorReading(reading),
        };
      });

    // Tramos contiguos del mismo origen, cada uno con su propia polyline y
    // compartiendo el punto de frontera con el vecino para que la línea se
    // vea continua.
    const runs: { key: string; points: string; nonSensor: boolean }[] = [];
    let runStart = 0;
    for (let i = 1; i <= coordinates.length; i += 1) {
      const atEnd = i === coordinates.length;
      if (atEnd || coordinates[i]!.nonSensor !== coordinates[runStart]!.nonSensor) {
        const runEnd = atEnd ? i - 1 : i;
        const run = coordinates.slice(runStart, runEnd + 1);
        if (run.length > 1) {
          runs.push({
            key: `seg-${runStart}`,
            points: run.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
            nonSensor: coordinates[runStart]!.nonSensor,
          });
        }
        runStart = runEnd;
      }
    }
    return { points: coordinates, segments: runs };
  }, [readings, plotWidth]);

  return (
    <Svg width={width} height={CHART_HEIGHT}>
      <ChartFrame plotWidth={plotWidth} />
      {segments.map((segment) => (
        <Polyline
          key={segment.key}
          points={segment.points}
          fill="none"
          stroke={segment.nonSensor ? colors.muted : colors.navy}
          strokeWidth={1.2}
          strokeDasharray={segment.nonSensor ? '3,3' : '0'}
          opacity={segment.nonSensor ? 0.55 : 0.35}
        />
      ))}
      {points.map((point) => (
        <Circle
          key={point.key}
          cx={point.x}
          cy={point.y}
          r={2.4}
          fill={point.nonSensor ? colors.surface : bandColorFor(point.mgDl)}
          stroke={bandColorFor(point.mgDl)}
          strokeWidth={point.nonSensor ? 1.2 : 0}
          opacity={point.nonSensor ? 0.75 : 1}
        />
      ))}
    </Svg>
  );
}

function bandPath(
  buckets: AmbulatoryProfile['buckets'],
  lower: (b: AmbulatoryProfile['buckets'][number]) => number,
  upper: (b: AmbulatoryProfile['buckets'][number]) => number,
  bucketMinutes: number,
  plotWidth: number,
): string {
  if (buckets.length === 0) return '';
  const centre = (b: AmbulatoryProfile['buckets'][number]): number =>
    xFor(b.startMinute + bucketMinutes / 2, plotWidth);
  const top = buckets.map((b) => `${centre(b).toFixed(1)},${yFor(upper(b)).toFixed(1)}`);
  const bottom = [...buckets].reverse().map((b) => `${centre(b).toFixed(1)},${yFor(lower(b)).toFixed(1)}`);
  return `M${top.join('L')}L${bottom.join('L')}Z`;
}

/**
 * Perfil ambulatorio (AGP): el "día promedio ponderado". Cinco curvas sobre
 * un único día de 24 h — mediana, intercuartil (p25–p75) e interdecil
 * (p05–p95) — que es el formato estándar de los reportes de CGM y el que un
 * equipo clínico ya sabe leer.
 */
export function AgpChart({ profile, width }: { profile: AmbulatoryProfile; width: number }) {
  const plotWidth = Math.max(120, width - AXIS_WIDTH - 6);
  const { buckets, bucketMinutes } = profile;

  const medianPoints = buckets
    .map((b) => `${xFor(b.startMinute + bucketMinutes / 2, plotWidth).toFixed(1)},${yFor(b.p50).toFixed(1)}`)
    .join(' ');

  return (
    <Svg width={width} height={CHART_HEIGHT}>
      <ChartFrame plotWidth={plotWidth} />
      <Path
        d={bandPath(buckets, (b) => b.p05, (b) => b.p95, bucketMinutes, plotWidth)}
        fill={colors.navy}
        opacity={0.12}
      />
      <Path
        d={bandPath(buckets, (b) => b.p25, (b) => b.p75, bucketMinutes, plotWidth)}
        fill={colors.navy}
        opacity={0.26}
      />
      {buckets.length > 1 ? (
        <Polyline points={medianPoints} fill="none" stroke={colors.navy} strokeWidth={2} />
      ) : null}
    </Svg>
  );
}

/** Leyenda del AGP — obligatoria: son tres series, no una. */
export function AgpLegend() {
  return (
    <View style={styles.legendRow}>
      <LegendItem swatch={<View style={[styles.legendLine, { backgroundColor: colors.navy }]} />} label="Mediana" />
      <LegendItem
        swatch={<View style={[styles.legendSwatch, { backgroundColor: colors.navy, opacity: 0.26 }]} />}
        label="50% central (p25–p75)"
      />
      <LegendItem
        swatch={<View style={[styles.legendSwatch, { backgroundColor: colors.navy, opacity: 0.12 }]} />}
        label="90% central (p05–p95)"
      />
    </View>
  );
}

function LegendItem({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <View style={styles.legendItem}>
      {swatch}
      <Text style={styles.legendLabel}>{label}</Text>
    </View>
  );
}

/**
 * Metas de consenso ATTD/ADA (Battelino et al. 2019) para diabetes tipo 1.
 * Son referencias poblacionales publicadas, NO un parámetro de terapia
 * personal ni algo que la app infiera — se muestran como contexto de
 * lectura, y el objetivo individual siempre lo define el equipo clínico.
 */
export const TIR_CONSENSUS_TARGETS: Record<keyof GlucoseRangeBreakdown, string> = {
  veryLowPct: 'meta <1%',
  lowPct: 'meta <4% junto con muy bajo',
  targetPct: 'meta >70%',
  highPct: 'meta <25% junto con muy alto',
  veryHighPct: 'meta <5%',
};

export const TIR_BANDS: {
  key: keyof GlucoseRangeBreakdown;
  label: string;
  range: string;
  color: string;
}[] = [
  { key: 'veryHighPct', label: 'Muy alto', range: `>${VERY_HIGH_THRESHOLD} mg/dL`, color: glucoseBands.veryHigh },
  { key: 'highPct', label: 'Alto', range: `${HIGH_THRESHOLD + 1}–${VERY_HIGH_THRESHOLD} mg/dL`, color: glucoseBands.high },
  { key: 'targetPct', label: 'En rango', range: `${HYPOGLYCEMIA_THRESHOLD}–${HIGH_THRESHOLD} mg/dL`, color: glucoseBands.target },
  { key: 'lowPct', label: 'Bajo', range: `${VERY_LOW_THRESHOLD}–${HYPOGLYCEMIA_THRESHOLD - 1} mg/dL`, color: glucoseBands.low },
  { key: 'veryLowPct', label: 'Muy bajo', range: `<${VERY_LOW_THRESHOLD} mg/dL`, color: glucoseBands.veryLow },
];

/**
 * Barra apilada vertical de Time in Range, con cada banda etiquetada al
 * lado. El orden es el clínico (muy alto arriba → muy bajo abajo), igual
 * que en los reportes de CGM estándar.
 */
export function RangeBar({ range }: { range: GlucoseRangeBreakdown }) {
  return (
    <View>
      <View style={styles.rangeBarRow}>
        <View style={styles.rangeBarColumn}>
          {TIR_BANDS.map((band) => {
            const value = range[band.key];
            if (value <= 0) return null;
            return (
              <View
                key={band.key}
                style={{ flex: value, backgroundColor: band.color, minHeight: 3 }}
                accessibilityLabel={`${band.label}, ${value.toFixed(0)} por ciento`}
              />
            );
          })}
        </View>
        <View style={styles.rangeLegendColumn}>
          {TIR_BANDS.map((band) => (
            <View key={band.key} style={styles.rangeLegendRow}>
              <View style={[styles.rangeSwatch, { backgroundColor: band.color }]} />
              <View style={styles.rangeLegendCopy}>
                <Text style={styles.rangeLegendLabel}>
                  {band.label} · <Text style={styles.rangeLegendValue}>{range[band.key].toFixed(1)}%</Text>
                </Text>
                <Text style={styles.rangeLegendRange}>
                  {band.range} · {TIR_CONSENSUS_TARGETS[band.key]}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  legendRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.sm },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  legendSwatch: { width: 14, height: 10, borderRadius: 2 },
  legendLine: { width: 14, height: 2, borderRadius: 1 },
  legendLabel: { color: colors.muted, fontSize: 11 },
  rangeBarRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'stretch' },
  rangeBarColumn: {
    width: 26,
    borderRadius: radius.sm,
    overflow: 'hidden',
    backgroundColor: colors.line,
    // 2px de superficie entre segmentos: separa bandas contiguas sin
    // introducir un borde de color que compita con el dato.
    gap: 2,
  },
  rangeLegendColumn: { flex: 1, justifyContent: 'space-between', gap: spacing.sm },
  rangeLegendRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  rangeSwatch: { width: 10, height: 10, borderRadius: 2, marginTop: 3 },
  rangeLegendCopy: { flex: 1 },
  rangeLegendLabel: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  rangeLegendValue: { fontWeight: '800' },
  rangeLegendRange: { color: colors.muted, fontSize: 11, marginTop: 1 },
});
