import {
  isValidServings,
  scaleCatalogFood,
  scaleCatalogFoodByServings,
  servingGramsOf,
  type CatalogFood,
} from './food-catalog';

/**
 * El carrito multi-alimento: Pan + Queso + Jamón en un solo registro.
 *
 * ## Por qué existe, y por qué acá
 *
 * El catálogo agregaba **un alimento por vez**: elegir el segundo reemplazaba
 * al primero. Armar un sándwich obligaba a sumar de cabeza y escribir el
 * total, o a registrar tres comidas.
 *
 * Vive en `packages/domain` y no en el `.tsx` que lo dibuja porque su salida
 * es un número de carbohidratos que la usuaria puede terminar confirmando, y
 * `systemPatterns.md` § Regla 1 es explícita: el dominio calcula, el `.tsx`
 * formatea. Un componente que sume macros es un componente que decide un dato
 * clínico.
 *
 * ## La frontera que no se cruza
 *
 * **El total del carrito es una estimación y sigue siéndolo.** El catálogo es
 * una media de estimaciones de IA (ver `food-catalog.ts`), así que sus
 * carbohidratos tienen exactamente el mismo estatus que los de una foto:
 * `AGENTS.md` prohíbe que se confirmen solos. Este módulo devuelve totales;
 * **nunca** devuelve "carbohidratos confirmados", y quien lo monte necesita
 * una acción explícita de la usuaria para transcribirlos.
 */

export type CartPortionMode = 'servings' | 'grams';

export interface CartLine {
  /**
   * Identidad de la línea, no del alimento: el mismo pan puede estar dos
   * veces con cantidades distintas y las dos tienen que poder editarse y
   * quitarse por separado.
   */
  id: string;
  food: CatalogFood;
  mode: CartPortionMode;
  /** Porciones si `mode === 'servings'`, gramos si `'grams'`. */
  quantity: number;
}

export interface CartLineTotals {
  grams: number;
  carbsG: number;
  proteinG: number;
  fatG: number;
  fiberG: number;
  caloriesKcal: number;
}

/** Los macros que un total puede declarar incompletos, con su nombre visible. */
export const CART_MACRO_LABELS = {
  carbsG: 'carbohidratos',
  proteinG: 'proteína',
  fatG: 'grasa',
  fiberG: 'fibra',
  caloriesKcal: 'calorías',
} as const;

export type CartMacro = keyof typeof CART_MACRO_LABELS;

/**
 * Qué macros de un alimento del catálogo **no están anotados**, distinto de
 * "valen cero".
 *
 * La distinción "en blanco no es cero" rige toda esta app, pero el catálogo
 * guarda números y no blancos: sus columnas son `NOT NULL`. Así que la
 * ausencia solo se puede reconocer donde el cero es **imposible**, no donde
 * es improbable:
 *
 * - Un valor no finito. Solo puede venir de una fila corrupta o de una
 *   migración vieja; leerlo como 0 sería inventar el dato.
 * - `kcalPer100g === 0` con algún macro > 0. Un alimento con 20 g de
 *   carbohidratos no puede tener 0 kcal: es aritméticamente imposible, así
 *   que ese 0 es un hueco, no una medición.
 *
 * Deliberadamente **no** se marca una fibra de 0 g como ausente: la pechuga
 * de pollo tiene 0 g de fibra de verdad, y llamarla "sin anotar" convertiría
 * un dato correcto en una advertencia permanente. Ante la duda, el dato real
 * gana.
 */
export function catalogFoodMissingMacros(food: CatalogFood): CartMacro[] {
  const missing: CartMacro[] = [];
  const values: Record<CartMacro, number> = {
    carbsG: food.carbsPer100g,
    proteinG: food.proteinPer100g,
    fatG: food.fatPer100g,
    fiberG: food.fiberPer100g,
    caloriesKcal: food.kcalPer100g,
  };
  for (const macro of Object.keys(values) as CartMacro[]) {
    if (!Number.isFinite(values[macro])) missing.push(macro);
  }
  const anyMacroPresent = [food.carbsPer100g, food.proteinPer100g, food.fatPer100g]
    .some((value) => Number.isFinite(value) && value > 0);
  if (anyMacroPresent && Number.isFinite(food.kcalPer100g) && food.kcalPer100g === 0
    && !missing.includes('caloriesKcal')) {
    missing.push('caloriesKcal');
  }
  return missing;
}

/** Gramos que representa una línea, resueltos desde porciones o desde gramos. */
export function cartLineGrams(line: CartLine): number {
  return line.mode === 'servings' ? line.quantity * servingGramsOf(line.food) : line.quantity;
}

/** True si la cantidad de una línea es utilizable en su modo. */
export function isValidCartQuantity(mode: CartPortionMode, quantity: number): boolean {
  if (!Number.isFinite(quantity) || quantity <= 0) return false;
  return mode === 'servings' ? isValidServings(quantity) : quantity <= 5000;
}

/** Macros de una línea, escalados a su cantidad. */
export function cartLineTotals(line: CartLine): CartLineTotals {
  const grams = cartLineGrams(line);
  const scaled = line.mode === 'servings'
    ? scaleCatalogFoodByServings(line.food, line.quantity)
    : scaleCatalogFood(line.food, grams);
  return { grams, ...scaled };
}

export interface CartTotals extends Omit<CartLineTotals, 'grams'> {
  grams: number;
  /** Cuántas líneas hay. Se muestra: "3 alimentos". */
  lineCount: number;
  /**
   * Macros que algún alimento no tenía anotados. Mientras no esté vacío, el
   * total es un **mínimo** y así hay que rotularlo.
   */
  missing: CartMacro[];
  /** Qué alimentos aportaron un hueco, por nombre, para poder nombrarlos. */
  incompleteFoods: string[];
}

/**
 * Suma el carrito.
 *
 * Recalcula desde cero en cada llamada a propósito: un total incremental se
 * desincroniza en cuanto se edita o se quita una línea, y ese total es el que
 * la usuaria puede terminar confirmando.
 */
export function cartTotals(lines: readonly CartLine[]): CartTotals {
  const totals: CartTotals = {
    grams: 0,
    carbsG: 0,
    proteinG: 0,
    fatG: 0,
    fiberG: 0,
    caloriesKcal: 0,
    lineCount: lines.length,
    missing: [],
    incompleteFoods: [],
  };
  const missing = new Set<CartMacro>();
  const incompleteFoods = new Set<string>();
  for (const line of lines) {
    const line_ = cartLineTotals(line);
    totals.grams += line_.grams;
    totals.carbsG += line_.carbsG;
    totals.proteinG += line_.proteinG;
    totals.fatG += line_.fatG;
    totals.fiberG += line_.fiberG;
    totals.caloriesKcal += line_.caloriesKcal;
    const holes = catalogFoodMissingMacros(line.food);
    if (holes.length > 0) {
      incompleteFoods.add(line.food.name);
      for (const hole of holes) missing.add(hole);
    }
  }
  // Un decimal, la misma precisión que `scaleCatalogFood`: sumar seis líneas
  // en coma flotante produce 41.900000000000006 sin esto.
  const round = (value: number): number => Number(value.toFixed(1));
  totals.grams = round(totals.grams);
  totals.carbsG = round(totals.carbsG);
  totals.proteinG = round(totals.proteinG);
  totals.fatG = round(totals.fatG);
  totals.fiberG = round(totals.fiberG);
  totals.caloriesKcal = Math.round(totals.caloriesKcal);
  totals.missing = [...missing];
  totals.incompleteFoods = [...incompleteFoods];
  return totals;
}

/**
 * Agrega una línea **sin reemplazar** las que ya estaban.
 *
 * Es el bug que el carrito viene a arreglar, escrito como función con test
 * para que no vuelva: el picker anterior guardaba `pendingFood`, uno solo, y
 * elegir el segundo alimento borraba el primero.
 */
export function addCartLine(lines: readonly CartLine[], line: CartLine): CartLine[] {
  return [...lines, line];
}

export function removeCartLine(lines: readonly CartLine[], id: string): CartLine[] {
  return lines.filter((line) => line.id !== id);
}

export function updateCartLineQuantity(
  lines: readonly CartLine[],
  id: string,
  mode: CartPortionMode,
  quantity: number,
): CartLine[] {
  return lines.map((line) => (line.id === id ? { ...line, mode, quantity } : line));
}

/**
 * Cómo se describe el total en pantalla cuando falta algo.
 *
 * Texto y no solo color: `contracts/ux-checklist.md` prohíbe que un estado se
 * comunique únicamente con un tono, y "este número es un piso" es exactamente
 * la clase de estado que se pierde si solo se pinta.
 */
export function cartCompletenessNote(totals: CartTotals): string | null {
  if (totals.missing.length === 0) return null;
  const macros = totals.missing.map((macro) => CART_MACRO_LABELS[macro]).join(', ');
  const foods = totals.incompleteFoods.join(', ');
  return `Total mínimo: falta ${macros} en ${foods}. Lo comido fue al menos esto.`;
}
