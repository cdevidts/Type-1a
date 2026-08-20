import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  assessKetones,
  KETONES_ELEVATED_MMOL_L,
  KETONES_HIGH_MMOL_L,
  KETONES_VERY_HIGH_MMOL_L,
  type KetoneBand,
} from '@type1a/domain';

import { colors, radius, spacing } from '../theme';
import { ModalShell } from './ModalShell';

/**
 * Registro de cetonas en sangre (Fase 13, ítem 8).
 *
 * `VitalsEventSchema.ketonesMmolL` existía desde la Fase 1 y ya salía en el
 * reporte, pero no había ningún punto de entrada en la app: solo llegaban por
 * importación de MySugr. Relevante para riesgo de cetoacidosis, no es
 * cosmético.
 *
 * **Frontera de seguridad.** La literatura de cetonas viene casi siempre con
 * protocolos de corrección con insulina. Nada de eso aparece acá: la pantalla
 * dice en qué banda cayó la medición (`assessKetones`, en `packages/domain`)
 * y que corresponde hablar con el equipo clínico. Ni una unidad, ni un
 * "deberías". Ver la cabecera de `packages/domain/src/ketones.ts`.
 *
 * No se usa `NumericEntryModal` porque acá **0 es un valor válido y bueno**
 * (ese modal exige positivos), el rango es distinto, y lo importante —la
 * lectura de la banda— no existe en aquel flujo.
 */

const MAX_KETONES_MMOL_L = 20;

const bandStyles: Record<KetoneBand, { box: object; text: object }> = {
  normal: { box: { backgroundColor: colors.greenSoft }, text: { color: colors.green } },
  elevated: { box: { backgroundColor: colors.warningSoft }, text: { color: colors.warning } },
  high: { box: { backgroundColor: colors.redSoft }, text: { color: colors.red } },
  veryHigh: { box: { backgroundColor: colors.redSoft }, text: { color: colors.red } },
};

export function KetonesModal({
  visible,
  onClose,
  onSubmit,
}: {
  visible: boolean;
  onClose: () => void;
  onSubmit: (mmolL: number) => Promise<void>;
}) {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (visible) {
      setValue('');
      setError(null);
    }
  }, [visible]);

  // Coma o punto: en Chile se escribe "0,8".
  const parsed = value.trim() === '' ? null : Number(value.trim().replace(',', '.'));
  const isValid = parsed !== null && Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_KETONES_MMOL_L;
  const assessment = isValid ? assessKetones(parsed) : null;

  async function submit(): Promise<void> {
    if (!isValid || parsed === null) {
      setError(`Ingresa un valor entre 0 y ${MAX_KETONES_MMOL_L} mmol/L.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(parsed);
      onClose();
    } catch {
      setError('No se pudo guardar la medición. Inténtalo otra vez.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell visible={visible} title="Cetonas" onClose={onClose}>
      <Text style={styles.copy}>
        Medición de cetonas <Text style={styles.strong}>en sangre</Text>, con un medidor de cetonas. Las tiras de
        orina usan otra escala y no sirven para este registro.
      </Text>

      <View style={styles.fieldRow}>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={(next) => { setValue(next); setError(null); }}
          keyboardType="decimal-pad"
          placeholder="0,0"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Cetonas en sangre"
        />
        <Text style={styles.unit}>mmol/L</Text>
      </View>

      {assessment === null ? null : (
        <View style={[styles.bandBox, bandStyles[assessment.band].box]}>
          {/* Texto además del color: la banda nunca se comunica solo con color. */}
          <Text style={[styles.bandLabel, bandStyles[assessment.band].text]}>{assessment.label}</Text>
          {assessment.urgent ? (
            <Text style={[styles.bandBody, bandStyles[assessment.band].text]}>
              Contacta a tu equipo clínico ahora. No esperes a ver si baja sola.
            </Text>
          ) : null}
        </View>
      )}

      <View style={styles.scale}>
        <Text style={styles.scaleTitle}>Cómo se leen</Text>
        <Text style={styles.scaleRow}>Menos de {KETONES_ELEVATED_MMOL_L} — normales</Text>
        <Text style={styles.scaleRow}>{KETONES_ELEVATED_MMOL_L} a {KETONES_HIGH_MMOL_L} — elevadas</Text>
        <Text style={styles.scaleRow}>{KETONES_HIGH_MMOL_L} a {KETONES_VERY_HIGH_MMOL_L} — altas, riesgo de cetoacidosis</Text>
        <Text style={styles.scaleRow}>Más de {KETONES_VERY_HIGH_MMOL_L} — muy altas, riesgo de cetoacidosis</Text>
      </View>

      {error === null ? null : <Text style={styles.error}>{error}</Text>}

      <Pressable
        style={[styles.saveButton, busy && styles.disabled]}
        disabled={busy}
        onPress={() => { void submit(); }}
        accessibilityRole="button"
      >
        <Text style={styles.saveText}>{busy ? 'Guardando…' : 'Guardar medición'}</Text>
      </Pressable>

      <Text style={styles.foot}>
        Type 1A registra y describe esta medición. No indica qué hacer con ella: eso se decide con tu equipo
        clínico.
      </Text>
    </ModalShell>
  );
}

const styles = StyleSheet.create({
  copy: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  strong: { fontWeight: '800', color: colors.ink },
  fieldRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    borderColor: colors.line,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    marginTop: spacing.lg,
  },
  input: { flex: 1, color: colors.ink, fontSize: 28, fontWeight: '800', paddingVertical: spacing.md },
  unit: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  bandBox: { borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md, gap: spacing.xs },
  bandLabel: { fontSize: 15, fontWeight: '800' },
  bandBody: { fontSize: 13, lineHeight: 19, fontWeight: '600' },
  scale: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md, gap: 3 },
  scaleTitle: { color: colors.ink, fontSize: 13, fontWeight: '800', marginBottom: 2 },
  scaleRow: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  error: { color: colors.red, fontSize: 13, marginTop: spacing.md, fontWeight: '600' },
  saveButton: {
    backgroundColor: colors.teal,
    borderRadius: radius.sm,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.lg,
  },
  saveText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  disabled: { opacity: 0.55 },
  foot: { color: colors.muted, fontSize: 11, lineHeight: 17, marginTop: spacing.md },
});
