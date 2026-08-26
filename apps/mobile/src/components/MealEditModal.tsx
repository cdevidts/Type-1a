import { useEffect, useState } from 'react';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

// Iconos por subpath, nunca desde el barrel: Metro no hace tree-shaking y el
// barrel arrastra los ~1.500 iconos al bundle (ver `.claude/skills/iconography`).
import Camera from 'lucide-react-native/icons/camera';
import PencilLine from 'lucide-react-native/icons/pencil-line';
import WandSparkles from 'lucide-react-native/icons/wand-sparkles';

import { resolveMacrosSource } from '@type1a/domain';
import type { MealAnalysisResult, MealEvent, MealSnapshot } from '@type1a/schemas';

import { analyzeMealDescription, analyzeMealImage, editMealWithInstruction, MobileApiError } from '../api';
import { parseNonNegativeNumber } from '../format';
import { logSaveError } from '../log';
import { colors, radius, spacing } from '../theme';
import { ModalShell } from './ModalShell';

/**
 * Lo que este modal devuelve al guardar. Es deliberadamente el mismo lenguaje
 * que `MealEditPatch` de `db.ts`: `undefined` = no se tocó, `null` = borrar.
 *
 * No hay campo de insulina. La dosis de una comida se edita desde su propio
 * ítem del Timeline; una edición asistida por IA no puede alcanzarla
 * (`AGENTS.md` § Safety boundaries).
 */
export interface MealEditResult {
  confirmedCarbsG?: number | null;
  note?: string | null;
  proteinG?: number | null;
  fatG?: number | null;
  fiberG?: number | null;
  caloriesKcal?: number | null;
  imageUri?: string | null;
  macrosSource?: MealEvent['macrosSource'];
  analysis?: { aiEstimatedCarbsG: number; aiAnalysisId: string };
}

const numberOrBlank = (value: number | undefined): string => (value === undefined ? '' : String(value));

/** `''` → borrar (`null`), texto inválido → `undefined` como señal de error. */
function parseOptional(input: string): number | null | undefined {
  if (input.trim() === '') return null;
  const parsed = parseNonNegativeNumber(input);
  return parsed === null ? undefined : parsed;
}

function fmt(value: string): string {
  return value.trim() === '' ? 'sin anotar' : value.trim();
}

/**
 * Antes y después, campo por campo.
 *
 * La confirmación explícita que exige `AGENTS.md` no se cumple con un botón
 * que diga "aceptar": se cumple mostrando **qué** cambia. Un número que se
 * reescribe solo en un campo ya lleno es indistinguible de uno que la usuaria
 * escribió, y después nadie puede decir cuál de los dos está mirando.
 */
function DiffRow({ label, before, after, unit }: { label: string; before: string; after: string; unit: string }) {
  const changed = fmt(before) !== fmt(after);
  return (
    <View style={styles.diffRow}>
      <Text style={styles.diffLabel}>{label}</Text>
      <View style={styles.diffValues}>
        <Text style={[styles.diffBefore, changed && styles.diffBeforeChanged]}>
          {fmt(before)}{before.trim() === '' ? '' : ` ${unit}`}
        </Text>
        <Text style={styles.diffArrow}>→</Text>
        <Text style={[styles.diffAfter, changed && styles.diffAfterChanged]}>
          {fmt(after)}{after.trim() === '' ? '' : ` ${unit}`}
        </Text>
      </View>
    </View>
  );
}

export function MealEditModal({
  meal,
  onClose,
  onSave,
}: {
  /** `null` cierra el modal. */
  meal: MealEvent | null;
  onClose: () => void;
  onSave: (mealId: string, result: MealEditResult) => Promise<void>;
}) {
  const [carbsInput, setCarbsInput] = useState('');
  const [proteinInput, setProteinInput] = useState('');
  const [fatInput, setFatInput] = useState('');
  const [fiberInput, setFiberInput] = useState('');
  const [caloriesInput, setCaloriesInput] = useState('');
  const [noteInput, setNoteInput] = useState('');

  const [instruction, setInstruction] = useState('');
  const [description, setDescription] = useState('');
  const [textOpen, setTextOpen] = useState(false);

  const [proposal, setProposal] = useState<MealAnalysisResult | null>(null);
  const [pendingImageUri, setPendingImageUri] = useState<string | null>(null);
  /**
   * La foto solo reemplaza a la guardada si su propuesta se aplicó.
   *
   * Sin esto, sacar una foto, ignorar la propuesta y guardar dejaba la comida
   * con la foto nueva y los macros viejos: el `aiAnalysisId` guardado apunta a
   * un análisis de otra imagen, y la foto deja de ser evidencia de lo que dice
   * el registro. La foto va con su análisis o no va.
   */
  const [appliedImageUri, setAppliedImageUri] = useState<string | null>(null);
  /** Lo que precargó la propuesta, para saber después si ella lo corrigió. */
  const [aiMacros, setAiMacros] = useState<{ proteinG: number; fatG: number; fiberG: number; caloriesKcal: number } | null>(null);
  const [appliedAnalysis, setAppliedAnalysis] = useState<MealAnalysisResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Re-sembrar en cada comida distinta. Sin esto la comida siguiente hereda
  // los números de la anterior — el mismo bug que ya costó una corrida en
  // MealModal, con el agravante de que acá se guardan sobre un registro que
  // ya existía.
  useEffect(() => {
    if (meal === null) return;
    setCarbsInput(numberOrBlank(meal.confirmedCarbsG));
    setProteinInput(numberOrBlank(meal.proteinG));
    setFatInput(numberOrBlank(meal.fatG));
    setFiberInput(numberOrBlank(meal.fiberG));
    setCaloriesInput(numberOrBlank(meal.caloriesKcal));
    setNoteInput(meal.note ?? '');
    setInstruction('');
    setDescription('');
    setTextOpen(false);
    setProposal(null);
    setPendingImageUri(null);
    setAppliedImageUri(null);
    setAiMacros(null);
    setAppliedAnalysis(null);
    setBusy(false);
    setMessage(null);
  }, [meal]);

  /**
   * Lo que se le manda a la IA de la comida actual.
   *
   * Se arma desde el `MealSnapshot`, que no tiene campo de insulina, glucosa
   * ni parámetro de terapia. La frontera es estructural: no se confía en que
   * este código "no incluya" la dosis, es que no hay dónde ponerla.
   */
  function snapshot(): MealSnapshot {
    const carbs = carbsInput.trim() === '' ? undefined : parseNonNegativeNumber(carbsInput) ?? undefined;
    const protein = proteinInput.trim() === '' ? undefined : parseNonNegativeNumber(proteinInput) ?? undefined;
    const fat = fatInput.trim() === '' ? undefined : parseNonNegativeNumber(fatInput) ?? undefined;
    const fiber = fiberInput.trim() === '' ? undefined : parseNonNegativeNumber(fiberInput) ?? undefined;
    const calories = caloriesInput.trim() === '' ? undefined : parseNonNegativeNumber(caloriesInput) ?? undefined;
    return {
      ...(noteInput.trim() === '' ? {} : { note: noteInput.trim() }),
      ...(carbs === undefined ? {} : { confirmedCarbsG: carbs }),
      ...(protein === undefined ? {} : { proteinG: protein }),
      ...(fat === undefined ? {} : { fatG: fat }),
      ...(fiber === undefined ? {} : { fiberG: fiber }),
      ...(calories === undefined ? {} : { caloriesKcal: calories }),
      // `appliedAnalysis`, no `proposal`: una propuesta que ella todavía no
      // aplicó no describe lo que dicen los campos, y mandarla junto con los
      // totales viejos le daría al modelo dos versiones distintas de la misma
      // comida.
      ...(appliedAnalysis === null ? {} : { foods: appliedAnalysis.estimate.foods }),
    };
  }

  function failWith(error: unknown, fallback: string): void {
    setMessage(error instanceof MobileApiError
      ? `${error.message} La comida sigue guardada como estaba.`
      : `${fallback} La comida sigue guardada como estaba.`);
  }

  async function reanalyzeFromPhoto(): Promise<void> {
    setMessage(null);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setMessage('No hay permiso de cámara. Puedes corregir los campos a mano más abajo.');
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
    setProposal(null);
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
      if (compressed.base64 === undefined) throw new Error('No base64 image');
      const next = await analyzeMealImage({
        imageBase64: compressed.base64,
        mimeType: 'image/jpeg',
        ...(description.trim() === '' ? {} : { description: description.trim() }),
      });
      // La foto solo se adopta si el análisis salió bien: si falla, la comida
      // se queda con la imagen que ya tenía en vez de con una sin análisis.
      setPendingImageUri(compressed.uri);
      setProposal(next);
      setMessage('Propuesta lista desde la foto. Revísala abajo: no se guarda nada hasta que toques Guardar.');
    } catch (error) {
      failWith(error, 'No se pudo analizar la foto.');
    } finally {
      setBusy(false);
    }
  }

  async function reanalyzeFromText(): Promise<void> {
    setMessage(null);
    if (description.trim() === '') {
      setMessage('Escribe qué comiste antes de estimar por texto.');
      return;
    }
    setBusy(true);
    setProposal(null);
    try {
      const next = await analyzeMealDescription(description.trim());
      setProposal(next);
      setMessage('Propuesta lista desde el texto (sin foto, la incertidumbre es mayor). No se guarda nada hasta que toques Guardar.');
    } catch (error) {
      failWith(error, 'No se pudo estimar desde el texto.');
    } finally {
      setBusy(false);
    }
  }

  async function applyInstruction(): Promise<void> {
    setMessage(null);
    if (instruction.trim() === '') {
      setMessage('Escribe qué hay que corregir, por ejemplo "en realidad fue media porción".');
      return;
    }
    setBusy(true);
    setProposal(null);
    try {
      const next = await editMealWithInstruction({ instruction: instruction.trim(), current: snapshot() });
      setProposal(next);
      setMessage('Propuesta lista. Revísala abajo: no se guarda nada hasta que toques Guardar.');
    } catch (error) {
      failWith(error, 'No se pudo aplicar el cambio.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Vuelca la propuesta a los campos — **menos los carbohidratos**.
   *
   * Es la misma regla que rige al crear una comida y la exige `AGENTS.md`: lo
   * que estima la IA no puede confundirse con lo que confirma la usuaria, y
   * los carbos son los que después alimentan una dosis. Quedan como sugerencia
   * tocable al lado del campo, que es un toque suyo, no una escritura nuestra.
   */
  function applyProposal(): void {
    if (proposal === null) return;
    setProteinInput(String(proposal.totals.proteinG));
    setFatInput(String(proposal.totals.fatG));
    setFiberInput(String(proposal.totals.fiberG));
    setCaloriesInput(String(proposal.totals.caloriesKcal));
    setAiMacros({
      proteinG: proposal.totals.proteinG,
      fatG: proposal.totals.fatG,
      fiberG: proposal.totals.fiberG,
      caloriesKcal: proposal.totals.caloriesKcal,
    });
    setAppliedAnalysis(proposal);
    if (pendingImageUri !== null) setAppliedImageUri(pendingImageUri);
    setMessage(`Macros actualizados. Los carbohidratos siguen siendo tuyos: la IA sugiere ${proposal.totals.carbsG} g.`);
  }

  function discardProposal(): void {
    setProposal(null);
    setPendingImageUri(null);
    setMessage('Propuesta descartada. Nada cambió.');
  }

  async function save(): Promise<void> {
    if (meal === null) return;
    setMessage(null);

    const carbs = parseOptional(carbsInput);
    const protein = parseOptional(proteinInput);
    const fat = parseOptional(fatInput);
    const fiber = parseOptional(fiberInput);
    const calories = parseOptional(caloriesInput);
    if (carbs === undefined || protein === undefined || fat === undefined || fiber === undefined || calories === undefined) {
      setMessage('Revisa los números: deben ser positivos, o quedar en blanco si no los anotaste.');
      return;
    }
    if (carbs !== null && carbs > 500) {
      setMessage('Los carbohidratos deben estar entre 0 y 500 g.');
      return;
    }

    // La procedencia la decide `packages/domain`, no esta pantalla.
    const macrosSource: MealEvent['macrosSource'] | undefined = resolveMacrosSource({
      entered: { proteinG: protein, fatG: fat, fiberG: fiber, caloriesKcal: calories },
      ...(aiMacros === null ? {} : { aiProposed: aiMacros }),
      previous: {
        values: {
          proteinG: meal.proteinG,
          fatG: meal.fatG,
          fiberG: meal.fiberG,
          caloriesKcal: meal.caloriesKcal,
        },
        source: meal.macrosSource,
      },
    });

    setBusy(true);
    try {
      await onSave(meal.id, {
        confirmedCarbsG: carbs,
        note: noteInput.trim() === '' ? null : noteInput.trim(),
        proteinG: protein,
        fatG: fat,
        fiberG: fiber,
        caloriesKcal: calories,
        ...(macrosSource === undefined ? {} : { macrosSource }),
        ...(appliedImageUri === null ? {} : { imageUri: appliedImageUri }),
        ...(appliedAnalysis === null
          ? {}
          : {
              analysis: {
                aiEstimatedCarbsG: appliedAnalysis.totals.carbsG,
                aiAnalysisId: appliedAnalysis.analysisId,
              },
            }),
      });
      onClose();
    } catch (error) {
      logSaveError('MealEditModal.save', error);
      setMessage('No se pudo guardar la comida. Inténtalo otra vez; nada se perdió.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell visible={meal !== null} title="Editar comida" onClose={onClose}>
      <View style={styles.aiBoundary}>
        <Text style={styles.aiTitle}>La IA propone, tú confirmas</Text>
        <Text style={styles.aiText}>
          Estima alimentos y macros. No calcula insulina, y no recibe la dosis que hayas registrado. Nada se guarda hasta que tocas Guardar.
        </Text>
      </View>

      <Text style={styles.sectionTitle}>Corregir con IA</Text>

      <Pressable
        style={[styles.aiButton, busy && styles.disabled]}
        disabled={busy}
        onPress={() => { void reanalyzeFromPhoto(); }}
        accessibilityRole="button"
        accessibilityLabel="Tomar otra foto y volver a estimar"
      >
        <Camera size={20} color={colors.teal} />
        <Text style={styles.aiButtonText}>{busy ? 'Procesando…' : 'Tomar otra foto y re-estimar'}</Text>
      </Pressable>

      <Pressable
        style={[styles.aiButton, busy && styles.disabled]}
        disabled={busy}
        onPress={() => { setTextOpen((open) => !open); }}
        accessibilityRole="button"
        accessibilityLabel="Describir la comida con texto"
      >
        <PencilLine size={20} color={colors.teal} />
        <Text style={styles.aiButtonText}>Describirla con texto</Text>
      </Pressable>

      {textOpen ? (
        <View style={styles.aiPanel}>
          <TextInput
            style={styles.textArea}
            value={description}
            onChangeText={setDescription}
            placeholder="Ej.: pollo al horno con arroz y ensalada"
            placeholderTextColor={colors.muted}
            maxLength={500}
            multiline
          />
          <Pressable
            style={[styles.panelAction, busy && styles.disabled]}
            disabled={busy}
            onPress={() => { void reanalyzeFromText(); }}
            accessibilityRole="button"
          >
            <Text style={styles.panelActionText}>Estimar desde el texto</Text>
          </Pressable>
        </View>
      ) : null}

      <View style={styles.aiPanel}>
        <View style={styles.panelHeader}>
          <WandSparkles size={20} color={colors.teal} />
          <Text style={styles.panelTitle}>Explícale el cambio</Text>
        </View>
        <Text style={styles.panelHint}>
          Solo lo que hay que corregir, en tus palabras: "agrégale una cucharada de aceite", "en realidad fue media porción", "era pan integral".
        </Text>
        <TextInput
          style={styles.textArea}
          value={instruction}
          onChangeText={setInstruction}
          placeholder="Qué hay que corregir"
          placeholderTextColor={colors.muted}
          maxLength={300}
          multiline
        />
        <Pressable
          style={[styles.panelAction, busy && styles.disabled]}
          disabled={busy}
          onPress={() => { void applyInstruction(); }}
          accessibilityRole="button"
        >
          <Text style={styles.panelActionText}>{busy ? 'Consultando…' : 'Ver qué propone'}</Text>
        </Pressable>
      </View>

      {pendingImageUri === null ? null : (
        <Image source={{ uri: pendingImageUri }} style={styles.preview} resizeMode="cover" />
      )}

      {proposal === null ? null : (
        <View style={styles.proposalBox}>
          <Text style={styles.proposalTitle}>Propuesta de la IA — todavía sin guardar</Text>
          {proposal.estimate.foods.map((food, index) => (
            <View key={`${food.name}:${index}`} style={styles.foodRow}>
              <View style={styles.foodNameWrap}>
                <Text style={styles.foodName}>{food.name}</Text>
                <Text style={styles.confidence}>Confianza {Math.round(food.confidence * 100)}%</Text>
              </View>
              <Text style={styles.foodCarbs}>{food.carbsG} g</Text>
            </View>
          ))}

          <View style={styles.diffBox}>
            <DiffRow label="Carbohidratos" before={carbsInput} after={String(proposal.totals.carbsG)} unit="g" />
            <DiffRow label="Proteína" before={proteinInput} after={String(proposal.totals.proteinG)} unit="g" />
            <DiffRow label="Grasa" before={fatInput} after={String(proposal.totals.fatG)} unit="g" />
            <DiffRow label="Fibra" before={fiberInput} after={String(proposal.totals.fiberG)} unit="g" />
            <DiffRow label="Calorías" before={caloriesInput} after={String(proposal.totals.caloriesKcal)} unit="kcal" />
          </View>

          {proposal.estimate.uncertaintyNotes.map((note, index) => (
            <Text key={`${note}:${index}`} style={styles.uncertainty}>• {note}</Text>
          ))}

          <Text style={styles.carbsWarning}>
            Los carbohidratos no se copian solos: los escribes tú abajo, o tocas la sugerencia.
          </Text>

          <View style={styles.proposalActions}>
            <Pressable style={styles.proposalApply} onPress={() => { applyProposal(); }} accessibilityRole="button">
              <Text style={styles.proposalApplyText}>Usar estos macros</Text>
            </Pressable>
            <Pressable style={styles.proposalDiscard} onPress={() => { discardProposal(); }} accessibilityRole="button">
              <Text style={styles.proposalDiscardText}>Descartar</Text>
            </Pressable>
          </View>
        </View>
      )}

      <Text style={styles.sectionTitle}>Valores guardados</Text>
      <Text style={styles.sectionHint}>
        Un campo en blanco significa "no lo anoté", que no es lo mismo que 0 g.
      </Text>

      <Text style={styles.fieldLabel}>Carbohidratos confirmados</Text>
      <View style={styles.inputWrap}>
        <TextInput
          value={carbsInput}
          onChangeText={setCarbsInput}
          keyboardType="decimal-pad"
          style={styles.input}
          placeholder="sin anotar"
          placeholderTextColor={colors.muted}
          selectTextOnFocus
          accessibilityLabel="Carbohidratos confirmados en gramos"
        />
        <Text style={styles.inputUnit}>g</Text>
      </View>
      {proposal === null || String(proposal.totals.carbsG) === carbsInput.trim() ? null : (
        <Pressable
          style={styles.suggestion}
          onPress={() => { setCarbsInput(String(proposal.totals.carbsG)); }}
          accessibilityRole="button"
          accessibilityLabel={`Usar los ${proposal.totals.carbsG} gramos que sugiere la IA`}
        >
          <Text style={styles.suggestionText}>Usar los {proposal.totals.carbsG} g que sugiere la IA</Text>
        </Pressable>
      )}

      <Text style={styles.fieldLabel}>Proteína</Text>
      <View style={styles.inputWrap}>
        <TextInput value={proteinInput} onChangeText={setProteinInput} keyboardType="decimal-pad" style={styles.input} placeholder="sin anotar" placeholderTextColor={colors.muted} accessibilityLabel="Proteína en gramos" />
        <Text style={styles.inputUnit}>g</Text>
      </View>

      <Text style={styles.fieldLabel}>Grasa</Text>
      <View style={styles.inputWrap}>
        <TextInput value={fatInput} onChangeText={setFatInput} keyboardType="decimal-pad" style={styles.input} placeholder="sin anotar" placeholderTextColor={colors.muted} accessibilityLabel="Grasa en gramos" />
        <Text style={styles.inputUnit}>g</Text>
      </View>

      <Text style={styles.fieldLabel}>Fibra</Text>
      <View style={styles.inputWrap}>
        <TextInput value={fiberInput} onChangeText={setFiberInput} keyboardType="decimal-pad" style={styles.input} placeholder="sin anotar" placeholderTextColor={colors.muted} accessibilityLabel="Fibra en gramos" />
        <Text style={styles.inputUnit}>g</Text>
      </View>

      <Text style={styles.fieldLabel}>Calorías</Text>
      <View style={styles.inputWrap}>
        <TextInput value={caloriesInput} onChangeText={setCaloriesInput} keyboardType="decimal-pad" style={styles.input} placeholder="sin anotar" placeholderTextColor={colors.muted} accessibilityLabel="Calorías" />
        <Text style={styles.inputUnit}>kcal</Text>
      </View>

      <Text style={styles.fieldLabel}>Nota</Text>
      <TextInput
        style={styles.textArea}
        value={noteInput}
        onChangeText={setNoteInput}
        placeholder="Contexto de la comida"
        placeholderTextColor={colors.muted}
        maxLength={300}
        multiline
      />

      {message === null ? null : <Text style={styles.message}>{message}</Text>}

      <Pressable
        style={[styles.saveButton, busy && styles.disabled]}
        disabled={busy}
        onPress={() => { void save(); }}
        accessibilityRole="button"
      >
        <Text style={styles.saveText}>{busy ? 'Guardando…' : 'Guardar cambios'}</Text>
      </Pressable>
    </ModalShell>
  );
}

const styles = StyleSheet.create({
  aiBoundary: {
    backgroundColor: colors.tealSoft,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginBottom: spacing.lg,
  },
  aiTitle: { fontSize: 15, fontWeight: '700', color: colors.navy, marginBottom: spacing.xs },
  aiText: { fontSize: 13, color: colors.navy, lineHeight: 18 },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.ink,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  sectionHint: { fontSize: 12, color: colors.muted, marginBottom: spacing.md, lineHeight: 16 },
  aiButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 48,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
  },
  aiButtonText: { fontSize: 15, fontWeight: '600', color: colors.ink },
  aiPanel: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  panelHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xs },
  panelTitle: { fontSize: 15, fontWeight: '700', color: colors.ink },
  panelHint: { fontSize: 12, color: colors.muted, lineHeight: 16, marginBottom: spacing.sm },
  panelAction: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.tealSoft,
    marginTop: spacing.sm,
  },
  panelActionText: { fontSize: 14, fontWeight: '700', color: colors.teal },
  preview: { width: '100%', height: 180, borderRadius: radius.md, marginBottom: spacing.md },
  proposalBox: {
    backgroundColor: colors.warningSoft,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginTop: spacing.sm,
    marginBottom: spacing.md,
  },
  proposalTitle: { fontSize: 15, fontWeight: '700', color: colors.warning, marginBottom: spacing.sm },
  foodRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.xs },
  foodNameWrap: { flex: 1, paddingRight: spacing.md },
  foodName: { fontSize: 14, color: colors.ink },
  confidence: { fontSize: 11, color: colors.muted },
  foodCarbs: { fontSize: 14, fontWeight: '700', color: colors.ink },
  diffBox: {
    borderTopWidth: 1,
    borderTopColor: colors.line,
    marginTop: spacing.sm,
    paddingTop: spacing.sm,
  },
  diffRow: { marginBottom: spacing.xs },
  diffLabel: { fontSize: 12, color: colors.muted },
  diffValues: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  diffBefore: { fontSize: 14, color: colors.muted },
  diffBeforeChanged: { textDecorationLine: 'line-through' },
  diffArrow: { fontSize: 14, color: colors.muted },
  diffAfter: { fontSize: 14, color: colors.ink },
  diffAfterChanged: { fontWeight: '700', color: colors.teal },
  uncertainty: { fontSize: 12, color: colors.warning, marginTop: spacing.xs, lineHeight: 16 },
  carbsWarning: { fontSize: 12, color: colors.navy, marginTop: spacing.sm, lineHeight: 16, fontWeight: '600' },
  proposalActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  proposalApply: {
    flex: 1,
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.teal,
  },
  proposalApplyText: { fontSize: 14, fontWeight: '700', color: colors.surface },
  proposalDiscard: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  proposalDiscardText: { fontSize: 14, fontWeight: '600', color: colors.muted },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: colors.muted, marginTop: spacing.md, marginBottom: spacing.xs },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    minHeight: 48,
  },
  input: { flex: 1, fontSize: 16, color: colors.ink, paddingVertical: spacing.sm },
  inputUnit: { fontSize: 14, color: colors.muted, marginLeft: spacing.sm },
  suggestion: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    marginTop: spacing.xs,
    borderRadius: radius.sm,
    backgroundColor: colors.tealSoft,
  },
  suggestionText: { fontSize: 13, fontWeight: '600', color: colors.teal },
  textArea: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    padding: spacing.md,
    minHeight: 72,
    fontSize: 15,
    color: colors.ink,
    textAlignVertical: 'top',
  },
  message: { fontSize: 13, color: colors.navy, marginTop: spacing.md, lineHeight: 18 },
  saveButton: {
    minHeight: 52,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.teal,
    marginTop: spacing.xl,
  },
  saveText: { fontSize: 16, fontWeight: '700', color: colors.surface },
  disabled: { opacity: 0.5 },
});
