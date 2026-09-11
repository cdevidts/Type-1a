import { describe, expect, it } from 'vitest';

import {
  addCartLine,
  cartCompletenessNote,
  cartLineGrams,
  cartLineTotals,
  cartTotals,
  catalogFoodMissingMacros,
  isValidCartQuantity,
  removeCartLine,
  updateCartLineQuantity,
  type CartLine,
  type CatalogFood,
} from '../src/index';

/**
 * Los tests del carrito comparan contra **verdad sembrada**, no contra lo que
 * la implementación devuelve hoy (`systemPatterns.md` § el corolario que costó
 * más caro). Cada alimento tiene números elegidos para que el total esperado
 * se pueda calcular a mano en el propio test.
 */

function food(overrides: Partial<CatalogFood> & { key: string; name: string }): CatalogFood {
  return {
    carbsPer100g: 0,
    proteinPer100g: 0,
    fatPer100g: 0,
    fiberPer100g: 0,
    kcalPer100g: 0,
    timesSeen: 1,
    lastSeenAt: '2026-08-27T12:00:00.000Z',
    ...overrides,
  };
}

// Pan: 50 g de carbos, 8 de proteína, 3 de grasa, 4 de fibra, 260 kcal /100 g.
const pan = food({ key: 'pan', name: 'Pan', carbsPer100g: 50, proteinPer100g: 8, fatPer100g: 3, fiberPer100g: 4, kcalPer100g: 260, servingGrams: 30 });
// Queso: sin carbos, mucha proteína y grasa.
const queso = food({ key: 'queso', name: 'Queso', carbsPer100g: 2, proteinPer100g: 25, fatPer100g: 30, fiberPer100g: 0, kcalPer100g: 380, servingGrams: 20 });
const jamon = food({ key: 'jamon', name: 'Jamón', carbsPer100g: 1, proteinPer100g: 20, fatPer100g: 5, fiberPer100g: 0, kcalPer100g: 130 });

const line = (id: string, f: CatalogFood, mode: CartLine['mode'], quantity: number): CartLine =>
  ({ id, food: f, mode, quantity });

describe('acumulación — el segundo alimento no reemplaza al primero', () => {
  /**
   * El bug que el carrito existe para arreglar: el picker anterior guardaba un
   * `pendingFood` y elegir el segundo borraba al primero, así que un sándwich
   * obligaba a sumar de cabeza o a registrar tres comidas.
   */
  it('tres alimentos se acumulan como tres líneas', () => {
    let lines: CartLine[] = [];
    lines = addCartLine(lines, line('1', pan, 'grams', 60));
    lines = addCartLine(lines, line('2', queso, 'grams', 40));
    lines = addCartLine(lines, line('3', jamon, 'grams', 30));
    expect(lines.map((l) => l.food.name)).toEqual(['Pan', 'Queso', 'Jamón']);
    expect(cartTotals(lines).lineCount).toBe(3);
  });

  it('el mismo alimento dos veces son dos líneas independientes', () => {
    const lines = addCartLine(addCartLine([], line('1', pan, 'grams', 30)), line('2', pan, 'grams', 60));
    expect(cartTotals(lines).lineCount).toBe(2);
    // 30 g + 60 g = 90 g de pan → 45 g de carbos.
    expect(cartTotals(lines).carbsG).toBe(45);
  });

  it('quitar una línea recalcula el resto y no toca a las demás', () => {
    const lines = [line('1', pan, 'grams', 100), line('2', queso, 'grams', 100)];
    // Antes: 50 + 2 = 52 g de carbos.
    expect(cartTotals(lines).carbsG).toBe(52);
    const after = removeCartLine(lines, '2');
    expect(after.map((l) => l.id)).toEqual(['1']);
    expect(cartTotals(after).carbsG).toBe(50);
    expect(cartTotals(after).proteinG).toBe(8);
  });
});

describe('cantidad — porciones y gramos recalculan todo', () => {
  it('una porción de pan son sus 30 g configurados', () => {
    expect(cartLineGrams(line('1', pan, 'servings', 1))).toBe(30);
    // 30 g de pan = 15 g de carbos, 2,4 de proteína, 0,9 de grasa, 1,2 de fibra.
    const totals = cartLineTotals(line('1', pan, 'servings', 1));
    expect(totals.carbsG).toBe(15);
    expect(totals.proteinG).toBe(2.4);
    expect(totals.fatG).toBe(0.9);
    expect(totals.fiberG).toBe(1.2);
    expect(totals.caloriesKcal).toBe(78);
  });

  it('un alimento sin porción configurada usa 100 g', () => {
    expect(cartLineGrams(line('1', jamon, 'servings', 2))).toBe(200);
  });

  it('cambiar la cantidad recalcula TODOS los macros, no solo los carbos', () => {
    const lines = [line('1', pan, 'grams', 100)];
    const doubled = updateCartLineQuantity(lines, '1', 'grams', 200);
    const totals = cartTotals(doubled);
    expect(totals.carbsG).toBe(100);
    expect(totals.proteinG).toBe(16);
    expect(totals.fatG).toBe(6);
    expect(totals.fiberG).toBe(8);
    expect(totals.caloriesKcal).toBe(520);
  });

  it('cambiar de gramos a porciones también recalcula', () => {
    const lines = updateCartLineQuantity([line('1', pan, 'grams', 100)], '1', 'servings', 2);
    // 2 porciones × 30 g = 60 g → 30 g de carbos.
    expect(cartTotals(lines).carbsG).toBe(30);
  });

  it('rechaza cantidades imposibles antes de escalar nada', () => {
    expect(isValidCartQuantity('servings', 0)).toBe(false);
    expect(isValidCartQuantity('servings', 20)).toBe(false);
    expect(isValidCartQuantity('servings', 2)).toBe(true);
    expect(isValidCartQuantity('grams', -5)).toBe(false);
    expect(isValidCartQuantity('grams', 6000)).toBe(false);
    expect(isValidCartQuantity('grams', 250)).toBe(true);
  });
});

describe('totales incompletos — un piso se rotula como piso', () => {
  /**
   * El catálogo guarda números, no blancos, así que la ausencia solo se puede
   * reconocer donde el cero es **imposible**. 20 g de carbohidratos con 0 kcal
   * no es un alimento: es un hueco.
   */
  it('0 kcal con macros presentes es un hueco, no una medición', () => {
    const sinKcal = food({ key: 'x', name: 'Arroz', carbsPer100g: 28, proteinPer100g: 3, fatPer100g: 0.3, fiberPer100g: 0.4, kcalPer100g: 0 });
    expect(catalogFoodMissingMacros(sinKcal)).toEqual(['caloriesKcal']);
    const totals = cartTotals([line('1', sinKcal, 'grams', 100)]);
    expect(totals.missing).toEqual(['caloriesKcal']);
    expect(totals.incompleteFoods).toEqual(['Arroz']);
    expect(cartCompletenessNote(totals)).toContain('Total mínimo');
    expect(cartCompletenessNote(totals)).toContain('calorías');
    expect(cartCompletenessNote(totals)).toContain('Arroz');
  });

  /**
   * La contracara, y es la que importa más: una fibra de 0 g **real** no se
   * puede llamar "sin anotar". La pechuga de pollo tiene 0 g de fibra de
   * verdad, y marcarla incompleta convertiría un dato correcto en una
   * advertencia permanente.
   */
  it('un cero legítimo NO se marca como ausente', () => {
    const pollo = food({ key: 'pollo', name: 'Pollo', carbsPer100g: 0, proteinPer100g: 31, fatPer100g: 3.6, fiberPer100g: 0, kcalPer100g: 165 });
    expect(catalogFoodMissingMacros(pollo)).toEqual([]);
    const totals = cartTotals([line('1', pollo, 'grams', 100)]);
    expect(totals.missing).toEqual([]);
    expect(cartCompletenessNote(totals)).toBeNull();
  });

  it('un valor no finito se declara ausente en vez de leerse como cero', () => {
    const roto = food({ key: 'roto', name: 'Roto', carbsPer100g: Number.NaN, proteinPer100g: 5, fatPer100g: 1, fiberPer100g: 0, kcalPer100g: 30 });
    expect(catalogFoodMissingMacros(roto)).toContain('carbsG');
  });

  it('un carrito completo no lleva nota de completitud', () => {
    const totals = cartTotals([line('1', pan, 'grams', 100), line('2', queso, 'grams', 100)]);
    expect(totals.missing).toEqual([]);
    expect(cartCompletenessNote(totals)).toBeNull();
  });
});

describe('totales del carrito — verdad sembrada', () => {
  it('Pan 60 g + Queso 40 g + Jamón 30 g suma exactamente lo esperado', () => {
    const lines = [
      line('1', pan, 'grams', 60),   // 30 carbos, 4.8 prot, 1.8 grasa, 2.4 fibra, 156 kcal
      line('2', queso, 'grams', 40), // 0.8 carbos, 10 prot, 12 grasa, 0 fibra, 152 kcal
      line('3', jamon, 'grams', 30), // 0.3 carbos, 6 prot, 1.5 grasa, 0 fibra, 39 kcal
    ];
    const totals = cartTotals(lines);
    expect(totals.carbsG).toBe(31.1);
    expect(totals.proteinG).toBe(20.8);
    expect(totals.fatG).toBe(15.3);
    expect(totals.fiberG).toBe(2.4);
    expect(totals.caloriesKcal).toBe(347);
    expect(totals.grams).toBe(130);
    expect(totals.lineCount).toBe(3);
  });

  it('un carrito vacío es cero y sin huecos, no un total inventado', () => {
    const totals = cartTotals([]);
    expect(totals).toMatchObject({ carbsG: 0, proteinG: 0, fatG: 0, fiberG: 0, caloriesKcal: 0, lineCount: 0 });
    expect(totals.missing).toEqual([]);
  });
});
