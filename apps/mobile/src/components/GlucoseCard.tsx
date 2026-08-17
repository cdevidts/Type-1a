import { StyleSheet, Text, View } from 'react-native';

import { assessFreshness, latestLiveReading, liveReadings } from '@type1a/domain';
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

  return (
    <View style={styles.card}>
      <View style={styles.headerRow}>
        <View>
          <Text style={styles.eyebrow}>GLUCOSA ACTUAL</Text>
          <Text style={styles.source}>{status?.provider ?? 'Sin proveedor conectado'}</Text>
        </View>
        <View style={[
          styles.badge,
          isSynthetic ? styles.syntheticBadge : isStale ? styles.staleBadge : styles.liveBadge,
        ]}>
          <Text style={[
            styles.badgeText,
            isSynthetic ? styles.syntheticText : isStale ? styles.staleText : styles.liveText,
          ]}>
            {isSynthetic ? 'SINTÉTICO' : isStale ? 'ATRASADO' : 'EN LÍNEA'}
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
          <Text style={[styles.timestamp, isStale && styles.staleText]}>
            Fuente {formatClock(latest.sourceTimestamp)} · {relativeAge(latest.sourceTimestamp)}
          </Text>
        </>
      )}

      <GlucoseChart readings={liveReadings(readings)} />
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
