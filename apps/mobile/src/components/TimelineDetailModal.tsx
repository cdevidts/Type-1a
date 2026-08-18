import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { formatDayTime, parseNonNegativeNumber, parsePositiveNumber, trendArrow } from '../format';
import { colors, radius, spacing } from '../theme';
import type { TimelineEditPayload, TimelineItem } from '../types';
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
        ...(item.raw.note === undefined || item.raw.note === '' ? [] : [{ label: 'Nota', value: item.raw.note }]),
        { label: 'Hora', value: formatDayTime(item.raw.timestamp) },
      ];
    case 'glucose':
      return [
        { label: 'Glucosa', value: `${item.raw.glucose} ${item.raw.unit}` },
        { label: 'Tendencia', value: trendArrow[item.raw.trend] },
        { label: 'Origen', value: originLabel[item.raw.origin] ?? item.raw.origin },
        { label: 'Proveedor', value: item.raw.source },
        // Not always a sensor: `origin: 'manual'` readings are hand-entered.
        {
          label: item.raw.origin === 'real' ? 'Hora del sensor' : 'Hora de la medición',
          value: formatDayTime(item.raw.sourceTimestamp),
        },
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

/** Whether this Timeline item has anything a user can edit. Episodes are a
 * computed aggregate (metrics/insight come from CGM readings, never typed
 * in), so they're delete-only. A CGM reading is only editable when it's
 * `origin: 'manual'` — correcting a sensor/imported/synthetic value in
 * place would misrepresent what that source actually reported. */
function isEditable(item: TimelineItem): boolean {
  if (item.kind === 'episode') return false;
  if (item.kind === 'glucose') return item.raw.origin === 'manual';
  return true;
}

function deleteLabel(item: TimelineItem): string {
  return item.kind === 'episode' ? 'Eliminar seguimiento' : 'Eliminar registro';
}

function deleteConfirmMessage(item: TimelineItem): string {
  if (item.kind === 'episode') {
    return 'Se deja de calcular el resumen post-comida de este episodio. La comida y los carbohidratos confirmados no se borran.';
  }
  if (item.kind === 'meal') {
    return 'Se borra esta comida y el seguimiento post-comida asociado. Los carbohidratos confirmados también se borran.';
  }
  return 'Esta acción no se puede deshacer.';
}

export function TimelineDetailModal({
  item,
  onClose,
  onSave,
  onDelete,
}: {
  item: TimelineItem | null;
  onClose: () => void;
  onSave: (item: TimelineItem, payload: TimelineEditPayload) => Promise<void>;
  onDelete: (item: TimelineItem) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [insulinType, setInsulinType] = useState<'rapid' | 'basal'>('rapid');
  const [units, setUnits] = useState('');
  const [insulinName, setInsulinName] = useState('');
  const [carbsG, setCarbsG] = useState('');
  const [note, setNote] = useState('');
  const [glucose, setGlucose] = useState('');

  // Re-seed the edit fields (and drop any in-progress edit/error) every time
  // a different item is opened. Keyed on the item's identity, not on
  // `editing`, so switching items always starts from view mode.
  useEffect(() => {
    setEditing(false);
    setError(null);
    if (item === null) return;
    if (item.kind === 'insulin') {
      setInsulinType(item.raw.type);
      setUnits(String(item.raw.units));
      setInsulinName(item.raw.insulinName ?? '');
    } else if (item.kind === 'carbs') {
      setCarbsG(String(item.raw.carbsG));
    } else if (item.kind === 'meal') {
      setNote(item.raw.note ?? '');
    } else if (item.kind === 'glucose') {
      setGlucose(String(item.raw.glucose));
    }
  }, [item]);

  async function handleSave(): Promise<void> {
    if (item === null) return;
    setError(null);

    let payload: TimelineEditPayload;
    if (item.kind === 'insulin') {
      const parsedUnits = parsePositiveNumber(units);
      if (parsedUnits === null || parsedUnits > 100) {
        setError('Las unidades deben ser un número positivo, 100 U o menos.');
        return;
      }
      payload = {
        kind: 'insulin',
        type: insulinType,
        units: parsedUnits,
        ...(insulinName.trim() === '' ? {} : { insulinName: insulinName.trim() }),
      };
    } else if (item.kind === 'carbs') {
      const parsed = parseNonNegativeNumber(carbsG);
      if (parsed === null || parsed > 500) {
        setError('Los carbohidratos deben ser un número entre 0 y 500 g.');
        return;
      }
      payload = { kind: 'carbs', carbsG: parsed };
    } else if (item.kind === 'meal') {
      payload = { kind: 'meal', note: note.trim() };
    } else if (item.kind === 'glucose') {
      const parsed = parsePositiveNumber(glucose);
      if (parsed === null) {
        setError('La glucosa debe ser un número positivo.');
        return;
      }
      payload = { kind: 'glucose', glucose: parsed };
    } else {
      return;
    }

    setBusy(true);
    try {
      await onSave(item, payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo guardar.');
    } finally {
      setBusy(false);
    }
  }

  function confirmDelete(): void {
    if (item === null) return;
    Alert.alert(deleteLabel(item), deleteConfirmMessage(item), [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Eliminar',
        style: 'destructive',
        onPress: () => {
          setBusy(true);
          onDelete(item)
            .then(onClose)
            .catch(() => { setError('No se pudo eliminar.'); })
            .finally(() => { setBusy(false); });
        },
      },
    ]);
  }

  return (
    <ModalShell visible={item !== null} title={item?.title ?? 'Detalle'} onClose={onClose}>
      {item === null ? null : editing ? (
        <>
          {item.kind === 'insulin' ? (
            <>
              <Text style={styles.fieldLabel}>Tipo</Text>
              <View style={styles.segmented}>
                <Pressable
                  style={[styles.segment, insulinType === 'rapid' && styles.segmentActive]}
                  onPress={() => { setInsulinType('rapid'); }}
                >
                  <Text style={[styles.segmentText, insulinType === 'rapid' && styles.segmentTextActive]}>Rápida</Text>
                </Pressable>
                <Pressable
                  style={[styles.segment, insulinType === 'basal' && styles.segmentActive]}
                  onPress={() => { setInsulinType('basal'); }}
                >
                  <Text style={[styles.segmentText, insulinType === 'basal' && styles.segmentTextActive]}>Basal</Text>
                </Pressable>
              </View>
              <Text style={styles.fieldLabel}>Unidades</Text>
              <View style={styles.inputWrap}>
                <TextInput value={units} onChangeText={setUnits} keyboardType="decimal-pad" style={styles.input} selectTextOnFocus />
                <Text style={styles.inputUnit}>U</Text>
              </View>
              <Text style={styles.fieldLabel}>Insulina (opcional)</Text>
              <TextInput value={insulinName} onChangeText={setInsulinName} style={styles.textInput} placeholder="Nombre de la insulina" placeholderTextColor={colors.muted} />
            </>
          ) : null}
          {item.kind === 'carbs' ? (
            <>
              <Text style={styles.fieldLabel}>Carbohidratos</Text>
              <View style={styles.inputWrap}>
                <TextInput value={carbsG} onChangeText={setCarbsG} keyboardType="decimal-pad" style={styles.input} selectTextOnFocus />
                <Text style={styles.inputUnit}>g</Text>
              </View>
            </>
          ) : null}
          {item.kind === 'meal' ? (
            <>
              {item.raw.confirmedCarbsG === undefined ? null : (
                <Text style={styles.hint}>
                  Carbohidratos confirmados: {item.raw.confirmedCarbsG} g. Se editan desde el ítem "Carbohidratos confirmados" del Timeline, no desde acá.
                </Text>
              )}
              <Text style={styles.fieldLabel}>Nota</Text>
              <TextInput
                value={note}
                onChangeText={setNote}
                style={[styles.textInput, styles.textArea]}
                placeholder="Contexto de la comida"
                placeholderTextColor={colors.muted}
                multiline
              />
            </>
          ) : null}
          {item.kind === 'glucose' ? (
            <>
              <Text style={styles.fieldLabel}>Glucosa</Text>
              <View style={styles.inputWrap}>
                <TextInput value={glucose} onChangeText={setGlucose} keyboardType="decimal-pad" style={styles.input} selectTextOnFocus />
                <Text style={styles.inputUnit}>{item.raw.unit}</Text>
              </View>
            </>
          ) : null}

          {error === null ? null : <Text style={styles.error}>{error}</Text>}
          <View style={styles.actionRow}>
            <Pressable style={[styles.button, styles.secondaryButton]} onPress={() => { setEditing(false); setError(null); }}>
              <Text style={styles.secondaryButtonText}>Cancelar</Text>
            </Pressable>
            <Pressable style={[styles.button, styles.primaryButton, busy && styles.disabled]} disabled={busy} onPress={() => { void handleSave(); }}>
              <Text style={styles.primaryButtonText}>{busy ? 'Guardando…' : 'Guardar cambios'}</Text>
            </Pressable>
          </View>
        </>
      ) : (
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

          {error === null ? null : <Text style={styles.error}>{error}</Text>}
          <View style={styles.actionRow}>
            {isEditable(item) ? (
              <Pressable style={[styles.button, styles.secondaryButton]} onPress={() => { setEditing(true); }}>
                <Text style={styles.secondaryButtonText}>Editar</Text>
              </Pressable>
            ) : null}
            <Pressable style={[styles.button, styles.dangerButton, busy && styles.disabled]} disabled={busy} onPress={confirmDelete}>
              <Text style={styles.dangerButtonText}>{deleteLabel(item)}</Text>
            </Pressable>
          </View>
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
  fieldLabel: { color: colors.navy, fontSize: 12, fontWeight: '800', marginTop: spacing.lg },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: spacing.md },
  inputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.sm, borderColor: colors.line, borderWidth: 1, marginTop: 6, paddingHorizontal: spacing.md },
  input: { color: colors.ink, fontSize: 20, fontWeight: '700', flex: 1, paddingVertical: spacing.md, minHeight: 44 },
  inputUnit: { color: colors.muted, fontSize: 12, marginLeft: 4 },
  textInput: { backgroundColor: colors.surface, color: colors.ink, borderColor: colors.line, borderWidth: 1, borderRadius: radius.sm, padding: spacing.md, marginTop: 6, fontSize: 15, minHeight: 44 },
  textArea: { minHeight: 70, textAlignVertical: 'top' },
  segmented: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.sm, borderColor: colors.line, borderWidth: 1, marginTop: 6, overflow: 'hidden' },
  segment: { flex: 1, paddingVertical: spacing.md, alignItems: 'center', minHeight: 44, justifyContent: 'center' },
  segmentActive: { backgroundColor: colors.teal },
  segmentText: { color: colors.navy, fontSize: 14, fontWeight: '700' },
  segmentTextActive: { color: '#FFFFFF' },
  error: { color: colors.red, fontSize: 13, marginTop: spacing.md },
  actionRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl },
  button: { flex: 1, borderRadius: radius.sm, paddingVertical: spacing.md, alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  primaryButton: { backgroundColor: colors.teal },
  primaryButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  secondaryButton: { borderColor: colors.line, borderWidth: 1 },
  secondaryButtonText: { color: colors.navy, fontSize: 14, fontWeight: '800' },
  dangerButton: { borderColor: colors.red, borderWidth: 1 },
  dangerButtonText: { color: colors.red, fontSize: 14, fontWeight: '800' },
  disabled: { opacity: 0.55 },
});
