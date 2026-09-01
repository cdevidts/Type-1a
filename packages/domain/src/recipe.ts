import { scaleCatalogFood, servingGramsOf, type CatalogFood } from './food-catalog';

/**
 * Una **receta**: un plato con nombre propio que agrupa varios alimentos del
 * catálogo.
 *
 * ## Por qué existe
 *
 * Una foto de arroz con pollo producía dos alimentos sueltos —`arroz` y
 * `pollo`— y **los dos heredaban la foto del plato entero**, así que el
 * catálogo terminaba con un "arroz" cuya miniatura es un plato de arroz con
 * pollo. La receta es el contenedor que faltaba: guarda la foto del plato,
 * y cada componente queda libre de tener la suya.
 *
 * ## La decisión que gobierna el módulo: los totales se DERIVAN
 *
 * Una receta **no guarda macros propios**. Sus números son siempre la suma de
 * sus componentes, calculada al leer.
 *
 * La alternativa —copiar los totales al crearla— parece más fiel a "esto fue
 * lo que midió la IA de ese plato", pero produce dos verdades que divergen: se
 * corrige el `arroz` en el catálogo, y la receta sigue mostrando el número
 * viejo sin que nada delate cuál está bien. Con los totales derivados hay una
 * sola fuente y corregir un componente arregla todas las recetas que lo usan.
 *
 * Consecuencia que hay que aceptar: **el número de una receta puede cambiar
 * con el tiempo**. Es correcto — cambia porque mejoró la estimación de un
 * componente —, y no toca ninguna comida ya registrada: una comida guarda sus
 * propios gramos, no una referencia a la receta.
 *
 * ## Frontera
 *
 * Esto suma gramos de alimento. No calcula, infiere ni sugiere insulina. Lo
 * que salga de acá sigue siendo **estimación**: pasarlo a carbohidratos
 * confirmados es un acto explícito de la usuaria, igual que en el carrito.
 */

export interface RecipeItem {
  /** `food_catalog.key` del componente. */
  foodKey: string;
  /**
   * Cuántos gramos de ese alimento lleva **una porción de la receta**.
   *
   * Se guarda en gramos y no en porciones del componente: la porción de un
   * alimento la puede cambiar la usuaria después, y eso movería en silencio la
   * composición de la receta.
   */
  grams: number;
}

export interface Recipe {
  id: string;
  name: string;
  /** Clave normalizada, para buscar y para no duplicar. */
  key: string;
  items: RecipeItem[];
  /** Foto del plato completo. La de los componentes es aparte, a propósito. */
  imageUri?: string;
  createdAt: string;
  lastSeenAt: string;
  timesSeen: number;
}

/** Los macros de una receta, siempre calculados. Nunca se guardan. */
export interface RecipeTotals {
  grams: number;
  carbsG: number;
  proteinG: number;
  fatG: number;
  fiberG: number;
  caloriesKcal: number;
  /**
   * Componentes que la receta declara pero que **ya no están en el catálogo**.
   *
   * No debería pasar —el borrado está bloqueado justamente para eso— pero un
   * total que ignora en silencio a un componente ausente miente hacia abajo, y
   * en esta app un número que apunta bajo es el que más duele.
   */
  missingFoodKeys: string[];
}

// Un decimal, **la misma precisión que `scaleCatalogFood` y `cartTotals`**.
// No es cosmético: el carrito ya suma los valores por línea *ya redondeados*,
// y el repo tiene escrita la regla de que el mismo plato debe dar el mismo
// número sumado de una forma o de otra. Redondear distinto acá haría que un
// arroz con pollo diera un total como receta y otro como carrito.
const round = (value: number): number => Number(value.toFixed(1));

/**
 * Suma los componentes de una receta contra el catálogo actual.
 *
 * `foodsByKey` es el catálogo vivo: por eso corregir un alimento corrige todas
 * las recetas que lo contienen, sin tocar ninguna fila de receta.
 */
export function recipeTotals(
  recipe: Pick<Recipe, 'items'>,
  foodsByKey: ReadonlyMap<string, CatalogFood>,
): RecipeTotals {
  const totals: RecipeTotals = {
    grams: 0, carbsG: 0, proteinG: 0, fatG: 0, fiberG: 0, caloriesKcal: 0,
    missingFoodKeys: [],
  };
  for (const item of recipe.items) {
    const food = foodsByKey.get(item.foodKey);
    if (food === undefined) {
      totals.missingFoodKeys.push(item.foodKey);
      continue;
    }
    const scaled = scaleCatalogFood(food, item.grams);
    totals.grams += item.grams;
    totals.carbsG += scaled.carbsG;
    totals.proteinG += scaled.proteinG;
    totals.fatG += scaled.fatG;
    totals.fiberG += scaled.fiberG;
    totals.caloriesKcal += scaled.caloriesKcal;
  }
  return {
    grams: round(totals.grams),
    carbsG: round(totals.carbsG),
    proteinG: round(totals.proteinG),
    fatG: round(totals.fatG),
    fiberG: round(totals.fiberG),
    caloriesKcal: Math.round(totals.caloriesKcal),
    missingFoodKeys: totals.missingFoodKeys,
  };
}

/**
 * Qué recetas quedarían rotas al borrar un alimento del catálogo.
 *
 * El borrado se **bloquea** cuando devuelve algo. Las alternativas se
 * descartaron por lo que le hacen a un dato que nadie estaba editando: borrar
 * en cascada cambia recetas a espaldas de la usuaria, y congelar los totales
 * deja una receta con componentes inexistentes y una suma que ya no se puede
 * verificar contra nada.
 */
export function recipesUsingFood(
  foodKey: string,
  recipes: readonly Recipe[],
): Recipe[] {
  return recipes.filter((recipe) => recipe.items.some((item) => item.foodKey === foodKey));
}

/**
 * Una receta con el componente reemplazado por otro, **conservando los
 * gramos**.
 *
 * Los gramos son de la receta ("este plato lleva 150 g de este alimento"), no
 * del alimento, así que sustituir arroz blanco por integral no cambia cuánto
 * hay en el plato. Si la receta ya contenía al reemplazo, las dos líneas se
 * funden en una sumando sus gramos, para que no queden dos entradas del mismo
 * alimento.
 */
export function replaceRecipeItem(
  recipe: Recipe,
  fromFoodKey: string,
  toFoodKey: string,
): Recipe {
  if (fromFoodKey === toFoodKey) return recipe;
  const merged = new Map<string, number>();
  for (const item of recipe.items) {
    const key = item.foodKey === fromFoodKey ? toFoodKey : item.foodKey;
    merged.set(key, round((merged.get(key) ?? 0) + item.grams));
  }
  return { ...recipe, items: [...merged].map(([foodKey, grams]) => ({ foodKey, grams })) };
}

/** Una receta sin ese componente. Puede quedar vacía; ver `isEmptyRecipe`. */
export function removeRecipeItem(recipe: Recipe, foodKey: string): Recipe {
  return { ...recipe, items: recipe.items.filter((item) => item.foodKey !== foodKey) };
}

/**
 * Una receta sin componentes no se puede guardar: su total sería cero y se
 * leería como "este plato no tiene nada", que es distinto de "no sé qué tiene".
 * Quien la deje vacía tiene que borrarla explícitamente.
 */
export function isEmptyRecipe(recipe: Pick<Recipe, 'items'>): boolean {
  return recipe.items.length === 0;
}

/** Gramos por defecto de un componente al armar una receta desde el catálogo. */
export function defaultItemGrams(food: CatalogFood): number {
  return servingGramsOf(food);
}

export const MIN_RECIPE_ITEM_GRAMS = 1;
export const MAX_RECIPE_ITEM_GRAMS = 3000;

export function isValidRecipeItemGrams(grams: number): boolean {
  return Number.isFinite(grams) && grams >= MIN_RECIPE_ITEM_GRAMS && grams <= MAX_RECIPE_ITEM_GRAMS;
}

/**
 * Lo que hay que resolver antes de poder borrar un alimento, receta por
 * receta. Es la entrada de la pantalla de ayuda: sin esto, "no se puede
 * borrar" es un callejón sin salida.
 */
export type RecipeFixAction =
  /** Cambiarlo por otro alimento del catálogo, conservando los gramos. */
  | { kind: 'replace'; toFoodKey: string }
  /** Sacarlo del plato. Si era el último componente, la receta se borra. */
  | { kind: 'remove' }
  /** Dejar esta receta como está — y por lo tanto no borrar el alimento. */
  | { kind: 'keep' };

export interface RecipeFixPlan {
  recipeId: string;
  action: RecipeFixAction;
}

export interface RecipeFixOutcome {
  /** Recetas ya resueltas, listas para escribir. */
  updated: Recipe[];
  /** Recetas que quedaron vacías: se borran con la misma acción. */
  deletedRecipeIds: string[];
  /**
   * `true` si después de aplicar el plan **ninguna** receta usa el alimento y
   * por lo tanto se puede borrar. Si alguna quedó en `'keep'`, es `false` y el
   * alimento sobrevive: no se borra a medias.
   */
  canDeleteFood: boolean;
}

/**
 * Aplica el plan de resolución completo.
 *
 * Es una sola función pura para que la pantalla no decida nada: recibe lo que
 * eligió la usuaria receta por receta y devuelve exactamente qué se escribe.
 * Todo o nada sobre el alimento — dejar una receta usándolo y borrarlo igual
 * es cómo se llega a un total que nadie puede reproducir.
 */
export function applyRecipeFixPlan(
  foodKey: string,
  recipes: readonly Recipe[],
  plans: readonly RecipeFixPlan[],
): RecipeFixOutcome {
  const byId = new Map(plans.map((plan) => [plan.recipeId, plan.action]));
  const updated: Recipe[] = [];
  const deletedRecipeIds: string[] = [];
  let canDeleteFood = true;

  for (const recipe of recipesUsingFood(foodKey, recipes)) {
    // Sin decisión explícita se conserva: nunca se toca una receta por omisión.
    const action = byId.get(recipe.id) ?? { kind: 'keep' as const };
    if (action.kind === 'keep') {
      canDeleteFood = false;
      continue;
    }
    const next = action.kind === 'replace'
      ? replaceRecipeItem(recipe, foodKey, action.toFoodKey)
      : removeRecipeItem(recipe, foodKey);
    if (isEmptyRecipe(next)) {
      deletedRecipeIds.push(recipe.id);
      continue;
    }
    updated.push(next);
  }

  return { updated, deletedRecipeIds, canDeleteFood };
}
