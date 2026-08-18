import { StyleSheet, Text, View } from 'react-native';

import { formatDayTime, trendArrow } from '../format';
import { colors, spacing } from '../theme';
import type { TimelineItem } from '../types';
import { ModalShell } from './ModalShell';

const originLabel: Record<string, string> = {
  real: 'Sensor en vivo',
  synthetic: 'Sintético (modo demo)',
  imported: 'Importado desde CSV',
  manual: 'Ingresado a mano',
};

const sourceLabel: Record<string, string> = {
  manual: 'Ingresado a mano',
  imported: 'Importado desde CSV',
  meal_confirmed: 'Confirmado desde una comida',
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue}>{value}</Text>
    </View>
  );
}

function rowsFor(item: TimelineItem): { label: string; value: string }[] {
  switch (item.kind) {
    case 'insulin':
      return [
        { label: 'Tipo', value: item.raw.type === 'rapid' ? 'Rápida' : 'Basal' },
        { label: 'Unidades', value: `${item.raw.units} U` },
        ...(item.raw.insulinName === undefined ? [] : [{ label: 'Insulina', value: item.raw.insulinName }]),
        ...(item.raw.purpose === undefined ? [] : [{ label: 'Propósito', value: { meal: 'Comida', correction: 'Corrección', combined: 'Combinado' }[item.raw.purpose] }]),
        { label: 'Origen', value: item.raw.source === 'imported' ? 'Importado desde CSV' : 'Ingresado a mano' },
        { label: 'Hora', value: formatDayTime(item.raw.timestamp) },
      ];
    case 'carbs':
      return [
        { label: 'Carbohidratos', value: `${item.raw.carbsG} g` },
        { label: 'Origen', value: sourceLabel[item.raw.source] ?? item.raw.source },
        { label: 'Hora', value: formatDayTime(item.timestamp) },
      ];
    case 'meal':
      return [
        ...(item.raw.confirmedCarbsG === undefined ? [] : [{ label: 'Carbohidratos confirmados', value: `${item.raw.confirmedCarbsG} g` }]),
        ...(item.raw.aiEstimatedCarbsG === undefined ? [] : [{ label: 'Estimado por IA', value: `${item.raw.aiEstimatedCarbsG} g` }]),
        ...(item.raw.proteinG === undefined ? [] : [{ label: 'Proteína', value: `${item.raw.proteinG} g` }]),
        ...(item.raw.fatG === undefined ? [] : [{ label: 'Grasa', value: `${item.raw.fatG} g` }]),
        ...(item.raw.fiberG === undefined ? [] : [{ label: 'Fibra', value: `${item.raw.fiberG} g` }]),
        ...(item.raw.caloriesKcal === undefined ? [] : [{ label: 'Calorías', value: `${item.raw.caloriesKcal} kcal` }]),
        ...(item.raw.note === undefined ? [] : [{ label: 'Nota', value: item.raw.note }]),
        { label: 'Hora', value: formatDayTime(item.raw.timestamp) },
      ];
    case 'glucose':
      return [
        { label: 'Glucosa', value: `${item.raw.glucose} ${item.raw.unit}` },
        { label: 'Tendencia', value: trendArrow[item.raw.trend] },
        { label: 'Origen', value: originLabel[item.raw.origin] ?? item.raw.origin },
        { label: 'Proveedor', value: item.raw.source },
        { label: 'Hora del sensor', value: formatDayTime(item.raw.sourceTimestamp) },
        { label: 'Hora de sincronización', value: formatDayTime(item.raw.ingestedAt) },
      ];
    case 'episode':
      return [
        ...(item.metrics?.startingGlucose === undefined ? [] : [{ label: 'Glucosa inicial', value: `${item.metrics.startingGlucose} mg/dL` }]),
        ...(item.metrics?.peakGlucose === undefined ? [] : [{ label: 'Pico', value: `${item.metrics.peakGlucose} mg/dL` }]),
        ...(item.metrics?.timeToPeakMinutes === undefined ? [] : [{ label: 'Tiempo al pico', value: `${item.metrics.timeToPeakMinutes} min` }]),
        ...(item.metrics?.minGlucose === undefined ? [] : [{ label: 'Mínimo', value: `${item.metrics.minGlucose} mg/dL` }]),
        ...(item.metrics?.confirmedCarbsG === undefined ? [] : [{ label: 'Carbohidratos', value: `${item.metrics.confirmedCarbsG} g` }]),
        ...(item.metrics?.rapidInsulinUnits === undefined ? [] : [{ label: 'Insulina rápida', value: `${item.metrics.rapidInsulinUnits} U` }]),
        { label: 'Hora de la comida', value: formatDayTime(item.timestamp) },
      ];
  }
}

export function TimelineDetailModal({ item, onClose }: { item: TimelineItem | null; onClose: () => void }) {
  return (
    <ModalShell visible={item !== null} title={item?.title ?? 'Detalle'} onClose={onClose}>
      {item === null ? null : (
        <>
          {rowsFor(item).map((row) => (
            <Row key={row.label} label={row.label} value={row.value} />
          ))}
          {item.kind === 'episode' && item.insight !== undefined ? (
            <View style={styles.insightBox}>
              <Text style={styles.insightTitle}>Análisis post-comida</Text>
              <Text style={styles.insightText}>{item.insight.summary}</Text>
              {item.insight.observations.map((observation) => (
                <Text key={observation} style={styles.insightBullet}>• {observation}</Text>
              ))}
              {item.insight.limitations.length === 0 ? null : (
                <Text style={styles.insightLimitations}>
                  Limitaciones: {item.insight.limitations.join(' · ')}
                </Text>
              )}
            </View>
          ) : null}
        </>
      )}
    </ModalShell>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: { color: colors.muted, fontSize: 13 },
  rowValue: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  insightBox: {
    backgroundColor: colors.tealSoft,
    borderRadius: 12,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  insightTitle: { color: colors.navy, fontSize: 14, fontWeight: '800', marginBottom: 4 },
  insightText: { color: colors.navy, fontSize: 13, lineHeight: 18 },
  insightBullet: { color: colors.navy, fontSize: 12, lineHeight: 17, marginTop: 6 },
  insightLimitations: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 8 },
});
