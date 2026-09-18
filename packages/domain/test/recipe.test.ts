import { describe, expect, it } from 'vitest';

import type { CatalogFood } from '../src/food-catalog';
import { cartTotals } from '../src/meal-cart';
import {
  addRecipeItem,
  applyRecipeFixPlan,
  isEmptyRecipe,
  recipeToCartLines,
  recipeTotals,
  recipesUsingFood,
  removeRecipeItem,
  replaceRecipeItem,
  setRecipeItemGrams,
  type Recipe,
} from '../src/recipe';

const AT = '2026-09-01T12:00:00.000Z';

function food(key: string, over: Partial<CatalogFood> = {}): CatalogFood {
  return {
    key, name: key,
    carbsPer100g: 20, proteinPer100g: 10, fatPer100g: 5, fiberPer100g: 2, kcalPer100g: 160,
    timesSeen: 1, lastSeenAt: AT,
    ...over,
  };
}

function recipe(over: Partial<Recipe> = {}): Recipe {
  return {
    id: 'r-1', name: 'Arroz con pollo', key: 'arroz con pollo',
    items: [{ foodKey: 'arroz', grams: 150 }, { foodKey: 'pollo', grams: 100 }],
    createdAt: AT, lastSeenAt: AT, timesSeen: 1,
    ...over,
  };
}

const catalogo = new Map<string, CatalogFood>([
  ['arroz', food('arroz', { carbsPer100g: 28, proteinPer100g: 2.7, fatPer100g: 0.3, fiberPer100g: 0.4, kcalPer100g: 130 })],
  ['pollo', food('pollo', { carbsPer100g: 0, proteinPer100g: 31, fatPer100g: 3.6, fiberPer100g: 0, kcalPer100g: 165 })],
]);

describe('recipeTotals — se derivan, nunca se guardan', () => {
  it('suma los componentes escalados a sus gramos', () => {
    const totals = recipeTotals(recipe(), catalogo);
    // Verdad a mano con la MISMA precisión que el carrito: `scaleCatalogFood`
    // redondea **cada componente** a un decimal antes de que se sumen.
    //   arroz 150 g → 42 carbos · 4.1 proteína (2,7×1,5 = 4,05 → 4,1)
    //                 · 0.4 grasa · 195 kcal
    //   pollo 100 g →  0 carbos · 31 proteína · 3.6 grasa · 165 kcal
    //
    // La grasa da 0,4 y no 0,5: 0,3 × 1,5 en coma flotante es 0,44999…, así
    // que `toFixed(1)` baja. Se deja escrito porque es justo el tipo de
    // "debería dar 4,1" que lleva a cambiar el redondeo y romper la paridad
    // con el carrito.
    expect(totals.grams).toBe(250);
    expect(totals.carbsG).toBe(42);
    expect(totals.proteinG).toBe(35.1);
    expect(totals.fatG).toBe(4);
    expect(totals.caloriesKcal).toBe(360);
    expect(totals.missingFoodKeys).toEqual([]);
  });

  it('corregir un componente cambia la receta sin tocar ninguna fila suya', () => {
    const antes = recipeTotals(recipe(), catalogo);
    const corregido = new Map(catalogo);
    corregido.set('arroz', food('arroz', { carbsPer100g: 14, kcalPer100g: 130 }));
    const despues = recipeTotals(recipe(), corregido);
    expect(antes.carbsG).toBe(42);
    expect(despues.carbsG).toBe(21);
  });

  it('un componente ausente se DECLARA en vez de sumar cero callado', () => {
    const sinPollo = new Map([['arroz', catalogo.get('arroz')!]]);
    const totals = recipeTotals(recipe(), sinPollo);
    expect(totals.missingFoodKeys).toEqual(['pollo']);
    // El total sigue siendo el de lo que sí conoce: es un piso, y quien lo
    // muestre tiene que decir que falta algo.
    expect(totals.grams).toBe(150);
  });

  it('una receta vacía da ceros completos, no un error', () => {
    expect(recipeTotals({ items: [] }, catalogo).carbsG).toBe(0);
  });
});

describe('el mismo plato da lo mismo como receta que como carrito', () => {
  it('receta y carrito coinciden macro a macro', () => {
    // Es la regla que el repo ya tenía escrita para el carrito: si el redondeo
    // difiriera, el mismo arroz con pollo daría dos números según cómo se
    // registró, y ninguno de los dos sería verificable.
    const lines = recipe().items.map((item, index) => ({
      id: `l-${index}`,
      food: catalogo.get(item.foodKey)!,
      mode: 'grams' as const,
      quantity: item.grams,
    }));
    const carrito = cartTotals(lines);
    const receta = recipeTotals(recipe(), catalogo);
    expect(receta.carbsG).toBe(carrito.carbsG);
    expect(receta.proteinG).toBe(carrito.proteinG);
    expect(receta.fatG).toBe(carrito.fatG);
    expect(receta.fiberG).toBe(carrito.fiberG);
    expect(receta.caloriesKcal).toBe(carrito.caloriesKcal);
    expect(receta.grams).toBe(carrito.grams);
  });
});

describe('recipesUsingFood', () => {
  it('encuentra las recetas que contienen el alimento', () => {
    const otra = recipe({ id: 'r-2', items: [{ foodKey: 'pan', grams: 60 }] });
    expect(recipesUsingFood('arroz', [recipe(), otra]).map((r) => r.id)).toEqual(['r-1']);
  });

  it('no encuentra nada cuando el alimento no se usa', () => {
    expect(recipesUsingFood('palta', [recipe()])).toEqual([]);
  });
});

describe('replaceRecipeItem — los gramos son del plato, no del alimento', () => {
  it('conserva los gramos al sustituir', () => {
    const next = replaceRecipeItem(recipe(), 'arroz', 'quinoa');
    expect(next.items).toEqual([{ foodKey: 'quinoa', grams: 150 }, { foodKey: 'pollo', grams: 100 }]);
  });

  it('funde las líneas si la receta ya contenía al reemplazo', () => {
    const conAmbos = recipe({ items: [{ foodKey: 'arroz', grams: 150 }, { foodKey: 'quinoa', grams: 50 }] });
    const next = replaceRecipeItem(conAmbos, 'arroz', 'quinoa');
    expect(next.items).toEqual([{ foodKey: 'quinoa', grams: 200 }]);
  });

  it('reemplazar por sí mismo no cambia nada', () => {
    expect(replaceRecipeItem(recipe(), 'arroz', 'arroz')).toEqual(recipe());
  });
});

describe('removeRecipeItem e isEmptyRecipe', () => {
  it('saca el componente', () => {
    expect(removeRecipeItem(recipe(), 'arroz').items).toEqual([{ foodKey: 'pollo', grams: 100 }]);
  });

  it('quitar el último deja la receta vacía, que no es guardable', () => {
    const sola = recipe({ items: [{ foodKey: 'arroz', grams: 150 }] });
    expect(isEmptyRecipe(removeRecipeItem(sola, 'arroz'))).toBe(true);
  });
});

describe('applyRecipeFixPlan — todo o nada sobre el alimento', () => {
  const otra = recipe({ id: 'r-2', name: 'Arroz solo', items: [{ foodKey: 'arroz', grams: 200 }] });

  it('resolver todas las recetas habilita el borrado', () => {
    const outcome = applyRecipeFixPlan('arroz', [recipe(), otra], [
      { recipeId: 'r-1', action: { kind: 'replace', toFoodKey: 'quinoa' } },
      { recipeId: 'r-2', action: { kind: 'remove' } },
    ]);
    expect(outcome.canDeleteFood).toBe(true);
    expect(outcome.updated.map((r) => r.id)).toEqual(['r-1']);
    // r-2 quedó sin componentes, así que se borra con la misma acción.
    expect(outcome.deletedRecipeIds).toEqual(['r-2']);
  });

  it('dejar UNA receta como está impide borrar el alimento', () => {
    const outcome = applyRecipeFixPlan('arroz', [recipe(), otra], [
      { recipeId: 'r-1', action: { kind: 'replace', toFoodKey: 'quinoa' } },
      { recipeId: 'r-2', action: { kind: 'keep' } },
    ]);
    expect(outcome.canDeleteFood).toBe(false);
  });

  it('una receta sin decisión se conserva: nada se toca por omisión', () => {
    const outcome = applyRecipeFixPlan('arroz', [recipe(), otra], []);
    expect(outcome.canDeleteFood).toBe(false);
    expect(outcome.updated).toEqual([]);
    expect(outcome.deletedRecipeIds).toEqual([]);
  });

  it('ignora recetas que no usan el alimento', () => {
    const ajena = recipe({ id: 'r-3', items: [{ foodKey: 'pan', grams: 60 }] });
    const outcome = applyRecipeFixPlan('arroz', [ajena], []);
    expect(outcome.canDeleteFood).toBe(true);
    expect(outcome.updated).toEqual([]);
  });
});

describe('editar la composición de una receta', () => {
  it('setRecipeItemGrams cambia solo esa línea, y rechaza gramos imposibles sin tocar nada', () => {
    const r = setRecipeItemGrams(recipe(), 'arroz', 200);
    expect(r.items).toEqual([{ foodKey: 'arroz', grams: 200 }, { foodKey: 'pollo', grams: 100 }]);
    expect(setRecipeItemGrams(recipe(), 'arroz', 0)).toEqual(recipe());
    expect(setRecipeItemGrams(recipe(), 'arroz', 99_999)).toEqual(recipe());
  });

  it('addRecipeItem agrega, y si ya estaba suma los gramos en vez de duplicar la línea', () => {
    const conPan = addRecipeItem(recipe(), 'pan', 40);
    expect(conPan.items).toHaveLength(3);
    expect(conPan.items[2]).toEqual({ foodKey: 'pan', grams: 40 });
    const masArroz = addRecipeItem(recipe(), 'arroz', 50);
    expect(masArroz.items).toEqual([{ foodKey: 'arroz', grams: 200 }, { foodKey: 'pollo', grams: 100 }]);
  });
});

describe('recipeToCartLines — reusar una receta en una comida', () => {
  let seq = 0;
  const nextId = (): string => `l-${++seq}`;

  it('se expande a una línea POR COMPONENTE, en gramos, escalada por los platos comidos', () => {
    const { lines, missingFoodKeys } = recipeToCartLines(recipe(), catalogo, 0.5, nextId);
    expect(missingFoodKeys).toEqual([]);
    expect(lines.map((l) => [l.food.key, l.mode, l.quantity])).toEqual([
      ['arroz', 'grams', 75],
      ['pollo', 'grams', 50],
    ]);
  });

  it('el mismo plato da el mismo número en el carrito que como receta', () => {
    // La invariante que ya fija `recipeTotals`, extendida al camino de reuso:
    // si el carrito sumara distinto, "un plato de arroz con pollo" tendría
    // dos verdades según por dónde entró.
    const { lines } = recipeToCartLines(recipe(), catalogo, 1, nextId);
    const cart = cartTotals(lines);
    const totals = recipeTotals(recipe(), catalogo);
    expect(cart.carbsG).toBe(totals.carbsG);
    expect(cart.proteinG).toBe(totals.proteinG);
    expect(cart.fatG).toBe(totals.fatG);
    expect(cart.caloriesKcal).toBe(totals.caloriesKcal);
  });

  it('un componente que ya no está en el catálogo se declara, no se omite en silencio', () => {
    const { lines, missingFoodKeys } = recipeToCartLines(recipe(), new Map([['arroz', catalogo.get('arroz')!]]), 1, nextId);
    expect(lines).toHaveLength(1);
    expect(missingFoodKeys).toEqual(['pollo']);
  });

  it('rechaza cero o negativo platos', () => {
    expect(() => recipeToCartLines(recipe(), catalogo, 0, nextId)).toThrow();
  });
});
