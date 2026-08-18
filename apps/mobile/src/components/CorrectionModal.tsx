import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { assessFreshness, calculateCorrection, isSensorReading, type CorrectionResult } from '@type1a/domain';
import type { CGMReading, InsulinEvent, TherapyProfile } from '@type1a/schemas';

import { formatDayTime, parsePositiveNumber } from '../format';
import { colors, radius, spacing } from '../theme';
import { ModalShell } from './ModalShell';

function Field({
  label,
  value,
  unit,
  onChange,
}: {
  label: string;
  value: string;
  unit: string;
  onChange: (value: string) => void;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.fieldInputWrap}>
        <TextInput
          value={value}
          onChangeText={onChange}
          keyboardType="decimal-pad"
          style={styles.fieldInput}
          selectTextOnFocus
        />
        <Text style={styles.fieldUnit}>{unit}</Text>
      </View>
    </View>
  );
}

export function CorrectionModal({
  visible,
  latest,
  profile,
  recentRapid,
  onClose,
  onSaveProfile,
  onRegister,
}: {
  visible: boolean;
  latest: CGMReading | null;
  profile: TherapyProfile;
  recentRapid: readonly InsulinEvent[];
  onClose: () => void;
  onSaveProfile: (profile: TherapyProfile) => Promise<void>;
  onRegister: (units: number) => Promise<void>;
}) {
  const [current, setCurrent] = useState('');
  const [target, setTarget] = useState(String(profile.targetGlucose));
  const [factor, setFactor] = useState(String(profile.correctionFactor));
  const [increment, setIncrement] = useState(String(profile.doseIncrement));
  /**
   * The reading that filled the field, frozen at prefill time. `latest` keeps
   * changing underneath us (the app refreshes on foreground), so validating
   * freshness against it would check a newer reading than the number shown.
   */
  const [prefilled, setPrefilled] = useState<{ glucose: number; sourceTimestamp: string; isSensor: boolean; isSynthetic: boolean } | null>(null);
  const [result, setResult] = useState<CorrectionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only re-initialize the form on the true "modal just opened" transition.
  // `latest` and `profile` are freshly parsed objects on every background
  // refresh (new identity, same or different value) — and saving the
  // profile below changes `profile`'s identity as a side effect of its own
  // click. Resetting on every identity change (instead of just on open)
  // was wiping the just-computed result/error mid-session with no visible
  // error, since it isn't a failure path — it's "open modal fresh" firing
  // again while already open.
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      const canUseReading = latest !== null && assessFreshness(latest.sourceTimestamp).state === 'connected';
      setCurrent(canUseReading ? String(latest.glucose) : '');
      setPrefilled(canUseReading && latest !== null
        ? {
            glucose: latest.glucose,
            sourceTimestamp: latest.sourceTimestamp,
            isSensor: isSensorReading(latest),
            isSynthetic: latest.origin === 'synthetic',
          }
        : null);
      setTarget(String(profile.targetGlucose));
      setFactor(String(profile.correctionFactor));
      setIncrement(String(profile.doseIncrement));
      setResult(null);
      setError(null);
    }
    wasVisibleRef.current = visible;
  }, [visible, latest, profile]);

  async function calculate(): Promise<void> {
    const currentGlucose = parsePositiveNumber(current);
    const targetGlucose = parsePositiveNumber(target);
    const correctionFactor = parsePositiveNumber(factor);
    const doseIncrement = parsePositiveNumber(increment);
    if (currentGlucose === null || targetGlucose === null || correctionFactor === null || doseIncrement === null || doseIncrement > 1) {
      setError('Revisa glucosa, objetivo, factor e incremento (máximo 1 U).');
      return;
    }
    // Validate the snapshot that filled the field, not whatever `latest` has
    // refreshed to since — otherwise a newer reading can vouch for an older
    // number still sitting in the input.
    if (prefilled !== null && currentGlucose === prefilled.glucose) {
      if (assessFreshness(prefilled.sourceTimestamp).state !== 'connected') {
        setPrefilled(null);
        setCurrent('');
        setError('La lectura dejó de estar vigente. Ingresa una glucosa actual manualmente.');
        return;
      }
      if (prefilled.isSynthetic) {
        setError('La glucosa precargada es sintética (modo demo). Escribe una medición real antes de calcular.');
        return;
      }
    }
    const nextProfile: TherapyProfile = {
      ...profile,
      targetGlucose,
      correctionFactor,
      doseIncrement,
    };
    setBusy(true);
    setError(null);
    try {
      await onSaveProfile(nextProfile);
      setResult(calculateCorrection({ currentGlucose, targetGlucose, correctionFactor, doseIncrement }));
    } catch {
      setError('No se pudieron guardar los parámetros.');
    } finally {
      setBusy(false);
    }
  }

  async function register(): Promise<void> {
    if (result === null || result.roundedUnits <= 0) return;
    setBusy(true);
    try {
      await onRegister(result.roundedUnits);
      onClose();
    } catch {
      setError('No se pudo registrar la insulina rápida.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell visible={visible} title="Corrección experimental" onClose={onClose}>
      <View style={styles.warningBox}>
        <Text style={styles.warningTitle}>Cálculo matemático, no recomendación</Text>
        <Text style={styles.warningText}>Usa solo los parámetros indicados por tu equipo clínico. Type 1A no calcula insulina activa (IOB) ni resta dosis anteriores.</Text>
      </View>

      {prefilled === null ? (
        <Text style={styles.staleText}>No hay lectura vigente para precargar. Escribe una medición actual.</Text>
      ) : prefilled.isSynthetic ? (
        <Text style={styles.syntheticText}>
          Glucosa precargada SINTÉTICA (modo demo) · {formatDayTime(prefilled.sourceTimestamp)}. No sirve para dosificar.
        </Text>
      ) : prefilled.isSensor ? (
        <Text style={styles.liveText}>Glucosa precargada desde el sensor · {formatDayTime(prefilled.sourceTimestamp)}</Text>
      ) : (
        <Text style={styles.manualText}>
          Glucosa precargada desde tu última medición manual · {formatDayTime(prefilled.sourceTimestamp)} (no viene del sensor)
        </Text>
      )}

      <Field
        label="Glucosa actual"
        value={current}
        unit="mg/dL"
        onChange={(value) => { setCurrent(value); setPrefilled(null); setResult(null); }}
      />
      <View style={styles.row}>
        <Field label="Objetivo" value={target} unit="mg/dL" onChange={(value) => { setTarget(value); setResult(null); }} />
        <Field label="Factor" value={factor} unit="mg/dL/U" onChange={(value) => { setFactor(value); setResult(null); }} />
      </View>
      <Field label="Incremento de pluma" value={increment} unit="U" onChange={(value) => { setIncrement(value); setResult(null); }} />

      <View style={styles.recentBox}>
        <Text style={styles.recentTitle}>Insulina rápida registrada · últimas 6 h</Text>
        {recentRapid.length === 0 ? (
          <Text style={styles.recentText}>No hay eventos registrados.</Text>
        ) : recentRapid.map((event) => (
          <Text key={event.id} style={styles.recentText}>{event.units} U · {formatDayTime(event.timestamp)}</Text>
        ))}
        <Text style={styles.recentFoot}>Contexto informativo; no es una estimación de IOB.</Text>
      </View>

      {error === null ? null : <Text style={styles.error}>{error}</Text>}
      <Pressable style={[styles.calculateButton, busy && styles.disabled]} disabled={busy} onPress={() => { void calculate(); }}>
        <Text style={styles.calculateText}>{busy ? 'Calculando…' : 'Guardar parámetros y calcular'}</Text>
      </Pressable>

      {result === null ? null : (
        <View style={styles.resultBox}>
          <Text style={styles.resultLabel}>RESULTADO DE LA FÓRMULA</Text>
          <Text style={styles.resultValue}>{result.roundedUnits} U</Text>
          <Text style={styles.formula}>{result.formula} = {result.rawUnits.toFixed(2)} U, redondeado al incremento.</Text>
          {result.isBelowTarget ? <Text style={styles.below}>Glucosa bajo el objetivo: el resultado se limita a 0 U.</Text> : null}
          {result.roundedUnits > 0 ? (
            <Pressable style={[styles.registerButton, busy && styles.disabled]} disabled={busy} onPress={() => { void register(); }}>
              <Text style={styles.registerText}>Confirmar y registrar {result.roundedUnits} U como rápida</Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </ModalShell>
  );
}

const styles = StyleSheet.create({
  warningBox: { backgroundColor: colors.warningSoft, borderRadius: radius.md, padding: spacing.md },
  warningTitle: { color: colors.warning, fontWeight: '800', fontSize: 14 },
  warningText: { color: colors.warning, fontSize: 13, lineHeight: 19, marginTop: 4 },
  staleText: { color: colors.red, fontSize: 13, lineHeight: 19, marginTop: spacing.lg },
  liveText: { color: colors.green, fontSize: 13, marginTop: spacing.lg },
  manualText: { color: colors.navy, fontSize: 13, lineHeight: 19, marginTop: spacing.lg },
  syntheticText: { color: colors.warning, fontSize: 13, lineHeight: 19, marginTop: spacing.lg, fontWeight: '700' },
  field: { flex: 1, marginTop: spacing.lg },
  fieldLabel: { color: colors.navy, fontSize: 12, fontWeight: '800' },
  fieldInputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.sm, borderColor: colors.line, borderWidth: 1, marginTop: 6, paddingHorizontal: spacing.md },
  fieldInput: { color: colors.ink, fontSize: 22, fontWeight: '700', flex: 1, paddingVertical: spacing.md },
  fieldUnit: { color: colors.muted, fontSize: 11, marginLeft: 4 },
  row: { flexDirection: 'row', gap: spacing.md },
  recentBox: { borderLeftWidth: 3, borderLeftColor: colors.blue, paddingLeft: spacing.md, marginTop: spacing.xl },
  recentTitle: { color: colors.navy, fontSize: 13, fontWeight: '800' },
  recentText: { color: colors.ink, fontSize: 13, marginTop: 5 },
  recentFoot: { color: colors.muted, fontSize: 11, marginTop: 7 },
  error: { color: colors.red, fontSize: 13, marginTop: spacing.md },
  calculateButton: { backgroundColor: colors.teal, borderRadius: radius.md, padding: spacing.lg, alignItems: 'center', marginTop: spacing.xl },
  calculateText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  resultBox: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg, marginTop: spacing.lg, borderWidth: 2, borderColor: colors.teal },
  resultLabel: { color: colors.teal, fontSize: 11, fontWeight: '900', letterSpacing: 0.8 },
  resultValue: { color: colors.ink, fontSize: 48, fontWeight: '900', marginTop: 2 },
  formula: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  below: { color: colors.red, fontSize: 13, marginTop: spacing.sm },
  registerButton: { backgroundColor: colors.blue, borderRadius: radius.sm, padding: spacing.md, alignItems: 'center', marginTop: spacing.lg },
  registerText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800', textAlign: 'center' },
  disabled: { opacity: 0.55 },
});
