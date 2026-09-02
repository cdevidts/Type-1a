import { useEffect, useState } from 'react';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Image, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import {
  calculateMealBolus,
  cartLineGrams,
  catalogEntryFromPortion,
  resolveMacrosSource,
  scaleCatalogFood,
  type CartLine,
  type Recipe,
  type CatalogFood,
} from '@type1a/domain';
import type { MealAnalysisResult } from '@type1a/schemas';

import { analyzeMealDescription, analyzeMealImage, editMealWithInstruction, MobileApiError } from '../api';
import { parseBlankAsUnset, parseNonNegativeNumber, parsePositiveNumber } from '../format';
import { knownFoodNamesFrom } from '../knownFoods';
import { logSaveError } from '../log';
import { mealNoteFrom } from '../mealNote';
import { MealAiFields } from './MealAiFields';
import { colors, radius, spacing } from '../theme';
import { MealCart } from './MealCart';
import { MacroFields } from './MacroFields';
import { ModalShell } from './ModalShell';

/**
 * Cuánto puede alejarse un valor de lo que predijo el catálogo antes de que
 * cuente como "corrigió el alimento". 10 % o 1 g, lo que sea mayor.
 */
const CATALOG_EDIT_TOLERANCE = 0.1;

export interface ConfirmedMealDraft {
  /**
   * Las tres decisiones de la Fase 21, independientes entre sí a propósito
   * (pedido explícito de Verónica, 2026-08-22): registrar o no la comida de
   * hoy, guardarla o no al catálogo, y ponerle o no insulina. La UI las deja
   * combinar libremente en vez de forzar un único camino.
   */
  /** `false` = solo al catálogo, sin tocar el timeline ni crear episodio. */
  registerToTimeline?: boolean;
  /** `false` = no alimentar el catálogo con los alimentos de esta comida. */
  saveToCatalog?: boolean;
  /**
   * Insulina rápida que acompaña a esta comida, si la hubo.
   *
   * Se guarda **bajo el mismo timestamp que la comida**, y esa es toda la
   * razón por la que este campo existe: el botón "Rápida" suelto escribía una
   * fila con su propio timestamp, y por eso la app después no encontraba qué
   * dosis correspondía a qué carbohidratos. Ver roadmap § Fase 21.
   *
   * Es un número que la usuaria confirma, nunca uno que la app decida por
   * ella: la calculadora solo aplica su propio `carbRatio`.
   */
  rapidUnits?: number;
  imageUri?: string;
  analysis?: MealAnalysisResult;
  /**
   * Qué se comió, en palabras, para que el registro del timeline diga algo
   * más que gramos. Lo resuelve `mealNoteFrom`; antes este modal usaba su
   * cuadro de texto solo para la llamada a la IA y lo tiraba.
   */
  note?: string;
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
  /**
   * La usuaria vació al menos un macro que la IA había precargado. Quien
   * guarde debe entonces **descartar** los macros del análisis en vez de
   * dejarlos: un campo en blanco significa "no lo anoté", no "usa el de la
   * IA".
   */
  clearedMacros?: boolean;
  /**
   * Carbohidratos que sugirió el catálogo, si se usó uno. Se guarda como
   * `aiEstimatedCarbsG` cuando no hubo análisis propio: el catálogo es una
   * media de estimaciones de IA, así que ese número tiene el mismo estatus
   * que el de una foto y no puede pasar por dato confirmado sin rastro.
   */
  catalogSuggestedCarbsG?: number;
  /**
   * Qué hacer con el alimento del catálogo del que salió esta comida
   * (Fase 18), cuando la usuaria corrigió sus macros antes de guardar.
   *
   * Es la respuesta a la pregunta de tres salidas. Sin ella, corregir una
   * comida puntual corrompería en silencio el alimento que se reutiliza en
   * todas las demás — o, al revés, una corrección real no llegaría nunca al
   * catálogo y habría que repetirla en cada comida.
   */
  catalogWrite?: {
    mode: 'update' | 'variant';
    food: CatalogFood;
    grams: number;
    name: string;
    carbsG: number;
    proteinG: number;
    fatG: number;
    fiberG: number;
    caloriesKcal: number;
  };
}

export function MealModal({
  visible,
  onClose,
  onConfirm,
  catalogFoods,
  recipes,
  presetCartLines,
  carbRatio,
  therapyConfigured,
  targetGlucose,
  correctionFactor,
  doseIncrement,
}: {
  visible: boolean;
  onClose: () => void;
  onConfirm: (draft: ConfirmedMealDraft) => Promise<void>;
  /** Alimentos ya conocidos, para reusar sin llamar a la IA (Fase 15). */
  catalogFoods: readonly CatalogFood[];
  /** Recetas, para que el carrito pueda reusarlas. */
  recipes?: readonly Recipe[] | undefined;
  /**
   * Líneas con las que arranca el carrito al abrir: es cómo "Usar en una
   * comida" desde una receta llega acá. Se aplican al abrir y nada más; una
   * comida siguiente vuelve a empezar vacía.
   */
  presetCartLines?: readonly CartLine[] | null | undefined;
  /**
   * Parámetros de terapia de la usuaria, para la calculadora por conteo.
   * `carbRatio` es opcional en el perfil: sin él la calculadora no aparece,
   * y el campo de insulina sigue estando para escribirla a mano.
   */
  carbRatio?: number | undefined;
  /**
   * `false` mientras el perfil sigue con los valores placeholder que vienen
   * con la app. **La calculadora tiene que negarse a calcular** en ese caso:
   * mostrar una dosis derivada de un default de fábrica sería inferir un
   * parámetro de terapia, que `AGENTS.md` prohíbe. Es la misma negativa
   * explícita que ya hacen `EntryModal` y `CorrectionModal`; esta pantalla
   * era la única superficie de dosis sin ella.
   */
  therapyConfigured: boolean;
  targetGlucose: number;
  correctionFactor: number;
  doseIncrement: number;
}) {
  const [imageUri, setImageUri] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<MealAnalysisResult | null>(null);
  const [description, setDescription] = useState('');
  /** Corrección sobre la propuesta ya hecha. Ver `MealAiFields`. */
  const [instruction, setInstruction] = useState('');
  const [confirmedCarbs, setConfirmedCarbs] = useState('');
  const [busy, setBusy] = useState(false);
  const [macrosOpen, setMacrosOpen] = useState(false);
  const [cartLines, setCartLines] = useState<CartLine[]>([]);
  const [registerToTimeline, setRegisterToTimeline] = useState(true);
  const [saveToCatalog, setSaveToCatalog] = useState(true);
  const [rapidInput, setRapidInput] = useState('');
  /**
   * Con qué gramos de carbohidratos se calculó la dosis que hay en el campo,
   * o `null` si el número lo escribió ella a mano.
   *
   * Existe para invalidar: sin esto, calcular 8 U para 80 g y después
   * corregir los carbohidratos a 30 g dejaba **8 U en el campo**, sin nada en
   * pantalla que atara ese número a los gramos de los que salió. Ella podía
   * guardarlo —o inyectárselo— creyendo que correspondía. `EntryModal` ya
   * resolvía esto con `invalidateSuggestion`; acá se había reimplementado la
   * calculadora sin la salvaguarda.
   */
  const [calcBasisCarbsG, setCalcBasisCarbsG] = useState<number | null>(null);
  const [proteinInput, setProteinInput] = useState('');
  const [fatInput, setFatInput] = useState('');
  const [fiberInput, setFiberInput] = useState('');
  /** Lo que precargó la IA, para saber después si la usuaria lo corrigió. */
  const [aiMacros, setAiMacros] = useState<{ proteinG: number; fatG: number; fiberG: number } | null>(null);
  const [catalogSuggestedCarbsG, setCatalogSuggestedCarbsG] = useState<number | null>(null);
  /**
   * El alimento del catálogo que se aplicó y con cuántos gramos, para poder
   * detectar después si la usuaria corrigió sus macros — y en ese caso
   * preguntarle qué hacer con el alimento (la pregunta de tres salidas).
   */
  const [appliedCatalog, setAppliedCatalog] = useState<{ food: CatalogFood; grams: number } | null>(null);
  /** Datos de la comida esperando la respuesta a esa pregunta. */
  const [catalogQuestion, setCatalogQuestion] = useState<ConfirmedMealDraft | null>(null);
  /**
   * Segundo paso de la pregunta: qué quedaría escrito en el catálogo, por
   * 100 g, antes de escribirlo. Ver `catalogPreviewFor`.
   */
  const [catalogPreview, setCatalogPreview] = useState<
    { mode: 'update' | 'variant'; carbsPer100g: number; proteinPer100g: number; fatPer100g: number } | null
  >(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setImageUri(null);
    setAnalysis(null);
    setDescription('');
    setInstruction('');
    setConfirmedCarbs('');
    setMessage(null);
    // Todo lo de macros y catálogo también, o la comida siguiente hereda los
    // números de la anterior. Antes de la Fase 15 estos campos casi siempre
    // estaban vacíos y la fuga no se notaba; ahora la IA los precarga en cada
    // análisis, así que sería la norma: una fruta registrada después de un
    // plato de pastas se guardaba con la proteína y la grasa de las pastas, y
    // encima etiquetada como estimación de IA de esa fruta.
    setProteinInput('');
    setFatInput('');
    setFiberInput('');
    setAiMacros(null);
    setMacrosOpen(false);
    // El carrito se vacía: heredar los alimentos de la comida anterior ya
    // costó una corrida en este mismo modal. Lo único que entra es lo que
    // quien abre pidió explícitamente (una receta desde el catálogo).
    setCartLines(presetCartLines === null || presetCartLines === undefined ? [] : [...presetCartLines]);
    setCatalogSuggestedCarbsG(null);
    setAppliedCatalog(null);
    setCatalogQuestion(null);
    setCatalogPreview(null);
    // Los tres controles de la Fase 21 vuelven a su estado por defecto.
    // `rapidInput` es el más grave de los tres: sin esto, la comida siguiente
    // heredaba las unidades de la anterior en un campo ya rellenado, listo
    // para confirmarse de un toque. Una dosis arrastrada es exactamente la
    // clase de error que esta app no puede permitirse.
    setRegisterToTimeline(true);
    setSaveToCatalog(true);
    setRapidInput('');
    setCalcBasisCarbsG(null);
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
        knownFoodNames: knownFoodNamesFrom(catalogFoods),
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
  /**
   * Qué hace esta pantalla cuando la usuaria toca "Usar N g como confirmados".
   *
   * La elección y el escalado los resuelve `MealCart`; acá solo se decide
   * dónde aterriza.
   *
   * ## Los carbohidratos SÍ se escriben en el campo, y por qué
   *
   * El botón del carrito dice literalmente "como confirmados": es la acción
   * explícita que exige `AGENTS.md` para que una estimación pase a dato
   * confirmado. Antes esta función mostraba "se transcribieron 62 g" y **no
   * tocaba el campo**, así que "Calcular por conteo" seguía leyendo los 20 g
   * que hubiera escrito antes: una dosis para 20 g creyendo que cubría 62.
   * Una pantalla que afirma un valor distinto del que usa la fórmula es peor
   * que una que no afirma nada.
   *
   * El rastro de que ese número es una estimación no se pierde:
   * `catalogSuggestedCarbsG` se guarda como `aiEstimatedCarbsG`.
   */
  function applyCart(totals: { carbsG: number; proteinG: number; fatG: number; fiberG: number; caloriesKcal: number }): void {
    setConfirmedCarbs(String(totals.carbsG));
    // Los gramos cambiaron, así que cualquier dosis ya calculada dejó de
    // corresponder. Misma invalidación que al teclear el campo a mano.
    if (calcBasisCarbsG !== null) {
      setCalcBasisCarbsG(null);
      setRapidInput('');
    }
    setProteinInput(String(totals.proteinG));
    setFatInput(String(totals.fatG));
    setFiberInput(String(totals.fiberG));
    setAiMacros({ proteinG: totals.proteinG, fatG: totals.fatG, fiberG: totals.fiberG });
    setMacrosOpen(true);
    setCatalogSuggestedCarbsG(totals.carbsG);
    // **La pregunta de tres salidas solo aplica a un alimento.** Con una sola
    // línea, una corrección de los macros es inequívocamente de ese alimento
    // y ofrecer "corregir el alimento / guardar variante / solo esta comida"
    // tiene sentido. Con dos o más, la diferencia no se puede atribuir a
    // ninguno en concreto, y atribuírsela corrompería el catálogo en
    // silencio: `appliedCatalog` queda en `null` y la pregunta no aparece.
    const only = cartLines.length === 1 ? cartLines[0] : undefined;
    setAppliedCatalog(only === undefined ? null : { food: only.food, grams: cartLineGrams(only) });
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
      const nextAnalysis = await analyzeMealDescription(description.trim(), knownFoodNamesFrom(catalogFoods));
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

  /**
   * Corrige la propuesta que ya está en pantalla, **sin volver a mandar la
   * foto**: `editMealWithInstruction` trabaja sobre la composición actual.
   *
   * Los macros se vuelven a precargar con `prefillMacrosFrom`, que es el mismo
   * camino de un análisis nuevo — y por lo tanto el que invalida la dosis
   * calculada. Una corrección cambia los carbohidratos, así que una dosis
   * anterior deja de corresponder.
   */
  async function refineAnalysis(): Promise<void> {
    setMessage(null);
    if (analysis === null) return;
    if (instruction.trim() === '') {
      setMessage('Escribe qué hay que corregir, por ejemplo "es menos arroz del que pensaste".');
      return;
    }
    setBusy(true);
    try {
      const next = await editMealWithInstruction({
        knownFoodNames: knownFoodNamesFrom(catalogFoods),
        instruction: instruction.trim(),
        current: {
          confirmedCarbsG: analysis.totals.carbsG,
          foods: analysis.estimate.foods,
          ...(description.trim() === '' ? {} : { note: description.trim() }),
        },
      });
      setAnalysis(next);
      prefillMacrosFrom(next);
      setInstruction('');
      setMessage('Propuesta corregida. Revísala: los carbohidratos los confirmas tú, y una dosis calculada antes ya no corresponde.');
    } catch (error) {
      // La propuesta anterior **queda como estaba**: degradar a lo que ya
      // había es siempre una salida válida.
      setMessage(error instanceof MobileApiError
        ? `${error.message} La propuesta anterior sigue como estaba.`
        : 'No se pudo aplicar la corrección. La propuesta anterior sigue como estaba.');
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
      const protein = parseBlankAsUnset(proteinInput);
      const fat = parseBlankAsUnset(fatInput);
      const fiber = parseBlankAsUnset(fiberInput);
      if (protein === null || fat === null || fiber === null) {
        setMessage('Revisa proteína, grasa y fibra: deben ser números, o quedar en blanco.');
        return;
      }

      // `clearedMacros` avisa a quien guarda que **descarte** los macros del
      // análisis: si la IA precargó un valor y ella lo dejó en blanco, está
      // diciendo "no lo sé", no "usa el de la IA". Sin esto, el spread del
      // análisis en `confirmMeal` volvía a escribir el número de la IA.
      const clearedMacros = aiMacros !== null
        && (protein === undefined || fat === undefined || fiber === undefined);
      // La procedencia la decide `packages/domain`, no esta pantalla.
      const macrosSource = resolveMacrosSource({
        entered: { proteinG: protein, fatG: fat, fiberG: fiber },
        ...(aiMacros === null ? {} : { aiProposed: aiMacros }),
      });

      const rapidUnits = rapidInput.trim() === '' ? undefined : parsePositiveNumber(rapidInput);
      if (rapidUnits === null || (rapidUnits !== undefined && rapidUnits > 100)) {
        setMessage('Revisa la insulina: debe ser un número entre 0,1 y 100 U, o quedar en blanco.');
        return;
      }

      // Lo que ella escribió manda; si no escribió, los alimentos que la IA
      // identificó o el del catálogo que reusó. Ver `mealNote.ts`.
      const note = mealNoteFrom({
        description,
        ...(analysis === null ? {} : { analysis }),
        ...(appliedCatalog === null ? {} : { catalogFoodName: appliedCatalog.food.name }),
      });

      const draft: ConfirmedMealDraft = {
        confirmedCarbsG: parsed,
        registerToTimeline,
        saveToCatalog,
        ...(rapidUnits === undefined || !registerToTimeline ? {} : { rapidUnits }),
        ...(macrosSource === undefined ? {} : { macrosSource }),
        ...(clearedMacros ? { clearedMacros: true } : {}),
        ...(catalogSuggestedCarbsG === null ? {} : { catalogSuggestedCarbsG }),
        ...(imageUri === null ? {} : { imageUri }),
        ...(analysis === null ? {} : { analysis }),
        ...(note === undefined ? {} : { note }),
        ...(protein === undefined ? {} : { proteinG: protein }),
        ...(fat === undefined ? {} : { fatG: fat }),
        ...(fiber === undefined ? {} : { fiberG: fiber }),
      };

      // La pregunta de tres salidas (Fase 18). Solo se hace si la comida vino
      // del catálogo Y ella cambió algo que describe al **alimento**, no a
      // esta comida. Cambiar cuántas porciones comió no pregunta nada: eso es
      // un dato de hoy, no del alimento.
      // La pregunta NO se hace si la comida además pasó por un análisis: ahí
      // los carbohidratos confirmados cubren varios alimentos y atribuirle la
      // diferencia al del catálogo sería inventar.
      if (analysis === null && appliedCatalog !== null && catalogMacrosEdited(protein, fat, fiber, parsed)) {
        setCatalogQuestion(draft);
        setBusy(false);
        return;
      }

      await onConfirm(draft);
      onClose();
    } catch (error) {
      logSaveError('MealModal.confirm', error);
      setMessage('No se pudo guardar la comida. Inténtalo otra vez.');
    } finally {
      setBusy(false);
    }
  }

  /**
   * ¿Los valores que va a guardar difieren de lo que el catálogo predijo para
   * esa porción?
   *
   * Se compara contra lo escalado, no contra los valores por 100 g: la
   * usuaria ve y corrige gramos de **su plato**, no la base del catálogo.
   */
  function catalogMacrosEdited(
    protein: number | undefined,
    fat: number | undefined,
    fiber: number | undefined,
    carbs: number,
  ): boolean {
    if (appliedCatalog === null) return false;
    const expected = scaleCatalogFood(appliedCatalog.food, appliedCatalog.grams);
    // Un macro borrado ("no lo anoté") no es una corrección del alimento: es
    // una afirmación sobre esta comida. Preguntar ahí sería pedirle que
    // decida sobre el catálogo por haber dejado un campo vacío.
    if (protein === undefined || fat === undefined || fiber === undefined) return false;
    // Con tolerancia, no con `!==`. Redondear 42,5 g a 42 es lo que hace
    // cualquiera al confirmar carbohidratos, y no significa que el alimento
    // esté mal: sin margen, la pregunta de tres salidas saltaría en casi
    // todas las comidas y se volvería un trámite que se responde sin leer —
    // que es exactamente cómo se termina corrompiendo el catálogo.
    const differs = (value: number, reference: number): boolean =>
      Math.abs(value - reference) > Math.max(1, reference * CATALOG_EDIT_TOLERANCE);
    return differs(protein, expected.proteinG)
      || differs(fat, expected.fatG)
      || differs(fiber, expected.fiberG)
      || differs(carbs, expected.carbsG);
  }

  /**
   * Qué quedaría escrito en el catálogo, por 100 g, si aceptara.
   *
   * **Esto existe porque el número no es obvio y puede estar mal.** La app
   * tiene un solo campo de carbohidratos, que es el total de *la comida*: si
   * ella reusó "Arroz" y además comió pan, la diferencia contra lo que
   * predijo el catálogo no es del arroz. Escribir ese total como si
   * describiera al arroz lo dejaría inflado para siempre, y con un valor
   * perfectamente plausible que ninguna validación puede atrapar. Mostrarlo
   * por 100 g antes de escribirlo es lo que le permite ver el disparate.
   */
  function catalogPreviewFor(mode: 'update' | 'variant'): void {
    const draft = catalogQuestion;
    if (draft === null || appliedCatalog === null) return;
    const entry = catalogEntryFromPortion(appliedCatalog.food, {
      grams: appliedCatalog.grams,
      carbsG: draft.confirmedCarbsG,
      proteinG: draft.proteinG ?? 0,
      fatG: draft.fatG ?? 0,
      fiberG: draft.fiberG ?? 0,
      caloriesKcal: scaleCatalogFood(appliedCatalog.food, appliedCatalog.grams).caloriesKcal,
    }, new Date().toISOString());
    if (entry === null) {
      setMessage('Esos valores no son posibles por 100 g, así que el catálogo no se puede corregir con ellos. Puedes guardar solo esta comida.');
      return;
    }
    setCatalogPreview({
      mode,
      carbsPer100g: entry.carbsPer100g,
      proteinPer100g: entry.proteinPer100g,
      fatPer100g: entry.fatPer100g,
    });
  }

  /** Resuelve la pregunta de tres salidas y guarda. */
  async function answerCatalogQuestion(mode: 'update' | 'variant' | 'none'): Promise<void> {
    const draft = catalogQuestion;
    if (draft === null || appliedCatalog === null) return;
    // Defensa: la pregunta solo aparece con los tres macros escritos
    // (`catalogMacrosEdited` lo exige), pero si alguna vez dejara de ser así,
    // escribir un macro ausente como 0 g en el catálogo lo corrompería con un
    // dato que nadie anotó.
    const macrosComplete = draft.proteinG !== undefined && draft.fatG !== undefined && draft.fiberG !== undefined;
    const effectiveMode = macrosComplete ? mode : 'none';
    setCatalogQuestion(null);
    setCatalogPreview(null);
    setBusy(true);
    try {
      await onConfirm(effectiveMode === 'none' ? draft : {
        ...draft,
        catalogWrite: {
          mode: effectiveMode,
          food: appliedCatalog.food,
          grams: appliedCatalog.grams,
          name: appliedCatalog.food.name,
          carbsG: draft.confirmedCarbsG,
          proteinG: draft.proteinG ?? 0,
          fatG: draft.fatG ?? 0,
          fiberG: draft.fiberG ?? 0,
          // Los `?? 0` son inalcanzables por `macrosComplete`; están para que
          // el tipo cierre, no como default silencioso.
          // El catálogo guarda calorías; sin análisis propio no hay un valor
          // medido, así que se escalan las que ya tenía para esa porción.
          caloriesKcal: scaleCatalogFood(appliedCatalog.food, appliedCatalog.grams).caloriesKcal,
        },
      });
      onClose();
    } catch (error) {
      logSaveError('MealModal.answerCatalogQuestion', error);
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

      <MealAiFields
        description={description}
        onChangeDescription={setDescription}
        hasPhoto={imageUri !== null}
        hasAnalysis={analysis !== null}
        instruction={instruction}
        onChangeInstruction={setInstruction}
        busy={busy}
        onEstimateFromText={() => { void analyzeFromDescription(); }}
        onRefine={() => { void refineAnalysis(); }}
      />

      <Pressable style={[styles.cameraButton, busy && styles.disabled]} disabled={busy} onPress={() => { void captureAndAnalyze(); }}>
        <Text style={styles.cameraIcon}>◎</Text>
        <Text style={styles.cameraText}>{busy ? 'Procesando imagen…' : imageUri === null ? 'Tomar foto y estimar' : 'Tomar otra foto'}</Text>
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

      {/*
        El carrito multi-alimento. Reemplaza al picker de un alimento por vez:
        elegir el segundo borraba al primero, así que un sándwich obligaba a
        sumar de cabeza o a registrar tres comidas.
      */}
      <MealCart
        foods={catalogFoods}
        recipes={recipes ?? []}
        lines={cartLines}
        onChange={(next) => {
          setCartLines(next);
          // Cambiar el carrito invalida la atribución al alimento único y
          // cualquier dosis calculada con el total anterior.
          setAppliedCatalog(null);
          setCatalogQuestion(null);
          setCatalogPreview(null);
        }}
        onUseCarbs={(totals) => {
          applyCart(totals);
          setMessage(`Se escribieron ${totals.carbsG} g en "carbohidratos que confirmas". Revísalos antes de guardar; si calculaste una dosis antes, vuelve a calcularla.`);
        }}
        onMessage={setMessage}
      />

      <Text style={styles.confirmLabel}>CARBOHIDRATOS QUE CONFIRMAS</Text>
      <View style={styles.confirmInputWrap}>
        <TextInput
          value={confirmedCarbs}
          onChangeText={(text) => {
            setConfirmedCarbs(text);
            // Si los gramos cambian, la dosis calculada deja de corresponder.
            // Se borra en vez de quedarse: un número viejo en un campo de
            // insulina es peor que un campo vacío.
            if (calcBasisCarbsG !== null) {
              setCalcBasisCarbsG(null);
              setRapidInput('');
              setMessage('Cambiaste los carbohidratos, así que se borró la dosis calculada. Vuelve a calcularla o escríbela a mano.');
            }
          }}
          keyboardType="decimal-pad"
          style={styles.confirmInput}
          placeholder="Escribe un valor"
          placeholderTextColor={colors.muted}
        />
        <Text style={styles.confirmUnit}>g</Text>
      </View>
      <Text style={styles.confirmFoot}>
        La estimación de una foto nunca lo completa sola. El carrito sí lo escribe, pero solo cuando tocas
        "Usar N g como confirmados": revisa el número antes de guardar.
      </Text>

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
          <MacroFields
            protein={proteinInput}
            fat={fatInput}
            fiber={fiberInput}
            onChange={(field, next) => {
              if (field === 'protein') setProteinInput(next);
              else if (field === 'fat') setFatInput(next);
              else if (field === 'fiber') setFiberInput(next);
            }}
            hint={aiMacros === null
              ? 'Déjalos en blanco si no los sabes. En blanco significa “no lo anoté”, que no es lo mismo que 0 g.'
              : 'Los estimó la IA a partir de lo que identificó. Corrígelos si sabes que van desviados; queda guardado si el número es suyo o tuyo.'}
          />
        </View>
      ) : null}

      {catalogQuestion === null || appliedCatalog === null ? null : catalogPreview !== null ? (
        <View style={styles.questionBox}>
          <Text style={styles.questionTitle}>
            {catalogPreview.mode === 'update'
              ? `${appliedCatalog.food.name} quedaría así`
              : `El alimento nuevo quedaría así`}
          </Text>
          <Text style={styles.questionHint}>
            Por cada 100 g: {catalogPreview.carbsPer100g} g de carbohidratos, {catalogPreview.proteinPer100g} g de
            proteína, {catalogPreview.fatPer100g} g de grasa.
          </Text>
          <Text style={styles.questionWarning}>
            Esto supone que lo que anotaste corresponde solo a {appliedCatalog.food.name}. Si en esa comida hubo
            algo más, los números de arriba van a quedar inflados — y se usarían cada vez que lo elijas.
          </Text>
          <Pressable
            style={styles.questionOption}
            onPress={() => { void answerCatalogQuestion(catalogPreview.mode); }}
            accessibilityRole="button"
          >
            <Text style={styles.questionOptionTitle}>Sí, guardar así</Text>
          </Pressable>
          <Pressable
            style={styles.questionOption}
            onPress={() => { setCatalogPreview(null); }}
            accessibilityRole="button"
          >
            <Text style={styles.questionOptionTitle}>Volver</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.questionBox}>
          <Text style={styles.questionTitle}>Lo que anotaste no cuadra con {appliedCatalog.food.name}</Text>
          <Text style={styles.questionHint}>
            Ese alimento se reutiliza en cada comida donde lo elijas. ¿Qué hacemos con él?
          </Text>
          <Pressable
            style={styles.questionOption}
            onPress={() => { catalogPreviewFor('update'); }}
            accessibilityRole="button"
          >
            <Text style={styles.questionOptionTitle}>Corregir el alimento</Text>
            <Text style={styles.questionOptionCopy}>Queda corregido para todas las comidas futuras que lo usen.</Text>
          </Pressable>
          <Pressable
            style={styles.questionOption}
            onPress={() => { catalogPreviewFor('variant'); }}
            accessibilityRole="button"
          >
            <Text style={styles.questionOptionTitle}>Guardar como alimento nuevo</Text>
            <Text style={styles.questionOptionCopy}>El original queda intacto y se agrega una variante.</Text>
          </Pressable>
          <Pressable
            style={styles.questionOption}
            onPress={() => { void answerCatalogQuestion('none'); }}
            accessibilityRole="button"
          >
            <Text style={styles.questionOptionTitle}>Solo para esta comida</Text>
            <Text style={styles.questionOptionCopy}>
              El catálogo no se toca. Es lo correcto si en esta comida hubo algo más además de {appliedCatalog.food.name}.
            </Text>
          </Pressable>
        </View>
      )}

      {/*
        Las tres decisiones de la Fase 21. Son independientes entre sí, así
        que van como interruptores separados y no como un selector de modo:
        "solo al catálogo", "comida sin insulina" y "comida con insulina" no
        son tres caminos excluyentes, son combinaciones de dos preguntas.
      */}
      <Text style={styles.sectionLabel}>Qué hacer con esto</Text>
      <View style={styles.choiceRow}>
        <View style={styles.choiceCopy}>
          <Text style={styles.choiceTitle}>Registrarla como comida de ahora</Text>
          <Text style={styles.choiceFoot}>
            {registerToTimeline
              ? 'Queda en el timeline y empieza el seguimiento post-comida.'
              : 'No se registra nada de hoy. Sirve para cargar el catálogo sin haber comido.'}
          </Text>
        </View>
        <Switch
          value={registerToTimeline}
          onValueChange={setRegisterToTimeline}
          trackColor={{ false: colors.line, true: colors.teal }}
        />
      </View>
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

      {registerToTimeline ? (
        <View style={styles.insulinBlock}>
          <View style={styles.insulinRow}>
            <View style={styles.choiceCopy}>
              <Text style={styles.choiceTitle}>Insulina rápida (opcional)</Text>
              <Text style={styles.choiceFoot}>
                Se guarda con la misma hora que la comida, así queda claro qué dosis fue de qué plato.
              </Text>
            </View>
            <View style={styles.insulinInputWrap}>
              <TextInput
                value={rapidInput}
                onChangeText={(text) => {
                  // Escrito a mano: deja de ser una dosis calculada, así que
                  // cambiar los carbohidratos ya no debe borrarlo.
                  setRapidInput(text);
                  setCalcBasisCarbsG(null);
                }}
                keyboardType="decimal-pad"
                style={styles.insulinInput}
                placeholder="—"
                placeholderTextColor={colors.muted}
                accessibilityLabel="Unidades de insulina rápida"
              />
              <Text style={styles.insulinUnit}>U</Text>
            </View>
          </View>
          {/*
            La calculadora solo aparece si la usuaria ya cargó su ratio, y
            solo aplica ESE valor suyo. La app no propone un ratio ni decide
            una dosis: escribe un número en un campo que ella revisa y puede
            sobrescribir antes de guardar (AGENTS.md).
          */}
          {!therapyConfigured || carbRatio === undefined ? (
            <Text style={styles.choiceFoot}>
              {therapyConfigured
                ? 'Para calcularla por conteo, carga tus “carbs por unidad” en Ajustes → Terapia.'
                : 'Para calcularla por conteo, confirma primero tus parámetros en Ajustes → Terapia. La app no calcula dosis con valores que tú no hayas cargado.'}
            </Text>
          ) : (
            <Pressable
              style={styles.calcButton}
              accessibilityRole="button"
              onPress={() => {
                const carbsNow = confirmedCarbs.trim() === '' ? null : parseNonNegativeNumber(confirmedCarbs);
                if (carbsNow === null) {
                  setMessage('Escribe primero los carbohidratos confirmados.');
                  return;
                }
                const result = calculateMealBolus({
                  carbsG: carbsNow,
                  carbRatio,
                  targetGlucose,
                  correctionFactor,
                  doseIncrement,
                });
                // 0 g da 0 U, y el guardado después rechaza el 0 con un error
                // que parece culpa de la usuaria. Se dice acá en su lugar.
                if (result.totalRoundedUnits <= 0) {
                  setMessage('Con esos carbohidratos el conteo da 0 U, así que no hay dosis que registrar.');
                  return;
                }
                setRapidInput(String(result.totalRoundedUnits));
                setCalcBasisCarbsG(carbsNow);
                setMessage(`Por conteo: ${result.mealFormula} = ${result.totalRoundedUnits} U. Revísalo antes de guardar.`);
              }}
            >
              <Text style={styles.calcButtonText}>Calcular por conteo</Text>
            </Pressable>
          )}
          <Text style={styles.insulinFoot}>
            Type 1A no decide ni sugiere dosis: solo aplica los valores que cargaste. Confirma la cantidad antes
            de guardar.{'\n\n'}
            El conteo no descuenta insulina que siga actuando de una dosis anterior — la app no calcula insulina
            activa. Si te pinchaste hace poco, tenlo en cuenta antes de confirmar.
          </Text>
        </View>
      ) : null}

      {message === null ? null : <Text style={styles.message}>{message}</Text>}
      <Pressable
        style={[styles.confirmButton, (busy || (!registerToTimeline && !saveToCatalog)) && styles.disabled]}
        disabled={busy || (!registerToTimeline && !saveToCatalog)}
        onPress={() => { void confirm(); }}
      >
        <Text style={styles.confirmButtonText}>
          {busy
            ? 'Guardando…'
            : !registerToTimeline
              ? 'Guardar solo en el catálogo'
              : 'Confirmar y crear episodio'}
        </Text>
      </Pressable>
      {!registerToTimeline && !saveToCatalog ? (
        <Text style={styles.message}>Con las dos opciones apagadas no hay nada que guardar.</Text>
      ) : null}
    </ModalShell>
  );
}


const styles = StyleSheet.create({
  sectionLabel: { color: colors.navy, fontSize: 13, fontWeight: '800', letterSpacing: 0.5, marginTop: spacing.xl },
  choiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 44,
    marginTop: spacing.md,
  },
  choiceCopy: { flex: 1 },
  choiceTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  choiceFoot: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 2 },
  insulinBlock: {
    marginTop: spacing.lg,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  insulinRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
  insulinInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 92,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.background,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.blue,
  },
  insulinInput: { flex: 1, color: colors.ink, fontSize: 20, fontWeight: '800', textAlign: 'right' },
  insulinUnit: { color: colors.muted, fontSize: 14, marginLeft: spacing.xs },
  calcButton: {
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.blue,
    marginTop: spacing.md,
  },
  calcButtonText: { color: colors.blue, fontSize: 14, fontWeight: '800' },
  insulinFoot: { color: colors.warning, fontSize: 12, lineHeight: 17, marginTop: spacing.md },
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
  unitToggle: {
    flexDirection: 'row',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
  unitOption: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  unitOptionActive: { backgroundColor: colors.tealSoft, borderColor: colors.teal },
  unitOptionText: { fontSize: 13, fontWeight: '600', color: colors.muted },
  unitOptionTextActive: { color: colors.teal },
  questionBox: {
    backgroundColor: colors.warningSoft,
    borderRadius: radius.md,
    padding: spacing.lg,
    marginTop: spacing.lg,
  },
  questionTitle: { fontSize: 15, fontWeight: '700', color: colors.warning },
  questionHint: { fontSize: 13, color: colors.navy, marginTop: spacing.xs, marginBottom: spacing.md, lineHeight: 18 },
  questionOption: {
    minHeight: 44,
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  questionWarning: { fontSize: 12, color: colors.warning, fontWeight: '600', marginBottom: spacing.md, lineHeight: 16 },
  questionOptionTitle: { fontSize: 14, fontWeight: '700', color: colors.ink },
  questionOptionCopy: { fontSize: 12, color: colors.muted, marginTop: 2, lineHeight: 16 },
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
