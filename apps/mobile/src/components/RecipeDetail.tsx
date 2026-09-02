import { useEffect, useMemo, useState } from 'react';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Alert, Image, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

// Subpath, nunca el barrel: Metro no hace tree-shaking (ver `/iconography`).
import Camera from 'lucide-react-native/icons/camera';
import ImageIcon from 'lucide-react-native/icons/image';
import Plus from 'lucide-react-native/icons/plus';
import Trash2 from 'lucide-react-native/icons/trash-2';
import UtensilsCrossed from 'lucide-react-native/icons/utensils-crossed';

import {
  addRecipeItem,
  defaultItemGrams,
  foodKey,
  isEmptyRecipe,
  isListedFood,
  isValidRecipeItemGrams,
  MAX_RECIPE_ITEM_GRAMS,
  MIN_RECIPE_ITEM_GRAMS,
  recipeTotals,
  removeRecipeItem,
  scaleCatalogFood,
  setRecipeItemGrams,
  type CatalogFood,
  type Recipe,
  type RecipeItem,
} from '@type1a/domain';

import { parseNonNegativeNumber } from '../format';
import { logSaveError } from '../log';
import { colors, radius, spacing } from '../theme';
import { FoodCard, MacroChipRow } from './FoodCard';

const numberText = (value: number): string => String(Number(value.toFixed(1)));

/**
 * El detalle de una receta: qué la compone, cuánto suma, y cómo se corrige.
 *
 * ## Dónde vive
 *
 * **Reemplaza la lista del catálogo, no se apila encima**, igual que
 * `FoodEditor`: un modal sobre un modal en Android deja el de abajo capturando
 * toques (ya pasó con el detalle del Timeline y el editor de comida).
 *
 * ## Lo que muestra y lo que decide
 *
 * - Los totales son **la misma fila de chips** que la tarjeta del catálogo
 *   (`MacroChipRow`) y salen de `recipeTotals` contra el catálogo vivo: acá no
 *   se suma nada. Corregir el arroz corrige este plato sin tocarlo.
 * - Cada componente es una `FoodCard` con sus gramos **en esta receta**, no su
 *   porción del catálogo: son cosas distintas y la leyenda lo dice.
 * - Un componente guardado con "solo receta" está marcado como tal y desde acá
 *   se puede **mostrar en el catálogo**. Es la salida de esa elección.
 * - La composición se edita en local y se guarda con un botón: es una sola
 *   escritura (`updateRecipeItems`) y no una por toque, así que un error a
 *   mitad de camino no deja la receta a medias.
 *
 * ## Fronteras
 *
 * Suma gramos de alimento. No calcula ni sugiere insulina; lo que sale de acá
 * sigue siendo **estimación** hasta que ella la confirma en una comida. La foto
 * es representación del plato, nunca evidencia de macros: cambiarla no
 * re-analiza nada.
 */

export interface RecipeDetailActions {
  onRename: (recipeId: string, name: string) => Promise<void>;
  /** `null` quita la foto. */
  onPhoto: (recipeId: string, imageUri: string | null) => Promise<void>;
  onSaveItems: (recipeId: string, items: RecipeItem[]) => Promise<void>;
  /** Sacar a la luz un componente guardado con "solo receta". */
  onListFood: (key: string) => Promise<void>;
  onDelete: (recipe: Recipe) => Promise<void>;
  /** Llevar la receta al carrito de una comida nueva. */
  onUseInMeal: (recipe: Recipe) => void;
}

export function RecipeDetail({
  recipe,
  catalog,
  actions,
  onBack,
}: {
  recipe: Recipe;
  /** Catálogo entero, ocultos incluidos: los componentes pueden estarlo. */
  catalog: readonly CatalogFood[];
  actions: RecipeDetailActions;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState<Recipe>(recipe);
  const [name, setName] = useState(recipe.name);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [gramsText, setGramsText] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Si la receta cambia por fuera (se guardó, se listó un componente), el
  // borrador arranca de nuevo desde lo guardado.
  useEffect(() => {
    setDraft(recipe);
    setName(recipe.name);
    setEditingKey(null);
    setMessage(null);
  }, [recipe]);

  const foodsByKey = useMemo(() => new Map(catalog.map((food) => [food.key, food])), [catalog]);
  const totals = useMemo(() => recipeTotals(draft, foodsByKey), [draft, foodsByKey]);
  const dirty = JSON.stringify(draft.items) !== JSON.stringify(recipe.items);

  const results = useMemo(() => {
    const term = foodKey(search);
    if (term === '') return [];
    const inRecipe = new Set(draft.items.map((item) => item.foodKey));
    return catalog.filter((food) => !inRecipe.has(food.key) && food.key.includes(term)).slice(0, 6);
  }, [catalog, draft.items, search]);

  async function run(label: string, work: () => Promise<void>, ok: string): Promise<void> {
    setMessage(null);
    setBusy(true);
    try {
      await work();
      setMessage(ok);
    } catch (error) {
      logSaveError(`RecipeDetail.${label}`, error);
      setMessage(error instanceof Error ? error.message : 'No se pudo guardar. La receta sigue como estaba.');
    } finally {
      setBusy(false);
    }
  }

  function applyGrams(): void {
    if (editingKey === null) return;
    const value = parseNonNegativeNumber(gramsText.trim());
    if (value === null || !isValidRecipeItemGrams(value)) {
      setMessage(`Los gramos van de ${MIN_RECIPE_ITEM_GRAMS} a ${MAX_RECIPE_ITEM_GRAMS}.`);
      return;
    }
    setDraft((prev) => setRecipeItemGrams(prev, editingKey, value));
    setEditingKey(null);
    setMessage(null);
  }

  async function pickPhoto(from: 'camera' | 'library'): Promise<void> {
    setMessage(null);
    if (from === 'camera') {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setMessage('No hay permiso de cámara. Puedes elegir una imagen de la galería.');
        return;
      }
    }
    const picked = from === 'camera'
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], allowsEditing: true, exif: false, quality: 1 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, exif: false, quality: 1 });
    if (picked.canceled) return;
    await run('photo', async () => {
      const asset = picked.assets[0]!;
      // Mismo tamaño y compresión que el resto de la app; `exif: false` y el
      // re-render dejan la imagen sin metadatos.
      const context = ImageManipulator.ImageManipulator.manipulate(asset.uri);
      context.resize({ width: 1280, height: null });
      const rendered = await context.renderAsync();
      const compressed = await rendered.saveAsync({ compress: 0.72, format: ImageManipulator.SaveFormat.JPEG });
      await actions.onPhoto(recipe.id, compressed.uri);
    }, 'Foto guardada.');
  }

  function confirmDelete(): void {
    Alert.alert(
      `Borrar ${recipe.name}`,
      'Se borra el plato. Los alimentos que solo existían dentro de esta receta se van con ella; los que están en tu catálogo siguen ahí. Las comidas ya registradas no se tocan.',
      [
        { text: 'Cancelar', style: 'cancel' },
        { text: 'Borrar', style: 'destructive', onPress: () => { void run('delete', () => actions.onDelete(recipe), 'Receta borrada.'); } },
      ],
    );
  }

  return (
    <View>
      <Pressable style={styles.back} onPress={onBack} accessibilityRole="button" accessibilityLabel="Volver al catálogo">
        <Text style={styles.backText}>‹ Catálogo</Text>
      </Pressable>

      {/* Foto del plato: representación, no evidencia. */}
      <View style={styles.hero}>
        {recipe.imageUri === undefined ? (
          <View style={[styles.photo, styles.photoEmpty]} accessible accessibilityLabel={`${recipe.name}, sin foto`}>
            <UtensilsCrossed size={28} color={colors.muted} />
          </View>
        ) : (
          <Image source={{ uri: recipe.imageUri }} style={styles.photo} resizeMode="cover" accessible accessibilityLabel={`Foto de ${recipe.name}`} />
        )}
        <View style={styles.photoActions}>
          <Pressable style={styles.iconButton} onPress={() => { void pickPhoto('camera'); }} accessibilityRole="button" accessibilityLabel="Tomar foto del plato" disabled={busy}>
            <Camera size={18} color={colors.navy} />
            <Text style={styles.iconButtonText}>Cámara</Text>
          </Pressable>
          <Pressable style={styles.iconButton} onPress={() => { void pickPhoto('library'); }} accessibilityRole="button" accessibilityLabel="Elegir foto de la galería" disabled={busy}>
            <ImageIcon size={18} color={colors.navy} />
            <Text style={styles.iconButtonText}>Galería</Text>
          </Pressable>
          {recipe.imageUri === undefined ? null : (
            <Pressable style={styles.iconButton} onPress={() => { void run('removePhoto', () => actions.onPhoto(recipe.id, null), 'Foto quitada.'); }} accessibilityRole="button" accessibilityLabel="Quitar la foto" disabled={busy}>
              <Text style={styles.iconButtonText}>Quitar foto</Text>
            </Pressable>
          )}
        </View>
      </View>

      <Text style={styles.label}>Nombre del plato</Text>
      <View style={styles.nameRow}>
        <TextInput
          value={name}
          onChangeText={setName}
          style={styles.nameInput}
          placeholder="Nombre de la receta"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Nombre de la receta"
        />
        {name.trim() !== recipe.name ? (
          <Pressable
            style={[styles.secondary, busy && styles.disabled]}
            disabled={busy}
            onPress={() => { void run('rename', () => actions.onRename(recipe.id, name.trim()), 'Nombre guardado.'); }}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryText}>Guardar nombre</Text>
          </Pressable>
        ) : null}
      </View>

      {/* Totales: la MISMA fila que la tarjeta, derivada del catálogo vivo. */}
      <View style={styles.totals}>
        <Text style={styles.totalsTitle}>Un plato · {numberText(totals.grams)} g</Text>
        <MacroChipRow
          macros={{ carbsG: totals.carbsG, proteinG: totals.proteinG, fatG: totals.fatG, fiberG: totals.fiberG, caloriesKcal: totals.caloriesKcal }}
          caption={dirty ? 'Total con los cambios sin guardar' : 'Total de la receta completa, sumado de sus alimentos'}
        />
        {totals.missingFoodKeys.length === 0 ? null : (
          <Text style={styles.warn}>
            {totals.missingFoodKeys.length} {totals.missingFoodKeys.length === 1 ? 'alimento ya no está' : 'alimentos ya no están'} en el
            catálogo, así que este total es un mínimo. Quítalo de la receta o vuelve a guardarlo.
          </Text>
        )}
        <Text style={styles.foot}>
          Los macros no se guardan: son siempre la suma de los alimentos de abajo. Sigue siendo una estimación;
          los carbohidratos los confirmas tú en cada comida.
        </Text>
      </View>

      <Text style={styles.sectionTitle}>Lo que lleva</Text>
      {draft.items.map((item) => {
        const food = foodsByKey.get(item.foodKey);
        const hidden = food !== undefined && !isListedFood(food);
        const scaled = food === undefined ? null : scaleCatalogFood(food, item.grams);
        const editing = editingKey === item.foodKey;
        return (
          <View key={item.foodKey}>
            <FoodCard
              name={food?.name ?? item.foodKey}
              subtitle={`${numberText(item.grams)} g en este plato${hidden ? ' · solo en esta receta' : ''}${food === undefined ? ' · ya no está en el catálogo' : ''}`}
              {...(food?.imageUri === undefined ? {} : { imageUri: food.imageUri })}
              macros={scaled === null
                ? {}
                : { carbsG: scaled.carbsG, proteinG: scaled.proteinG, fatG: scaled.fatG, fiberG: scaled.fiberG, caloriesKcal: scaled.caloriesKcal }}
              macrosCaption={`Macros de esos ${numberText(item.grams)} g`}
              action={{
                kind: 'edit',
                label: `Editar ${food?.name ?? item.foodKey} en la receta`,
                onPress: () => { setEditingKey(editing ? null : item.foodKey); setGramsText(numberText(item.grams)); setMessage(null); },
              }}
            />
            {editing ? (
              <View style={styles.lineEdit}>
                <Text style={styles.label}>Gramos en este plato</Text>
                <View style={styles.inputWrap}>
                  <TextInput
                    value={gramsText}
                    onChangeText={setGramsText}
                    keyboardType="decimal-pad"
                    style={styles.input}
                    selectTextOnFocus
                    accessibilityLabel={`Gramos de ${food?.name ?? item.foodKey} en la receta`}
                  />
                  <Text style={styles.unit}>g</Text>
                </View>
                <View style={styles.row}>
                  <Pressable style={styles.secondary} onPress={applyGrams} accessibilityRole="button">
                    <Text style={styles.secondaryText}>Aplicar</Text>
                  </Pressable>
                  <Pressable
                    style={styles.dangerOutline}
                    onPress={() => { setDraft((prev) => removeRecipeItem(prev, item.foodKey)); setEditingKey(null); }}
                    accessibilityRole="button"
                  >
                    <Text style={styles.dangerOutlineText}>Quitar de la receta</Text>
                  </Pressable>
                  {hidden ? (
                    <Pressable
                      style={[styles.secondary, busy && styles.disabled]}
                      disabled={busy}
                      onPress={() => { void run('list', () => actions.onListFood(item.foodKey), `${food?.name ?? item.foodKey} ahora aparece en tu catálogo.`); }}
                      accessibilityRole="button"
                    >
                      <Text style={styles.secondaryText}>Mostrar en el catálogo</Text>
                    </Pressable>
                  ) : null}
                </View>
              </View>
            ) : null}
          </View>
        );
      })}
      {isEmptyRecipe(draft) ? (
        <Text style={styles.warn}>Sin alimentos no se puede guardar: una receta vacía se leería como "este plato no tiene nada". Agrega uno o borra la receta.</Text>
      ) : null}

      <Text style={styles.sectionTitle}>Agregar un alimento</Text>
      <TextInput
        value={search}
        onChangeText={setSearch}
        style={styles.nameInput}
        placeholder="Buscar en tu catálogo"
        placeholderTextColor={colors.muted}
        accessibilityLabel="Buscar un alimento para agregar a la receta"
      />
      {results.map((food) => (
        <Pressable
          key={food.key}
          style={styles.result}
          onPress={() => { setDraft((prev) => addRecipeItem(prev, food.key, defaultItemGrams(food))); setSearch(''); setMessage(null); }}
          accessibilityRole="button"
          accessibilityLabel={`Agregar ${food.name} a la receta`}
        >
          <Plus size={16} color={colors.teal} />
          <View style={{ flex: 1 }}>
            <Text style={styles.resultName}>{food.name}</Text>
            <Text style={styles.resultMeta}>Entra con {numberText(defaultItemGrams(food))} g; lo cambias después.</Text>
          </View>
        </Pressable>
      ))}
      {foodKey(search) !== '' && results.length === 0 ? <Text style={styles.foot}>Nada con ese nombre.</Text> : null}

      {message === null ? null : <Text style={styles.message}>{message}</Text>}

      {dirty ? (
        <Pressable
          style={[styles.primary, (busy || isEmptyRecipe(draft)) && styles.disabled]}
          disabled={busy || isEmptyRecipe(draft)}
          onPress={() => { void run('items', () => actions.onSaveItems(recipe.id, draft.items), 'Receta guardada.'); }}
          accessibilityRole="button"
        >
          <Text style={styles.primaryText}>{busy ? 'Guardando…' : 'Guardar cambios de la receta'}</Text>
        </Pressable>
      ) : (
        <Pressable
          style={[styles.primary, busy && styles.disabled]}
          disabled={busy}
          onPress={() => { actions.onUseInMeal(recipe); }}
          accessibilityRole="button"
        >
          <Text style={styles.primaryText}>Usar en una comida</Text>
        </Pressable>
      )}
      {dirty ? (
        <Pressable style={styles.link} onPress={() => { setDraft(recipe); setEditingKey(null); setMessage(null); }} accessibilityRole="button">
          <Text style={styles.linkText}>Descartar cambios</Text>
        </Pressable>
      ) : null}

      <Pressable style={styles.deleteRow} onPress={confirmDelete} accessibilityRole="button" accessibilityLabel={`Borrar la receta ${recipe.name}`} hitSlop={8}>
        <Trash2 size={16} color={colors.red} />
        <Text style={styles.deleteRowText}>Borrar receta</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  back: { minHeight: 44, justifyContent: 'center' },
  backText: { color: colors.teal, fontSize: 14, fontWeight: '800' },
  hero: { alignItems: 'center', marginTop: spacing.sm },
  photo: { width: 160, height: 160, borderRadius: radius.md, backgroundColor: colors.background },
  photoEmpty: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line },
  photoActions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: spacing.sm, marginTop: spacing.sm },
  iconButton: {
    minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.md,
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface,
  },
  iconButtonText: { color: colors.navy, fontSize: 12, fontWeight: '800' },
  label: { color: colors.navy, fontSize: 12, fontWeight: '800', marginTop: spacing.md },
  nameRow: { gap: spacing.sm },
  nameInput: {
    color: colors.ink, fontSize: 15, fontWeight: '700', backgroundColor: colors.surface, borderRadius: radius.sm,
    borderColor: colors.line, borderWidth: 1, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    marginTop: 6, minHeight: 44,
  },
  totals: {
    backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line,
    padding: spacing.md, marginTop: spacing.lg,
  },
  totalsTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  foot: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: spacing.sm },
  warn: { color: colors.warning, backgroundColor: colors.warningSoft, borderRadius: radius.sm, padding: spacing.sm, fontSize: 12, lineHeight: 17, marginTop: spacing.sm },
  sectionTitle: { color: colors.ink, fontSize: 16, fontWeight: '800', marginTop: spacing.lg, marginBottom: spacing.sm },
  lineEdit: {
    backgroundColor: colors.tealSoft, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm, marginTop: -spacing.xs,
  },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.sm,
    borderColor: colors.line, borderWidth: 1, marginTop: 6, paddingHorizontal: spacing.md,
  },
  input: { color: colors.ink, fontSize: 18, fontWeight: '800', flex: 1, paddingVertical: spacing.sm, minHeight: 44 },
  unit: { color: colors.muted, fontSize: 13, marginLeft: 4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  secondary: {
    minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.md,
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.teal, backgroundColor: colors.surface,
  },
  secondaryText: { color: colors.teal, fontSize: 13, fontWeight: '800' },
  dangerOutline: {
    minHeight: 44, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.md,
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.red, backgroundColor: colors.surface,
  },
  dangerOutlineText: { color: colors.red, fontSize: 13, fontWeight: '800' },
  result: {
    minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm,
    borderBottomWidth: 1, borderBottomColor: colors.line,
  },
  resultName: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  resultMeta: { color: colors.muted, fontSize: 11, marginTop: 2 },
  message: { color: colors.navy, backgroundColor: colors.tealSoft, borderRadius: radius.sm, padding: spacing.md, fontSize: 13, lineHeight: 19, marginTop: spacing.md },
  primary: { backgroundColor: colors.teal, borderRadius: radius.md, padding: spacing.lg, alignItems: 'center', marginTop: spacing.xl, minHeight: 44, justifyContent: 'center' },
  primaryText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  link: { minHeight: 44, justifyContent: 'center', alignItems: 'center', marginTop: spacing.sm },
  linkText: { color: colors.teal, fontSize: 13, fontWeight: '700' },
  deleteRow: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: spacing.lg, marginBottom: spacing.xl },
  deleteRowText: { color: colors.red, fontSize: 13, fontWeight: '800' },
  disabled: { opacity: 0.55 },
});
