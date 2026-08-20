import { useEffect, useState } from 'react';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { scaleCatalogFood, type CatalogFood } from '@type1a/domain';
import type { MealAnalysisResult } from '@type1a/schemas';

import { analyzeMealDescription, analyzeMealImage, MobileApiError } from '../api';
import { parseNonNegativeNumber } from '../format';
import { logSaveError } from '../log';
import { colors, radius, spacing } from '../theme';
import { ModalShell } from './ModalShell';

export interface ConfirmedMealDraft {
  imageUri?: string;
  analysis?: MealAnalysisResult;
  confirmedCarbsG: number;
  /**
   * Macros opcionales (Fase 13, ítem 7). Se omiten si la usuaria los deja en
   * blanco — un campo vacío significa "no lo anoté", no "cero gramos", y esa
   * diferencia es la que impide inventar promedios en
   * `buildNutritionInsights`.
   */
  proteinG?: number;
  fatG?: number;
  fiberG?: number;
  /** Ver `MealEventSchema.macrosSource`. */
  macrosSource?: 'ai' | 'user' | 'mixed';
}

/**
 * Alimentos ya conocidos, para volver a registrarlos sin llamar a la IA.
 *
 * Es el retorno del catálogo: la gente come casi siempre lo mismo, y un
 * desayuno repetido no debería costar una foto, una espera y una llamada
 * remota. Al tocar uno se escala desde los valores por 100 g guardados.
 */
function CatalogPicker({
  foods,
  onPick,
}: {
  foods: readonly CatalogFood[];
  onPick: (food: CatalogFood) => void;
}) {
  if (foods.length === 0) return null;
  return (
    <View style={styles.catalogBox}>
      <Text style={styles.catalogTitle}>Lo que sueles comer</Text>
      <Text style={styles.catalogHint}>
        Alimentos que la IA ya reconoció antes. Tócalos para reusar su estimación sin gastar otra foto.
      </Text>
      <View style={styles.catalogRow}>
        {foods.map((food) => (
          <Pressable
            key={food.key}
            style={styles.catalogChip}
            onPress={() => { onPick(food); }}
            accessibilityRole="button"
            accessibilityLabel={`Reusar ${food.name}`}
          >
            <Text style={styles.catalogChipName}>{food.name}</Text>
            <Text style={styles.catalogChipMeta}>{food.carbsPer100g.toFixed(0)} g carbos/100 g</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export function MealModal({
  visible,
  onClose,
  onConfirm,
  catalogFoods,
}: {
  visible: boolean;
  onClose: () => void;
  onConfirm: (draft: ConfirmedMealDraft) => Promise<void>;
  /** Alimentos ya conocidos, para reusar sin llamar a la IA (Fase 15). */
  catalogFoods: readonly CatalogFood[];
}) {
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<MealAnalysisResult | null>(null);
  const [description, setDescription] = useState('');
  const [confirmedCarbs, setConfirmedCarbs] = useState('');
  const [busy, setBusy] = useState(false);
  const [macrosOpen, setMacrosOpen] = useState(false);
  const [proteinInput, setProteinInput] = useState('');
  const [fatInput, setFatInput] = useState('');
  const [fiberInput, setFiberInput] = useState('');
  /** Lo que precargó la IA, para saber después si la usuaria lo corrigió. */
  const [aiMacros, setAiMacros] = useState<{ proteinG: number; fatG: number; fiberG: number } | null>(null);
  const [pendingFood, setPendingFood] = useState<CatalogFood | null>(null);
  const [portionInput, setPortionInput] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setImageUri(null);
    setAnalysis(null);
    setDescription('');
    setConfirmedCarbs('');
    setMessage(null);
  }, [visible]);

  async function captureAndAnalyze(): Promise<void> {
    setMessage(null);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setMessage('No hay permiso de cámara. Puedes ingresar carbohidratos manualmente.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      allowsEditing: false,
      exif: false,
      quality: 1,
    });
    if (result.canceled) return;

    setBusy(true);
    setAnalysis(null);
    try {
      const asset = result.assets[0]!;
      const context = ImageManipulator.ImageManipulator.manipulate(asset.uri);
      context.resize({ width: 1280, height: null });
      const rendered = await context.renderAsync();
      const compressed = await rendered.saveAsync({
        base64: true,
        compress: 0.72,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      setImageUri(compressed.uri);
      if (compressed.base64 === undefined) {
        throw new Error('No base64 image');
      }
      const nextAnalysis = await analyzeMealImage({
        imageBase64: compressed.base64,
        mimeType: 'image/jpeg',
        ...(description.trim() === '' ? {} : { description: description.trim() }),
      });
      setAnalysis(nextAnalysis);
      prefillMacrosFrom(nextAnalysis);
      setMessage('Estimación lista: proteína, grasa y fibra quedaron precargadas y puedes corregirlas. Los carbohidratos los confirmas tú.');
    } catch (error) {
      setMessage(error instanceof MobileApiError
        ? `${error.message} Continúa con el ingreso manual.`
        : 'No se pudo analizar la foto. Continúa con el ingreso manual.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Precarga los macros con lo que estimó la IA y abre la sección.
   *
   * Los carbohidratos **no** se precargan: `AGENTS.md` exige que lo estimado
   * por IA no se confunda con lo confirmado por la usuaria, y los carbos son
   * los que alimentan el bolo. Proteína, grasa y fibra no entran en ningún
   * cálculo de dosis, así que ahí precargar es una comodidad legítima —
   * quedan editables y la procedencia se guarda en `macrosSource`.
   */
  function prefillMacrosFrom(next: MealAnalysisResult): void {
    setProteinInput(String(next.totals.proteinG));
    setFatInput(String(next.totals.fatG));
    setFiberInput(String(next.totals.fiberG));
    setAiMacros({
      proteinG: next.totals.proteinG,
      fatG: next.totals.fatG,
      fiberG: next.totals.fiberG,
    });
    setMacrosOpen(true);
  }

  /**
   * Aplica un alimento del catálogo a la porción indicada.
   *
   * Precarga proteína, grasa y fibra, y **sugiere** los carbohidratos en el
   * mensaje sin escribirlos en el campo: siguen siendo un valor que confirma
   * la usuaria, igual que con una estimación por foto.
   */
  function applyCatalogFood(): void {
    if (pendingFood === null) return;
    const grams = Number(portionInput.trim().replace(',', '.'));
    if (!Number.isFinite(grams) || grams <= 0) {
      setMessage('Escribe cuántos gramos comiste.');
      return;
    }
    const scaled = scaleCatalogFood(pendingFood, grams);
    setProteinInput(String(scaled.proteinG));
    setFatInput(String(scaled.fatG));
    setFiberInput(String(scaled.fiberG));
    setAiMacros({ proteinG: scaled.proteinG, fatG: scaled.fatG, fiberG: scaled.fiberG });
    setMacrosOpen(true);
    setPendingFood(null);
    setMessage(`${pendingFood.name}, ${grams} g: ≈ ${scaled.carbsG} g de carbohidratos. Escríbelos abajo si los confirmas.`);
  }

  async function analyzeFromDescription(): Promise<void> {
    setMessage(null);
    if (description.trim() === '') {
      setMessage('Escribe qué comiste antes de estimar por texto.');
      return;
    }
    setBusy(true);
    setAnalysis(null);
    try {
      const nextAnalysis = await analyzeMealDescription(description.trim());
      setAnalysis(nextAnalysis);
      prefillMacrosFrom(nextAnalysis);
      setMessage('Estimación lista desde el texto (sin foto, la incertidumbre es mayor). Proteína, grasa y fibra quedaron precargadas y puedes corregirlas; los carbohidratos los confirmas tú.');
    } catch (error) {
      setMessage(error instanceof MobileApiError
        ? `${error.message} Continúa con el ingreso manual.`
        : 'No se pudo estimar desde el texto. Continúa con el ingreso manual.');
    } finally {
      setBusy(false);
    }
  }

  async function confirm(): Promise<void> {
    // Mismo problema que los macros: en blanco daba 0, y "0 g confirmados"
    // es una afirmación distinta de "no escribí nada".
    const parsed = confirmedCarbs.trim() === '' ? null : parseNonNegativeNumber(confirmedCarbs);
    if (parsed === null || parsed > 500) {
      setMessage('Escribe los carbohidratos confirmados entre 0 y 500 g.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      // OJO: `parseNonNegativeNumber('')` devuelve **0**, no `null`, porque
      // `Number('')` es 0. Sin este chequeo de blanco explícito, cada comida
      // se guardaba con `proteinG: 0, fatG: 0, fiberG: 0` aunque la usuaria
      // nunca hubiera abierto la sección — y el reporte al médico mostraba
      // "0 g de proteína, promedio de N" como si fuera un dato medido. La
      // distinción "no anotado" vs "0 g" es justamente el punto del ítem 7.
      const parseOptionalMacro = (input: string): number | null | undefined =>
        input.trim() === '' ? undefined : parseNonNegativeNumber(input);
      const protein = parseOptionalMacro(proteinInput);
      const fat = parseOptionalMacro(fatInput);
      const fiber = parseOptionalMacro(fiberInput);
      if (protein === null || fat === null || fiber === null) {
        setMessage('Revisa proteína, grasa y fibra: deben ser números, o quedar en blanco.');
        return;
      }
      // Procedencia de los macros: si la IA los precargó y siguen idénticos es
      // `ai`; si ella tocó alguno, `mixed`; sin análisis de por medio, `user`.
      const macrosSource: 'ai' | 'user' | 'mixed' | undefined =
        aiMacros === null
          ? (protein === null && fat === null && fiber === null ? undefined : 'user')
          : (protein === aiMacros.proteinG && fat === aiMacros.fatG && fiber === aiMacros.fiberG ? 'ai' : 'mixed');

      await onConfirm({
        confirmedCarbsG: parsed,
        ...(macrosSource === undefined ? {} : { macrosSource }),
        ...(imageUri === null ? {} : { imageUri }),
        ...(analysis === null ? {} : { analysis }),
        ...(protein === undefined ? {} : { proteinG: protein }),
        ...(fat === undefined ? {} : { fatG: fat }),
        ...(fiber === undefined ? {} : { fiberG: fiber }),
      });
      onClose();
    } catch (error) {
      logSaveError('MealModal.confirm', error);
      setMessage('No se pudo guardar la comida. Inténtalo otra vez.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell visible={visible} title="Registrar comida" onClose={onClose}>
      <View style={styles.aiBoundary}>
        <Text style={styles.aiTitle}>La foto solo estima alimentos y macros</Text>
        <Text style={styles.aiText}>No calcula insulina. Los carbohidratos de IA quedan separados hasta que tú escribes y confirmas un valor.</Text>
      </View>

      <Text style={styles.label}>Contexto opcional de la porción</Text>
      <TextInput
        style={styles.description}
        value={description}
        onChangeText={setDescription}
        placeholder="Ej.: plato de 24 cm, comí la mitad"
        placeholderTextColor={colors.muted}
        maxLength={500}
        multiline
      />

      <Pressable style={[styles.cameraButton, busy && styles.disabled]} disabled={busy} onPress={() => { void captureAndAnalyze(); }}>
        <Text style={styles.cameraIcon}>◎</Text>
        <Text style={styles.cameraText}>{busy ? 'Procesando imagen…' : 'Tomar foto y estimar'}</Text>
      </Pressable>
      <Pressable style={[styles.textEstimateButton, busy && styles.disabled]} disabled={busy} onPress={() => { void analyzeFromDescription(); }}>
        <Text style={styles.textEstimateText}>Estimar por texto, sin foto</Text>
      </Pressable>

      {imageUri === null ? null : <Image source={{ uri: imageUri }} style={styles.preview} resizeMode="cover" />}

      {analysis === null ? (
        <View style={styles.manualBox}>
          <Text style={styles.manualTitle}>Ingreso manual siempre disponible</Text>
          <Text style={styles.manualText}>Puedes guardar la comida aunque la cámara, internet o Abacus no estén disponibles.</Text>
        </View>
      ) : (
        <View style={styles.analysisBox}>
          <View style={styles.totalRow}>
            <Text style={styles.analysisTitle}>Estimación IA</Text>
            <Text style={styles.estimatedCarbs}>≈ {analysis.totals.carbsG} g carbos</Text>
          </View>
          {analysis.estimate.foods.map((food, index) => (
            <View key={`${food.name}:${index}`} style={styles.foodRow}>
              <View style={styles.foodNameWrap}>
                <Text style={styles.foodName}>{food.name}</Text>
                <Text style={styles.confidence}>Confianza {Math.round(food.confidence * 100)}%</Text>
              </View>
              <Text style={styles.foodCarbs}>{food.carbsG} g</Text>
            </View>
          ))}
          <Text style={styles.macroText}>Proteína {analysis.totals.proteinG} g · Grasa {analysis.totals.fatG} g · Fibra {analysis.totals.fiberG} g</Text>
          {analysis.estimate.uncertaintyNotes.map((note, index) => (
            <Text key={`${note}:${index}`} style={styles.uncertainty}>• {note}</Text>
          ))}
        </View>
      )}

      {pendingFood === null ? (
        <CatalogPicker foods={catalogFoods} onPick={(food) => { setPendingFood(food); setPortionInput(''); }} />
      ) : (
        <View style={styles.catalogBox}>
          <Text style={styles.catalogTitle}>{pendingFood.name}</Text>
          <Text style={styles.catalogHint}>¿Cuántos gramos comiste? Se escala desde la estimación guardada.</Text>
          <View style={styles.portionRow}>
            <TextInput
              value={portionInput}
              onChangeText={setPortionInput}
              keyboardType="decimal-pad"
              style={styles.portionInput}
              placeholder="gramos"
              placeholderTextColor={colors.muted}
              accessibilityLabel="Porción en gramos"
            />
            <Pressable
              style={styles.portionButton}
              onPress={() => { applyCatalogFood(); }}
              accessibilityRole="button"
            >
              <Text style={styles.portionButtonText}>Usar</Text>
            </Pressable>
            <Pressable
              style={styles.portionCancel}
              onPress={() => { setPendingFood(null); }}
              accessibilityRole="button"
            >
              <Text style={styles.portionCancelText}>Cancelar</Text>
            </Pressable>
          </View>
        </View>
      )}

      <Text style={styles.confirmLabel}>CARBOHIDRATOS QUE CONFIRMAS</Text>
      <View style={styles.confirmInputWrap}>
        <TextInput
          value={confirmedCarbs}
          onChangeText={setConfirmedCarbs}
          keyboardType="decimal-pad"
          style={styles.confirmInput}
          placeholder="Escribe un valor"
          placeholderTextColor={colors.muted}
        />
        <Text style={styles.confirmUnit}>g</Text>
      </View>
      <Text style={styles.confirmFoot}>No se completa automáticamente con la estimación.</Text>

      {/*
        Opcionales y colapsados por defecto: el registro frecuente es
        "carbohidratos y listo", y pedir cuatro campos más en cada comida
        haría más lento justo el flujo que tiene que ser rápido.
      */}
      <Pressable
        style={styles.macroToggle}
        onPress={() => { setMacrosOpen((open) => !open); }}
        accessibilityRole="button"
        accessibilityState={{ expanded: macrosOpen }}
      >
        <Text style={styles.macroToggleText}>
          {macrosOpen ? 'Ocultar' : aiMacros !== null ? 'Ver' : 'Agregar'} proteína, grasa y fibra
          {aiMacros === null ? ' (opcional)' : ' (estimadas por IA)'}
        </Text>
      </Pressable>
      {macrosOpen ? (
        <View>
          <Text style={styles.macroHint}>
            {aiMacros === null
              ? 'Déjalos en blanco si no los sabes. En blanco significa “no lo anoté”, que no es lo mismo que 0 g.'
              : 'Los estimó la IA a partir de lo que identificó. Corrígelos si sabes que van desviados; queda guardado si el número es suyo o tuyo.'}
          </Text>
          <View style={styles.macroRow}>
            <MacroField label="Proteína" value={proteinInput} onChange={setProteinInput} />
            <MacroField label="Grasa" value={fatInput} onChange={setFatInput} />
            <MacroField label="Fibra" value={fiberInput} onChange={setFiberInput} />
          </View>
        </View>
      ) : null}

      {message === null ? null : <Text style={styles.message}>{message}</Text>}
      <Pressable style={[styles.confirmButton, busy && styles.disabled]} disabled={busy} onPress={() => { void confirm(); }}>
        <Text style={styles.confirmButtonText}>{busy ? 'Guardando…' : 'Confirmar y crear episodio'}</Text>
      </Pressable>
    </ModalShell>
  );
}

function MacroField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <View style={styles.macroField}>
      <Text style={styles.macroLabel}>{label}</Text>
      <View style={styles.macroInputWrap}>
        <TextInput
          value={value}
          onChangeText={onChange}
          keyboardType="decimal-pad"
          style={styles.macroInput}
          placeholder="—"
          placeholderTextColor={colors.muted}
          accessibilityLabel={`${label} en gramos`}
        />
        <Text style={styles.macroUnit}>g</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  catalogBox: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md },
  catalogTitle: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  catalogHint: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 2, marginBottom: spacing.sm },
  catalogRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  catalogChip: {
    borderColor: colors.line, borderWidth: 1, borderRadius: radius.sm,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md, minHeight: 44, justifyContent: 'center',
  },
  catalogChipName: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  catalogChipMeta: { color: colors.muted, fontSize: 10, marginTop: 1 },
  portionRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  portionInput: {
    flex: 1, minHeight: 44, backgroundColor: colors.background, borderRadius: radius.sm,
    borderColor: colors.line, borderWidth: 1, color: colors.ink, fontSize: 15, paddingHorizontal: spacing.md,
  },
  portionButton: {
    minHeight: 44, paddingHorizontal: spacing.lg, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.sm, backgroundColor: colors.teal,
  },
  portionButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  portionCancel: { minHeight: 44, paddingHorizontal: spacing.md, alignItems: 'center', justifyContent: 'center' },
  portionCancelText: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  macroToggle: { minHeight: 44, justifyContent: 'center', marginTop: spacing.md },
  macroToggleText: { color: colors.teal, fontSize: 14, fontWeight: '700' },
  macroHint: { color: colors.muted, fontSize: 11, lineHeight: 17, marginBottom: spacing.sm },
  macroRow: { flexDirection: 'row', gap: spacing.sm },
  macroField: { flex: 1 },
  macroLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', marginBottom: 4 },
  macroInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    borderColor: colors.line,
    borderWidth: 1,
    paddingHorizontal: spacing.sm,
  },
  macroInput: { flex: 1, color: colors.ink, fontSize: 15, paddingVertical: spacing.md },
  macroUnit: { color: colors.muted, fontSize: 12 },
  aiBoundary: { backgroundColor: colors.tealSoft, borderRadius: radius.md, padding: spacing.md },
  aiTitle: { color: colors.navy, fontSize: 14, fontWeight: '800' },
  aiText: { color: colors.navy, fontSize: 13, lineHeight: 19, marginTop: 4 },
  label: { color: colors.navy, fontSize: 12, fontWeight: '800', marginTop: spacing.lg },
  description: { backgroundColor: colors.surface, color: colors.ink, borderColor: colors.line, borderWidth: 1, borderRadius: radius.sm, minHeight: 70, padding: spacing.md, marginTop: 6, textAlignVertical: 'top' },
  cameraButton: { backgroundColor: colors.navy, borderRadius: radius.md, padding: spacing.lg, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', marginTop: spacing.lg },
  cameraIcon: { color: '#FFFFFF', fontSize: 24, marginRight: spacing.sm },
  cameraText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  textEstimateButton: { borderColor: colors.navy, borderWidth: 1, borderRadius: radius.md, padding: spacing.md, alignItems: 'center', marginTop: spacing.sm, minHeight: 44, justifyContent: 'center' },
  textEstimateText: { color: colors.navy, fontSize: 13, fontWeight: '700' },
  preview: { width: '100%', height: 220, borderRadius: radius.md, marginTop: spacing.md },
  manualBox: { backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line, padding: spacing.md, marginTop: spacing.md },
  manualTitle: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  manualText: { color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 4 },
  analysisBox: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  analysisTitle: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  estimatedCarbs: { color: colors.orange, fontSize: 16, fontWeight: '800' },
  foodRow: { flexDirection: 'row', alignItems: 'center', borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: spacing.sm },
  foodNameWrap: { flex: 1 },
  foodName: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  confidence: { color: colors.muted, fontSize: 10, marginTop: 2 },
  foodCarbs: { color: colors.orange, fontSize: 14, fontWeight: '800' },
  macroText: { color: colors.muted, fontSize: 12, marginTop: spacing.md },
  uncertainty: { color: colors.warning, fontSize: 12, lineHeight: 17, marginTop: 5 },
  confirmLabel: { color: colors.orange, fontSize: 12, fontWeight: '900', letterSpacing: 0.7, marginTop: spacing.xl },
  confirmInputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.md, borderColor: colors.orange, borderWidth: 2, paddingHorizontal: spacing.md, marginTop: spacing.sm },
  confirmInput: { color: colors.ink, fontSize: 24, fontWeight: '700', flex: 1, paddingVertical: spacing.md },
  confirmUnit: { color: colors.muted, fontSize: 18 },
  confirmFoot: { color: colors.muted, fontSize: 11, marginTop: 5 },
  message: { color: colors.warning, fontSize: 13, lineHeight: 18, marginTop: spacing.md },
  confirmButton: { backgroundColor: colors.orange, borderRadius: radius.md, padding: spacing.lg, alignItems: 'center', marginTop: spacing.xl },
  confirmButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  disabled: { opacity: 0.55 },
});
