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
    case 'note':
      return [
        { label: 'Nota', value: item.raw.text },
        { label: 'Hora', value: formatDayTime(item.raw.timestamp) },
      ];
    case 'entry':
      return [
        ...(item.raw.glucose === undefined ? [] : [{
          label: item.raw.glucoseOrigin !== undefined && item.raw.glucoseOrigin !== 'manual' ? 'Glucosa (sensor)' : 'Glicemia capilar',
          value: `${item.raw.glucose} mg/dL`,
        }]),
        ...(item.raw.carbsG === undefined ? [] : [{ label: 'Carbohidratos', value: `${item.raw.carbsG} g` }]),
        ...(item.raw.aiEstimatedCarbsG === undefined ? [] : [{ label: 'Estimado por IA', value: `${item.raw.aiEstimatedCarbsG} g` }]),
        ...(item.raw.description === undefined || item.raw.description === '' ? [] : [{ label: 'Comida', value: item.raw.description }]),
        ...(item.raw.rapidUnits === undefined ? [] : [{ label: 'Insulina rápida', value: `${item.raw.rapidUnits} U` }]),
        ...(item.raw.basalUnits === undefined ? [] : [{ label: 'Insulina basal', value: `${item.raw.basalUnits} U` }]),
        ...(item.raw.note === undefined || item.raw.note === '' ? [] : [{ label: 'Nota', value: item.raw.note }]),
        { label: 'Hora', value: formatDayTime(item.timestamp) },
      ];
  }
}

/** Whether a packaged entry (or a candidate one) is anchored on a real
 * sensor/imported/synthetic reading rather than a hand-typed 'manual' value.
 * That value is a record of what the source reported — read-only, and kept
 * when the rest of the entry is deleted. */
function hasReadOnlyGlucoseAnchor(item: TimelineItem): boolean {
  if (item.kind === 'glucose') return item.raw.origin !== 'manual';
  if (item.kind === 'entry') return item.raw.glucoseOrigin !== undefined && item.raw.glucoseOrigin !== 'manual';
  return false;
}

/** Whether this Timeline item has anything a user can edit. Episodes are a
 * computed aggregate (metrics/insight come from CGM readings, never typed
 * in), so they're delete-only. A glucose reading is always editable now: a
 * 'manual' one lets you correct the value, and any reading (sensor included)
 * lets you attach carbs/insulina/nota to it after the fact — the sensor value
 * itself stays read-only. */
function isEditable(item: TimelineItem): boolean {
  return item.kind !== 'episode';
}

function deleteLabel(item: TimelineItem): string {
  if (item.kind === 'episode') return 'Eliminar seguimiento';
  if (item.kind === 'entry') return hasReadOnlyGlucoseAnchor(item) ? 'Quitar datos adjuntos' : 'Eliminar entrada completa';
  return 'Eliminar registro';
}

function deleteConfirmMessage(item: TimelineItem): string {
  if (item.kind === 'episode') {
    return 'Se deja de calcular el resumen post-comida de este episodio. La comida y los carbohidratos confirmados no se borran.';
  }
  if (item.kind === 'meal') {
    return 'Se borra esta comida y el seguimiento post-comida asociado. Los carbohidratos confirmados también se borran.';
  }
  if (item.kind === 'entry') {
    return hasReadOnlyGlucoseAnchor(item)
      ? 'Se quitan los carbohidratos, la insulina y la nota de esta entrada. La glucosa del sensor se conserva.'
      : 'Se borra todo lo guardado junto en esta entrada: glicemia, carbohidratos, insulina y nota.';
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

  // Only the packaged "entry" kind needs all five of these at once.
  const [entryGlucose, setEntryGlucose] = useState('');
  const [entryCarbsG, setEntryCarbsG] = useState('');
  const [entryDescription, setEntryDescription] = useState('');
  const [entryRapidUnits, setEntryRapidUnits] = useState('');
  const [entryBasalUnits, setEntryBasalUnits] = useState('');
  const [entryNote, setEntryNote] = useState('');

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
      // Attachment fields (reused from the packaged-entry form) start empty —
      // a standalone reading has nothing attached yet.
      setEntryCarbsG('');
      setEntryDescription('');
      setEntryRapidUnits('');
      setEntryBasalUnits('');
      setEntryNote('');
    } else if (item.kind === 'note') {
      setNote(item.raw.text);
    } else if (item.kind === 'entry') {
      setEntryGlucose(item.raw.glucose === undefined ? '' : String(item.raw.glucose));
      setEntryCarbsG(item.raw.carbsG === undefined ? '' : String(item.raw.carbsG));
      setEntryDescription(item.raw.description ?? '');
      setEntryRapidUnits(item.raw.rapidUnits === undefined ? '' : String(item.raw.rapidUnits));
      setEntryBasalUnits(item.raw.basalUnits === undefined ? '' : String(item.raw.basalUnits));
      setEntryNote(item.raw.note ?? '');
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
      // A 'manual' reading's value is editable; any other origin is a record
      // of what the source reported and stays read-only — you can still
      // attach carbs/insulina/nota to it.
      const isManual = item.raw.origin === 'manual';
      let glucoseValue: number | undefined;
      if (isManual) {
        const parsed = parsePositiveNumber(glucose);
        if (parsed === null) {
          setError('La glucosa debe ser un número positivo.');
          return;
        }
        glucoseValue = parsed;
      }
      const carbsValue = entryCarbsG.trim() === '' ? undefined : parseNonNegativeNumber(entryCarbsG);
      if (carbsValue === null || (carbsValue !== undefined && carbsValue > 500)) {
        setError('Los carbohidratos deben ser un número entre 0 y 500 g.');
        return;
      }
      const rapidValue = entryRapidUnits.trim() === '' ? undefined : parsePositiveNumber(entryRapidUnits);
      if (rapidValue === null || (rapidValue !== undefined && rapidValue > 100)) {
        setError('La insulina rápida debe ser un número positivo, 100 U o menos.');
        return;
      }
      const basalValue = entryBasalUnits.trim() === '' ? undefined : parsePositiveNumber(entryBasalUnits);
      if (basalValue === null || (basalValue !== undefined && basalValue > 100)) {
        setError('La insulina basal debe ser un número positivo, 100 U o menos.');
        return;
      }
      const hasAttachments = carbsValue !== undefined || entryDescription.trim() !== ''
        || rapidValue !== undefined || basalValue !== undefined || entryNote.trim() !== '';
      // For a read-only sensor value, editing only makes sense to attach
      // something — there's no value change to save on its own.
      if (!isManual && !hasAttachments) {
        setError('Agrega carbohidratos, insulina o una nota para adjuntar a esta lectura.');
        return;
      }
      payload = {
        kind: 'glucose',
        ...(glucoseValue === undefined ? {} : { glucose: glucoseValue }),
        ...(carbsValue === undefined ? {} : { carbsG: carbsValue }),
        ...(entryDescription.trim() === '' ? {} : { description: entryDescription.trim() }),
        ...(rapidValue === undefined ? {} : { rapidUnits: rapidValue }),
        ...(basalValue === undefined ? {} : { basalUnits: basalValue }),
        ...(entryNote.trim() === '' ? {} : { note: entryNote.trim() }),
      };
    } else if (item.kind === 'note') {
      const text = note.trim();
      if (text === '') {
        setError('La nota no puede quedar vacía. Para borrarla, usa Eliminar.');
        return;
      }
      payload = { kind: 'note', text };
    } else if (item.kind === 'entry') {
      // A sensor-anchored entry's glucose is read-only (a real reading) — it's
      // never sent back as a manual value, so it can't overwrite or delete the
      // sensor reading. Only a 'manual' anchor (or none) is editable here.
      const isSensorAnchor = hasReadOnlyGlucoseAnchor(item);
      let glucoseValue: number | undefined;
      if (!isSensorAnchor && entryGlucose.trim() !== '') {
        const parsed = parsePositiveNumber(entryGlucose);
        if (parsed === null) {
          setError('La glicemia capilar debe ser un número positivo.');
          return;
        }
        glucoseValue = parsed;
      }
      const carbsValue = entryCarbsG.trim() === '' ? undefined : parseNonNegativeNumber(entryCarbsG);
      if (carbsValue === null || (carbsValue !== undefined && carbsValue > 500)) {
        setError('Los carbohidratos deben ser un número entre 0 y 500 g.');
        return;
      }
      const rapidValue = entryRapidUnits.trim() === '' ? undefined : parsePositiveNumber(entryRapidUnits);
      if (rapidValue === null || (rapidValue !== undefined && rapidValue > 100)) {
        setError('La insulina rápida debe ser un número positivo, 100 U o menos.');
        return;
      }
      const basalValue = entryBasalUnits.trim() === '' ? undefined : parsePositiveNumber(entryBasalUnits);
      if (basalValue === null || (basalValue !== undefined && basalValue > 100)) {
        setError('La insulina basal debe ser un número positivo, 100 U o menos.');
        return;
      }
      const hasSomething = glucoseValue !== undefined || carbsValue !== undefined || entryDescription.trim() !== ''
        || rapidValue !== undefined || basalValue !== undefined || entryNote.trim() !== '';
      if (!hasSomething) {
        setError('Completa al menos un campo, o usa el botón de eliminar de abajo.');
        return;
      }
      payload = {
        kind: 'entry',
        ...(glucoseValue === undefined ? {} : { manualGlucose: glucoseValue }),
        ...(carbsValue === undefined ? {} : { carbsG: carbsValue }),
        ...(entryDescription.trim() === '' ? {} : { description: entryDescription.trim() }),
        ...(rapidValue === undefined ? {} : { rapidUnits: rapidValue }),
        ...(basalValue === undefined ? {} : { basalUnits: basalValue }),
        ...(entryNote.trim() === '' ? {} : { note: entryNote.trim() }),
      };
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
              {item.raw.origin === 'manual' ? (
                <>
                  <Text style={styles.fieldLabel}>Glucosa</Text>
                  <View style={styles.inputWrap}>
                    <TextInput value={glucose} onChangeText={setGlucose} keyboardType="decimal-pad" style={styles.input} selectTextOnFocus />
                    <Text style={styles.inputUnit}>{item.raw.unit}</Text>
                  </View>
                </>
              ) : (
                <>
                  <Text style={styles.fieldLabel}>Glucosa (del sensor)</Text>
                  <Text style={styles.readonlyValue}>{item.raw.glucose} {item.raw.unit}</Text>
                  <Text style={styles.hint}>
                    Este valor viene del sensor y no se edita. Puedes adjuntarle lo que comiste, la insulina o una nota de ese momento.
                  </Text>
                </>
              )}
              <Text style={styles.fieldLabel}>Carbohidratos</Text>
              <View style={styles.inputWrap}>
                <TextInput value={entryCarbsG} onChangeText={setEntryCarbsG} keyboardType="decimal-pad" style={styles.input} placeholder="—" placeholderTextColor={colors.muted} selectTextOnFocus />
                <Text style={styles.inputUnit}>g</Text>
              </View>
              <Text style={styles.fieldLabel}>Comida</Text>
              <TextInput
                value={entryDescription}
                onChangeText={setEntryDescription}
                style={[styles.textInput, styles.textArea]}
                placeholder="¿Qué comiste?"
                placeholderTextColor={colors.muted}
                multiline
              />
              <View style={styles.fieldRow}>
                <View style={styles.fieldRowItem}>
                  <Text style={styles.fieldLabel}>Rápida</Text>
                  <View style={styles.inputWrap}>
                    <TextInput value={entryRapidUnits} onChangeText={setEntryRapidUnits} keyboardType="decimal-pad" style={styles.input} placeholder="—" placeholderTextColor={colors.muted} selectTextOnFocus />
                    <Text style={styles.inputUnit}>U</Text>
                  </View>
                </View>
                <View style={styles.fieldRowItem}>
                  <Text style={styles.fieldLabel}>Basal</Text>
                  <View style={styles.inputWrap}>
                    <TextInput value={entryBasalUnits} onChangeText={setEntryBasalUnits} keyboardType="decimal-pad" style={styles.input} placeholder="—" placeholderTextColor={colors.muted} selectTextOnFocus />
                    <Text style={styles.inputUnit}>U</Text>
                  </View>
                </View>
              </View>
              <Text style={styles.fieldLabel}>Nota</Text>
              <TextInput
                value={entryNote}
                onChangeText={setEntryNote}
                style={[styles.textInput, styles.textArea]}
                placeholder="Contexto, ejercicio, cómo te sentías…"
                placeholderTextColor={colors.muted}
                multiline
              />
            </>
          ) : null}
          {item.kind === 'note' ? (
            <>
              <Text style={styles.fieldLabel}>Nota</Text>
              <TextInput
                value={note}
                onChangeText={setNote}
                style={[styles.textInput, styles.textArea]}
                placeholderTextColor={colors.muted}
                multiline
              />
            </>
          ) : null}
          {item.kind === 'entry' ? (
            <>
              <Text style={styles.hint}>
                Esta entrada se guardó junto: edita lo que corresponda y guarda — lo que dejes vacío se borra de la entrada.
              </Text>
              {item.raw.glucoseOrigin !== undefined && item.raw.glucoseOrigin !== 'manual' ? (
                <>
                  <Text style={styles.fieldLabel}>Glucosa (del sensor)</Text>
                  <Text style={styles.readonlyValue}>{item.raw.glucose} mg/dL</Text>
                  <Text style={styles.hint}>Viene del sensor y no se edita; el resto de la entrada sí.</Text>
                </>
              ) : (
                <>
                  <Text style={styles.fieldLabel}>Glicemia capilar</Text>
                  <View style={styles.inputWrap}>
                    <TextInput value={entryGlucose} onChangeText={setEntryGlucose} keyboardType="decimal-pad" style={styles.input} placeholder="—" placeholderTextColor={colors.muted} selectTextOnFocus />
                    <Text style={styles.inputUnit}>mg/dL</Text>
                  </View>
                </>
              )}
              <Text style={styles.fieldLabel}>Carbohidratos</Text>
              <View style={styles.inputWrap}>
                <TextInput value={entryCarbsG} onChangeText={setEntryCarbsG} keyboardType="decimal-pad" style={styles.input} placeholder="—" placeholderTextColor={colors.muted} selectTextOnFocus />
                <Text style={styles.inputUnit}>g</Text>
              </View>
              {item.raw.aiEstimatedCarbsG === undefined ? null : (
                <Text style={styles.hint}>Estimado por IA al crear la entrada: {item.raw.aiEstimatedCarbsG} g (no editable).</Text>
              )}
              <Text style={styles.fieldLabel}>Comida</Text>
              <TextInput
                value={entryDescription}
                onChangeText={setEntryDescription}
                style={[styles.textInput, styles.textArea]}
                placeholder="¿Qué comiste?"
                placeholderTextColor={colors.muted}
                multiline
              />
              <View style={styles.fieldRow}>
                <View style={styles.fieldRowItem}>
                  <Text style={styles.fieldLabel}>Rápida</Text>
                  <View style={styles.inputWrap}>
                    <TextInput value={entryRapidUnits} onChangeText={setEntryRapidUnits} keyboardType="decimal-pad" style={styles.input} placeholder="—" placeholderTextColor={colors.muted} selectTextOnFocus />
                    <Text style={styles.inputUnit}>U</Text>
                  </View>
                </View>
                <View style={styles.fieldRowItem}>
                  <Text style={styles.fieldLabel}>Basal</Text>
                  <View style={styles.inputWrap}>
                    <TextInput value={entryBasalUnits} onChangeText={setEntryBasalUnits} keyboardType="decimal-pad" style={styles.input} placeholder="—" placeholderTextColor={colors.muted} selectTextOnFocus />
                    <Text style={styles.inputUnit}>U</Text>
                  </View>
                </View>
              </View>
              <Text style={styles.fieldLabel}>Nota</Text>
              <TextInput
                value={entryNote}
                onChangeText={setEntryNote}
                style={[styles.textInput, styles.textArea]}
                placeholder="Contexto, ejercicio, cómo te sentías…"
                placeholderTextColor={colors.muted}
                multiline
              />
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
  fieldRow: { flexDirection: 'row', gap: spacing.md },
  fieldRowItem: { flex: 1 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: spacing.md },
  readonlyValue: { color: colors.ink, fontSize: 20, fontWeight: '700', marginTop: 6 },
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
