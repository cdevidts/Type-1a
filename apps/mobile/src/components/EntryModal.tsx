import { useEffect, useRef, useState } from 'react';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { AppState, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { assessFreshness, calculateCorrection, calculateMealBolus, isSensorReading } from '@type1a/domain';
import type { CGMReading, MealAnalysisResult, TherapyProfile } from '@type1a/schemas';

import { analyzeMealImage, MobileApiError } from '../api';
import { formatDayTime, parseNonNegativeNumber, parsePositiveNumber } from '../format';
import { colors, radius, spacing } from '../theme';
import { ModalShell } from './ModalShell';

const HYPO_WARNING = 'Estás en hipoglucemia. Trata la hipoglucemia primero y calcula la dosis después de recuperarte — este número no reemplaza esa decisión.';

/**
 * Display-normalized output of whichever domain calculator ran. The maths
 * always happens in `@type1a/domain` — this only carries its result and the
 * formula lines to show, so the screen never does arithmetic of its own.
 */
interface DoseSuggestion {
  units: number;
  lines: string[];
  belowTargetNote: string | null;
  hypoWarning: string | null;
  /** The therapy parameters this number came from, echoed so a wrong one is visible here. */
  parameterSummary: string;
}

/**
 * The reading that actually populated the glucose field, frozen at that
 * moment. The `latest` prop keeps moving while the sheet is open (the app
 * refreshes whenever it returns to the foreground), so re-checking freshness
 * against `latest` would validate a *newer* reading than the number sitting
 * in the field. Everything about the prefill — its freshness, its timestamp,
 * its provenance label — has to be judged against this snapshot.
 */
interface PrefilledReading {
  glucose: number;
  sourceTimestamp: string;
  isSensor: boolean;
  isSynthetic: boolean;
}

export interface UnifiedEntryDraft {
  /** When the entry happened, as shown in the sheet's header. */
  timestamp: string;
  /** True when the rapid dose the user is saving covers a correction too. */
  rapidIncludesCorrection: boolean;
  /** Only set when the user typed it — a value carried over from CGM is not re-saved. */
  manualGlucose?: number;
  description?: string;
  carbsG?: number;
  imageUri?: string;
  analysis?: MealAnalysisResult;
  rapidUnits?: number;
  basalUnits?: number;
  note?: string;
}

function Field({
  label,
  value,
  unit,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  unit: string;
  placeholder?: string;
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
          placeholder={placeholder ?? '—'}
          placeholderTextColor={colors.muted}
          selectTextOnFocus
        />
        <Text style={styles.fieldUnit}>{unit}</Text>
      </View>
    </View>
  );
}

export function EntryModal({
  visible,
  latest,
  profile,
  therapyConfigured,
  onClose,
  onSave,
}: {
  visible: boolean;
  latest: CGMReading | null;
  profile: TherapyProfile;
  /** False while the therapy values are still the placeholders shipped with the app. */
  therapyConfigured: boolean;
  onClose: () => void;
  onSave: (draft: UnifiedEntryDraft) => Promise<void>;
}) {
  const [glucose, setGlucose] = useState('');
  const [prefilled, setPrefilled] = useState<PrefilledReading | null>(null);
  const [description, setDescription] = useState('');
  const [carbs, setCarbs] = useState('');
  const [rapid, setRapid] = useState('');
  const [basal, setBasal] = useState('');
  const [note, setNote] = useState('');
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<MealAnalysisResult | null>(null);
  const [suggestion, setSuggestion] = useState<DoseSuggestion | null>(null);
  const [correctionIncluded, setCorrectionIncluded] = useState(false);
  const [rapidFromCalculator, setRapidFromCalculator] = useState(false);
  const [rapidStale, setRapidStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [openedAt, setOpenedAt] = useState<string>(() => new Date().toISOString());

  // Same gating as CorrectionModal: reset only on the real open transition,
  // never on a background refresh that hands us a new `latest`/`profile`
  // object identity while the user is mid-entry.
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      const canUseReading = latest !== null && assessFreshness(latest.sourceTimestamp).state === 'connected';
      setGlucose(canUseReading ? String(latest.glucose) : '');
      setPrefilled(canUseReading && latest !== null
        ? {
            glucose: latest.glucose,
            sourceTimestamp: latest.sourceTimestamp,
            isSensor: isSensorReading(latest),
            isSynthetic: latest.origin === 'synthetic',
          }
        : null);
      setDescription('');
      setCarbs('');
      setRapid('');
      setBasal('');
      setNote('');
      setImageUri(null);
      setAnalysis(null);
      setSuggestion(null);
      setCorrectionIncluded(false);
      setRapidFromCalculator(false);
      setRapidStale(false);
      setMessage(null);
      setOpenedAt(new Date().toISOString());
    }
    wasVisibleRef.current = visible;
  }, [visible, latest]);

  // The sheet can sit open across a long break (it isn't dismissed when the
  // app is backgrounded), and everything written here — the bolus, the carbs,
  // the meal episode's +60/+120/+180 window — is stamped with `openedAt`.
  // Re-stamp on return so a three-hour-old header time doesn't become the
  // recorded time of a meal that's about to be eaten. Only the timestamp
  // moves; nothing the user typed is touched.
  useEffect(() => {
    if (!visible) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') setOpenedAt(new Date().toISOString());
    });
    return () => { subscription.remove(); };
  }, [visible]);

  /**
   * Drop a suggestion whose inputs just changed. If its number was already
   * copied into the insulin field it stays there — silently editing what the
   * user typed would be worse — but it gets flagged as stale so a dose from
   * the old carbs/glucose can't be saved looking freshly calculated.
   */
  function invalidateSuggestion(): void {
    setSuggestion(null);
    if (rapidFromCalculator) setRapidStale(true);
  }

  async function captureAndAnalyze(): Promise<void> {
    setMessage(null);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setMessage('No hay permiso de cámara. Puedes escribir los carbohidratos a mano.');
      return;
    }
    const picked = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      exif: false,
      quality: 1,
    });
    if (picked.canceled) return;

    setBusy(true);
    setAnalysis(null);
    try {
      const asset = picked.assets[0]!;
      const context = ImageManipulator.ImageManipulator.manipulate(asset.uri);
      context.resize({ width: 1280, height: null });
      const rendered = await context.renderAsync();
      const compressed = await rendered.saveAsync({
        base64: true,
        compress: 0.72,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      setImageUri(compressed.uri);
      if (compressed.base64 === undefined) throw new Error('No base64 image');
      const nextAnalysis = await analyzeMealImage({
        imageBase64: compressed.base64,
        mimeType: 'image/jpeg',
        ...(description.trim() === '' ? {} : { description: description.trim() }),
      });
      setAnalysis(nextAnalysis);
      setMessage('Estimación lista. Escribe tú los carbohidratos que confirmas.');
    } catch (error) {
      setMessage(error instanceof MobileApiError
        ? `${error.message} Continúa con el ingreso manual.`
        : 'No se pudo analizar la foto. Continúa con el ingreso manual.');
    } finally {
      setBusy(false);
    }
  }

  function calculate(): void {
    setMessage(null);
    // Refuse outright while the therapy values are still the ones the app
    // shipped with. A dose derived from a placeholder factor would look
    // exactly like a real one on screen.
    if (!therapyConfigured) {
      setMessage('Antes de calcular, confirma tus parámetros en Ajustes → Parámetros de terapia. Los valores que trae la app son solo de ejemplo y no sirven para dosificar.');
      return;
    }
    const carbsG = carbs.trim() === '' ? 0 : parseNonNegativeNumber(carbs);
    if (carbsG === null || carbsG > 500) {
      setMessage('Escribe los carbohidratos entre 0 y 500 g (o déjalo vacío).');
      return;
    }
    const currentGlucose = glucose.trim() === '' ? undefined : parsePositiveNumber(glucose);
    if (currentGlucose === null) {
      setMessage('La glucosa debe ser un número positivo.');
      return;
    }
    // Judge the reading that actually filled the field, not whatever the app
    // has refreshed to since. A value that went stale while the sheet sat
    // open must not silently drive a dose.
    //
    // Invariant: `prefilled` is cleared on any edit of the glucose field, so
    // a non-null `prefilled` means the field still holds exactly that
    // reading. Don't reintroduce a value comparison here — if the banner is
    // ever kept visible after an edit, comparing by value would let a
    // hand-typed number inherit the prefill's freshness verdict.
    if (prefilled !== null) {
      if (assessFreshness(prefilled.sourceTimestamp).state !== 'connected') {
        setPrefilled(null);
        setGlucose('');
        invalidateSuggestion();
        setMessage('La lectura precargada dejó de estar vigente. Escribe una glucosa actual.');
        return;
      }
      if (prefilled.isSynthetic) {
        invalidateSuggestion();
        setMessage('La glucosa precargada es sintética (modo demo). No la uses para dosificar: escribe una medición real.');
        return;
      }
    }

    // Two genuinely different calculations, kept apart on purpose. Carb
    // coverage is impossible without a carbRatio the user configured, so
    // when there are carbs and no ratio we stop and say so — we never
    // substitute a stand-in value. With no carbs there is nothing to cover
    // and this is simply the existing correction formula.
    if (carbsG > 0) {
      const carbRatio = profile.carbRatio;
      if (carbRatio === undefined) {
        setMessage('Falta "Carbs por unidad" en Ajustes → Parámetros de terapia. Sin ese valor no se puede calcular el bolo de comida.');
        return;
      }
      const result = calculateMealBolus({
        carbsG,
        carbRatio,
        targetGlucose: profile.targetGlucose,
        correctionFactor: profile.correctionFactor,
        doseIncrement: profile.doseIncrement,
        ...(currentGlucose === undefined ? {} : { currentGlucose }),
      });
      setSuggestion({
        units: result.totalRoundedUnits,
        lines: [
          `Comida: ${result.mealFormula} = ${result.mealUnits.toFixed(2)} U`,
          result.correctionFormula === null
            ? 'Sin corrección: no había glucosa actual.'
            : `Corrección: ${result.correctionFormula} = ${result.correctionUnits.toFixed(2)} U`,
          `Total ${result.totalRawUnits.toFixed(2)} U, redondeado al incremento de ${profile.doseIncrement} U.`,
        ],
        belowTargetNote: result.isBelowTarget
          ? 'Glucosa bajo el objetivo: la corrección resta de la dosis de comida.'
          : null,
        hypoWarning: result.isHypoglycemic ? HYPO_WARNING : null,
        parameterSummary: `Objetivo ${profile.targetGlucose} · factor ${profile.correctionFactor} · ratio ${carbRatio} g/U · incremento ${profile.doseIncrement} U`,
      });
      setCorrectionIncluded(result.correctionApplied);
      return;
    }

    if (currentGlucose === undefined) {
      setMessage('Para calcular necesitas carbohidratos, una glucosa actual, o ambos.');
      return;
    }
    const result = calculateCorrection({
      currentGlucose,
      targetGlucose: profile.targetGlucose,
      correctionFactor: profile.correctionFactor,
      doseIncrement: profile.doseIncrement,
    });
    setSuggestion({
      units: result.roundedUnits,
      lines: [
        `Corrección: ${result.formula} = ${result.rawUnits.toFixed(2)} U`,
        `Redondeado al incremento de ${profile.doseIncrement} U.`,
      ],
      belowTargetNote: result.isBelowTarget
        ? 'Glucosa bajo el objetivo: el resultado se limita a 0 U.'
        : null,
      // Straight from the domain result — the cutoff lives in
      // packages/domain so this path and the meal-bolus path above can't
      // drift into disagreeing about whether the user is low.
      hypoWarning: result.isHypoglycemic ? HYPO_WARNING : null,
      parameterSummary: `Objetivo ${profile.targetGlucose} · factor ${profile.correctionFactor} · incremento ${profile.doseIncrement} U`,
    });
    setCorrectionIncluded(true);
  }

  async function save(): Promise<void> {
    const carbsG = carbs.trim() === '' ? undefined : parseNonNegativeNumber(carbs);
    const rapidUnits = rapid.trim() === '' ? undefined : parsePositiveNumber(rapid);
    const basalUnits = basal.trim() === '' ? undefined : parsePositiveNumber(basal);
    const glucoseValue = glucose.trim() === '' ? undefined : parsePositiveNumber(glucose);

    if (carbsG === null || (carbsG !== undefined && carbsG > 500)) {
      setMessage('Escribe los carbohidratos entre 0 y 500 g (o déjalo vacío).');
      return;
    }
    if (rapidUnits === null || basalUnits === null || glucoseValue === null) {
      setMessage('Revisa los valores numéricos: deben ser positivos o quedar vacíos.');
      return;
    }
    // Same bounds the event schemas enforce, checked here so a typo (150 for
    // 15.0) is a message instead of a rejected write.
    if ((rapidUnits !== undefined && rapidUnits > 100) || (basalUnits !== undefined && basalUnits > 100)) {
      setMessage('Las unidades de insulina deben ser 100 U o menos. Revisa si escribiste un punto de más.');
      return;
    }
    const hasSomething = carbsG !== undefined || rapidUnits !== undefined || basalUnits !== undefined
      || glucoseValue !== undefined || description.trim() !== '' || note.trim() !== '';
    if (!hasSomething) {
      setMessage('Completa al menos un campo antes de guardar.');
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      await onSave({
        timestamp: openedAt,
        rapidIncludesCorrection: rapidFromCalculator && correctionIncluded,
        // Only a hand-typed glucose becomes a new stored reading; an
        // untouched prefill is already in the database and must not be
        // duplicated. Same invariant as in `calculate()`: `prefilled` is
        // non-null exactly while the field still holds the prefilled value.
        ...(glucoseValue === undefined || prefilled !== null ? {} : { manualGlucose: glucoseValue }),
        ...(description.trim() === '' ? {} : { description: description.trim() }),
        ...(carbsG === undefined ? {} : { carbsG }),
        ...(imageUri === null ? {} : { imageUri }),
        ...(analysis === null ? {} : { analysis }),
        ...(rapidUnits === undefined ? {} : { rapidUnits }),
        ...(basalUnits === undefined ? {} : { basalUnits }),
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
      onClose();
    } catch {
      setMessage('No se pudo guardar la entrada. Inténtalo otra vez.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell visible={visible} title="Nueva entrada" onClose={onClose}>
      <View style={styles.timeRow}>
        <Text style={styles.timeLabel}>Hora</Text>
        <Text style={styles.timeValue}>{formatDayTime(openedAt)}</Text>
      </View>

      <Text style={styles.sectionTitle}>Glucosa</Text>
      {prefilled === null ? (
        <Text style={styles.staleText}>Sin lectura vigente para precargar. Escríbela si te mediste.</Text>
      ) : prefilled.isSynthetic ? (
        <Text style={styles.syntheticText}>
          Precargada con un valor SINTÉTICO (modo demo) · {formatDayTime(prefilled.sourceTimestamp)}. No sirve para dosificar.
        </Text>
      ) : prefilled.isSensor ? (
        <Text style={styles.liveText}>Precargada desde el sensor · {formatDayTime(prefilled.sourceTimestamp)}</Text>
      ) : (
        <Text style={styles.manualText}>
          Precargada desde tu última medición manual · {formatDayTime(prefilled.sourceTimestamp)} (no viene del sensor)
        </Text>
      )}
      <Field
        label="Glucemia"
        value={glucose}
        unit="mg/dL"
        onChange={(value) => { setGlucose(value); setPrefilled(null); invalidateSuggestion(); }}
      />

      <Text style={styles.sectionTitle}>Comida</Text>
      <TextInput
        style={styles.description}
        value={description}
        onChangeText={setDescription}
        placeholder="¿Qué comiste? Ej.: pollo con arroz y ensalada"
        placeholderTextColor={colors.muted}
        maxLength={300}
        multiline
      />
      <Pressable style={[styles.cameraButton, busy && styles.disabled]} disabled={busy} onPress={() => { void captureAndAnalyze(); }}>
        <Text style={styles.cameraText}>{busy ? 'Procesando…' : '◎  Foto para estimar carbohidratos'}</Text>
      </Pressable>
      {imageUri === null ? null : <Image source={{ uri: imageUri }} style={styles.preview} resizeMode="cover" />}
      {analysis === null ? null : (
        <View style={styles.analysisBox}>
          <Text style={styles.analysisTitle}>Estimación IA · ≈ {analysis.totals.carbsG} g</Text>
          <Text style={styles.analysisFoods}>{analysis.estimate.foods.map((food) => food.name).join(' · ')}</Text>
          <Text style={styles.analysisFoot}>Solo estima alimentos. Nunca calcula insulina — los carbohidratos los confirmas tú abajo.</Text>
        </View>
      )}
      <Field label="Carbohidratos confirmados" value={carbs} unit="g" onChange={(value) => { setCarbs(value); invalidateSuggestion(); }} />

      <Text style={styles.sectionTitle}>Calculadora de dosis</Text>
      <View style={styles.warningBox}>
        <Text style={styles.warningTitle}>Aritmética con tus parámetros, no una recomendación</Text>
        <Text style={styles.warningText}>
          Usa el objetivo, el factor de corrección y los carbs por unidad que configuraste con tu equipo clínico.
          No descuenta insulina activa (IOB) de dosis anteriores: si te pinchaste hace poco, este número queda alto.
        </Text>
      </View>
      <Pressable style={[styles.calculateButton, busy && styles.disabled]} disabled={busy} onPress={calculate}>
        <Text style={styles.calculateText}>Calcular dosis sugerida</Text>
      </Pressable>

      {suggestion === null ? null : (
        <View style={styles.resultBox}>
          <Text style={styles.resultLabel}>RESULTADO DE LA FÓRMULA</Text>
          <Text style={styles.resultValue}>{suggestion.units} U</Text>
          {suggestion.lines.map((line) => (
            <Text key={line} style={styles.formula}>{line}</Text>
          ))}
          <Text style={styles.parameterSummary}>Con: {suggestion.parameterSummary}</Text>
          {suggestion.belowTargetNote === null ? null : (
            <Text style={styles.below}>{suggestion.belowTargetNote}</Text>
          )}
          {suggestion.hypoWarning === null ? null : (
            <View style={styles.hypoBox}><Text style={styles.hypoText}>{suggestion.hypoWarning}</Text></View>
          )}
          {suggestion.units === 0 ? (
            <Text style={styles.useFoot}>La fórmula da 0 U: no hay nada que registrar como rápida.</Text>
          ) : (
            <>
              <Pressable
                style={styles.useButton}
                onPress={() => {
                  setRapid(String(suggestion.units));
                  setRapidFromCalculator(true);
                  setRapidStale(false);
                }}
              >
                <Text style={styles.useText}>Usar {suggestion.units} U como rápida</Text>
              </Pressable>
              <Text style={styles.useFoot}>No se copia sola: revisa el número y edítalo si tu equipo clínico indica otra cosa.</Text>
            </>
          )}
        </View>
      )}

      <Text style={styles.sectionTitle}>Insulina</Text>
      <View style={styles.row}>
        <Field
          label="Rápida"
          value={rapid}
          unit="U"
          onChange={(value) => { setRapid(value); setRapidFromCalculator(false); setRapidStale(false); }}
        />
        <Field label="Acción prolongada" value={basal} unit="U" onChange={setBasal} />
      </View>
      {rapidStale ? (
        <Text style={styles.staleDose}>
          Cambiaste los carbohidratos o la glucosa después de copiar esta dosis. Vuelve a calcular o escribe el valor que te vas a poner.
        </Text>
      ) : null}
      <Text style={styles.hint}>Se guarda exactamente lo que escribas aquí, no lo calculado.</Text>

      <Text style={styles.sectionTitle}>Nota</Text>
      <TextInput
        style={styles.description}
        value={note}
        onChangeText={setNote}
        placeholder="Ejercicio, estrés, enfermedad, lo que quieras recordar"
        placeholderTextColor={colors.muted}
        maxLength={300}
        multiline
      />

      {message === null ? null : <Text style={styles.message}>{message}</Text>}
      <Pressable style={[styles.saveButton, busy && styles.disabled]} disabled={busy} onPress={() => { void save(); }}>
        <Text style={styles.saveText}>{busy ? 'Guardando…' : 'Guardar entrada'}</Text>
      </Pressable>
    </ModalShell>
  );
}

const styles = StyleSheet.create({
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingBottom: spacing.sm, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth },
  timeLabel: { color: colors.muted, fontSize: 13 },
  timeValue: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', marginTop: spacing.xl },
  liveText: { color: colors.green, fontSize: 12, marginTop: 4 },
  staleText: { color: colors.red, fontSize: 12, lineHeight: 17, marginTop: 4 },
  manualText: { color: colors.navy, fontSize: 12, lineHeight: 17, marginTop: 4 },
  syntheticText: { color: colors.warning, fontSize: 12, lineHeight: 17, marginTop: 4, fontWeight: '700' },
  parameterSummary: { color: colors.navy, fontSize: 11, lineHeight: 16, marginTop: spacing.sm, fontWeight: '700' },
  hypoBox: { backgroundColor: colors.redSoft, borderRadius: radius.sm, padding: spacing.md, marginTop: spacing.md },
  hypoText: { color: colors.red, fontSize: 13, lineHeight: 19, fontWeight: '700' },
  staleDose: { color: colors.warning, fontSize: 12, lineHeight: 17, marginTop: spacing.sm, fontWeight: '700' },
  field: { flex: 1, marginTop: spacing.md },
  fieldLabel: { color: colors.navy, fontSize: 12, fontWeight: '800' },
  fieldInputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.sm, borderColor: colors.line, borderWidth: 1, marginTop: 6, paddingHorizontal: spacing.md },
  fieldInput: { color: colors.ink, fontSize: 20, fontWeight: '700', flex: 1, paddingVertical: spacing.md },
  fieldUnit: { color: colors.muted, fontSize: 11, marginLeft: 4 },
  row: { flexDirection: 'row', gap: spacing.md },
  hint: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 6 },
  description: { backgroundColor: colors.surface, color: colors.ink, borderColor: colors.line, borderWidth: 1, borderRadius: radius.sm, minHeight: 64, padding: spacing.md, marginTop: spacing.sm, textAlignVertical: 'top' },
  cameraButton: { backgroundColor: colors.navy, borderRadius: radius.sm, padding: spacing.md, alignItems: 'center', marginTop: spacing.sm },
  cameraText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  preview: { width: '100%', height: 180, borderRadius: radius.md, marginTop: spacing.sm },
  analysisBox: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm, borderColor: colors.line, borderWidth: 1 },
  analysisTitle: { color: colors.orange, fontSize: 14, fontWeight: '800' },
  analysisFoods: { color: colors.ink, fontSize: 13, lineHeight: 18, marginTop: 4 },
  analysisFoot: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 6 },
  warningBox: { backgroundColor: colors.warningSoft, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm },
  warningTitle: { color: colors.warning, fontWeight: '800', fontSize: 13 },
  warningText: { color: colors.warning, fontSize: 12, lineHeight: 18, marginTop: 4 },
  calculateButton: { backgroundColor: colors.teal, borderRadius: radius.md, padding: spacing.lg, alignItems: 'center', marginTop: spacing.md },
  calculateText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  resultBox: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg, marginTop: spacing.md, borderWidth: 2, borderColor: colors.teal },
  resultLabel: { color: colors.teal, fontSize: 11, fontWeight: '900', letterSpacing: 0.8 },
  resultValue: { color: colors.ink, fontSize: 44, fontWeight: '900', marginTop: 2 },
  formula: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  below: { color: colors.red, fontSize: 12, lineHeight: 17, marginTop: spacing.sm },
  useButton: { backgroundColor: colors.blue, borderRadius: radius.sm, padding: spacing.md, alignItems: 'center', marginTop: spacing.md },
  useText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  useFoot: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 6 },
  message: { color: colors.warning, backgroundColor: colors.warningSoft, borderRadius: radius.sm, padding: spacing.md, fontSize: 13, lineHeight: 19, marginTop: spacing.lg },
  saveButton: { backgroundColor: colors.orange, borderRadius: radius.md, padding: spacing.lg, alignItems: 'center', marginTop: spacing.xl },
  saveText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  disabled: { opacity: 0.55 },
});
