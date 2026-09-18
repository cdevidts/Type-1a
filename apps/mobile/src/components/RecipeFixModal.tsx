import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import {
  findSimilarFood,
  recipeTotals,
  type CatalogFood,
  type Recipe,
  type RecipeFixAction,
  type RecipeFixPlan,
} from '@type1a/domain';

import { logSaveError } from '../log';
import { colors, radius, spacing } from '../theme';
import { ModalShell } from './ModalShell';

const numberText = (value: number): string => String(Number(value.toFixed(1)));

/**
 * Resolver las recetas que usan un alimento antes de poder borrarlo.
 *
 * ## Por qué existe
 *
 * Borrar un alimento que una receta usa está **bloqueado** (decisión de
 * producto): la cascada cambiaría recetas a espaldas de la usuaria, y congelar
 * los totales dejaría una suma imposible de verificar. Pero "no se puede
 * borrar" a secas es un callejón — esta pantalla es la salida.
 *
 * ## Las tres salidas por receta
 *
 * 1. **Cambiarlo por otro**, conservando los gramos. Los gramos son del plato,
 *    no del alimento: sustituir arroz blanco por integral no cambia cuánto hay
 *    en el plato. Si la receta ya contenía al reemplazo, las dos líneas se
 *    funden.
 * 2. **Sacarlo del plato.** Si era el último componente, la receta se borra con
 *    la misma acción: una receta vacía se leería como "este plato no tiene
 *    nada", que no es lo mismo que "no sé qué tiene".
 * 3. **Dejarla como está.**
 *
 * ## La regla dura: todo o nada
 *
 * Si queda **una sola** receta en "dejar como está", el alimento no se borra, y
 * la pantalla lo dice antes de que ella toque nada. Resolver a medias es cómo
 * se llega a un total que nadie puede reproducir. La decisión vive en
 * `applyRecipeFixPlan` (pura y con test); acá solo se elige.
 *
 * ## Qué hace la IA acá
 *
 * **Propone un sustituto**, nunca lo aplica: `findSimilarFood` busca en el
 * catálogo el alimento más parecido al que se va a borrar y lo ofrece
 * preseleccionado, con su razón escrita. Emparejar mal mezcla macros de dos
 * alimentos distintos, así que la confirmación es de ella.
 */

/** Un sustituto ofrecido, con por qué se ofrece. */
interface Suggestion {
  food: CatalogFood;
  why: string;
}

function suggestionsFor(
  target: CatalogFood,
  catalog: readonly CatalogFood[],
): Suggestion[] {
  const others = catalog.filter((food) => food.key !== target.key);
  const out: Suggestion[] = [];
  const seen = new Set<string>();

  // 1. El más parecido por nombre, si lo hay.
  const similar = findSimilarFood(target.name, others);
  if (similar !== null) {
    out.push({ food: similar.food, why: 'se parece por nombre' });
    seen.add(similar.food.key);
  }
  // 2. Los de macros más cercanos: sustituir un alimento por otro de perfil
  //    parecido es lo que menos mueve el total de la receta. Se compara solo
  //    con carbohidratos y calorías porque son los dos que la usuaria mira.
  const byDistance = [...others]
    .filter((food) => !seen.has(food.key))
    .map((food) => ({
      food,
      distance: Math.abs(food.carbsPer100g - target.carbsPer100g)
        + Math.abs(food.kcalPer100g - target.kcalPer100g) / 10,
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 4);
  for (const { food } of byDistance) out.push({ food, why: 'macros parecidos' });
  return out;
}

export function RecipeFixModal({
  visible,
  food,
  recipes,
  catalog,
  onClose,
  onResolve,
}: {
  visible: boolean;
  /** El alimento que se intentó borrar. `null` cierra la pantalla. */
  food: CatalogFood | null;
  /** Solo las recetas que lo usan. */
  recipes: readonly Recipe[];
  /** Catálogo completo, para ofrecer sustitutos. */
  catalog: readonly CatalogFood[];
  onClose: () => void;
  onResolve: (plans: RecipeFixPlan[]) => Promise<void>;
}) {
  const [actions, setActions] = useState<Record<string, RecipeFixAction>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setActions({});
    setMessage(null);
    setBusy(false);
  }, [visible, food]);

  const foodsByKey = useMemo(
    () => new Map(catalog.map((item) => [item.key, item])),
    [catalog],
  );
  const suggestions = useMemo(
    () => (food === null ? [] : suggestionsFor(food, catalog)),
    [food, catalog],
  );

  if (food === null) return null;

  // Sin decisión explícita se conserva: nada se toca por omisión.
  const decided = recipes.filter((recipe) => {
    const action = actions[recipe.id];
    return action !== undefined && action.kind !== 'keep';
  });
  const canDelete = decided.length === recipes.length && recipes.length > 0;

  async function resolve(): Promise<void> {
    setMessage(null);
    setBusy(true);
    try {
      await onResolve(recipes.map((recipe) => ({
        recipeId: recipe.id,
        action: actions[recipe.id] ?? { kind: 'keep' as const },
      })));
      onClose();
    } catch (error) {
      logSaveError('RecipeFixModal.resolve', error);
      setMessage('No se pudo aplicar. Nada cambió: tus recetas y el alimento siguen como estaban.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell visible={visible} title={`Borrar "${food.name}"`} onClose={onClose}>
      <Text style={styles.intro}>
        {recipes.length === 1
          ? 'Una receta usa este alimento. Decide qué hacer con ella y podrás borrarlo.'
          : `${recipes.length} recetas usan este alimento. Decide qué hacer con cada una y podrás borrarlo.`}
      </Text>
      <Text style={styles.rule}>
        Es todo o nada: si dejas alguna receta como está, el alimento no se borra. Así ninguna receta
        queda con una suma que no se puede verificar.
      </Text>

      {recipes.map((recipe) => {
        const action = actions[recipe.id] ?? { kind: 'keep' as const };
        const totals = recipeTotals(recipe, foodsByKey);
        const mine = recipe.items.find((item) => item.foodKey === food.key);
        const lastOne = recipe.items.length === 1;
        const set = (next: RecipeFixAction): void => {
          setActions((prev) => ({ ...prev, [recipe.id]: next }));
        };
        return (
          <View key={recipe.id} style={styles.card}>
            <Text style={styles.name}>{recipe.name}</Text>
            <Text style={styles.detail}>
              {recipe.items.length} {recipe.items.length === 1 ? 'alimento' : 'alimentos'} ·{' '}
              {numberText(totals.grams)} g · {numberText(totals.carbsG)} g de carbos
            </Text>
            {mine === undefined ? null : (
              <Text style={styles.detail}>
                Lleva {numberText(mine.grams)} g de {food.name}.
              </Text>
            )}

            <View style={styles.choices}>
              <Pressable
                style={[styles.choice, action.kind === 'replace' && styles.choiceOn]}
                onPress={() => {
                  const first = suggestions[0];
                  set(first === undefined
                    ? { kind: 'remove' }
                    : { kind: 'replace', toFoodKey: first.food.key });
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: action.kind === 'replace' }}
                disabled={suggestions.length === 0}
              >
                <Text style={[styles.choiceText, action.kind === 'replace' && styles.choiceTextOn]}>
                  Cambiarlo por otro
                </Text>
              </Pressable>
              <Pressable
                style={[styles.choice, action.kind === 'remove' && styles.choiceOn]}
                onPress={() => { set({ kind: 'remove' }); }}
                accessibilityRole="button"
                accessibilityState={{ selected: action.kind === 'remove' }}
              >
                <Text style={[styles.choiceText, action.kind === 'remove' && styles.choiceTextOn]}>
                  {lastOne ? 'Borrar la receta' : 'Sacarlo del plato'}
                </Text>
              </Pressable>
              <Pressable
                style={[styles.choice, action.kind === 'keep' && styles.choiceOn]}
                onPress={() => { set({ kind: 'keep' }); }}
                accessibilityRole="button"
                accessibilityState={{ selected: action.kind === 'keep' }}
              >
                <Text style={[styles.choiceText, action.kind === 'keep' && styles.choiceTextOn]}>
                  Dejarla como está
                </Text>
              </Pressable>
            </View>

            {action.kind === 'replace' ? (
              <View style={styles.substitutes}>
                <Text style={styles.subsTitle}>Cambiarlo por</Text>
                {suggestions.map((suggestion) => {
                  const chosen = action.toFoodKey === suggestion.food.key;
                  return (
                    <Pressable
                      key={suggestion.food.key}
                      style={[styles.sub, chosen && styles.subOn]}
                      onPress={() => { set({ kind: 'replace', toFoodKey: suggestion.food.key }); }}
                      accessibilityRole="button"
                      accessibilityState={{ selected: chosen }}
                    >
                      <Text style={[styles.subName, chosen && styles.subNameOn]}>
                        {chosen ? '✓ ' : ''}{suggestion.food.name}
                      </Text>
                      {/* La razón va escrita: una propuesta de la IA que no
                          explica por qué es una propuesta que no se puede juzgar. */}
                      <Text style={styles.subWhy}>
                        {suggestion.why} · {numberText(suggestion.food.carbsPer100g)} g carbos/100 g
                      </Text>
                    </Pressable>
                  );
                })}
                <Text style={styles.keepGrams}>
                  Se conservan los {mine === undefined ? '' : `${numberText(mine.grams)} `}g del plato: los
                  gramos son de la receta, no del alimento.
                </Text>
              </View>
            ) : action.kind === 'remove' && lastOne ? (
              <Text style={styles.warn}>
                Era su único alimento, así que la receta se borra. Tus comidas ya registradas no cambian.
              </Text>
            ) : null}
          </View>
        );
      })}

      {suggestions.length === 0 ? (
        <Text style={styles.warn}>
          No hay otros alimentos en el catálogo para ofrecer como cambio. Puedes sacarlo del plato o dejar
          las recetas como están.
        </Text>
      ) : null}

      {message === null ? null : <Text style={styles.message}>{message}</Text>}

      <Text style={styles.status}>
        {canDelete
          ? `Se resolvieron las ${recipes.length === 1 ? 'receta' : `${recipes.length} recetas`} y el alimento se borrará.`
          : `Falta decidir ${recipes.length - decided.length} de ${recipes.length}. El alimento NO se borrará.`}
      </Text>

      <Pressable
        style={[styles.save, busy && styles.disabled]}
        disabled={busy}
        onPress={() => { void resolve(); }}
        accessibilityRole="button"
      >
        <Text style={styles.saveText}>
          {busy ? 'Aplicando…' : canDelete ? 'Aplicar y borrar el alimento' : 'Aplicar solo los cambios de recetas'}
        </Text>
      </Pressable>
      <Pressable style={styles.link} onPress={onClose} accessibilityRole="button">
        <Text style={styles.linkText}>Cancelar · no cambiar nada</Text>
      </Pressable>
      {/* `ScrollView` vacío para que el último botón no quede pegado al borde
          inferior en pantallas cortas; `ModalShell` ya hace scroll. */}
      <ScrollView style={styles.tail} />
    </ModalShell>
  );
}

const styles = StyleSheet.create({
  intro: { color: colors.ink, fontSize: 14, lineHeight: 20, marginTop: spacing.md, fontWeight: '700' },
  rule: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: spacing.sm },
  card: {
    backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line,
    padding: spacing.md, marginTop: spacing.md,
  },
  name: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  detail: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 3 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.md },
  choice: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md,
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.background,
  },
  choiceOn: { borderColor: colors.teal, backgroundColor: colors.tealSoft },
  choiceText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  choiceTextOn: { color: colors.navy, fontWeight: '900' },
  substitutes: { marginTop: spacing.md },
  subsTitle: { color: colors.navy, fontSize: 12, fontWeight: '800' },
  sub: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, marginTop: 6,
  },
  subOn: { borderColor: colors.teal, backgroundColor: colors.tealSoft },
  subName: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  subNameOn: { color: colors.navy, fontWeight: '900' },
  subWhy: { color: colors.muted, fontSize: 11, marginTop: 2 },
  keepGrams: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: spacing.sm },
  warn: { color: colors.warning, fontSize: 12, lineHeight: 18, marginTop: spacing.sm },
  message: { color: colors.warning, backgroundColor: colors.warningSoft, borderRadius: radius.sm, padding: spacing.md, fontSize: 13, lineHeight: 19, marginTop: spacing.md },
  status: { color: colors.navy, fontSize: 13, fontWeight: '800', lineHeight: 19, marginTop: spacing.lg },
  save: { backgroundColor: colors.teal, borderRadius: radius.md, padding: spacing.lg, alignItems: 'center', marginTop: spacing.md, minHeight: 44, justifyContent: 'center' },
  saveText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  link: { minHeight: 44, justifyContent: 'center', alignItems: 'center', marginTop: spacing.sm },
  linkText: { color: colors.teal, fontSize: 13, fontWeight: '700' },
  disabled: { opacity: 0.55 },
  tail: { height: spacing.xl },
});
