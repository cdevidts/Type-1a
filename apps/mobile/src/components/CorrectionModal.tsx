import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { assessFreshness, calculateCorrection, convertGlucose, isSensorReading, type CorrectionResult } from '@type1a/domain';
import type { CGMReading, InsulinEvent, TherapyProfile } from '@type1a/schemas';

import { formatClock, formatDayTime, parsePositiveNumber } from '../format';
import { logSaveError } from '../log';
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
  therapyConfigured,
  recentRapid,
  onClose,
  onSaveProfile,
  onRegister,
}: {
  visible: boolean;
  latest: CGMReading | null;
  profile: TherapyProfile;
  /** False while the therapy values are still the placeholders shipped with the app. */
  therapyConfigured: boolean;
  recentRapid: readonly InsulinEvent[];
  onClose: () => void;
  onSaveProfile: (profile: TherapyProfile) => Promise<void>;
  onRegister: (units: number) => Promise<void>;
}) {
  const [current, setCurrent] = useState('');
  // Empty until configured, matching Ajustes. Showing the shipped
  // placeholders here would contradict the notice there that the app doesn't
  // propose therapy values — and three plausible-looking numbers read as a
  // recommendation, which is exactly what she must not copy back into Ajustes.
  const [target, setTarget] = useState(therapyConfigured ? String(profile.targetGlucose) : '');
  const [factor, setFactor] = useState(therapyConfigured ? String(profile.correctionFactor) : '');
  const [increment, setIncrement] = useState(therapyConfigured ? String(profile.doseIncrement) : '');
  /**
   * The reading that filled the field, frozen at prefill time. `latest` keeps
   * changing underneath us (the app refreshes on foreground), so validating
   * freshness against it would check a newer reading than the number shown.
   */
  const [prefilled, setPrefilled] = useState<{ glucose: number; sourceTimestamp: string; isSensor: boolean; isSynthetic: boolean } | null>(null);
  const [result, setResult] = useState<CorrectionResult | null>(null);
  // Stamped so a dose built from a hand-typed glucose — which the app
  // deliberately never expires — still shows its own age.
  const [calculatedAt, setCalculatedAt] = useState('');
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
      // Convertido a mg/dL antes de precargar: este valor entra directo al
      // cálculo de dosis de corrección, así que tiene que quedar en la misma
      // unidad en la que la usuaria escribió target/factor — mezclar mmol/L
      // crudo con parámetros pensados en mg/dL arruina el cálculo, no solo
      // la lectura.
      const currentGlucoseMgDl = canUseReading && latest !== null
        ? convertGlucose(latest.glucose, latest.unit, 'mg/dL')
        : null;
      setCurrent(currentGlucoseMgDl === null ? '' : String(currentGlucoseMgDl));
      setPrefilled(currentGlucoseMgDl === null || latest === null
        ? null
        : {
            glucose: currentGlucoseMgDl,
            sourceTimestamp: latest.sourceTimestamp,
            isSensor: isSensorReading(latest),
            isSynthetic: latest.origin === 'synthetic',
          });
      setTarget(therapyConfigured ? String(profile.targetGlucose) : '');
      setFactor(therapyConfigured ? String(profile.correctionFactor) : '');
      setIncrement(therapyConfigured ? String(profile.doseIncrement) : '');
      setResult(null);
      setError(null);
    }
    wasVisibleRef.current = visible;
  }, [visible, latest, profile, therapyConfigured]);

  async function calculate(): Promise<void> {
    // The fields below arrive pre-filled with the values the app ships with,
    // which look no different from real ones. Until they've been confirmed
    // in Ajustes, calculating here would just launder a placeholder into a
    // dose — and, since saving is a side effect of this button, would also
    // mark them "configured" for every other screen.
    if (!therapyConfigured) {
      setError('Antes de calcular, confirma tus parámetros en Ajustes → Parámetros de terapia. Los valores que trae la app son solo de ejemplo y no sirven para dosificar.');
      return;
    }
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
    // Invariant: `prefilled` is cleared on any edit of the glucose field, so
    // a non-null `prefilled` means the field still holds exactly that
    // reading. Don't reintroduce a value comparison here — if the banner is
    // ever kept visible after an edit, comparing by value would let a
    // hand-typed number inherit the prefill's freshness verdict.
    if (prefilled !== null) {
      if (assessFreshness(prefilled.sourceTimestamp).state !== 'connected') {
        setPrefilled(null);
        setCurrent('');
        // Drop the previous result too: leaving it on screen would put a
        // live "registrar N U" button directly under the message saying the
        // reading it came from is no longer valid.
        setResult(null);
        setError('La lectura dejó de estar vigente. Ingresa una glucosa actual manualmente.');
        return;
      }
      if (prefilled.isSynthetic) {
        setResult(null);
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
      setCalculatedAt(new Date().toISOString());
    } catch (error) {
      logSaveError('CorrectionModal.calculate', error);
      setError('No se pudieron guardar los parámetros.');
    } finally {
      setBusy(false);
    }
  }

  async function register(): Promise<void> {
    if (result === null || result.roundedUnits <= 0) return;
    // A computed result doesn't expire on its own, and this button writes an
    // insulin event directly. The sheet can sit open for an hour (phone
    // locked, user interrupted), so re-check the reading the dose was built
    // from at the moment of the tap, not just when it was calculated.
    if (prefilled !== null && assessFreshness(prefilled.sourceTimestamp).state !== 'connected') {
      setPrefilled(null);
      setCurrent('');
      setResult(null);
      setError('La lectura que originó esta dosis ya no está vigente. Ingresa una glucosa actual y vuelve a calcular.');
      return;
    }
    setBusy(true);
    try {
      await onRegister(result.roundedUnits);
      onClose();
    } catch (error) {
      logSaveError('CorrectionModal.register', error);
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
          <Text style={styles.resultLabel}>RESULTADO DE LA FÓRMULA · {formatClock(calculatedAt)}</Text>
          <Text style={styles.resultValue}>{result.roundedUnits} U</Text>
          <Text style={styles.formula}>{result.formula} = {result.rawUnits.toFixed(2)} U, redondeado al incremento.</Text>
          {result.isBelowTarget ? <Text style={styles.below}>Glucosa bajo el objetivo: el resultado se limita a 0 U.</Text> : null}
          {result.isHypoglycemic ? (
            <View style={styles.hypoBox}>
              <Text style={styles.hypoText}>
                Estás en hipoglucemia. Trata la hipoglucemia primero y calcula la dosis después de recuperarte — este número no reemplaza esa decisión.
              </Text>
            </View>
          ) : null}
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
  hypoBox: { backgroundColor: colors.redSoft, borderRadius: radius.sm, padding: spacing.md, marginTop: spacing.md },
  hypoText: { color: colors.red, fontSize: 13, lineHeight: 19, fontWeight: '700' },
  registerButton: { backgroundColor: colors.blue, borderRadius: radius.sm, padding: spacing.md, alignItems: 'center', marginTop: spacing.lg },
  registerText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800', textAlign: 'center' },
  disabled: { opacity: 0.55 },
});
