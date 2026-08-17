import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Polyline, Text as SvgText } from 'react-native-svg';

import type { CGMReading } from '@type1a/schemas';

import { formatClock } from '../format';
import { colors } from '../theme';

const WIDTH = 320;
const HEIGHT = 150;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 10;
const PADDING_LEFT = 32;
const PADDING_RIGHT = 12;
const MIN_GLUCOSE = 50;
const MAX_GLUCOSE = 250;
const LOW_THRESHOLD = 70;
const HIGH_THRESHOLD = 180;

function yForGlucose(glucose: number): number {
  const clamped = Math.max(MIN_GLUCOSE, Math.min(MAX_GLUCOSE, glucose));
  return PADDING_TOP + ((MAX_GLUCOSE - clamped) / (MAX_GLUCOSE - MIN_GLUCOSE)) * (HEIGHT - PADDING_TOP - PADDING_BOTTOM);
}

function colorForGlucose(glucose: number): string {
  if (glucose < LOW_THRESHOLD) return colors.red;
  if (glucose > HIGH_THRESHOLD) return colors.orange;
  return colors.teal;
}

export function GlucoseChart({ readings }: { readings: readonly CGMReading[] }) {
  const points = useMemo(() => readings.slice(-40), [readings]);
  if (points.length < 2) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>El gráfico aparecerá al recibir al menos dos lecturas.</Text>
      </View>
    );
  }

  const firstMs = Date.parse(points[0]!.sourceTimestamp);
  const lastMs = Date.parse(points.at(-1)!.sourceTimestamp);
  const span = Math.max(1, lastMs - firstMs);
  const coordinates = points.map((reading) => ({
    x: PADDING_LEFT + ((Date.parse(reading.sourceTimestamp) - firstMs) / span) * (WIDTH - PADDING_LEFT - PADDING_RIGHT),
    y: yForGlucose(reading.glucose),
    glucose: reading.glucose,
  }));
  const polyline = coordinates.map(({ x, y }) => `${x},${y}`).join(' ');
  const latest = coordinates.at(-1)!;
  const midIndex = Math.floor((points.length - 1) / 2);

  return (
    <View>
      <Svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} accessibilityLabel="Gráfico de glucosa de las últimas tres horas">
        <Line x1={PADDING_LEFT} y1={yForGlucose(HIGH_THRESHOLD)} x2={WIDTH - PADDING_RIGHT} y2={yForGlucose(HIGH_THRESHOLD)} stroke={colors.orange} strokeDasharray="4 4" opacity={0.55} />
        <Line x1={PADDING_LEFT} y1={yForGlucose(LOW_THRESHOLD)} x2={WIDTH - PADDING_RIGHT} y2={yForGlucose(LOW_THRESHOLD)} stroke={colors.red} strokeDasharray="4 4" opacity={0.55} />
        <SvgText x={PADDING_LEFT - 6} y={yForGlucose(HIGH_THRESHOLD) + 3} fontSize={10} fill={colors.muted} textAnchor="end">{HIGH_THRESHOLD}</SvgText>
        <SvgText x={PADDING_LEFT - 6} y={yForGlucose(LOW_THRESHOLD) + 3} fontSize={10} fill={colors.muted} textAnchor="end">{LOW_THRESHOLD}</SvgText>
        <Polyline points={polyline} fill="none" stroke={colors.teal} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" opacity={0.8} />
        {coordinates.slice(0, -1).map((point, index) => (
          <Circle key={`${points[index]!.id}-${index}`} cx={point.x} cy={point.y} r={2.75} fill={colorForGlucose(point.glucose)} />
        ))}
        <Circle cx={latest.x} cy={latest.y} r={6} fill={colors.surface} stroke={colorForGlucose(latest.glucose)} strokeWidth={3} />
      </Svg>
      <View style={styles.legend}>
        <Text style={styles.legendText}>{formatClock(points[0]!.sourceTimestamp)}</Text>
        <Text style={styles.legendText}>{formatClock(points[midIndex]!.sourceTimestamp)}</Text>
        <Text style={styles.legendText}>Ahora · {formatClock(points.at(-1)!.sourceTimestamp)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  empty: {
    height: HEIGHT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
  },
  emptyText: {
    color: colors.muted,
    fontSize: 13,
    textAlign: 'center',
  },
  legend: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
    marginTop: 2,
  },
  legendText: {
    color: colors.muted,
    fontSize: 11,
  },
});
