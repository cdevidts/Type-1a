import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { parsePositiveNumber } from '../format';
import { logSaveError } from '../log';
import { colors, radius, spacing } from '../theme';
import type { QuickRoute } from '../types';
import { ModalShell } from './ModalShell';

/**
 * Solo basal desde la Fase 21.
 *
 * "Carbos" e "insulina rápida" salieron de acá a propósito: cada uno escribía
 * una fila suelta con su propio timestamp, y por eso la app después no
 * lograba emparejar una dosis con su comida. Los dos casos pasaron a
 * `MealModal`, que guarda todo bajo una misma hora.
 *
 * La basal se queda porque no pertenece a ninguna comida: una fila suelta es
 * exactamente lo que es.
 */
const contentByRoute = {
  basal: { title: 'Registrar insulina basal', unit: 'U', defaultValue: '10', step: 1, color: colors.navy },
} as const;

type NumericRoute = Extract<QuickRoute, 'basal'>;

export function NumericEntryModal({
  route,
  onClose,
  onSubmit,
}: {
  route: NumericRoute | null;
  onClose: () => void;
  onSubmit: (route: NumericRoute, value: number) => Promise<void>;
}) {
  const config = contentByRoute.basal;
  const [value, setValue] = useState<string>(config.defaultValue);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (route !== null) {
      setValue(contentByRoute[route].defaultValue);
      setError(null);
    }
  }, [route]);

  function adjust(delta: number): void {
    const current = parsePositiveNumber(value) ?? 0;
    setValue(String(Math.max(config.step, Number((current + delta).toFixed(1)))));
  }

  async function submit(): Promise<void> {
    if (route === null) return;
    const parsed = parsePositiveNumber(value);
    if (parsed === null || parsed > 100) {
      setError('Ingresa entre 0,1 y 100 U.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(route, parsed);
      onClose();
    } catch (error) {
      logSaveError('NumericEntryModal.submit', error);
      setError('No se pudo guardar. Inténtalo otra vez.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell visible={route !== null} title={config.title} onClose={onClose}>
      <Text style={styles.label}>Cantidad</Text>
      <View style={styles.stepper}>
        <Pressable style={styles.stepButton} onPress={() => adjust(-config.step)} accessibilityLabel="Disminuir">
          <Text style={styles.stepText}>−</Text>
        </Pressable>
        <View style={styles.inputWrap}>
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={setValue}
            keyboardType="decimal-pad"
            selectTextOnFocus
            accessibilityLabel={`Cantidad en ${config.unit}`}
          />
          <Text style={styles.unit}>{config.unit}</Text>
        </View>
        <Pressable style={styles.stepButton} onPress={() => adjust(config.step)} accessibilityLabel="Aumentar">
          <Text style={styles.stepText}>+</Text>
        </Pressable>
      </View>
      <Text style={styles.timestamp}>Se guardará con la hora actual. Podrás verlo inmediatamente en el timeline.</Text>
      <View style={styles.safetyBox}>
        <Text style={styles.safetyText}>Confirma la cantidad antes de guardar. Type 1A registra el evento, pero no administra insulina.</Text>
      </View>
      {error === null ? null : <Text style={styles.error}>{error}</Text>}
      <Pressable
        style={[styles.primaryButton, { backgroundColor: config.color }, busy && styles.disabled]}
        disabled={busy}
        onPress={() => { void submit(); }}
      >
        <Text style={styles.primaryText}>{busy ? 'Guardando…' : 'Confirmar registro'}</Text>
      </Pressable>
    </ModalShell>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.navy, fontSize: 13, fontWeight: '800', letterSpacing: 0.5 },
  stepper: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.md, gap: spacing.md },
  stepButton: {
    width: 54,
    height: 54,
    borderRadius: 27,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderColor: colors.line,
    borderWidth: 1,
  },
  stepText: { color: colors.teal, fontSize: 28, lineHeight: 30, fontWeight: '500' },
  inputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 2,
    borderColor: colors.teal,
  },
  input: { color: colors.ink, fontSize: 44, fontWeight: '800', minWidth: 85, textAlign: 'right', paddingVertical: 10 },
  unit: { color: colors.muted, fontSize: 18, marginLeft: spacing.sm },
  timestamp: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: spacing.lg },
  safetyBox: { backgroundColor: colors.warningSoft, borderRadius: radius.sm, padding: spacing.md, marginTop: spacing.lg },
  safetyText: { color: colors.warning, fontSize: 13, lineHeight: 19 },
  error: { color: colors.red, fontSize: 13, marginTop: spacing.md },
  primaryButton: { borderRadius: radius.md, padding: spacing.lg, alignItems: 'center', marginTop: spacing.xl },
  primaryText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  disabled: { opacity: 0.55 },
});
