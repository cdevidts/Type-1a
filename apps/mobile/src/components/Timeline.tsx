import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatDayTime } from '../format';
import { colors, radius, spacing } from '../theme';
import type { TimelineItem } from '../types';
import { TimelineDetailModal } from './TimelineDetailModal';

const toneColors = {
  blue: colors.blue,
  navy: colors.navy,
  orange: colors.orange,
  green: colors.green,
  teal: colors.teal,
  warning: colors.warning,
  muted: colors.muted,
} as const;

export function Timeline({ items }: { items: readonly TimelineItem[] }) {
  const [selected, setSelected] = useState<TimelineItem | null>(null);

  return (
    <View style={styles.section}>
      <Text style={styles.title}>Timeline</Text>
      <Text style={styles.subtitle}>Lo registrado en este teléfono — toca un ítem para ver el detalle</Text>
      {items.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyTitle}>Todavía no hay eventos</Text>
          <Text style={styles.emptyCopy}>Usa un acceso rápido para registrar el primero.</Text>
        </View>
      ) : items.map((item) => (
        <Pressable
          key={`${item.kind}:${item.id}`}
          style={styles.item}
          onPress={() => { setSelected(item); }}
          accessibilityRole="button"
          accessibilityLabel={`Ver detalle de ${item.title}`}
        >
          <View style={[styles.dot, { backgroundColor: toneColors[item.tone] }]} />
          <View style={styles.itemBody}>
            <View style={styles.itemHeader}>
              <Text style={styles.itemTitle}>{item.title}</Text>
              <Text style={styles.time}>{formatDayTime(item.timestamp)}</Text>
            </View>
            <Text style={styles.detail}>{item.detail}</Text>
            {item.kind === 'episode' && item.insight !== undefined ? (
              <Text style={styles.insight}>{item.insight.summary}</Text>
            ) : null}
          </View>
        </Pressable>
      ))}
      <TimelineDetailModal item={selected} onClose={() => { setSelected(null); }} />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { marginTop: spacing.xl },
  title: { color: colors.ink, fontSize: 24, fontWeight: '800' },
  subtitle: { color: colors.muted, fontSize: 13, marginTop: 2, marginBottom: spacing.md },
  empty: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.xl,
    alignItems: 'center',
  },
  emptyTitle: { color: colors.ink, fontSize: 16, fontWeight: '700' },
  emptyCopy: { color: colors.muted, fontSize: 13, marginTop: 5 },
  item: {
    flexDirection: 'row',
    backgroundColor: colors.surface,
    padding: spacing.md,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 7, marginRight: spacing.md },
  itemBody: { flex: 1 },
  itemHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  itemTitle: { color: colors.ink, fontSize: 15, fontWeight: '700', flex: 1 },
  time: { color: colors.muted, fontSize: 11 },
  detail: { color: colors.muted, fontSize: 13, marginTop: 3 },
  insight: { color: colors.navy, fontSize: 13, lineHeight: 18, marginTop: 8 },
});
