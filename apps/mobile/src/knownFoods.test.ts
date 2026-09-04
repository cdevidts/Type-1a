import { describe, expect, it } from 'vitest';
import type { CatalogFood } from '@type1a/domain';

import { knownFoodNamesFrom, MAX_KNOWN_FOOD_NAMES } from './knownFoods';

function food(name: string, timesSeen: number, over: Partial<CatalogFood> = {}): CatalogFood {
  return {
    key: name.toLowerCase(), name,
    carbsPer100g: 10, proteinPer100g: 1, fatPer100g: 1, fiberPer100g: 0, kcalPer100g: 50,
    timesSeen, lastSeenAt: '2026-09-02T00:00:00.000Z', ...over,
  };
}

describe('knownFoodNamesFrom', () => {
  it('manda SOLO nombres, los más vistos primero', () => {
    const names = knownFoodNamesFrom([food('Arroz', 2), food('Muslo de pollo', 9), food('Pan', 5)]);
    expect(names).toEqual(['Muslo de pollo', 'Pan', 'Arroz']);
    for (const name of names) expect(typeof name).toBe('string');
  });

  it('incluye los ocultos dentro de una receta: volver a fotografiar el plato debe reconocerlos', () => {
    expect(knownFoodNamesFrom([food('Pollo', 1, { listed: false })])).toEqual(['Pollo']);
  });

  it('respeta el tope del esquema del servidor', () => {
    const many = Array.from({ length: 400 }, (_, i) => food(`Alimento ${i}`, i));
    expect(knownFoodNamesFrom(many)).toHaveLength(MAX_KNOWN_FOOD_NAMES);
    expect(MAX_KNOWN_FOOD_NAMES).toBe(300);
  });

  it('descarta lo que el servidor rechazaría, en vez de tumbar el análisis entero', () => {
    const names = knownFoodNamesFrom([food('   ', 1), food('x'.repeat(81), 1), food('Pan', 1)]);
    expect(names).toEqual(['Pan']);
  });
});
