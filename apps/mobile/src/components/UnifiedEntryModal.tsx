import { useEffect, useRef, useState } from 'react';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { AppState, Image, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { assessFreshness, calculateCorrection, calculateMealBolus, convertGlucose, isSensorReading, resolveMacrosSource, type CartLine, type CatalogFood } from '@type1a/domain';
import type { CGMReading, MealAnalysisResult, MealEvent, TherapyProfile } from '@type1a/schemas';

import { analyzeMealDescription, analyzeMealImage, MobileApiError } from '../api';
import { combineDayAndTime, dayOfMonthISO, isFutureDay, parseDayISO, timeOfDay } from '../entryTime';
import { formatDayTime, parseBlankAsUnset, parseBlankAsUnsetPositive, parseNonNegativeNumber } from '../format';
import { logSaveError } from '../log';
import { colors, radius, spacing } from '../theme';
import {
  HISTORIC_CALCULATOR_TITLE,
  historicCalculatorWarning,
  isHistoricCalculation,
  masterSectionsFor,
  sectionStartsOpen,
  type MasterSection,
  type MasterSeed,
} from '../masterModal';
import type { EntryFocus, MasterEditPayload } from '../types';
import { EntrySection } from './EntrySection';
import { MacroFields } from './MacroFields';
import { MealCart } from './MealCart';
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

/**
 * El título nombra lo que ella venía a hacer, no el componente. Abrir "Basal"
 * y que el modal diga "Nueva entrada" es perder el hilo de lo que se estaba
 * anotando — `contracts/ux-checklist.md`: el título nombra la acción.
 */
const FOCUS_TITLE: Record<EntryFocus, string> = {
  all: 'Nueva entrada',
  glucose: 'Glucosa',
  meal: 'Comida',
  insulin: 'Insulina',
  ketones: 'Cetonas y vitales',
  note: 'Nota',
};

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
  /**
   * `false` = no alimentar el catálogo con los alimentos de esta comida.
   *
   * Existía solo en el acceso rápido de comida: esta hoja alimentaba el
   * catálogo **siempre** que hubiera análisis, sin ofrecer la decisión. Dos
   * caminos para lo mismo con reglas distintas.
   */
  saveToCatalog?: boolean;
  /**
   * Carbohidratos que sugirió el catálogo o el carrito, si se usaron.
   *
   * Se guarda como `aiEstimatedCarbsG` cuando no hubo análisis propio: el
   * catálogo es una media de estimaciones de IA, así que ese número tiene el
   * mismo estatus que el de una foto y **no puede pasar por dato confirmado
   * sin rastro**. Sin esto, transcribir la sugerencia al campo de confirmación
   * la volvía indistinguible de un valor pesado en balanza, tanto para ella
   * como para el reporte al médico.
   */
  catalogSuggestedCarbsG?: number;
  rapidUnits?: number;
  basalUnits?: number;
  note?: string;
  proteinG?: number;
  fatG?: number;
  fiberG?: number;
  caloriesKcal?: number;
  /**
   * Procedencia de los macros, ya resuelta por `packages/domain`. `null` = sin
   * macros que declarar.
   *
   * **Se decide acá y no en `App`** porque este componente es el único que
   * sabe qué precargó una estimación: la foto, el texto **y el carrito**.
   * Recalcularla afuera comparando solo contra `analysis` marcaba `'user'`
   * unos macros que salieron del catálogo.
   */
  macrosSource?: MealEvent['macrosSource'] | null;
  ketonesMmolL?: number;
  weightKg?: number;
  systolicBP?: number;
  diastolicBP?: number;
}

/**
 * En qué está el maestro: creando o corrigiendo.
 *
 * Es **un solo componente** para los dos, que es la regla de
 * `projectbrief.md`: "Nueva entrada y TODOS los modales de edición consumen un
 * mismo componente maestro". Un flujo de edición nunca puede ser más pobre que
 * uno de creación — ya pasó, y costó una fase entera.
 */
export type MasterMode =
  | {
      kind: 'create';
      /**
       * Día heredado al registrar en el pasado (el "+" contextual de
       * Nutrición). Cuando viene, la hora **se pide**: no se inventa un
       * mediodía ni se guarda "ahora" en silencio.
       */
      presetDay?: Date | null;
      onSave: (draft: UnifiedEntryDraft) => Promise<void>;
    }
  | {
      kind: 'edit';
      seed: MasterSeed;
      title: string;
      onSave: (payload: MasterEditPayload) => Promise<void>;
      /** Abre el editor de comida con IA sobre la comida que ya existe. */
      onEditMeal?: (meal: MealEvent) => void;
    };

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

const numberOrBlank = (value: number | undefined): string => (value === undefined ? '' : String(value));

export function UnifiedEntryModal({
  mode,
  latest,
  profile,
  therapyConfigured,
  catalogFoods,
  focus = 'all',
  onClose,
  onOpenTherapySettings,
}: {
  /** `null` = cerrado. Ver `MasterMode`. */
  mode: MasterMode | null;
  latest: CGMReading | null;
  profile: TherapyProfile;
  /** False while the therapy values are still the placeholders shipped with the app. */
  therapyConfigured: boolean;
  /** Alimentos ya conocidos, para reusar sin llamar a la IA (Fase 15). */
  catalogFoods: readonly CatalogFood[];
  /**
   * Con qué sección arranca abierta al **crear**. Es lo único que distingue un
   * acceso rápido de una entrada completa: el mismo formulario, plegado
   * distinto. Al **editar** manda el contenido — ver `masterSectionsFor`.
   */
  focus?: EntryFocus;
  onClose: () => void;
  /** Lleva a Ajustes → Terapia, donde vive el nombre de la insulina. */
  onOpenTherapySettings?: () => void;
}) {
  const visible = mode !== null;
  const editing = mode?.kind === 'edit' ? mode : null;
  const seed = editing?.seed ?? null;

  const [glucose, setGlucose] = useState('');
  const [prefilled, setPrefilled] = useState<PrefilledReading | null>(null);
  // Snapshot of the sensor prefill taken at open time, kept around even
  // after the user switches to "Capilar" (which nulls `prefilled`) so
  // switching back to "Sensor" can restore it without waiting for another
  // refresh. Distinct from `prefilled`, which the freshness/save logic
  // treats as "what's currently active" — this is just "what's available".
  const [originalPrefill, setOriginalPrefill] = useState<PrefilledReading | null>(null);
  const [glucoseSource, setGlucoseSource] = useState<'sensor' | 'capillary'>('capillary');
  const [description, setDescription] = useState('');
  const [carbs, setCarbs] = useState('');
  const [rapid, setRapid] = useState('');
  const [basal, setBasal] = useState('');
  const [protein, setProtein] = useState('');
  const [fat, setFat] = useState('');
  const [fiber, setFiber] = useState('');
  const [calories, setCalories] = useState('');
  const [ketones, setKetones] = useState('');
  const [weight, setWeight] = useState('');
  const [systolic, setSystolic] = useState('');
  const [diastolic, setDiastolic] = useState('');
  const [note, setNote] = useState('');
  const [imageUri, setImageUri] = useState<string | null>(null);
  /** `true` = la usuaria pidió quitar la foto que ya estaba guardada. */
  const [imageRemoved, setImageRemoved] = useState(false);
  const [analysis, setAnalysis] = useState<MealAnalysisResult | null>(null);
  /**
   * Lo que precargó una estimación —la IA o el carrito— para poder decidir
   * después si la usuaria lo corrigió.
   *
   * `resolveMacrosSource` compara contra **el valor precargado**, no contra la
   * ausencia de valor: comparar con `undefined` etiquetaba `'mixed'` una
   * comida analizada que ella nunca tocó. El carrito entra acá por la misma
   * razón que la foto — el catálogo es una media de estimaciones de IA, así
   * que sus macros no son "escritos por la usuaria".
   */
  const [proposedMacros, setProposedMacros] = useState<
    { proteinG: number; fatG: number; fiberG: number; caloriesKcal: number } | null
  >(null);
  const [cartLines, setCartLines] = useState<CartLine[]>([]);
  const [saveToCatalog, setSaveToCatalog] = useState(true);
  const [catalogSuggestedCarbsG, setCatalogSuggestedCarbsG] = useState<number | null>(null);
  const [suggestion, setSuggestion] = useState<DoseSuggestion | null>(null);
  const [correctionIncluded, setCorrectionIncluded] = useState(false);
  const [rapidFromCalculator, setRapidFromCalculator] = useState(false);
  const [rapidStale, setRapidStale] = useState(false);
  /** Set when a calculated dose outlived the reading it came from; cleared only by retyping the units or recalculating. */
  const [doseNeedsReconfirm, setDoseNeedsReconfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [openedAt, setOpenedAt] = useState<string>(() => new Date().toISOString());
  /** Fecha y hora del registro, editables. Ver `entryTime.ts`. */
  const [dayText, setDayText] = useState('');
  const [timeText, setTimeText] = useState('');
  /**
   * `true` mientras la hora de un registro en el pasado siga sin escribirse.
   *
   * Guardar con esto en pie está prohibido: un registro histórico sin hora
   * exacta acabaría con un "ahora" o un mediodía inventado, y ese invento
   * después se lee como el momento en que comió.
   */
  const [timeRequired, setTimeRequired] = useState(false);

  // Same gating as CorrectionModal: reset only on the real open transition,
  // never on a background refresh that hands us a new `latest`/`profile`
  // object identity while the user is mid-entry.
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      const editSeed = mode?.kind === 'edit' ? mode.seed : null;
      const preset = mode?.kind === 'create' ? (mode.presetDay ?? null) : null;

      if (editSeed !== null) {
        // ---- Edición: los campos salen del registro, no del sensor. ----
        setGlucose(numberOrBlank(editSeed.glucose));
        setPrefilled(null);
        setOriginalPrefill(null);
        setGlucoseSource('capillary');
        setDescription(editSeed.description ?? '');
        setCarbs(numberOrBlank(editSeed.carbsG));
        setRapid(numberOrBlank(editSeed.rapidUnits));
        setBasal(numberOrBlank(editSeed.basalUnits));
        setProtein(numberOrBlank(editSeed.proteinG));
        setFat(numberOrBlank(editSeed.fatG));
        setFiber(numberOrBlank(editSeed.fiberG));
        setCalories(numberOrBlank(editSeed.caloriesKcal));
        setKetones(numberOrBlank(editSeed.ketonesMmolL));
        setWeight(numberOrBlank(editSeed.weightKg));
        setSystolic(numberOrBlank(editSeed.systolicBP));
        setDiastolic(numberOrBlank(editSeed.diastolicBP));
        setNote(editSeed.note ?? '');
        setImageUri(editSeed.imageUri ?? null);
        setImageRemoved(false);
        setOpenedAt(editSeed.timestamp);
        setDayText(dayOfMonthISO(editSeed.timestamp));
        setTimeText(timeOfDay(editSeed.timestamp));
        setTimeRequired(false);
      } else {
        const canUseReading = latest !== null && assessFreshness(latest.sourceTimestamp).state === 'connected';
        // Convertido a mg/dL: este valor precarga el campo que alimenta la
        // calculadora de dosis (calculateMealBolus/calculateCorrection) — un
        // mmol/L crudo ahí arruina el cálculo, no solo la lectura en pantalla.
        const snapshot = canUseReading && latest !== null
          ? {
              glucose: convertGlucose(latest.glucose, latest.unit, 'mg/dL'),
              sourceTimestamp: latest.sourceTimestamp,
              isSensor: isSensorReading(latest),
              isSynthetic: latest.origin === 'synthetic',
            }
          : null;
        // Only default to the "Sensor" tab, and only auto-fill the number,
        // when the prefill genuinely came off the sensor (or the synthetic
        // provider standing in for it in demo mode — same "Sensor" tab, its
        // own warning text below) — the most recent *live* reading can itself
        // be a manual one (manual counts as live, see isSensorReading's doc
        // comment). Starting "Capilar" blank rather than silently carrying
        // over an old manual value keeps this from looking like a fresh
        // measurement when it isn't one.
        //
        // Registrando en el pasado **nunca** se precarga: la glucosa de ahora
        // no es la que había el martes, y precargarla la convertiría en un
        // dato de ese día que nadie midió.
        const canUseAsSensor = preset === null && snapshot !== null && (snapshot.isSensor || snapshot.isSynthetic);
        setGlucose(canUseAsSensor && snapshot !== null ? String(snapshot.glucose) : '');
        setPrefilled(canUseAsSensor ? snapshot : null);
        setOriginalPrefill(canUseAsSensor ? snapshot : null);
        setGlucoseSource(canUseAsSensor ? 'sensor' : 'capillary');
        setDescription('');
        setCarbs('');
        setRapid('');
        setBasal('');
        setNote('');
        setProtein('');
        setFat('');
        setFiber('');
        setCalories('');
        setKetones('');
        setWeight('');
        setSystolic('');
        setDiastolic('');
        setImageUri(null);
        setImageRemoved(false);
        const base = preset ?? new Date();
        const stamp = preset === null ? new Date().toISOString() : base.toISOString();
        setOpenedAt(stamp);
        setDayText(dayOfMonthISO(stamp));
        // Con fecha heredada la hora arranca **vacía** y es obligatoria.
        setTimeText(preset === null ? timeOfDay(stamp) : '');
        setTimeRequired(preset !== null);
      }

      setAnalysis(null);
      setProposedMacros(null);
      setCartLines([]);
      setSuggestion(null);
      setCorrectionIncluded(false);
      setRapidFromCalculator(false);
      setRapidStale(false);
      setDoseNeedsReconfirm(false);
      setMessage(null);
      setSaveToCatalog(true);
      setCatalogSuggestedCarbsG(null);
    }
    wasVisibleRef.current = visible;
  }, [visible, latest, mode]);

  // The sheet can sit open across a long break (it isn't dismissed when the
  // app is backgrounded), and everything written here — the bolus, the carbs,
  // the meal episode's +60/+120/+180 window — is stamped with `openedAt`.
  // Re-stamp on return so a three-hour-old header time doesn't become the
  // recorded time of a meal that's about to be eaten. Only the timestamp
  // moves; nothing the user typed is touched.
  //
  // ⚠️ **Solo cuando la hora es "ahora".** Si la usuaria eligió una fecha
  // histórica —o está editando un registro viejo— volver del segundo plano no
  // puede reemplazarla por `now`: sería reescribir en silencio el dato que
  // vino a corregir.
  const dayTextRef = useRef(dayText);
  const timeTextRef = useRef(timeText);
  useEffect(() => { dayTextRef.current = dayText; timeTextRef.current = timeText; }, [dayText, timeText]);
  useEffect(() => {
    if (!visible || mode?.kind !== 'create' || (mode.presetDay ?? null) !== null) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      const now = new Date();
      // Si tocó el día o la hora, esos son suyos y no se pisan.
      const untouched = dayTextRef.current === dayOfMonthISO(openedAt) && timeTextRef.current === timeOfDay(openedAt);
      if (!untouched) return;
      const stamp = now.toISOString();
      setOpenedAt(stamp);
      setDayText(dayOfMonthISO(stamp));
      setTimeText(timeOfDay(stamp));
    });
    return () => { subscription.remove(); };
  }, [visible, mode, openedAt]);

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

  function selectSensorSource(): void {
    if (originalPrefill === null) return;
    setGlucoseSource('sensor');
    setGlucose(String(originalPrefill.glucose));
    setPrefilled(originalPrefill);
    invalidateSuggestion();
  }

  function selectCapillarySource(): void {
    setGlucoseSource('capillary');
    setGlucose('');
    setPrefilled(null);
    invalidateSuggestion();
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
      if (compressed.base64 === undefined) throw new Error('No base64 image');
      const nextAnalysis = await analyzeMealImage({
        imageBase64: compressed.base64,
        mimeType: 'image/jpeg',
        ...(description.trim() === '' ? {} : { description: description.trim() }),
      });
      // La foto se adopta **con** su análisis, nunca sin él: una imagen cuyo
      // análisis falló deja el registro con una foto que no describe sus
      // macros.
      setImageUri(compressed.uri);
      setImageRemoved(false);
      setAnalysis(nextAnalysis);
      // Prellenar los macros con lo que estimó la IA, visibles y editables
      // (2026-08-26). Antes se guardaban en silencio con los campos en
      // blanco: si ella corregía solo la proteína, la comida quedaba marcada
      // "estimada por IA y corregida por la usuaria" para una grasa y una
      // fibra que nunca vio. Ahora lo que se guarda es lo que está en
      // pantalla.
      setProtein(String(Math.round(nextAnalysis.totals.proteinG)));
      setFat(String(Math.round(nextAnalysis.totals.fatG)));
      setFiber(String(Math.round(nextAnalysis.totals.fiberG)));
      setCalories(String(Math.round(nextAnalysis.totals.caloriesKcal)));
      setProposedMacros({
        proteinG: Math.round(nextAnalysis.totals.proteinG),
        fatG: Math.round(nextAnalysis.totals.fatG),
        fiberG: Math.round(nextAnalysis.totals.fiberG),
        caloriesKcal: Math.round(nextAnalysis.totals.caloriesKcal),
      });
      setMessage('Estimación lista. Escribe tú los carbohidratos que confirmas.');
    } catch (error) {
      setMessage(error instanceof MobileApiError
        ? `${error.message} Continúa con el ingreso manual.`
        : 'No se pudo analizar la foto. Continúa con el ingreso manual.');
    } finally {
      setBusy(false);
    }
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
      setProtein(String(Math.round(nextAnalysis.totals.proteinG)));
      setFat(String(Math.round(nextAnalysis.totals.fatG)));
      setFiber(String(Math.round(nextAnalysis.totals.fiberG)));
      setCalories(String(Math.round(nextAnalysis.totals.caloriesKcal)));
      setProposedMacros({
        proteinG: Math.round(nextAnalysis.totals.proteinG),
        fatG: Math.round(nextAnalysis.totals.fatG),
        fiberG: Math.round(nextAnalysis.totals.fiberG),
        caloriesKcal: Math.round(nextAnalysis.totals.caloriesKcal),
      });
      setMessage('Estimación lista a partir del texto (sin foto, así que la incertidumbre es mayor). Escribe tú los carbohidratos que confirmas.');
    } catch (error) {
      setMessage(error instanceof MobileApiError
        ? `${error.message} Continúa con el ingreso manual.`
        : 'No se pudo estimar desde el texto. Continúa con el ingreso manual.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * La glucosa sobre la que calcula la fórmula, y de cuándo es.
   *
   * En creación es la del campo (precargada del sensor o tecleada). En
   * edición es la del **registro histórico**, y por eso el bloque de la
   * calculadora cambia de título y lleva su advertencia: reconstruir el
   * contexto de anteayer no es sugerir una dosis para ahora.
   */
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
    const currentGlucose = parseBlankAsUnsetPositive(glucose);
    if (currentGlucose === null) {
      setMessage('La glucosa debe ser un número positivo.');
      return;
    }
    // Una glucosa sintética no sirve de base clínica, venga del sensor de
    // demo (creación) o del registro que se está corrigiendo (edición).
    if (seed?.glucoseOrigin === 'synthetic') {
      setMessage('La glucosa de este registro es SINTÉTICA (modo demo). No sirve para reconstruir una dosis.');
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
    //
    // Al **editar** no aplica: la glucosa es histórica a propósito, y su
    // vigencia la declara la advertencia del bloque, no este chequeo.
    if (editing === null && prefilled !== null) {
      if (assessFreshness(prefilled.sourceTimestamp).state !== 'connected') {
        setPrefilled(null);
        setGlucose('');
        setGlucoseSource('capillary');
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

  /**
   * El instante que se va a guardar, o `null` con el motivo en `message`.
   *
   * Una sola puerta para las tres reglas de tiempo: la hora del pasado es
   * obligatoria, la fecha tiene que ser real, y el futuro se rechaza con un
   * mensaje comprensible.
   */
  function resolveTimestamp(): string | null {
    if (seed !== null && !seed.timestampEditable) {
      // Lo ancla una fuente externa (sensor, importación). Su hora es parte
      // de lo que reportó: los adjuntos se mueven con ella, no al revés.
      return seed.timestamp;
    }
    const day = parseDayISO(dayText);
    if (day === null) {
      setMessage('Revisa la fecha: debe tener el formato AAAA-MM-DD, por ejemplo 2026-08-27.');
      return null;
    }
    if (timeText.trim() === '') {
      setMessage('Escribe la hora exacta de ese día, en formato HH:MM. Sin ella el registro quedaría a una hora inventada.');
      return null;
    }
    const stamp = combineDayAndTime(day, timeText);
    if (stamp === null) {
      setMessage('Revisa la hora: debe tener el formato HH:MM entre 00:00 y 23:59.');
      return null;
    }
    if (Date.parse(stamp) > Date.now() + 60_000) {
      setMessage('Esa fecha y hora todavía no han pasado. Un registro futuro no se puede guardar.');
      return null;
    }
    return stamp;
  }

  /**
   * Qué mandar para un campo de vitales.
   *
   * `undefined` = **no se tocó** · `null` = la usuaria lo vació, o sea borrar
   * · número = el valor. Vaciar un campo que el formulario mostraba con un
   * valor **es** la acción explícita de borrado; un campo que nunca tuvo nada
   * no borra nada, que es la regla que impide que corregir una cetona se
   * lleve el peso de la misma fila.
   */
  function vitalsField(text: string, seeded: number | undefined): number | null | undefined {
    if (text.trim() === '') return seeded === undefined ? undefined : null;
    const parsed = parseNonNegativeNumber(text);
    return parsed === null ? undefined : parsed;
  }

  function readMealNumbers(): {
    carbsG?: number; proteinG?: number; fatG?: number; fiberG?: number; caloriesKcal?: number;
  } | null {
    const carbsG = parseBlankAsUnset(carbs);
    const proteinG = parseBlankAsUnset(protein);
    const fatG = parseBlankAsUnset(fat);
    const fiberG = parseBlankAsUnset(fiber);
    const caloriesKcal = parseBlankAsUnset(calories);
    if (carbsG === null || (carbsG !== undefined && carbsG > 500)) {
      setMessage('Escribe los carbohidratos entre 0 y 500 g (o déjalo vacío).');
      return null;
    }
    if (proteinG === null || fatG === null || fiberG === null
      || [proteinG, fatG, fiberG].some((value) => value !== undefined && value > 500)) {
      setMessage('Revisa proteína, grasa y fibra: deben ser números entre 0 y 500 g, o quedar en blanco.');
      return null;
    }
    if (caloriesKcal === null || (caloriesKcal !== undefined && caloriesKcal > 10000)) {
      setMessage('Revisa las calorías: deben ser un número entre 0 y 10.000 kcal, o quedar en blanco.');
      return null;
    }
    return {
      ...(carbsG === undefined ? {} : { carbsG }),
      ...(proteinG === undefined ? {} : { proteinG }),
      ...(fatG === undefined ? {} : { fatG }),
      ...(fiberG === undefined ? {} : { fiberG }),
      ...(caloriesKcal === undefined ? {} : { caloriesKcal }),
    };
  }

  async function save(): Promise<void> {
    if (mode === null) return;
    // A calculated dose doesn't expire on its own: `rapidStale` only fires
    // when the inputs are *edited*, so a sheet left open while the glucose
    // it was built from goes stale would still save that dose. Re-check at
    // save time, and only for a number that came from the calculator — a
    // hand-typed dose is the user's own decision and isn't ours to expire.
    // Nothing typed is discarded: she can retype the units and save.
    const doseSourceExpired = editing === null && rapidFromCalculator && prefilled !== null
      && assessFreshness(prefilled.sourceTimestamp).state !== 'connected';
    // `doseNeedsReconfirm` outlives the branch below on purpose. Clearing
    // `prefilled` there would otherwise make this same condition false on a
    // second tap, so tapping Guardar again would write the very dose we just
    // refused. Requiring a keystroke on the units instead of a repeat tap
    // keeps it possible to log insulin she actually injected — refusing to
    // record real insulin is its own hazard — while making it a decision.
    if (doseSourceExpired || doseNeedsReconfirm) {
      if (doseSourceExpired) {
        setPrefilled(null);
        setGlucose('');
        setGlucoseSource('capillary');
        setSuggestion(null);
        setDoseNeedsReconfirm(true);
      }
      setMessage('La glucosa que originó esta dosis ya no está vigente. Escribe una glucosa actual y vuelve a calcular, o confirma a mano las unidades que te vas a poner (toca el campo Rápida y reescribe el número).');
      return;
    }

    const timestamp = resolveTimestamp();
    if (timestamp === null) return;

    const mealNumbers = readMealNumbers();
    if (mealNumbers === null) return;

    const rapidUnits = parseBlankAsUnsetPositive(rapid);
    const basalUnits = parseBlankAsUnsetPositive(basal);
    const glucoseValue = parseBlankAsUnsetPositive(glucose);
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
    const ketonesValue = vitalsField(ketones, seed?.ketonesMmolL);
    if (typeof ketonesValue === 'number' && ketonesValue > 20) {
      setMessage('Revisa las cetonas: deben estar entre 0 y 20 mmol/L, o quedar en blanco.');
      return;
    }
    const weightValue = vitalsField(weight, seed?.weightKg);
    if (typeof weightValue === 'number' && (weightValue <= 0 || weightValue > 400)) {
      setMessage('Revisa el peso: debe estar entre 1 y 400 kg, o quedar en blanco.');
      return;
    }
    const systolicValue = vitalsField(systolic, seed?.systolicBP);
    const diastolicValue = vitalsField(diastolic, seed?.diastolicBP);
    if ((typeof systolicValue === 'number') !== (typeof diastolicValue === 'number')) {
      setMessage('La presión necesita los dos números: sistólica y diastólica.');
      return;
    }
    if (typeof systolicValue === 'number' && (!Number.isInteger(systolicValue) || systolicValue <= 0 || systolicValue > 300)) {
      setMessage('Revisa la presión sistólica: debe ser un número entero entre 1 y 300 mmHg.');
      return;
    }
    if (typeof diastolicValue === 'number' && (!Number.isInteger(diastolicValue) || diastolicValue <= 0 || diastolicValue > 200)) {
      setMessage('Revisa la presión diastólica: debe ser un número entero entre 1 y 200 mmHg.');
      return;
    }

    const vitals = {
      ...(ketonesValue === undefined ? {} : { ketonesMmolL: ketonesValue }),
      ...(weightValue === undefined ? {} : { weightKg: weightValue }),
      ...(systolicValue === undefined ? {} : { systolicBP: systolicValue }),
      ...(diastolicValue === undefined ? {} : { diastolicBP: diastolicValue }),
    };

    // La procedencia la decide `packages/domain`, nunca esta pantalla, y se
    // imprime en el reporte del control médico: un macro estimado que llegue
    // marcado `'user'` es una afirmación falsa sobre quién midió qué.
    const macrosSource = resolveMacrosSource({
      entered: {
        proteinG: mealNumbers.proteinG,
        fatG: mealNumbers.fatG,
        fiberG: mealNumbers.fiberG,
        caloriesKcal: mealNumbers.caloriesKcal,
      },
      ...(proposedMacros === null ? {} : { aiProposed: proposedMacros }),
      ...(seed === null ? {} : {
        previous: {
          values: {
            proteinG: seed.proteinG,
            fatG: seed.fatG,
            fiberG: seed.fiberG,
            caloriesKcal: seed.caloriesKcal,
          },
          // `source` va **siempre**, incluso en `undefined`: ausente significa
          // "procedencia desconocida", y `MealEventSchema` prohíbe convertir
          // eso en "confirmado por la usuaria".
          source: seed.meal?.macrosSource,
        },
      }),
    });

    setBusy(true);
    setMessage(null);
    try {
      if (mode.kind === 'edit') {
        await mode.onSave({
          timestamp,
          // Una lectura de sensor conserva su valor: nunca se manda de vuelta
          // como manual, así que no puede reescribirla ni borrarla.
          ...(seed !== null && seed.glucoseReadOnly ? {} : (glucoseValue === undefined ? {} : { manualGlucose: glucoseValue })),
          ...mealNumbers,
          ...(description.trim() === '' ? {} : { description: description.trim() }),
          // Foto: parche. Solo viaja si la quitó o si adoptó una nueva.
          ...(imageRemoved ? { imageUri: null } : (imageUri !== null && imageUri !== seed?.imageUri ? { imageUri } : {})),
          ...(analysis === null
            ? {}
            : { aiEstimatedCarbsG: analysis.totals.carbsG, aiAnalysisId: analysis.analysisId }),
          ...(analysis === null && catalogSuggestedCarbsG !== null
            ? { aiEstimatedCarbsG: catalogSuggestedCarbsG }
            : {}),
          // Se manda **siempre**, `null` incluido: una comida que se quedó sin
          // macros no puede conservar la etiqueta de procedencia anterior.
          macrosSource: macrosSource ?? null,
          ...(rapidUnits === undefined ? {} : { rapidUnits }),
          ...(basalUnits === undefined ? {} : { basalUnits }),
          rapidIncludesCorrection: rapidFromCalculator && correctionIncluded,
          ...(Object.keys(vitals).length === 0 ? {} : { vitals }),
          ...(note.trim() === '' ? {} : { note: note.trim() }),
        });
      } else {
        const hasSomething = mealNumbers.carbsG !== undefined || rapidUnits !== undefined || basalUnits !== undefined
          || glucoseValue !== undefined || description.trim() !== '' || note.trim() !== ''
          || mealNumbers.proteinG !== undefined || mealNumbers.fatG !== undefined || mealNumbers.fiberG !== undefined
          || mealNumbers.caloriesKcal !== undefined || Object.keys(vitals).length > 0;
        if (!hasSomething) {
          setMessage('Completa al menos un campo antes de guardar.');
          setBusy(false);
          return;
        }
        await mode.onSave({
          timestamp,
          rapidIncludesCorrection: rapidFromCalculator && correctionIncluded,
          // Only a hand-typed glucose becomes a new stored reading; an
          // untouched prefill is already in the database and must not be
          // duplicated. Same invariant as in `calculate()`: `prefilled` is
          // non-null exactly while the field still holds the prefilled value.
          ...(glucoseValue === undefined || prefilled !== null ? {} : { manualGlucose: glucoseValue }),
          ...(description.trim() === '' ? {} : { description: description.trim() }),
          ...mealNumbers,
          ...(imageUri === null ? {} : { imageUri }),
          ...(analysis === null ? {} : { analysis }),
          ...(rapidUnits === undefined ? {} : { rapidUnits }),
          ...(basalUnits === undefined ? {} : { basalUnits }),
          ...(note.trim() === '' ? {} : { note: note.trim() }),
          ...(typeof vitals.ketonesMmolL === 'number' ? { ketonesMmolL: vitals.ketonesMmolL } : {}),
          ...(typeof vitals.weightKg === 'number' ? { weightKg: vitals.weightKg } : {}),
          ...(typeof vitals.systolicBP === 'number' ? { systolicBP: vitals.systolicBP } : {}),
          ...(typeof vitals.diastolicBP === 'number' ? { diastolicBP: vitals.diastolicBP } : {}),
          ...(saveToCatalog ? {} : { saveToCatalog: false }),
          ...(catalogSuggestedCarbsG === null ? {} : { catalogSuggestedCarbsG }),
          // **La procedencia viaja también al crear.** Antes solo se mandaba
          // en modo edición, y `App.saveEntry` la recalculaba comparando
          // únicamente contra `draft.analysis`. Con el carrito no hay
          // análisis, así que unos macros que salen de una media de
          // estimaciones de IA del catálogo se guardaban marcados `'user'` —
          // y el reporte del control médico los imprimía como "anotados por la
          // usuaria". Acá se compara contra lo que precargó la estimación,
          // venga de una foto, de un texto o del carrito.
          macrosSource: macrosSource ?? null,
        });
      }
      onClose();
    } catch (error) {
      logSaveError('UnifiedEntryModal.save', error);
      setMessage('No se pudo guardar la entrada. Inténtalo otra vez; nada se perdió.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Qué secciones arrancan abiertas.
   *
   * Al **crear** manda el foco (el acceso rápido). Al **editar** manda el
   * contenido: una sección con datos se abre porque un dato clínico plegado
   * es un dato que se olvida, y una vacía queda disponible porque el tipo con
   * el que nació el registro no limita lo que se le suma después.
   */
  const openSections: Set<MasterSection> | null = seed === null ? null : masterSectionsFor(seed);
  function sectionOpen(section: MasterSection): boolean {
    if (openSections !== null) return openSections.has(section);
    // La calculadora acompaña a Insulina: es la herramienta de esa sección.
    const asFocus: EntryFocus = section === 'calculator' ? 'insulin' : section;
    return sectionStartsOpen(focus, asFocus);
  }

  /**
   * Lo que hay dentro de cada sección plegada, para poder leerlo sin abrirla.
   * Sin esto, el estado "tiene datos" se comunicaría solo con la posición del
   * chevron — y un dato clínico escondido en un acordeón es uno que se olvida.
   */
  const filled = (label: string, value: string, unit: string): string | null =>
    value.trim() === '' ? null : `${label} ${value.trim()} ${unit}`;
  const joinSummary = (...parts: (string | null)[]): string | null => {
    const present = parts.filter((part): part is string => part !== null);
    return present.length === 0 ? null : present.join(' · ');
  };
  const glucoseSummary = joinSummary(filled('', glucose, 'mg/dL'));
  const mealSummary = joinSummary(
    filled('', carbs, 'g'),
    protein.trim() === '' && fat.trim() === '' && fiber.trim() === '' ? null : 'con macros',
    fiber.trim() === '' ? null : `fibra ${fiber.trim()} g`,
    analysis === null ? null : 'analizada por IA',
    cartLines.length === 0 ? null : `${cartLines.length} del catálogo`,
    description.trim() === '' ? null : 'con descripción',
  );
  const insulinSummary = joinSummary(filled('rápida', rapid, 'U'), filled('basal', basal, 'U'));
  const vitalsSummary = joinSummary(
    filled('cetonas', ketones, 'mmol/L'),
    filled('peso', weight, 'kg'),
    systolic.trim() === '' || diastolic.trim() === '' ? null : `presión ${systolic.trim()}/${diastolic.trim()} mmHg`,
  );
  const noteSummary = note.trim() === '' ? null : 'anotada';

  const title = editing !== null ? editing.title : (focus === 'all' ? 'Nueva entrada' : FOCUS_TITLE[focus]);
  /**
   * `true` cuando lo que se está anotando **no es de ahora**.
   *
   * Cubre los dos caminos, y esa es la corrección: la advertencia histórica de
   * la calculadora estaba solo en modo edición, pero registrar en el pasado
   * (el "+" contextual de Nutrición) llega a la misma superficie con una
   * glucosa de hace cinco días. Ahí la sección decía "Calculadora de dosis",
   * el botón "Calcular dosis sugerida" y el resultado "6 U" sin nada que
   * dijera de cuándo era el número — que es exactamente cómo un cálculo
   * reconstruido se lee como una indicación de pincharse ahora.
   */
  const historicEntry = isHistoricCalculation({
    editing: editing !== null,
    hasPresetDay: mode?.kind === 'create' && (mode.presetDay ?? null) !== null,
  });
  /** El momento sobre el que se está reconstruyendo, para nombrarlo. */
  const historicMoment = seed?.timestamp ?? openedAt;
  const savedImage = seed?.imageUri;
  const showTimeWarning = timeRequired && timeText.trim() === '';
  const dayIsFuture = (() => {
    const day = parseDayISO(dayText);
    return day !== null && isFutureDay(day);
  })();

  return (
    <ModalShell visible={visible} title={title} onClose={onClose}>
      {/*
        Fecha y hora, editables. Antes era una etiqueta de solo lectura: si la
        anotación llegaba tarde —o si se registraba lo de ayer— la hora del
        registro era la del formulario y no la del hecho, y esa hora es la que
        agrupa episodios y recorta las ventanas de patrones.
      */}
      <View style={styles.timeBox}>
        <Text style={styles.timeLabel}>Cuándo pasó</Text>
        {seed !== null && !seed.timestampEditable ? (
          <>
            <Text style={styles.timeValue}>{formatDayTime(seed.timestamp)}</Text>
            <Text style={styles.hint}>
              La hora la fija la fuente del dato (sensor o importación) y no se edita. Lo que le adjuntes se
              guarda en ese mismo momento.
            </Text>
          </>
        ) : (
          <>
            <View style={styles.timeRow}>
              <View style={styles.timeField}>
                <Text style={styles.fieldLabel}>Fecha</Text>
                <TextInput
                  value={dayText}
                  onChangeText={setDayText}
                  style={styles.timeInput}
                  placeholder="AAAA-MM-DD"
                  placeholderTextColor={colors.muted}
                  accessibilityLabel="Fecha del registro, en formato año-mes-día"
                />
              </View>
              <View style={styles.timeField}>
                <Text style={styles.fieldLabel}>Hora</Text>
                <TextInput
                  value={timeText}
                  onChangeText={(next) => { setTimeText(next); setTimeRequired(false); }}
                  style={[styles.timeInput, showTimeWarning && styles.timeInputRequired]}
                  placeholder="HH:MM"
                  placeholderTextColor={colors.muted}
                  keyboardType="numbers-and-punctuation"
                  accessibilityLabel="Hora del registro, en formato horas y minutos"
                />
              </View>
            </View>
            {showTimeWarning ? (
              <Text style={styles.timeRequired}>
                Estás registrando en el pasado. Escribe la hora exacta de ese día: la app no la inventa.
              </Text>
            ) : null}
            {dayIsFuture ? (
              <Text style={styles.timeRequired}>Esa fecha todavía no ha pasado. No se puede guardar un registro futuro.</Text>
            ) : null}
          </>
        )}
      </View>

      <EntrySection title="Glucosa" summary={glucoseSummary} initiallyOpen={sectionOpen('glucose')}>
        {seed !== null && seed.glucoseReadOnly ? (
          <>
            {/*
              La etiqueta nombra el ORIGEN REAL. Decía "Glucosa (del sensor)"
              para cualquier valor de solo lectura, así que un dato sintético de
              demo o uno importado de un CSV se rotulaba como sensor y solo el
              pie de abajo lo desmentía. `AGENTS.md` prohíbe presentar datos
              sintéticos o importados como lectura de sensor: la etiqueta y el
              pie no pueden decir cosas distintas del mismo número.
            */}
            <Text style={styles.fieldLabel}>
              {seed.glucoseOrigin === 'imported'
                ? 'Glucosa (importada)'
                : seed.glucoseOrigin === 'synthetic'
                  ? 'Glucosa SINTÉTICA (modo demo)'
                  : 'Glucosa (del sensor)'}
            </Text>
            <Text style={[styles.readonlyValue, seed.glucoseOrigin === 'synthetic' && styles.readonlyValueSynthetic]}>
              {seed.glucose ?? '—'} mg/dL
            </Text>
            <Text style={seed.glucoseOrigin === 'synthetic' ? styles.syntheticText : styles.hint}>
              {seed.glucoseOrigin === 'imported'
                ? 'Viene de un archivo que importaste y no se edita. No es una lectura de sensor.'
                : seed.glucoseOrigin === 'synthetic'
                  ? 'Es un valor de prueba generado por la app, NO una medición. No sirve para dosificar.'
                  : 'Este valor viene de tu sensor y no se edita.'}
              {' '}Puedes adjuntarle la comida, la insulina, las cetonas o una nota de ese momento.
            </Text>
          </>
        ) : (
          <>
            {editing === null ? (
              <View style={styles.segmented}>
                <Pressable
                  style={[styles.segment, glucoseSource === 'sensor' && styles.segmentActive]}
                  onPress={selectSensorSource}
                  disabled={originalPrefill === null}
                >
                  <Text style={[
                    styles.segmentText,
                    glucoseSource === 'sensor' && styles.segmentTextActive,
                    originalPrefill === null && styles.segmentTextDisabled,
                  ]}
                  >
                    Sensor
                  </Text>
                </Pressable>
                <Pressable
                  style={[styles.segment, glucoseSource === 'capillary' && styles.segmentActive]}
                  onPress={selectCapillarySource}
                >
                  <Text style={[styles.segmentText, glucoseSource === 'capillary' && styles.segmentTextActive]}>
                    Capilar (punción)
                  </Text>
                </Pressable>
              </View>
            ) : null}
            {editing !== null ? null : glucoseSource === 'capillary' ? (
              <Text style={styles.manualText}>Escribe el valor de tu medidor de glicemia capilar.</Text>
            ) : prefilled === null ? (
              <Text style={styles.staleText}>Sin lectura vigente para precargar. Escríbela si te mediste, o cambia a "Capilar".</Text>
            ) : prefilled.isSynthetic ? (
              <Text style={styles.syntheticText}>
                Precargada con un valor SINTÉTICO (modo demo) · {formatDayTime(prefilled.sourceTimestamp)}. No sirve para dosificar.
              </Text>
            ) : (
              <Text style={styles.liveText}>Precargada desde el sensor · {formatDayTime(prefilled.sourceTimestamp)}</Text>
            )}
            <Field
              label="Glucemia"
              value={glucose}
              unit="mg/dL"
              onChange={(value) => {
                setGlucose(value);
                setPrefilled(null);
                if (editing === null) setGlucoseSource('capillary');
                invalidateSuggestion();
              }}
            />
          </>
        )}
      </EntrySection>

      <EntrySection title="Comida" summary={mealSummary} initiallyOpen={sectionOpen('meal')}>
        {/*
          Cuando la comida ya existe, su editor completo —foto nueva,
          re-análisis, instrucción libre, propuesta antes → después— sigue
          siendo `MealEditModal`. Se **hospeda** desde acá en vez de
          reescribirse: es la herramienta madura, y reconstruirla como campos
          básicos es exactamente la degradación que este trabajo evita.
        */}
        {seed?.meal != null && editing?.onEditMeal !== undefined ? (
          <Pressable
            style={styles.mealEditorButton}
            onPress={() => { editing.onEditMeal!(seed.meal!); }}
            accessibilityRole="button"
          >
            <Text style={styles.mealEditorText}>Editor de comida: foto, IA y propuesta antes → después</Text>
            <Text style={styles.mealEditorHint}>
              Toma otra foto, re-estima por texto o explícale el cambio ("en realidad fue media porción").
            </Text>
          </Pressable>
        ) : null}

        {/*
          El carrito multi-alimento. Está en **todos** los caminos de comida:
          al crear, al adjuntar una comida a una glucosa, y al corregir una que
          ya existe. Una facultad que solo vive en un camino es una asimetría.
        */}
        <MealCart
          foods={catalogFoods}
          lines={cartLines}
          onChange={(next) => {
            setCartLines(next);
            // Cambiar el carrito invalida cualquier dosis calculada con el
            // total anterior: el número de la calculadora describía otra
            // comida.
            invalidateSuggestion();
          }}
          onUseCarbs={(totals) => {
            // Acción explícita de la usuaria. Los carbohidratos pasan al campo
            // de confirmados **y** se recuerda de dónde salieron, para que el
            // número no pierda su procedencia de estimación en el reporte.
            setCarbs(String(totals.carbsG));
            setProtein(String(totals.proteinG));
            setFat(String(totals.fatG));
            setFiber(String(totals.fiberG));
            setCalories(String(totals.caloriesKcal));
            setProposedMacros({
              proteinG: totals.proteinG,
              fatG: totals.fatG,
              fiberG: totals.fiberG,
              caloriesKcal: totals.caloriesKcal,
            });
            setCatalogSuggestedCarbsG(totals.carbsG);
            invalidateSuggestion();
            setMessage(`Se transcribieron ${totals.carbsG} g del carrito. Quedan como carbohidratos confirmados por ti; revísalos antes de guardar.`);
          }}
          onMessage={setMessage}
        />

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
          <Text style={styles.cameraText}>{busy ? 'Procesando…' : 'Foto para estimar carbohidratos'}</Text>
        </Pressable>
        <Pressable style={[styles.textEstimateButton, busy && styles.disabled]} disabled={busy} onPress={() => { void analyzeFromDescription(); }}>
          <Text style={styles.textEstimateText}>Estimar por texto, sin foto</Text>
        </Pressable>

        {/*
          Foto guardada vs. foto nueva: se distinguen con **texto**, no solo
          con la posición. Sin el rótulo, una imagen recién tomada y una que ya
          estaba en el registro son indistinguibles, y ahí es donde la foto
          deja de ser evidencia de lo que dice el registro.
        */}
        {imageUri === null ? null : (
          <View style={styles.imageBlock}>
            <Text style={styles.imageLabel}>
              {imageUri === savedImage ? 'Foto guardada de este registro' : 'Foto nueva · se guarda al tocar Guardar'}
            </Text>
            <Image source={{ uri: imageUri }} style={styles.preview} resizeMode="cover" />
            {savedImage === undefined ? null : (
              <View style={styles.imageActions}>
                <Pressable
                  style={styles.imageAction}
                  onPress={() => { void captureAndAnalyze(); }}
                  accessibilityRole="button"
                  accessibilityLabel="Reemplazar la foto guardada"
                >
                  <Text style={styles.imageActionText}>Reemplazar foto</Text>
                </Pressable>
                <Pressable
                  style={[styles.imageAction, styles.imageActionDanger]}
                  onPress={() => { setImageUri(null); setImageRemoved(true); setMessage('La foto se quitará al guardar. Los macros y los carbohidratos no se tocan.'); }}
                  accessibilityRole="button"
                  accessibilityLabel="Quitar la foto guardada"
                >
                  <Text style={styles.imageActionDangerText}>Quitar foto</Text>
                </Pressable>
              </View>
            )}
          </View>
        )}
        {imageRemoved ? (
          <Text style={styles.hint}>La foto guardada se quitará al guardar. Toca "Foto para estimar" si quieres poner otra.</Text>
        ) : null}

        {analysis === null ? null : (
          <View style={styles.analysisBox}>
            <Text style={styles.analysisTitle}>Estimación IA · ≈ {analysis.totals.carbsG} g</Text>
            <Text style={styles.analysisFoods}>{analysis.estimate.foods.map((food) => food.name).join(' · ')}</Text>
            <Text style={styles.analysisFoot}>Solo estima alimentos. Nunca calcula insulina — los carbohidratos los confirmas tú abajo.</Text>
          </View>
        )}
        {seed?.aiEstimatedCarbsG === undefined ? null : (
          <Text style={styles.hint}>Estimado por IA cuando se creó el registro: {seed.aiEstimatedCarbsG} g (dato de solo lectura).</Text>
        )}
        <Field label="Carbohidratos confirmados" value={carbs} unit="g" onChange={(value) => { setCarbs(value); setCatalogSuggestedCarbsG(null); invalidateSuggestion(); }} />
        <MacroFields
          protein={protein}
          fat={fat}
          fiber={fiber}
          calories={calories}
          layout="stacked"
          onChange={(field, next) => {
            if (field === 'protein') setProtein(next);
            else if (field === 'fat') setFat(next);
            else if (field === 'fiber') setFiber(next);
            else setCalories(next);
          }}
          hint="Déjalos en blanco si no los anotaste. En blanco no es lo mismo que 0 g. La fibra cuenta: se suma aparte en Nutrición."
        />
        {editing === null ? (
          <View style={styles.choiceRow}>
            <View style={styles.choiceCopy}>
              <Text style={styles.choiceTitle}>Guardarla en mi catálogo</Text>
              <Text style={styles.choiceFoot}>
                {saveToCatalog
                  ? 'Los alimentos quedan disponibles para reusar sin volver a llamar a la IA.'
                  : 'El catálogo no se toca.'}
              </Text>
            </View>
            <Switch
              value={saveToCatalog}
              onValueChange={setSaveToCatalog}
              trackColor={{ false: colors.line, true: colors.teal }}
            />
          </View>
        ) : null}
      </EntrySection>

      <EntrySection
        title={historicEntry ? HISTORIC_CALCULATOR_TITLE : 'Calculadora de dosis'}
        summary={null}
        initiallyOpen={sectionOpen('calculator')}
      >
        {historicEntry ? (
          <View style={styles.historicBox}>
            <Text style={styles.historicTitle}>
              Reconstrucción histórica · {editing === null ? `${dayText} ${timeText}`.trim() : formatDayTime(historicMoment)}
            </Text>
            <Text style={styles.historicText}>
              {historicCalculatorWarning(
                editing === null
                  ? (timeText.trim() === '' ? null : `${dayText} a las ${timeText}`)
                  : formatDayTime(historicMoment),
              )}
            </Text>
          </View>
        ) : null}
        <View style={styles.warningBox}>
          <Text style={styles.warningTitle}>Aritmética con tus parámetros, no una recomendación</Text>
          <Text style={styles.warningText}>
            Usa el objetivo, el factor de corrección y los carbs por unidad que configuraste con tu equipo clínico.
            No descuenta insulina activa (IOB) de dosis anteriores: si te pinchaste hace poco, este número queda alto.
          </Text>
        </View>
        <Pressable style={[styles.calculateButton, busy && styles.disabled]} disabled={busy} onPress={calculate}>
          <Text style={styles.calculateText}>
            {historicEntry ? 'Reconstruir el cálculo de ese momento' : 'Calcular dosis sugerida'}
          </Text>
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
                    setDoseNeedsReconfirm(false);
                  }}
                >
                  <Text style={styles.useText}>
                    {historicEntry
                      ? `Anotar ${suggestion.units} U como la rápida de ese momento`
                      : `Usar ${suggestion.units} U como rápida`}
                  </Text>
                </Pressable>
                <Text style={styles.useFoot}>
                  {historicEntry
                    ? 'No se copia sola, y no es una dosis para ahora: es lo que la fórmula habría dado entonces.'
                    : 'No se copia sola: revisa el número y edítalo si tu equipo clínico indica otra cosa.'}
                </Text>
              </>
            )}
          </View>
        )}
      </EntrySection>

      <EntrySection title="Insulina" summary={insulinSummary} initiallyOpen={sectionOpen('insulin')}>
        <View style={styles.row}>
          <Field
            label="Rápida"
            value={rapid}
            unit="U"
            onChange={(value) => {
              setRapid(value);
              setRapidFromCalculator(false);
              setRapidStale(false);
              setDoseNeedsReconfirm(false);
            }}
          />
          <Field label="Acción prolongada" value={basal} unit="U" onChange={setBasal} />
        </View>
        {/*
          El nombre de la insulina es **configuración**, no un campo por
          registro. El input libre se fue: escribirlo a mano en cada dosis
          producía "fiasp", "Fiasp " y un blanco en el mismo historial, y el
          reporte médico los contaba como tres insulinas.
        */}
        <View style={styles.insulinNames}>
          <Text style={styles.insulinNameLine}>
            Rápida: {seed?.rapidInsulinName ?? profile.rapidInsulinName ?? 'sin configurar'}
          </Text>
          <Text style={styles.insulinNameLine}>
            Basal: {seed?.basalInsulinName ?? profile.basalInsulinName ?? 'sin configurar'}
          </Text>
          {profile.rapidInsulinName === undefined && profile.basalInsulinName === undefined ? (
            <Text style={styles.hint}>
              Todavía no configuraste tus insulinas, así que el registro se guarda sin nombre. La app no inventa uno.
            </Text>
          ) : (
            <Text style={styles.hint}>
              Se estampa al crear el registro: si más adelante cambias de tratamiento, el historial antiguo conserva
              la que usabas entonces.
            </Text>
          )}
          {onOpenTherapySettings === undefined ? null : (
            <Pressable
              style={styles.linkButton}
              onPress={onOpenTherapySettings}
              accessibilityRole="button"
              accessibilityLabel="Ir a Ajustes, Terapia, para cambiar tus insulinas"
            >
              <Text style={styles.linkText}>Cambiar en Ajustes → Terapia</Text>
            </Pressable>
          )}
        </View>
        {doseNeedsReconfirm ? (
          <Text style={styles.staleDose}>
            Esta dosis se calculó con una glucosa que ya no está vigente. Vuelve a calcular, o reescribe el número aquí para confirmar que es el que te vas a poner.
          </Text>
        ) : rapidStale ? (
          <Text style={styles.staleDose}>
            Cambiaste los carbohidratos, el carrito o la glucosa después de copiar esta dosis. Vuelve a calcular o escribe el valor que te vas a poner.
          </Text>
        ) : null}
        <Text style={styles.hint}>Se guarda exactamente lo que escribas aquí, no lo calculado.</Text>
      </EntrySection>

      <EntrySection title="Cetonas y vitales" summary={vitalsSummary} initiallyOpen={sectionOpen('ketones')}>
        <Field label="Cetonas en sangre" value={ketones} unit="mmol/L" onChange={setKetones} />
        <Field label="Peso" value={weight} unit="kg" onChange={setWeight} />
        <View style={styles.row}>
          <Field label="Presión sistólica" value={systolic} unit="mmHg" onChange={setSystolic} />
          <Field label="Presión diastólica" value={diastolic} unit="mmHg" onChange={setDiastolic} />
        </View>
        <Text style={styles.hint}>
          Solo lo que te mediste. Corregir uno de estos campos no toca a los demás: un campo que dejes como está
          se queda igual, y vaciar uno que tenía valor lo borra.
        </Text>
        <Text style={styles.hint}>
          Type 1A registra las cetonas y te dice en qué banda caen; qué hacer con eso lo decides con tu equipo clínico.
        </Text>
      </EntrySection>

      <EntrySection title="Nota" summary={noteSummary} initiallyOpen={sectionOpen('note')}>
        <TextInput
          style={styles.description}
          value={note}
          onChangeText={setNote}
          placeholder="Ejercicio, estrés, enfermedad, lo que quieras recordar"
          placeholderTextColor={colors.muted}
          maxLength={300}
          multiline
        />
      </EntrySection>

      {message === null ? null : <Text style={styles.message}>{message}</Text>}
      <Pressable style={[styles.saveButton, busy && styles.disabled]} disabled={busy} onPress={() => { void save(); }}>
        <Text style={styles.saveText}>
          {busy ? 'Guardando…' : editing === null ? 'Guardar entrada' : 'Guardar cambios'}
        </Text>
      </Pressable>
      {editing === null ? null : (
        <Text style={styles.useFoot}>
          Lo que dejes vacío se borra de esta entrada, salvo la foto y los vitales: esos solo cambian si los tocas.
        </Text>
      )}
    </ModalShell>
  );
}

const styles = StyleSheet.create({
  timeBox: { paddingBottom: spacing.sm, borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth },
  timeLabel: { color: colors.muted, fontSize: 12, fontWeight: '800' },
  timeValue: { color: colors.ink, fontSize: 16, fontWeight: '700', marginTop: 4 },
  timeRow: { flexDirection: 'row', gap: spacing.md, marginTop: 4 },
  timeField: { flex: 1 },
  timeInput: {
    backgroundColor: colors.surface, color: colors.ink, borderColor: colors.line, borderWidth: 1,
    borderRadius: radius.sm, paddingHorizontal: spacing.md, marginTop: 6, fontSize: 16, minHeight: 44,
  },
  timeInputRequired: { borderColor: colors.warning, borderWidth: 2 },
  timeRequired: { color: colors.warning, fontSize: 12, lineHeight: 17, marginTop: 6, fontWeight: '700' },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', marginTop: spacing.xl },
  segmented: { flexDirection: 'row', backgroundColor: colors.surface, borderRadius: radius.sm, borderColor: colors.line, borderWidth: 1, marginTop: spacing.sm, overflow: 'hidden' },
  segment: { flex: 1, paddingVertical: spacing.md, alignItems: 'center', justifyContent: 'center', minHeight: 44 },
  segmentActive: { backgroundColor: colors.teal },
  segmentText: { color: colors.navy, fontSize: 13, fontWeight: '700' },
  segmentTextActive: { color: '#FFFFFF' },
  segmentTextDisabled: { color: colors.muted },
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
  fieldInput: { color: colors.ink, fontSize: 20, fontWeight: '700', flex: 1, paddingVertical: spacing.md, minHeight: 44 },
  fieldUnit: { color: colors.muted, fontSize: 11, marginLeft: 4 },
  readonlyValue: { color: colors.ink, fontSize: 22, fontWeight: '800', marginTop: 6 },
  readonlyValueSynthetic: { color: colors.warning },
  row: { flexDirection: 'row', gap: spacing.md },
  hint: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 6 },
  description: { backgroundColor: colors.surface, color: colors.ink, borderColor: colors.line, borderWidth: 1, borderRadius: radius.sm, minHeight: 64, padding: spacing.md, marginTop: spacing.sm, textAlignVertical: 'top' },
  cameraButton: { backgroundColor: colors.navy, borderRadius: radius.sm, padding: spacing.md, alignItems: 'center', marginTop: spacing.sm, minHeight: 44, justifyContent: 'center' },
  cameraText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  // Deliberately de-emphasized (outline, not solid navy like cameraButton):
  // this sheet already has several actions competing for attention, and the
  // photo estimate is the primary way to get an AI estimate — text is the
  // fallback for when a photo isn't practical, not an equal alternative.
  textEstimateButton: { borderColor: colors.navy, borderWidth: 1, borderRadius: radius.sm, padding: spacing.md, alignItems: 'center', marginTop: spacing.sm, minHeight: 44, justifyContent: 'center' },
  textEstimateText: { color: colors.navy, fontSize: 13, fontWeight: '700' },
  imageBlock: { marginTop: spacing.sm },
  imageLabel: { color: colors.navy, fontSize: 11, fontWeight: '800', marginBottom: 4 },
  preview: { width: '100%', height: 180, borderRadius: radius.md },
  imageActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  imageAction: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line },
  imageActionText: { color: colors.navy, fontSize: 13, fontWeight: '700' },
  imageActionDanger: { borderColor: colors.red },
  imageActionDangerText: { color: colors.red, fontSize: 13, fontWeight: '700' },
  analysisBox: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm, borderColor: colors.line, borderWidth: 1 },
  analysisTitle: { color: colors.orange, fontSize: 14, fontWeight: '800' },
  analysisFoods: { color: colors.ink, fontSize: 13, lineHeight: 18, marginTop: 4 },
  analysisFoot: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 6 },
  mealEditorButton: { backgroundColor: colors.tealSoft, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm, minHeight: 44, justifyContent: 'center' },
  mealEditorText: { color: colors.teal, fontSize: 14, fontWeight: '800' },
  mealEditorHint: { color: colors.navy, fontSize: 11, lineHeight: 16, marginTop: 2 },
  historicBox: { backgroundColor: colors.redSoft, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm },
  historicTitle: { color: colors.red, fontWeight: '900', fontSize: 13 },
  historicText: { color: colors.red, fontSize: 12, lineHeight: 18, marginTop: 4 },
  warningBox: { backgroundColor: colors.warningSoft, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm },
  warningTitle: { color: colors.warning, fontWeight: '800', fontSize: 13 },
  warningText: { color: colors.warning, fontSize: 12, lineHeight: 18, marginTop: 4 },
  calculateButton: { backgroundColor: colors.teal, borderRadius: radius.md, padding: spacing.lg, alignItems: 'center', marginTop: spacing.md, minHeight: 44, justifyContent: 'center' },
  calculateText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  resultBox: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg, marginTop: spacing.md, borderWidth: 2, borderColor: colors.teal },
  resultLabel: { color: colors.teal, fontSize: 11, fontWeight: '900', letterSpacing: 0.8 },
  resultValue: { color: colors.ink, fontSize: 44, fontWeight: '900', marginTop: 2 },
  formula: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  below: { color: colors.red, fontSize: 12, lineHeight: 17, marginTop: spacing.sm },
  useButton: { backgroundColor: colors.blue, borderRadius: radius.sm, padding: spacing.md, alignItems: 'center', marginTop: spacing.md, minHeight: 44, justifyContent: 'center' },
  useText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  useFoot: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 6 },
  insulinNames: { backgroundColor: colors.surface, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, padding: spacing.md, marginTop: spacing.md },
  insulinNameLine: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  linkButton: { minHeight: 44, justifyContent: 'center', marginTop: spacing.xs },
  linkText: { color: colors.teal, fontSize: 13, fontWeight: '800' },
  message: { color: colors.warning, backgroundColor: colors.warningSoft, borderRadius: radius.sm, padding: spacing.md, fontSize: 13, lineHeight: 19, marginTop: spacing.lg },
  saveButton: { backgroundColor: colors.orange, borderRadius: radius.md, padding: spacing.lg, alignItems: 'center', marginTop: spacing.xl, minHeight: 44, justifyContent: 'center' },
  saveText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  disabled: { opacity: 0.55 },
  choiceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, marginTop: spacing.lg },
  choiceCopy: { flex: 1 },
  choiceTitle: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  choiceFoot: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 2 },
});
