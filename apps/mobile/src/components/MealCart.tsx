import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import Search from 'lucide-react-native/icons/search';

import {
  addCartLine,
  cartCompletenessNote,
  cartLineTotals,
  cartTotals,
  foodKey,
  isListedFood,
  isValidCartQuantity,
  MAX_SERVINGS,
  MIN_SERVINGS,
  recipeToCartLines,
  recipeTotals,
  removeCartLine,
  servingGramsOf,
  updateCartLineQuantity,
  type CartLine,
  type CartPortionMode,
  type CatalogFood,
  type Recipe,
} from '@type1a/domain';

import { colors, radius, spacing } from '../theme';
import { FoodCard } from './FoodCard';

/**
 * El carrito multi-alimento.
 *
 * ## Qué reemplaza
 *
 * `CatalogQuickAdd` elegía **un** alimento: guardaba un `pendingFood` y el
 * segundo reemplazaba al primero. Armar un sándwich —pan, queso y jamón—
 * obligaba a sumar de cabeza o a registrar tres comidas, que después el
 * timeline muestra como tres acontecimientos.
 *
 * ## La frontera que no se cruza
 *
 * **El total del carrito es una estimación.** El catálogo es una media de
 * estimaciones de IA (`food-catalog.ts`), así que sus carbohidratos tienen
 * exactamente el mismo estatus que los de una foto y `AGENTS.md` prohíbe que
 * se confirmen solos. Este componente **nunca escribe** el campo de
 * carbohidratos confirmados: ofrece un botón —"Usar N g como confirmados"—
 * que es un toque de la usuaria, y avisa a quien lo monta para que invalide
 * cualquier dosis calculada con el total anterior.
 *
 * La aritmética entera vive en `packages/domain/src/meal-cart.ts`, con test.
 * Acá no se suma nada: un componente que suma macros es un componente que
 * decide un dato que puede terminar en una dosis.
 */

let cartLineSeq = 0;
/**
 * Id de línea local, no global.
 *
 * No se usa `Crypto.randomUUID` a propósito: esto no persiste ni sale del
 * componente, solo distingue dos líneas del mismo alimento mientras el
 * formulario está abierto.
 */
export function nextCartLineId(): string {
  cartLineSeq += 1;
  return `line-${cartLineSeq}`;
}
const nextLineId = nextCartLineId;

export function MealCart({
  foods,
  recipes = [],
  lines,
  onChange,
  onUseCarbs,
  onMessage,
}: {
  /**
   * El catálogo completo, ocultos incluidos. Se busca solo entre los que
   * están a la vista; los ocultos hacen falta igual para expandir una receta.
   */
  foods: readonly CatalogFood[];
  /**
   * Las recetas, para reusarlas: una receta entra como **una línea por
   * componente**, en gramos, así que después se puede quitar el pollo o poner
   * menos arroz sin inventar un macro para el plato entero.
   */
  recipes?: readonly Recipe[];
  lines: readonly CartLine[];
  onChange: (next: CartLine[]) => void;
  /**
   * La acción explícita: transcribir los carbohidratos del carrito al campo
   * de confirmados. Recibe también el total escalado para que quien guarde
   * pueda conservar la procedencia (`aiEstimatedCarbsG`) del número.
   */
  onUseCarbs: (totals: { carbsG: number; proteinG: number; fatG: number; fiberG: number; caloriesKcal: number }) => void;
  onMessage: (message: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [pending, setPending] = useState<CatalogFood | null>(null);
  const [pendingRecipe, setPendingRecipe] = useState<Recipe | null>(null);
  const [pendingPlates, setPendingPlates] = useState('1');
  const foodsByKey = useMemo(() => new Map(foods.map((food) => [food.key, food])), [foods]);
  const [pendingMode, setPendingMode] = useState<CartPortionMode>('servings');
  const [pendingQuantity, setPendingQuantity] = useState('');
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [editingQuantity, setEditingQuantity] = useState('');
  const [editingMode, setEditingMode] = useState<CartPortionMode>('servings');

  const totals = useMemo(() => cartTotals(lines), [lines]);
  const completeness = cartCompletenessNote(totals);

  /**
   * Búsqueda real sobre todo el catálogo guardado, no los primeros chips.
   * Filtra por la **clave** normalizada, igual que `getCatalogFoods`: así
   * "platano" encuentra "Plátano" sin pedirle acentos a nadie.
   */
  const results = useMemo(() => {
    const term = foodKey(search);
    const listed = foods.filter(isListedFood);
    const matches = term === '' ? listed : listed.filter((food) => food.key.includes(term));
    return matches.slice(0, 12);
  }, [foods, search]);
  const recipeResults = useMemo(() => {
    const term = foodKey(search);
    const matches = term === '' ? recipes : recipes.filter((recipe) => recipe.key.includes(term));
    return matches.slice(0, 6);
  }, [recipes, search]);

  function confirmPendingRecipe(): void {
    if (pendingRecipe === null) return;
    const plates = Number(pendingPlates.trim().replace(',', '.'));
    if (!isValidCartQuantity('servings', plates)) {
      onMessage(`Escribe cuántos platos comiste, entre ${MIN_SERVINGS} y ${MAX_SERVINGS}.`);
      return;
    }
    const { lines: expanded, missingFoodKeys } = recipeToCartLines(pendingRecipe, foodsByKey, plates, nextLineId);
    let next = [...lines];
    for (const line of expanded) next = addCartLine(next, line);
    onChange(next);
    if (missingFoodKeys.length > 0) {
      // Se declara, no se calla: una línea que falta baja los carbohidratos
      // del carrito y ese carrito puede terminar en confirmados.
      onMessage(`${pendingRecipe.name} entró sin ${missingFoodKeys.length} ${missingFoodKeys.length === 1 ? 'alimento que ya no está' : 'alimentos que ya no están'} en el catálogo. El total es un mínimo.`);
    }
    setPendingRecipe(null);
    setPendingPlates('1');
    setSearch('');
  }

  function confirmPending(): void {
    if (pending === null) return;
    const quantity = Number(pendingQuantity.trim().replace(',', '.'));
    if (!isValidCartQuantity(pendingMode, quantity)) {
      onMessage(pendingMode === 'servings'
        ? `Escribe cuántas porciones comiste, entre ${MIN_SERVINGS} y ${MAX_SERVINGS}.`
        : 'Escribe cuántos gramos comiste, entre 1 y 5000.');
      return;
    }
    // `addCartLine`, no un `setState` con el alimento suelto: el bug que este
    // carrito viene a arreglar era exactamente reemplazar en vez de agregar,
    // y la función que acumula está en el dominio con su test.
    onChange(addCartLine(lines, { id: nextLineId(), food: pending, mode: pendingMode, quantity }));
    setPending(null);
    setPendingQuantity('');
    setSearch('');
  }

  function applyLineEdit(line: CartLine): void {
    const quantity = Number(editingQuantity.trim().replace(',', '.'));
    if (!isValidCartQuantity(editingMode, quantity)) {
      onMessage(editingMode === 'servings'
        ? `Las porciones van de ${MIN_SERVINGS} a ${MAX_SERVINGS}.`
        : 'Los gramos deben ser un número entre 1 y 5000.');
      return;
    }
    onChange(updateCartLineQuantity(lines, line.id, editingMode, quantity));
    setEditingLineId(null);
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Lo que sueles comer</Text>
      <Text style={styles.hint}>
        Busca un alimento guardado y agrégalo. Puedes sumar varios: el segundo no reemplaza al primero.
      </Text>

      <View style={styles.searchRow}>
        <Search size={18} color={colors.muted} />
        <TextInput
          style={styles.searchInput}
          value={search}
          onChangeText={(next) => { setSearch(next); setPending(null); }}
          placeholder="Buscar en tu catálogo"
          placeholderTextColor={colors.muted}
          accessibilityLabel="Buscar un alimento del catálogo"
        />
      </View>

      {foods.length === 0 ? (
        <Text style={styles.empty}>
          Todavía no hay alimentos guardados. Aparecen solos cuando la IA identifica una comida desde una foto
          o una descripción; mientras tanto, escribe los macros abajo a mano.
        </Text>
      ) : null}

      {pendingRecipe !== null ? (
        <View style={styles.pendingBox}>
          <Text style={styles.pendingTitle}>{pendingRecipe.name}</Text>
          <Text style={styles.hint}>
            ¿Cuántos platos? Un plato son {recipeTotals(pendingRecipe, foodsByKey).grams.toFixed(0)} g y entra como una línea
            por alimento, así que después puedes ajustar cada uno.
          </Text>
          <View style={styles.quantityRow}>
            <TextInput
              value={pendingPlates}
              onChangeText={setPendingPlates}
              keyboardType="decimal-pad"
              style={styles.quantityInput}
              placeholder={`${MIN_SERVINGS} a ${MAX_SERVINGS}`}
              placeholderTextColor={colors.muted}
              accessibilityLabel="Cuántos platos"
              selectTextOnFocus
            />
            <Text style={styles.quantityUnit}>platos</Text>
            <Pressable style={styles.primary} onPress={confirmPendingRecipe} accessibilityRole="button">
              <Text style={styles.primaryText}>Agregar</Text>
            </Pressable>
            <Pressable style={styles.cancel} onPress={() => { setPendingRecipe(null); }} accessibilityRole="button">
              <Text style={styles.cancelText}>Cancelar</Text>
            </Pressable>
          </View>
        </View>
      ) : pending === null ? (
        <ScrollView style={styles.results} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {results.length === 0 && recipeResults.length === 0 && foods.length > 0 ? (
            <Text style={styles.empty}>Ningún alimento con ese nombre. Prueba con otra palabra.</Text>
          ) : null}
          {recipeResults.map((recipe) => (
            <Pressable
              key={`recipe-${recipe.id}`}
              style={styles.result}
              onPress={() => { setPendingRecipe(recipe); setPendingPlates('1'); }}
              accessibilityRole="button"
              accessibilityLabel={`Agregar la receta ${recipe.name} al carrito`}
            >
              <Text style={styles.resultName}>{recipe.name} <Text style={styles.resultTag}>RECETA</Text></Text>
              <Text style={styles.resultMeta}>
                {recipe.items.length} alimentos · {recipeTotals(recipe, foodsByKey).carbsG} g carbos por plato
              </Text>
            </Pressable>
          ))}
          {results.map((food) => (
            <Pressable
              key={food.key}
              style={styles.result}
              onPress={() => { setPending(food); setPendingQuantity(''); setPendingMode('servings'); }}
              accessibilityRole="button"
              accessibilityLabel={`Agregar ${food.name} al carrito`}
            >
              <Text style={styles.resultName}>{food.name}</Text>
              <Text style={styles.resultMeta}>
                {food.carbsPer100g.toFixed(0)} g carbos/100 g · porción {servingGramsOf(food).toFixed(0)} g
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <View style={styles.pendingBox}>
          <Text style={styles.pendingTitle}>{pending.name}</Text>
          <Text style={styles.hint}>
            {pendingMode === 'servings'
              ? `¿Cuántas porciones? Una porción son ${servingGramsOf(pending).toFixed(0)} g${pending.servingLabel === undefined ? '' : ` (${pending.servingLabel})`}.`
              : '¿Cuántos gramos? Se escala desde la estimación guardada.'}
          </Text>
          <ModeToggle mode={pendingMode} onChange={(next) => { setPendingMode(next); setPendingQuantity(''); }} />
          <View style={styles.quantityRow}>
            <TextInput
              value={pendingQuantity}
              onChangeText={setPendingQuantity}
              keyboardType="decimal-pad"
              style={styles.quantityInput}
              placeholder={pendingMode === 'servings' ? `${MIN_SERVINGS} a ${MAX_SERVINGS}` : 'gramos'}
              placeholderTextColor={colors.muted}
              accessibilityLabel={pendingMode === 'servings' ? 'Cuántas porciones' : 'Cuántos gramos'}
            />
            <Text style={styles.quantityUnit}>{pendingMode === 'servings' ? 'porciones' : 'g'}</Text>
            <Pressable style={styles.primary} onPress={confirmPending} accessibilityRole="button">
              <Text style={styles.primaryText}>Agregar</Text>
            </Pressable>
            <Pressable style={styles.cancel} onPress={() => { setPending(null); }} accessibilityRole="button">
              <Text style={styles.cancelText}>Cancelar</Text>
            </Pressable>
          </View>
        </View>
      )}

      {lines.length === 0 ? null : (
        <View style={styles.cartBox}>
          <Text style={styles.cartTitle}>
            En esta comida · {totals.lineCount} {totals.lineCount === 1 ? 'alimento' : 'alimentos'}
          </Text>
          {lines.map((line) => {
            const lineTotals = cartLineTotals(line);
            const isEditing = editingLineId === line.id;
            return (
              <View key={line.id}>
                <FoodCard
                  name={line.food.name}
                  subtitle={line.mode === 'servings'
                    ? `${line.quantity} ${line.quantity === 1 ? 'porción' : 'porciones'} · ${lineTotals.grams.toFixed(0)} g`
                    : `${lineTotals.grams.toFixed(0)} g`}
                  {...(line.food.imageUri === undefined ? {} : { imageUri: line.food.imageUri })}
                  macros={{
                    carbsG: lineTotals.carbsG,
                    proteinG: lineTotals.proteinG,
                    fatG: lineTotals.fatG,
                    fiberG: lineTotals.fiberG,
                    caloriesKcal: lineTotals.caloriesKcal,
                  }}
                  action={{
                    kind: 'remove',
                    label: `Quitar ${line.food.name} de la comida`,
                    onPress: () => { onChange(removeCartLine(lines, line.id)); setEditingLineId(null); },
                  }}
                />
                {isEditing ? (
                  <View style={styles.lineEdit}>
                    <ModeToggle mode={editingMode} onChange={setEditingMode} />
                    <View style={styles.quantityRow}>
                      <TextInput
                        value={editingQuantity}
                        onChangeText={setEditingQuantity}
                        keyboardType="decimal-pad"
                        style={styles.quantityInput}
                        accessibilityLabel={`Cantidad de ${line.food.name}`}
                      />
                      <Text style={styles.quantityUnit}>{editingMode === 'servings' ? 'porciones' : 'g'}</Text>
                      <Pressable style={styles.primary} onPress={() => { applyLineEdit(line); }} accessibilityRole="button">
                        <Text style={styles.primaryText}>Guardar</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : (
                  <Pressable
                    style={styles.lineEditOpen}
                    onPress={() => {
                      setEditingLineId(line.id);
                      setEditingMode(line.mode);
                      setEditingQuantity(String(line.quantity));
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`Cambiar la cantidad de ${line.food.name}`}
                  >
                    <Text style={styles.lineEditOpenText}>Cambiar cantidad</Text>
                  </Pressable>
                )}
              </View>
            );
          })}

          {/*
            El banner de estimación se queda mientras haya líneas. No es una
            advertencia que se cierra: mientras el número venga del catálogo,
            no es un dato pesado en balanza.
          */}
          <View style={styles.estimateBanner}>
            <Text style={styles.estimateTitle}>Total estimado, no confirmado</Text>
            <Text style={styles.estimateBody}>
              Sale del catálogo, que es una media de estimaciones de IA. Para usarlo como carbohidratos
              confirmados tienes que decirlo tú abajo.
            </Text>
          </View>

          <View style={styles.totalsRow}>
            <Totals label="Carbohidratos" value={`${totals.carbsG} g`} strong />
            <Totals label="Proteína" value={`${totals.proteinG} g`} />
            <Totals label="Grasa" value={`${totals.fatG} g`} />
            <Totals label="Fibra" value={`${totals.fiberG} g`} />
            <Totals label="Calorías" value={`${totals.caloriesKcal} kcal`} />
          </View>

          {completeness === null ? null : <Text style={styles.incomplete}>{completeness}</Text>}

          <Pressable
            style={styles.useButton}
            onPress={() => {
              onUseCarbs({
                carbsG: totals.carbsG,
                proteinG: totals.proteinG,
                fatG: totals.fatG,
                fiberG: totals.fiberG,
                caloriesKcal: totals.caloriesKcal,
              });
            }}
            accessibilityRole="button"
            accessibilityLabel={`Usar ${totals.carbsG} gramos del carrito como carbohidratos confirmados`}
          >
            <Text style={styles.useText}>Usar {totals.carbsG} g como confirmados</Text>
          </Pressable>
          <Text style={styles.useFoot}>
            No se copia solo. Si después cambias el carrito, cualquier dosis que hayas calculado con el total
            anterior deja de valer y hay que recalcularla.
          </Text>
        </View>
      )}
    </View>
  );
}

function ModeToggle({ mode, onChange }: { mode: CartPortionMode; onChange: (next: CartPortionMode) => void }) {
  return (
    <View style={styles.modeToggle}>
      {(['servings', 'grams'] as const).map((option) => (
        <Pressable
          key={option}
          style={[styles.modeOption, mode === option && styles.modeOptionActive]}
          onPress={() => { onChange(option); }}
          accessibilityRole="button"
          accessibilityState={{ selected: mode === option }}
        >
          <Text style={[styles.modeText, mode === option && styles.modeTextActive]}>
            {option === 'servings' ? 'Porciones' : 'Gramos'}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

function Totals({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.totalItem}>
      <Text style={styles.totalLabel}>{label}</Text>
      <Text style={[styles.totalValue, strong && styles.totalValueStrong]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md, borderWidth: 1, borderColor: colors.line },
  title: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  hint: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 2 },
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm,
    backgroundColor: colors.background, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line,
    paddingHorizontal: spacing.md, minHeight: 44,
  },
  searchInput: { flex: 1, fontSize: 15, color: colors.ink, paddingVertical: spacing.sm, minHeight: 44 },
  results: { maxHeight: 180, marginTop: spacing.sm },
  result: { minHeight: 44, justifyContent: 'center', paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  resultName: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  // El tipo va escrito, no solo por estilo: una receta y un alimento no son
  // la misma cosa al tocarlos.
  resultTag: { color: colors.teal, fontSize: 10, fontWeight: '900', letterSpacing: 0.5 },
  resultMeta: { color: colors.muted, fontSize: 11, marginTop: 1 },
  empty: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: spacing.sm },
  pendingBox: { marginTop: spacing.sm, backgroundColor: colors.background, borderRadius: radius.sm, padding: spacing.md },
  pendingTitle: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  modeToggle: { flexDirection: 'row', gap: spacing.xs, marginTop: spacing.sm },
  modeOption: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.lg,
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface,
  },
  modeOptionActive: { backgroundColor: colors.tealSoft, borderColor: colors.teal },
  modeText: { fontSize: 13, fontWeight: '600', color: colors.muted },
  modeTextActive: { color: colors.teal },
  quantityRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm, flexWrap: 'wrap' },
  quantityInput: {
    flex: 1, minWidth: 80, minHeight: 44, backgroundColor: colors.surface, borderRadius: radius.sm,
    borderColor: colors.line, borderWidth: 1, color: colors.ink, fontSize: 15, paddingHorizontal: spacing.md,
  },
  quantityUnit: { color: colors.muted, fontSize: 12 },
  primary: { minHeight: 44, paddingHorizontal: spacing.lg, alignItems: 'center', justifyContent: 'center', borderRadius: radius.sm, backgroundColor: colors.teal },
  primaryText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  cancel: { minHeight: 44, paddingHorizontal: spacing.md, alignItems: 'center', justifyContent: 'center' },
  cancelText: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  cartBox: { marginTop: spacing.lg },
  cartTitle: { color: colors.ink, fontSize: 13, fontWeight: '800', marginBottom: spacing.sm },
  lineEdit: { backgroundColor: colors.background, borderRadius: radius.sm, padding: spacing.md, marginTop: -spacing.xs, marginBottom: spacing.sm },
  lineEditOpen: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.sm, marginTop: -spacing.xs, marginBottom: spacing.sm },
  lineEditOpenText: { color: colors.teal, fontSize: 13, fontWeight: '700' },
  estimateBanner: { backgroundColor: colors.warningSoft, borderRadius: radius.sm, padding: spacing.md, marginTop: spacing.sm },
  estimateTitle: { color: colors.warning, fontSize: 13, fontWeight: '800' },
  estimateBody: { color: colors.warning, fontSize: 11, lineHeight: 16, marginTop: 2 },
  totalsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, marginTop: spacing.md },
  totalItem: { minWidth: 84 },
  totalLabel: { color: colors.muted, fontSize: 10, fontWeight: '800', letterSpacing: 0.3 },
  totalValue: { color: colors.ink, fontSize: 15, fontWeight: '700', marginTop: 1 },
  totalValueStrong: { fontSize: 20, fontWeight: '900' },
  incomplete: { color: colors.warning, fontSize: 12, lineHeight: 17, marginTop: spacing.sm, fontWeight: '700' },
  useButton: { minHeight: 48, borderRadius: radius.sm, backgroundColor: colors.blue, alignItems: 'center', justifyContent: 'center', marginTop: spacing.md },
  useText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  useFoot: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 6 },
});
