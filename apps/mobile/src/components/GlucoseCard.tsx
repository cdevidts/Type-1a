import { StyleSheet, Text, View } from 'react-native';

import { assessFreshness, isSensorReading, latestLiveReading } from '@type1a/domain';
import type { CGMProviderStatus, CGMReading } from '@type1a/schemas';

import { formatClock, relativeAge, trendArrow } from '../format';
import { colors, radius, spacing } from '../theme';
import { GlucoseChart } from './GlucoseChart';

export function GlucoseCard({
  readings,
  status,
}: {
  readings: readonly CGMReading[];
  status: CGMProviderStatus | null;
}) {
  const latest = latestLiveReading(readings);
  const freshness = latest === null ? null : assessFreshness(latest.sourceTimestamp);
  const isStale = freshness?.state !== 'connected';
  const isSynthetic = latest?.origin === 'synthetic' || status?.isSynthetic === true;
  // A hand-typed measurement is a legitimate current value, but it is not
  // proof the sensor is streaming — badging it "EN LÍNEA" under the
  // provider's name would hide a sensor outage behind a fingerstick.
  const isManual = latest !== null && latest.origin === 'manual';
  const showsSensorValue = latest !== null && isSensorReading(latest);

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.eyebrow}>GLUCOSA ACTUAL</Text>
          <Text style={styles.source}>
            {isManual
              ? 'Medición manual · el sensor no la respalda'
              : status?.provider ?? 'Sin proveedor conectado'}
          </Text>
        </View>
        <View style={[
          styles.badge,
          isSynthetic ? styles.syntheticBadge : isManual ? styles.manualBadge : isStale ? styles.staleBadge : styles.liveBadge,
        ]}>
          <Text style={[
            styles.badgeText,
            isSynthetic ? styles.syntheticText : isManual ? styles.manualText : isStale ? styles.staleText : styles.liveText,
          ]}>
            {isSynthetic ? 'SINTÉTICO' : isManual ? 'MANUAL' : isStale ? 'ATRASADO' : 'EN LÍNEA'}
          </Text>
        </View>
      </View>

      {latest === null ? (
        <View style={styles.noReading}>
          <Text style={styles.noReadingTitle}>Sin lecturas CGM</Text>
          <Text style={styles.noReadingCopy}>Puedes seguir registrando carbohidratos e insulina sin conexión.</Text>
        </View>
      ) : (
        <>
          <View style={styles.valueRow}>
            <Text style={[styles.value, isStale && styles.staleValue]}>{latest.glucose}</Text>
            <View style={styles.valueMeta}>
              <Text style={[styles.arrow, isStale && styles.staleValue]}>{trendArrow[latest.trend]}</Text>
              <Text style={styles.unit}>mg/dL</Text>
            </View>
          </View>
          <Text style={[styles.timestamp, isStale && !isManual && styles.staleText]}>
            {showsSensorValue ? 'Sensor' : 'Registrado'} {formatClock(latest.sourceTimestamp)} · {relativeAge(latest.sourceTimestamp)}
          </Text>
        </>
      )}

      {/*
        Full readings, including imported history — this is a multi-day
        scrollable trend chart, not a "current status" indicator, so
        showing imported points in their correct historical position is
        accurate, not a live/imported mixup. GlucoseChart itself uses
        latestLiveReading to decide which point (if any) gets the
        "current/Ahora" emphasis, and visually distinguishes imported
        points (hollow marker) from live ones (filled) — imported data is
        never drawn as if it were the current reading.
      */}
      <GlucoseChart readings={readings} />
      <Text style={styles.disclaimer}>No sustituye las alarmas ni la app oficial de FreeStyle.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.lg,
    shadowColor: '#14212A',
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  eyebrow: {
    color: colors.navy,
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 1,
  },
  source: {
    color: colors.muted,
    fontSize: 12,
    marginTop: 3,
  },
  badge: {
    borderRadius: 999,
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  liveBadge: { backgroundColor: colors.greenSoft },
  staleBadge: { backgroundColor: colors.redSoft },
  syntheticBadge: { backgroundColor: colors.warningSoft },
  manualBadge: { backgroundColor: colors.tealSoft },
  manualText: { color: colors.navy },
  badgeText: { fontSize: 10, fontWeight: '900', letterSpacing: 0.7 },
  liveText: { color: colors.green },
  staleText: { color: colors.red },
  syntheticText: { color: colors.warning },
  valueRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 10,
  },
  value: {
    color: colors.ink,
    fontSize: 68,
    fontWeight: '800',
    letterSpacing: -4,
    lineHeight: 76,
  },
  valueMeta: { marginLeft: 12 },
  arrow: { color: colors.teal, fontSize: 34, fontWeight: '700', lineHeight: 36 },
  unit: { color: colors.muted, fontSize: 13, marginTop: 2 },
  timestamp: { color: colors.muted, fontSize: 13, marginBottom: 4 },
  staleValue: { color: colors.red },
  noReading: { paddingVertical: 24 },
  noReadingTitle: { color: colors.ink, fontSize: 24, fontWeight: '700' },
  noReadingCopy: { color: colors.muted, fontSize: 14, marginTop: 6, lineHeight: 20 },
  disclaimer: { color: colors.muted, fontSize: 10, textAlign: 'center', marginTop: 10 },
});
