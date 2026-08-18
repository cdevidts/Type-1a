import { useEffect, useMemo, useRef } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Line, Polyline, Text as SvgText } from 'react-native-svg';

import { latestLiveReading } from '@type1a/domain';
import type { CGMReading } from '@type1a/schemas';

import { colors } from '../theme';

const HEIGHT = 150;
const PADDING_TOP = 10;
const PADDING_BOTTOM = 24;
const AXIS_WIDTH = 30;
const PIXELS_PER_HOUR = 30;
const MIN_PLOT_WIDTH = 280;
const MIN_GLUCOSE = 50;
const MAX_GLUCOSE = 250;
const LOW_THRESHOLD = 70;
const HIGH_THRESHOLD = 180;
// Past this many points, stop drawing a marker for every single reading —
// the line stays full-resolution, only the dots thin out. Keeps a
// multi-day view from asking react-native-svg to lay out thousands of
// circles at once.
const MAX_MARKERS = 300;

function yForGlucose(glucose: number): number {
  const clamped = Math.max(MIN_GLUCOSE, Math.min(MAX_GLUCOSE, glucose));
  return PADDING_TOP + ((MAX_GLUCOSE - clamped) / (MAX_GLUCOSE - MIN_GLUCOSE)) * (HEIGHT - PADDING_TOP - PADDING_BOTTOM);
}

function colorForGlucose(glucose: number): string {
  if (glucose < LOW_THRESHOLD) return colors.red;
  if (glucose > HIGH_THRESHOLD) return colors.orange;
  return colors.teal;
}

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function formatDayLabel(ms: number): string {
  return new Intl.DateTimeFormat('es-CL', { day: '2-digit', month: 'short' }).format(new Date(ms));
}

function formatHourLabel(ms: number): string {
  return new Intl.DateTimeFormat('es-CL', { hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
}

export function GlucoseChart({ readings }: { readings: readonly CGMReading[] }) {
  const scrollRef = useRef<ScrollView>(null);
  const hasAutoScrolledRef = useRef(false);

  const points = useMemo(
    () => [...readings].sort((a, b) => Date.parse(a.sourceTimestamp) - Date.parse(b.sourceTimestamp)),
    [readings],
  );

  const latestLive = useMemo(() => latestLiveReading(points), [points]);

  const chart = useMemo(() => {
    if (points.length < 2) return null;
    const firstMs = Date.parse(points[0]!.sourceTimestamp);
    const lastMs = Date.parse(points.at(-1)!.sourceTimestamp);
    const hoursSpan = Math.max(0.5, (lastMs - firstMs) / (60 * 60_000));
    const plotWidth = Math.max(MIN_PLOT_WIDTH, hoursSpan * PIXELS_PER_HOUR);
    const span = Math.max(1, lastMs - firstMs);
    const xFor = (ms: number): number => ((ms - firstMs) / span) * plotWidth;

    const coordinates = points.map((reading) => ({
      x: xFor(Date.parse(reading.sourceTimestamp)),
      y: yForGlucose(reading.glucose),
      glucose: reading.glucose,
      imported: reading.origin === 'imported',
      id: reading.id,
    }));

    // The line itself must carry the imported/live distinction, not just
    // the (thinned-out) markers — at multi-day density most points don't
    // get a marker at all, so a long imported stretch with no dots would
    // otherwise render as an undifferentiated line, indistinguishable from
    // live data. Split into contiguous same-origin runs, each its own
    // Polyline, sharing one boundary point with its neighbor so the line
    // stays visually continuous.
    const segments: { key: string; points: string; imported: boolean }[] = [];
    let runStart = 0;
    for (let i = 1; i <= coordinates.length; i += 1) {
      const atEnd = i === coordinates.length;
      if (atEnd || coordinates[i]!.imported !== coordinates[runStart]!.imported) {
        const runEnd = atEnd ? i - 1 : i;
        const run = coordinates.slice(runStart, runEnd + 1);
        segments.push({
          key: `seg-${runStart}`,
          points: run.map(({ x, y }) => `${x},${y}`).join(' '),
          imported: coordinates[runStart]!.imported,
        });
        runStart = runEnd;
      }
    }

    const markerStep = Math.max(1, Math.ceil(coordinates.length / MAX_MARKERS));
    const markers = coordinates.filter((_, index) => index % markerStep === 0);

    const dayBoundaries: { x: number; label: string }[] = [];
    for (let dayStart = startOfDay(firstMs); dayStart <= lastMs; dayStart += 24 * 60 * 60_000) {
      if (dayStart < firstMs) continue;
      dayBoundaries.push({ x: xFor(dayStart), label: formatDayLabel(dayStart) });
    }

    const latestCoordinate = latestLive === undefined || latestLive === null
      ? null
      : (() => {
          const ms = Date.parse(latestLive.sourceTimestamp);
          return { x: xFor(ms), y: yForGlucose(latestLive.glucose) };
        })();

    return { plotWidth, coordinates, segments, markers, dayBoundaries, latestCoordinate, firstMs, lastMs };
  }, [points, latestLive]);

  useEffect(() => {
    if (chart === null || hasAutoScrolledRef.current) return;
    hasAutoScrolledRef.current = true;
    // Defer to the next tick so the ScrollView has measured its content.
    setTimeout(() => scrollRef.current?.scrollToEnd({ animated: false }), 0);
  }, [chart]);

  if (chart === null) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyText}>El gráfico aparecerá al recibir al menos dos lecturas.</Text>
      </View>
    );
  }

  const { plotWidth, segments, markers, dayBoundaries, latestCoordinate } = chart;

  return (
    <View>
      <View style={styles.row}>
        <Svg width={AXIS_WIDTH} height={HEIGHT} accessibilityElementsHidden>
          <SvgText x={AXIS_WIDTH - 4} y={yForGlucose(HIGH_THRESHOLD) + 3} fontSize={10} fill={colors.muted} textAnchor="end">{HIGH_THRESHOLD}</SvgText>
          <SvgText x={AXIS_WIDTH - 4} y={yForGlucose(LOW_THRESHOLD) + 3} fontSize={10} fill={colors.muted} textAnchor="end">{LOW_THRESHOLD}</SvgText>
        </Svg>
        <ScrollView
          ref={scrollRef}
          horizontal
          showsHorizontalScrollIndicator={false}
          accessibilityLabel="Gráfico de glucosa — desliza para ver días anteriores"
        >
          <Svg width={plotWidth} height={HEIGHT}>
            <Line x1={0} y1={yForGlucose(HIGH_THRESHOLD)} x2={plotWidth} y2={yForGlucose(HIGH_THRESHOLD)} stroke={colors.orange} strokeDasharray="4 4" opacity={0.55} />
            <Line x1={0} y1={yForGlucose(LOW_THRESHOLD)} x2={plotWidth} y2={yForGlucose(LOW_THRESHOLD)} stroke={colors.red} strokeDasharray="4 4" opacity={0.55} />
            {dayBoundaries.map((boundary) => (
              <Line key={boundary.x} x1={boundary.x} y1={PADDING_TOP} x2={boundary.x} y2={HEIGHT - PADDING_BOTTOM} stroke={colors.line} strokeWidth={1.5} />
            ))}
            {dayBoundaries.map((boundary) => (
              <SvgText key={`label-${boundary.x}`} x={boundary.x + 4} y={HEIGHT - 8} fontSize={10} fill={colors.muted}>{boundary.label}</SvgText>
            ))}
            {segments.map((segment) => (
              <Polyline
                key={segment.key}
                points={segment.points}
                fill="none"
                stroke={segment.imported ? colors.muted : colors.teal}
                strokeWidth={2.5}
                strokeDasharray={segment.imported ? '5 4' : 'none'}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={segment.imported ? 0.65 : 0.8}
              />
            ))}
            {markers.map((point) => (
              point.imported ? (
                <Circle key={point.id} cx={point.x} cy={point.y} r={2.75} fill={colors.surface} stroke={colorForGlucose(point.glucose)} strokeWidth={1.5} opacity={0.85} />
              ) : (
                <Circle key={point.id} cx={point.x} cy={point.y} r={2.75} fill={colorForGlucose(point.glucose)} />
              )
            ))}
            {latestCoordinate === null ? null : (
              <Circle cx={latestCoordinate.x} cy={latestCoordinate.y} r={6} fill={colors.surface} stroke={colorForGlucose(latestLive!.glucose)} strokeWidth={3} />
            )}
          </Svg>
        </ScrollView>
      </View>
      <View style={styles.legend}>
        <Text style={styles.legendText}>{formatHourLabel(Date.parse(points[0]!.sourceTimestamp))}</Text>
        <View style={styles.legendHints}>
          <View style={styles.legendDot} />
          <Text style={styles.legendText}>en vivo</Text>
          <View style={[styles.legendDot, styles.legendDotImported]} />
          <Text style={styles.legendText}>importado</Text>
        </View>
        <Text style={styles.legendText}>
          {latestLive === null ? 'Sin lectura en vivo' : `Ahora · ${formatHourLabel(Date.parse(latestLive.sourceTimestamp))}`}
        </Text>
      </View>
      <Text style={styles.scrollHint}>Desliza el gráfico hacia la izquierda para ver días anteriores.</Text>
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
  row: {
    flexDirection: 'row',
  },
  legend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: AXIS_WIDTH + 4,
    paddingRight: 6,
    marginTop: 2,
  },
  legendHints: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  legendDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: colors.teal,
  },
  legendDotImported: {
    backgroundColor: colors.surface,
    borderWidth: 1.5,
    borderColor: colors.teal,
  },
  legendText: {
    color: colors.muted,
    fontSize: 11,
  },
  scrollHint: {
    color: colors.muted,
    fontSize: 10,
    textAlign: 'center',
    marginTop: 6,
  },
});
