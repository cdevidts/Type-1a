import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type GestureResponderHandlers } from 'react-native';

// Subpath, nunca el barrel: Metro no hace tree-shaking (ver `/iconography`).
import Search from 'lucide-react-native/icons/search';
import Trash2 from 'lucide-react-native/icons/trash-2';
import WandSparkles from 'lucide-react-native/icons/wand-sparkles';

import {
  DEFAULT_SERVING_GRAMS,
  MAX_SERVING_GRAMS,
  isValidServingGrams,
  servingGramsOf,
  type CatalogFood,
  type CatalogFoodEdit,
} from '@type1a/domain';

/**
 * Re-exportado con el nombre que usa `App`: el tipo canónico vive en
 * `packages/domain` junto a `applyCatalogEdit`, que es quien lo valida.
 */
export type CatalogEdit = CatalogFoodEdit;

import { editCatalogFoodWithInstruction, MobileApiError } from '../api';
import { parseNonNegativeNumber } from '../format';
import { logSaveError } from '../log';
import { colors, radius, spacing } from '../theme';
import { FoodCard } from './FoodCard';
import { ModalShell } from './ModalShell';

const numberText = (value: number): string => String(Number(value.toFixed(2)));

function Field({
  label,
  unit,
  value,
  onChangeText,
  placeholder,
}: {
  label: string;
  unit: string;
  value: string;
  onChangeText: (next: string) => void;
  placeholder?: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <View style={styles.inputWrap}>
        <TextInput
          value={value}
          onChangeText={onChangeText}
          keyboardType="decimal-pad"
          style={styles.input}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          accessibilityLabel={`${label} ${unit}`}
        />
        <Text style={styles.inputUnit}>{unit}</Text>
      </View>
    </View>
  );
}

/**
 * Editor de un alimento del catálogo.
 *
 * Se muestra en lugar de la lista, no encima: un modal sobre un modal en
 * Android deja el de abajo capturando toques (ya pasó con el detalle del
 * Timeline y el editor de comida en la Fase 17).
 */
function FoodEditor({
  food,
  onCancel,
  onSave,
}: {
  food: CatalogFood;
  onCancel: () => void;
  onSave: (key: string, edit: CatalogEdit) => Promise<void>;
}) {
  const [name, setName] = useState(food.name);
  const [carbs, setCarbs] = useState(numberText(food.carbsPer100g));
  const [protein, setProtein] = useState(numberText(food.proteinPer100g));
  const [fat, setFat] = useState(numberText(food.fatPer100g));
  const [fiber, setFiber] = useState(numberText(food.fiberPer100g));
  const [kcal, setKcal] = useState(numberText(food.kcalPer100g));
  const [servingGrams, setServingGrams] = useState(
    food.servingGrams === undefined ? '' : numberText(food.servingGrams),
  );
  const [servingLabel, setServingLabel] = useState(food.servingLabel ?? '');
  const [instruction, setInstruction] = useState('');
  /** Quitar la foto es una acción explícita, no un efecto de guardar. */
  const [removePhoto, setRemovePhoto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function applyInstruction(): Promise<void> {
    setMessage(null);
    if (instruction.trim() === '') {
      setMessage('Escribe qué hay que corregir, por ejemplo "son 28 g de carbos por 100 g".');
      return;
    }
    // Si algún campo está ilegible, se para acá: mandarle a la IA un alimento
    // con valores equivocados hace que "corrija" desde una base falsa.
    if ([carbs, protein, fat, fiber, kcal].some((value) => parseNonNegativeNumber(value) === null)) {
      setMessage('Revisa los macros: alguno no es un número. La IA necesita los valores actuales para corregirlos.');
      return;
    }
    setBusy(true);
    try {
      const result = await editCatalogFoodWithInstruction({
        instruction: instruction.trim(),
        // `parseNonNegativeNumber`, no `Number()`: en un teclado decimal
        // chileno se escribe "28,5", y `Number('28,5')` es NaN. Con el
        // `|| 0` que había antes, la IA recibía **0 g por 100 g** como estado
        // actual del alimento, "corregía" desde cero y devolvía macros
        // inventados que se escribían en los campos.
        food: {
          name,
          carbsPer100g: parseNonNegativeNumber(carbs) ?? 0,
          proteinPer100g: parseNonNegativeNumber(protein) ?? 0,
          fatPer100g: parseNonNegativeNumber(fat) ?? 0,
          fiberPer100g: parseNonNegativeNumber(fiber) ?? 0,
          kcalPer100g: parseNonNegativeNumber(kcal) ?? 0,
          // La porción que hay ahora mismo en el formulario, para que una
          // instrucción como "una porción son dos rebanadas" corrija sobre
          // algo en vez de inventarlo.
          //
          // El campo vacío se descarta **antes** de parsear: `Number('')` es
          // 0, no `NaN`, así que `parseNonNegativeNumber('')` devuelve 0 y sin
          // esta guarda la IA recibiría "una porción pesa 0 g".
          ...(servingGrams.trim() === '' || parseNonNegativeNumber(servingGrams) === null
            ? {}
            : { servingGrams: parseNonNegativeNumber(servingGrams) as number }),
          ...(servingLabel.trim() === '' ? {} : { servingLabel: servingLabel.trim() }),
        },
      });
      const revised = result.estimate.foods[0];
      if (revised === undefined) {
        setMessage('La IA no devolvió un alimento utilizable. Corrige los campos a mano.');
        return;
      }
      // La respuesta viene en gramos absolutos sobre la porción que se le
      // mandó (100 g). Si el modelo cambió el tamaño, hay que re-normalizar o
      // los números quedarían en otra base que el resto del catálogo.
      const grams = revised.estimatedGrams ?? 100;
      const per100 = (value: number): string =>
        numberText(grams > 0 ? (value / grams) * 100 : value);
      setName(revised.name);
      setCarbs(per100(revised.carbsG));
      setProtein(per100(revised.proteinG));
      setFat(per100(revised.fatG));
      setFiber(per100(revised.fiberG));
      setKcal(per100(revised.caloriesKcal));
      // La porción también, si la propuso: "una porción son dos rebanadas" es
      // justo el tipo de corrección que se escribe acá, y sin esto la
      // instrucción se aplicaba a los macros y la porción quedaba intacta.
      if (revised.servingGrams !== null) setServingGrams(numberText(revised.servingGrams));
      if (revised.servingLabel !== null) setServingLabel(revised.servingLabel);
      setMessage('Campos actualizados con la propuesta. Revísalos: no se guarda nada hasta que toques Guardar.');
    } catch (error) {
      setMessage(error instanceof MobileApiError
        ? `${error.message} El alimento sigue como estaba.`
        : 'No se pudo aplicar el cambio. El alimento sigue como estaba.');
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    setMessage(null);
    const parsed = {
      carbsPer100g: parseNonNegativeNumber(carbs),
      proteinPer100g: parseNonNegativeNumber(protein),
      fatPer100g: parseNonNegativeNumber(fat),
      fiberPer100g: parseNonNegativeNumber(fiber),
      kcalPer100g: parseNonNegativeNumber(kcal),
    };
    if (Object.values(parsed).some((value) => value === null)) {
      setMessage('Los macros deben ser números positivos por 100 g.');
      return;
    }
    if (name.trim() === '') {
      setMessage('El alimento necesita un nombre.');
      return;
    }
    const gramsText = servingGrams.trim();
    let serving: number | null = null;
    if (gramsText !== '') {
      const value = parseNonNegativeNumber(gramsText);
      if (value === null || !isValidServingGrams(value)) {
        setMessage(`El tamaño de la porción debe estar entre 1 y ${MAX_SERVING_GRAMS} g, o quedar en blanco para usar ${DEFAULT_SERVING_GRAMS} g.`);
        return;
      }
      serving = value;
    }

    setBusy(true);
    try {
      await onSave(food.key, {
        name: name.trim(),
        carbsPer100g: parsed.carbsPer100g!,
        proteinPer100g: parsed.proteinPer100g!,
        fatPer100g: parsed.fatPer100g!,
        fiberPer100g: parsed.fiberPer100g!,
        kcalPer100g: parsed.kcalPer100g!,
        servingGrams: serving,
        servingLabel: servingLabel.trim() === '' ? null : servingLabel.trim(),
        // Ausente deja la foto como está; `null` la quita. Un campo que no
        // viaja nunca borra nada.
        ...(removePhoto ? { imageUri: null } : {}),
      });
      onCancel();
    } catch (error) {
      logSaveError('CatalogModal.save', error);
      setMessage(error instanceof Error ? error.message : 'No se pudo guardar el alimento.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={styles.editorBody} keyboardShouldPersistTaps="handled">
      <Text style={styles.editorTitle}>{food.name}</Text>
      <Text style={styles.editorMeta}>
        Identificado {food.timesSeen} {food.timesSeen === 1 ? 'vez' : 'veces'} por la IA.
        {food.timesSeen === 1 ? ' Una sola estimación: tómala con pinzas.' : ' Mientras más veces, más asentada está la estimación.'}
      </Text>

      <View style={styles.aiPanel}>
        <View style={styles.panelHeader}>
          <WandSparkles size={20} color={colors.teal} />
          <Text style={styles.panelTitle}>Corregirlo con IA</Text>
        </View>
        <Text style={styles.panelHint}>
          En tus palabras: "son 28 g de carbos por 100 g", "esto es integral, tiene más fibra".
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

      {/*
        La foto guardada del alimento. **Nunca se genera**: sale de la imagen
        que la usuaria sacó al registrar una comida donde ese alimento se
        identificó, y un alimento sin foto —todo lo anterior a este campo—
        muestra su fallback en la tarjeta. Acá solo se puede quitar.
      */}
      {food.imageUri === undefined ? (
        <Text style={styles.sectionHint}>
          Este alimento no tiene foto. Aparece sola la próxima vez que lo registres con una foto de la comida.
        </Text>
      ) : (
        <>
          <Text style={styles.sectionTitle}>Foto</Text>
          <Text style={styles.sectionHint}>
            Es la foto de la comida donde se identificó este alimento, así que puede incluir otros. No sirve para
            estimar la porción: para eso está el tamaño de porción de más abajo.
          </Text>
          <Image source={{ uri: food.imageUri }} style={styles.editorPhoto} resizeMode="cover" />
          <Pressable
            style={[styles.removePhoto, removePhoto && styles.removePhotoActive]}
            onPress={() => { setRemovePhoto((previous) => !previous); }}
            accessibilityRole="button"
            accessibilityState={{ selected: removePhoto }}
            accessibilityLabel={removePhoto ? 'Conservar la foto guardada' : 'Quitar la foto guardada'}
          >
            <Text style={[styles.removePhotoText, removePhoto && styles.removePhotoTextActive]}>
              {removePhoto ? 'Se quitará al guardar · tocar para conservarla' : 'Quitar foto'}
            </Text>
          </Pressable>
        </>
      )}

      <Text style={styles.sectionTitle}>Nombre</Text>
      <TextInput
        style={styles.textInput}
        value={name}
        onChangeText={setName}
        placeholder="Nombre del alimento"
        placeholderTextColor={colors.muted}
        maxLength={120}
      />

      <Text style={styles.sectionTitle}>Por cada 100 g</Text>
      <Text style={styles.sectionHint}>
        Todo el catálogo se guarda en esta base. Al reusar el alimento se escala a la porción que elijas.
      </Text>
      <Field label="Carbohidratos" unit="g" value={carbs} onChangeText={setCarbs} />
      <Field label="Proteína" unit="g" value={protein} onChangeText={setProtein} />
      <Field label="Grasa" unit="g" value={fat} onChangeText={setFat} />
      <Field label="Fibra" unit="g" value={fiber} onChangeText={setFiber} />
      <Field label="Calorías" unit="kcal" value={kcal} onChangeText={setKcal} />

      <Text style={styles.sectionTitle}>Porción de referencia</Text>
      <Text style={styles.sectionHint}>
        Opcional. En blanco son {DEFAULT_SERVING_GRAMS} g. Sirve para pedir "dos tazas" en vez de calcular gramos.
        Entre 1 y {MAX_SERVING_GRAMS} g.
      </Text>
      <Field label="Una porción pesa" unit="g" value={servingGrams} onChangeText={setServingGrams} placeholder={String(DEFAULT_SERVING_GRAMS)} />
      <View style={styles.field}>
        <Text style={styles.fieldLabel}>Y se llama</Text>
        <TextInput
          style={styles.textInput}
          value={servingLabel}
          onChangeText={setServingLabel}
          placeholder="taza, rebanada, plato…"
          placeholderTextColor={colors.muted}
          maxLength={40}
        />
      </View>

      {message === null ? null : <Text style={styles.message}>{message}</Text>}

      <View style={styles.editorActions}>
        <Pressable style={styles.secondaryButton} onPress={onCancel} accessibilityRole="button">
          <Text style={styles.secondaryButtonText}>Cancelar</Text>
        </Pressable>
        <Pressable
          style={[styles.primaryButton, busy && styles.disabled]}
          disabled={busy}
          onPress={() => { void save(); }}
          accessibilityRole="button"
        >
          <Text style={styles.primaryButtonText}>{busy ? 'Guardando…' : 'Guardar'}</Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

/**
 * Catálogo de alimentos (Fase 18).
 *
 * El catálogo se llenaba solo desde cada análisis de IA y **no había dónde
 * verlo ni corregirlo**: un alimento mal estimado quedaba mal para siempre y
 * contaminaba cada comida que lo reusara. `deleteCatalogFood` existía en el
 * código desde la Fase 15, sin ningún botón que la llamara.
 */
export function CatalogModal({
  visible,
  onClose,
  onLoad,
  onSaveFood,
  onDeleteFood,
  swipeHandlers,
}: {
  visible: boolean;
  onClose: () => void;
  onLoad: (search: string) => Promise<CatalogFood[]>;
  onSaveFood: (key: string, edit: CatalogEdit) => Promise<void>;
  onDeleteFood: (food: CatalogFood) => Promise<void>;
  swipeHandlers?: GestureResponderHandlers | undefined;
}) {
  const [search, setSearch] = useState('');
  const [foods, setFoods] = useState<CatalogFood[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<CatalogFood | null>(null);

  // `onLoad` llega como arrow inline desde `App`, así que cambia de identidad
  // en cada render. Si `load` dependiera de él, el efecto de más abajo se
  // volvería a montar en cada render y el catálogo se recargaría solo cada
  // 250 ms para siempre — cada carga hace `setFoods`, que provoca el render
  // siguiente. La ref rompe ese ciclo sin obligar a quien llama a memoizar.
  const onLoadRef = useRef(onLoad);
  useEffect(() => { onLoadRef.current = onLoad; }, [onLoad]);

  const load = useCallback(async (term: string): Promise<void> => {
    setLoading(true);
    setFailed(false);
    try {
      setFoods(await onLoadRef.current(term));
    } catch (error) {
      logSaveError('CatalogModal.load', error);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  // Al abrir: se limpia la búsqueda y el editor. Dejar el término de la vez
  // anterior haría que el catálogo pareciera vacío al volver a entrar.
  useEffect(() => {
    if (!visible) return;
    setEditing(null);
    setSearch('');
  }, [visible]);

  // Un solo efecto para cargar, con un retardo corto: recargar en cada tecla
  // dispara una consulta por letra. Al abrir, `search` ya quedó en '' por el
  // efecto de arriba, así que esta misma carga sirve para el primer render.
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(() => { void load(search); }, 250);
    return () => { clearTimeout(timer); };
  }, [search, visible, load]);

  function confirmDelete(food: CatalogFood): void {
    Alert.alert(
      `Borrar ${food.name}`,
      'Se quita del catálogo y deja de sugerirse. Las comidas ya registradas con este alimento no se tocan.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Borrar',
          style: 'destructive',
          onPress: () => {
            void onDeleteFood(food)
              .then(() => load(search))
              .catch((error: unknown) => { logSaveError('CatalogModal.delete', error); });
          },
        },
      ],
    );
  }

  return (
    <ModalShell visible={visible} title="Catálogo" onClose={onClose} scroll={false} swipeHandlers={swipeHandlers}>
      {editing !== null ? (
        <FoodEditor
          food={editing}
          onCancel={() => { setEditing(null); void load(search); }}
          onSave={onSaveFood}
        />
      ) : (
        <>
          <View style={styles.searchRow}>
            <Search size={18} color={colors.muted} />
            <TextInput
              style={styles.searchInput}
              value={search}
              onChangeText={setSearch}
              placeholder="Buscar un alimento"
              placeholderTextColor={colors.muted}
              accessibilityLabel="Buscar un alimento en el catálogo"
            />
          </View>

          <ScrollView contentContainerStyle={styles.listBody} keyboardShouldPersistTaps="handled">
            <Text style={styles.intro}>
              Alimentos que la IA ya identificó en tus comidas. Sus valores son una media de estimaciones,
              no un dato pesado en balanza: corrígelos cuando sepas el valor real.
            </Text>

            {loading ? <ActivityIndicator color={colors.teal} style={styles.loader} /> : null}

            {failed ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>No se pudo leer el catálogo</Text>
                <Text style={styles.emptyCopy}>Tus comidas registradas están intactas. Vuelve a intentarlo.</Text>
                <Pressable style={styles.retry} onPress={() => { void load(search); }} accessibilityRole="button">
                  <Text style={styles.retryText}>Reintentar</Text>
                </Pressable>
              </View>
            ) : null}

            {!loading && !failed && foods.length === 0 ? (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>
                  {search.trim() === '' ? 'Todavía no hay alimentos' : 'Ningún alimento con ese nombre'}
                </Text>
                <Text style={styles.emptyCopy}>
                  {search.trim() === ''
                    ? 'Aparecen solos cuando la IA identifica una comida desde una foto o una descripción. Registra una comida y vuelve acá.'
                    : 'Prueba con otra palabra, o borra la búsqueda para ver todo el catálogo.'}
                </Text>
              </View>
            ) : null}

            {/*
              La misma tarjeta que usa el carrito. Lo único que cambia es el
              control de la derecha: acá un lápiz para editar, allá una X para
              quitar la línea.

              **Tocar el contenedor ya no abre la edición.** Recorriendo la
              lista con el pulgar se abría el editor por accidente, y ese
              editor cambia valores que después sugieren carbohidratos en cada
              comida que reuse el alimento.
            */}
            {foods.map((food) => (
              <View key={food.key}>
                <FoodCard
                  name={food.name}
                  subtitle={`${numberText(food.carbsPer100g)} g carbos/100 g · porción ${numberText(servingGramsOf(food))} g`
                    + `${food.servingLabel === undefined ? '' : ` (${food.servingLabel})`}`
                    + ` · ${food.timesSeen} ${food.timesSeen === 1 ? 'vez' : 'veces'}`}
                  {...(food.imageUri === undefined ? {} : { imageUri: food.imageUri })}
                  macros={{
                    carbsG: food.carbsPer100g,
                    proteinG: food.proteinPer100g,
                    fatG: food.fatPer100g,
                    fiberG: food.fiberPer100g,
                  }}
                  action={{ kind: 'edit', label: `Editar ${food.name}`, onPress: () => { setEditing(food); } }}
                />
                {/*
                  El borrado sigue siendo explícito, confirmado y **separado
                  del lápiz**: es la única acción destructiva de esta pantalla
                  y no puede compartir gesto con la de corregir.
                */}
                <Pressable
                  style={styles.deleteRow}
                  onPress={() => { confirmDelete(food); }}
                  accessibilityRole="button"
                  accessibilityLabel={`Borrar ${food.name} del catálogo`}
                  hitSlop={8}
                >
                  <Trash2 size={16} color={colors.red} />
                  <Text style={styles.deleteRowText}>Borrar del catálogo</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </>
      )}
    </ModalShell>
  );
}

const styles = StyleSheet.create({
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: spacing.lg,
    minHeight: 52,
  },
  searchInput: { flex: 1, fontSize: 16, color: colors.ink, paddingVertical: spacing.sm },
  listBody: { padding: spacing.lg, paddingBottom: spacing.xxl },
  intro: { fontSize: 13, color: colors.muted, lineHeight: 18, marginBottom: spacing.lg },
  loader: { marginVertical: spacing.lg },
  empty: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.xl,
    alignItems: 'center',
  },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.ink, textAlign: 'center' },
  emptyCopy: { fontSize: 13, color: colors.muted, textAlign: 'center', marginTop: spacing.sm, lineHeight: 18 },
  retry: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    marginTop: spacing.md,
    borderRadius: radius.sm,
    backgroundColor: colors.tealSoft,
  },
  retryText: { fontSize: 14, fontWeight: '700', color: colors.teal },
  deleteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    marginTop: -spacing.xs,
    marginBottom: spacing.md,
  },
  deleteRowText: { fontSize: 12, fontWeight: '700', color: colors.red },
  editorBody: { padding: spacing.lg, paddingBottom: spacing.xxl },
  editorTitle: { fontSize: 20, fontWeight: '800', color: colors.ink },
  editorMeta: { fontSize: 12, color: colors.muted, marginTop: spacing.xs, marginBottom: spacing.lg, lineHeight: 16 },
  aiPanel: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.lg,
    marginBottom: spacing.md,
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
  sectionTitle: { fontSize: 16, fontWeight: '700', color: colors.ink, marginTop: spacing.lg, marginBottom: spacing.xs },
  sectionHint: { fontSize: 12, color: colors.muted, lineHeight: 16, marginBottom: spacing.sm },
  field: { marginBottom: spacing.sm },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: colors.muted, marginBottom: spacing.xs },
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
  textInput: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.sm,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    minHeight: 48,
    fontSize: 16,
    color: colors.ink,
  },
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
  editorPhoto: { width: '100%', height: 160, borderRadius: radius.md, marginBottom: spacing.sm },
  removePhoto: {
    minHeight: 44, justifyContent: 'center', alignItems: 'center',
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.red,
  },
  removePhotoActive: { backgroundColor: colors.redSoft },
  removePhotoText: { fontSize: 13, fontWeight: '700', color: colors.red },
  removePhotoTextActive: { fontWeight: '900' },
  message: { fontSize: 13, color: colors.navy, marginTop: spacing.md, lineHeight: 18 },
  editorActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xl },
  secondaryButton: {
    minHeight: 52,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  secondaryButtonText: { fontSize: 15, fontWeight: '600', color: colors.muted },
  primaryButton: {
    flex: 1,
    minHeight: 52,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.md,
    backgroundColor: colors.teal,
  },
  primaryButtonText: { fontSize: 16, fontWeight: '700', color: colors.surface },
  disabled: { opacity: 0.5 },
});
