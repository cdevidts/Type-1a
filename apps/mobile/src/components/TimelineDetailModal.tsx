import { useEffect, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';

import type { EpisodeContextEvent } from '@type1a/schemas';

import { formatDayTime, trendArrow } from '../format';
import { colors, radius, spacing } from '../theme';
import type { TimelineItem } from '../types';
import { isMasterEditable, masterSeedFrom } from '../masterModal';
import { ModalShell } from './ModalShell';

/**
 * El detalle de lectura de un registro del Timeline.
 *
 * ## Qué dejó de ser
 *
 * Hasta el 2026-08-27 este archivo tenía **dos formularios de edición
 * completos** escritos a mano —uno para la glucosa, otro para la entrada
 * empaquetada— con su propio parseo, su propia validación y su propio
 * criterio de qué se podía anotar. Eran los "formularios primitivos" que
 * `projectbrief.md` prohíbe: sabían menos que el de creación, y editar era
 * más pobre que registrar.
 *
 * Ahora **solo lee**. El botón Editar abre el Modal Maestro, que es el mismo
 * componente que monta "Nueva entrada": una sola implementación, una sola
 * lista de campos, una sola validación. Lo que cambia entre los dos usos es
 * qué sección arranca abierta, y eso lo decide `masterSectionsFor` por
 * contenido.
 *
 * Un episodio de comida sigue siendo de lectura y borrado: sus métricas salen
 * del CGM, nadie las tecleó, y un formulario para "corregirlas" sería
 * inventar el dato.
 */

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

/**
 * Etiqueta de un evento que ocurrió durante el episodio (Fase 23).
 *
 * Descriptivo y nada más: dice **qué** se registró y **cuándo**, nunca si
 * correspondía. Una nota se nombra sin su texto — el contexto guardado no lo
 * lleva, justamente para que no salga del teléfono.
 */
function contextEventLabel(event: EpisodeContextEvent): string {
  // Negativo = antes del ancla. Pasa desde el 2026-08-25: con la duración de
  // insulina configurada, una dosis anterior que sigue actuando entra al
  // contexto. Sin este signo decía "-1 h -30 min después", que además de feo
  // se leía al revés.
  const before = event.minutesAfterAnchor < 0;
  const total = Math.abs(event.minutesAfterAnchor);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const span = hours === 0 ? `${minutes} min` : minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
  const when = `${span} ${before ? 'antes' : 'después'}`;
  const amount = event.amount;
  switch (event.kind) {
    case 'rapid_insulin':
      return amount === undefined ? `Insulina rápida, ${when}` : `${amount} U de rápida, ${when}`;
    case 'basal_insulin':
      return amount === undefined ? `Insulina basal, ${when}` : `${amount} U de basal, ${when}`;
    case 'carbs':
      return amount === undefined ? `Carbohidratos, ${when}` : `${amount} g de carbohidratos, ${when}`;
    case 'meal':
      return amount === undefined ? `Otra comida, ${when}` : `Otra comida de ${amount} g, ${when}`;
    case 'activity':
      return amount === undefined ? `Actividad física, ${when}` : `Actividad física de ${amount} min, ${when}`;
    case 'note':
      return `Una nota, ${when}`;
  }
}

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
        // El desglose de una dosis calculada. `purpose` decía para qué fue;
        // esto dice de cuánto se compuso, que es otra pregunta y la que
        // permite mirar después qué tan bien funcionaron las correcciones.
        ...(item.raw.mealUnits === undefined ? [] : [{ label: 'De comida', value: `${item.raw.mealUnits} U` }]),
        ...(item.raw.correctionUnits === undefined ? [] : [{ label: 'De corrección', value: `${item.raw.correctionUnits} U` }]),
        ...(item.raw.iobUnits === undefined ? [] : [{ label: 'Insulina activa descontada', value: `− ${item.raw.iobUnits} U` }]),
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
        // La fibra se lista siempre, con "sin anotar" cuando falta: es un
        // macro de primera clase, no una nota al pie que solo aparece si es
        // mayor que cero.
        { label: 'Fibra', value: item.raw.fiberG === undefined ? 'sin anotar' : `${item.raw.fiberG} g` },
        ...(item.raw.caloriesKcal === undefined ? [] : [{ label: 'Calorías', value: `${item.raw.caloriesKcal} kcal` }]),
        ...(item.raw.note === undefined || item.raw.note === '' ? [] : [{ label: 'Nota', value: item.raw.note }]),
        { label: 'Hora', value: formatDayTime(item.raw.timestamp) },
      ];
    case 'vitals':
      return [
        ...(item.raw.ketonesMmolL === undefined ? [] : [{ label: 'Cetonas', value: `${item.raw.ketonesMmolL} mmol/L` }]),
        ...(item.raw.weightKg === undefined ? [] : [{ label: 'Peso', value: `${item.raw.weightKg} kg` }]),
        ...(item.raw.systolicBP === undefined || item.raw.diastolicBP === undefined
          ? []
          : [{ label: 'Presión', value: `${item.raw.systolicBP}/${item.raw.diastolicBP} mmHg` }]),
        { label: 'Origen', value: item.raw.source === 'imported' ? 'Importado' : 'Ingresado a mano' },
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
        ...(item.raw.proteinG === undefined ? [] : [{ label: 'Proteína', value: `${item.raw.proteinG} g` }]),
        ...(item.raw.fatG === undefined ? [] : [{ label: 'Grasa', value: `${item.raw.fatG} g` }]),
        ...(item.raw.meal === undefined && item.raw.fiberG === undefined
          ? []
          : [{ label: 'Fibra', value: item.raw.fiberG === undefined ? 'sin anotar' : `${item.raw.fiberG} g` }]),
        ...(item.raw.caloriesKcal === undefined ? [] : [{ label: 'Calorías', value: `${item.raw.caloriesKcal} kcal` }]),
        ...(item.raw.ketonesMmolL === undefined ? [] : [{ label: 'Cetonas', value: `${item.raw.ketonesMmolL} mmol/L` }]),
        ...(item.raw.weightKg === undefined ? [] : [{ label: 'Peso', value: `${item.raw.weightKg} kg` }]),
        ...(item.raw.systolicBP === undefined || item.raw.diastolicBP === undefined
          ? []
          : [{ label: 'Presión', value: `${item.raw.systolicBP}/${item.raw.diastolicBP} mmHg` }]),
        ...(item.raw.rapidUnits === undefined ? [] : [{ label: 'Insulina rápida', value: `${item.raw.rapidUnits} U` }]),
        // Una entrada agrupada mostraba SOLO el total: no decía cuánto de esa
        // rápida cubría los carbohidratos y cuánto corregía la glucosa, ni
        // siquiera para qué fue. Con el IOB en juego eso importa el doble.
        ...(item.raw.rapidPurpose === undefined ? [] : [{ label: 'Propósito', value: { meal: 'Comida', correction: 'Corrección', combined: 'Comida + corrección' }[item.raw.rapidPurpose] }]),
        ...(item.raw.rapidMealUnits === undefined ? [] : [{ label: 'De comida', value: `${item.raw.rapidMealUnits} U` }]),
        ...(item.raw.rapidCorrectionUnits === undefined ? [] : [{ label: 'De corrección', value: `${item.raw.rapidCorrectionUnits} U` }]),
        ...(item.raw.rapidIobUnits === undefined ? [] : [{ label: 'Insulina activa descontada', value: `− ${item.raw.rapidIobUnits} U` }]),
        ...(item.raw.rapidInsulinName === undefined ? [] : [{ label: 'Rápida usada', value: item.raw.rapidInsulinName }]),
        ...(item.raw.basalUnits === undefined ? [] : [{ label: 'Insulina basal', value: `${item.raw.basalUnits} U` }]),
        ...(item.raw.basalInsulinName === undefined ? [] : [{ label: 'Basal usada', value: item.raw.basalInsulinName }]),
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

/**
 * `true` cuando el momento de este registro lo fija una fuente externa.
 *
 * Se deriva de `masterSeedFrom`, que es quien lo decide de verdad, en vez de
 * repetir la condición: dos lugares que respondan lo mismo por su cuenta es
 * cómo el detalle terminó prometiendo algo que el editor no hacía.
 */
function fixedTimestamp(item: TimelineItem): boolean {
  return !masterSeedFrom(item).timestampEditable;
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
  if (item.kind === 'carbs') {
    // Un espejo huérfano —cuya comida ya no existe— sigue siendo la única
    // copia de esos gramos. Se dice, para que borrarlo sea una decisión.
    return item.raw.source === 'meal_confirmed'
      ? 'Estos carbohidratos venían de una comida que ya no está. Son la única copia que queda de ese dato.'
      : 'Esta acción no se puede deshacer.';
  }
  if (item.kind === 'vitals') {
    // Una sola fila puede traer cetonas, peso y presión juntos, y el borrado
    // se las lleva todas. El resto de los tipos con varias partes ya lo dicen.
    const partes = [
      item.raw.ketonesMmolL === undefined ? null : 'las cetonas',
      item.raw.weightKg === undefined ? null : 'el peso',
      item.raw.systolicBP === undefined ? null : 'la presión',
    ].filter((parte): parte is string => parte !== null);
    return `Se borra ${partes.join(', ')} de este registro. Esta acción no se puede deshacer. Para corregir solo uno, usa Editar.`;
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
  onEdit,
  onDelete,
}: {
  item: TimelineItem | null;
  onClose: () => void;
  /**
   * Abre el Modal Maestro sobre este registro. **No hay un `onSave` acá**: la
   * edición dejó de vivir en este archivo.
   */
  onEdit: (item: TimelineItem) => void;
  onDelete: (item: TimelineItem) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Limpiar el error al cambiar de ítem: un "no se pudo eliminar" del anterior
  // colgado sobre un registro distinto es peor que no decir nada.
  useEffect(() => { setError(null); }, [item]);

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
            .catch(() => { setError('No se pudo eliminar. Tus datos siguen guardados como estaban.'); })
            .finally(() => { setBusy(false); });
        },
      },
    ]);
  }

  return (
    <ModalShell visible={item !== null} title={item?.title ?? 'Detalle'} onClose={onClose}>
      {item === null ? null : (
        <>
          {rowsFor(item).map((row) => (
            <Row key={row.label} label={row.label} value={row.value} />
          ))}
          {item.kind === 'episode' && (item.metrics?.contextEvents?.length ?? 0) > 0 ? (
            <View style={styles.contextBox}>
              <Text style={styles.contextTitle}>Durante este seguimiento también se registró</Text>
              {item.metrics!.contextEvents!.map((event) => (
                <Text key={`${event.kind}:${event.timestamp}`} style={styles.contextItem}>
                  • {contextEventLabel(event)}
                </Text>
              ))}
              <Text style={styles.contextFoot}>
                Se muestra para leer la curva con contexto: parte de lo que pasó después puede
                deberse a esto y no solo a la comida. La app no evalúa si correspondía.
              </Text>
            </View>
          ) : null}
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

          {item.kind === 'episode' ? (
            <Text style={styles.hint}>
              Este resumen lo calcula la app con tus lecturas de CGM: no es un dato que se teclee, así que no se
              edita. Para corregir la comida que lo originó, abre esa comida.
            </Text>
          ) : (
            <Text style={styles.hint}>
              {/*
                La promesa se ajusta al ítem. Decir "puedes corregir la fecha y
                la hora" sobre una lectura de sensor o importada era falso: su
                momento lo fija la fuente y el maestro lo muestra de solo
                lectura. El comportamiento estaba bien; la frase no.
              */}
              {fixedTimestamp(item)
                ? 'Editar abre el formulario completo: puedes agregarle lo que falte — una comida con foto, la '
                  + 'insulina, las cetonas o una nota. La hora la fija la fuente del dato y no se edita.'
                : 'Editar abre el formulario completo: puedes corregir la fecha y la hora, y agregarle lo que falte '
                  + '— una comida con foto, la insulina, las cetonas o una nota — aunque el registro no haya nacido así.'}
            </Text>
          )}

          {error === null ? null : <Text style={styles.error}>{error}</Text>}
          <View style={styles.actionRow}>
            {isMasterEditable(item) ? (
              <Pressable
                style={[styles.button, styles.primaryButton]}
                onPress={() => { onEdit(item); }}
                accessibilityRole="button"
                accessibilityLabel="Editar este registro"
              >
                <Text style={styles.primaryButtonText}>Editar</Text>
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
  contextBox: {
    backgroundColor: colors.warningSoft,
    borderRadius: 12,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  contextTitle: { color: colors.warning, fontSize: 14, fontWeight: '800', marginBottom: 4 },
  contextItem: { color: colors.ink, fontSize: 13, lineHeight: 18, marginTop: 2 },
  contextFoot: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 8 },
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
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: spacing.lg },
  error: { color: colors.red, fontSize: 13, marginTop: spacing.md },
  actionRow: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.xl },
  button: { flex: 1, borderRadius: radius.sm, paddingVertical: spacing.md, alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  primaryButton: { backgroundColor: colors.teal },
  primaryButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  dangerButton: { borderColor: colors.red, borderWidth: 1 },
  dangerButtonText: { color: colors.red, fontSize: 14, fontWeight: '800' },
  disabled: { opacity: 0.55 },
});
