import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Polyline } from 'react-native-svg';

import type { CGMReading } from '@type1a/schemas';

import { colors } from '../theme';

const WIDTH = 320;
const HEIGHT = 118;
const PADDING = 12;
const MIN_GLUCOSE = 50;
const MAX_GLUCOSE = 250;

function yForGlucose(glucose: number): number {
  const clamped = Math.max(MIN_GLUCOSE, Math.min(MAX_GLUCOSE, glucose));
  return PADDING + ((MAX_GLUCOSE - clamped) / (MAX_GLUCOSE - MIN_GLUCOSE)) * (HEIGHT - PADDING * 2);
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
    x: PADDING + ((Date.parse(reading.sourceTimestamp) - firstMs) / span) * (WIDTH - PADDING * 2),
    y: yForGlucose(reading.glucose),
  }));
  const polyline = coordinates.map(({ x, y }) => `${x},${y}`).join(' ');
  const latest = coordinates.at(-1)!;

  return (
    <View>
      <Svg width="100%" height={HEIGHT} viewBox={`0 0 ${WIDTH} ${HEIGHT}`} accessibilityLabel="Gráfico de glucosa de las últimas tres horas">
        <Line x1={PADDING} y1={yForGlucose(180)} x2={WIDTH - PADDING} y2={yForGlucose(180)} stroke={colors.orange} strokeDasharray="4 4" opacity={0.55} />
        <Line x1={PADDING} y1={yForGlucose(70)} x2={WIDTH - PADDING} y2={yForGlucose(70)} stroke={colors.red} strokeDasharray="4 4" opacity={0.55} />
        <Polyline points={polyline} fill="none" stroke={colors.teal} strokeWidth={4} strokeLinecap="round" strokeLinejoin="round" />
        <Circle cx={latest.x} cy={latest.y} r={6} fill={colors.surface} stroke={colors.teal} strokeWidth={3} />
      </Svg>
      <View style={styles.legend}>
        <Text style={styles.legendText}>−3 h</Text>
        <Text style={styles.legendText}>Rango guía 70–180</Text>
        <Text style={styles.legendText}>Ahora</Text>
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
    paddingHorizontal: 10,
  },
  legendText: {
    color: colors.muted,
    fontSize: 11,
  },
});
