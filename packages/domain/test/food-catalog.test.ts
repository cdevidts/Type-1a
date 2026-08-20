import type { FoodEstimate } from '@type1a/schemas';
import { describe, expect, it } from 'vitest';

import {
  catalogEntriesFrom,
  foodKey,
  MIN_CATALOG_GRAMS,
  scaleCatalogFood,
  toCatalogEntry,
  type CatalogFood,
} from '../src/food-catalog';

const AT = '2026-08-20T12:00:00.000Z';

function food(overrides: Partial<FoodEstimate> = {}): FoodEstimate {
  return {
    name: 'Pan integral',
    estimatedGrams: 50,
    carbsG: 20,
    proteinG: 5,
    fatG: 2,
    fiberG: 3,
    caloriesKcal: 130,
    confidence: 0.8,
    ...overrides,
  };
}

describe('foodKey', () => {
  it('colapsa mayúsculas, acentos, puntuación y espacios', () => {
    expect(foodKey('Pan Integral')).toBe(foodKey('pan  integral.'));
    expect(foodKey('Plátano')).toBe('platano');
    expect(foodKey('  Arroz   blanco  ')).toBe('arroz blanco');
  });

  it('NO junta singular y plural, a propósito', () => {
    // Colapsarlos necesitaría un diccionario de español, y equivocarse ahí
    // mezcla macros de alimentos distintos: peor que dos entradas parecidas.
    expect(foodKey('manzana')).not.toBe(foodKey('manzanas'));
  });

  it('devuelve cadena vacía cuando el nombre no aporta nada', () => {
    expect(foodKey('...')).toBe('');
    expect(foodKey('   ')).toBe('');
  });
});

describe('toCatalogEntry', () => {
  it('normaliza a 100 g', () => {
    const entry = toCatalogEntry(food({ estimatedGrams: 50, carbsG: 20 }), AT);
    expect(entry).not.toBeNull();
    expect(entry!.carbsPer100g).toBe(40);
    expect(entry!.proteinPer100g).toBe(10);
    expect(entry!.kcalPer100g).toBe(260);
  });

  it('rechaza un alimento sin gramos estimados', () => {
    // `estimatedGrams` es nullable porque la IA declara cuándo no puede
    // estimar la porción. Escalar desde una porción desconocida sería
    // inventar el dato.
    expect(toCatalogEntry(food({ estimatedGrams: null }), AT)).toBeNull();
  });

  it('rechaza porciones demasiado chicas para normalizar', () => {
    expect(toCatalogEntry(food({ estimatedGrams: MIN_CATALOG_GRAMS - 1 }), AT)).toBeNull();
  });

  it('rechaza un nombre sin contenido', () => {
    expect(toCatalogEntry(food({ name: '...' }), AT)).toBeNull();
  });
});

describe('catalogEntriesFrom', () => {
  it('descarta los no normalizables y deduplica por clave', () => {
    const entries = catalogEntriesFrom([
      food({ name: 'Pan integral', estimatedGrams: 50, carbsG: 20 }),
      food({ name: 'PAN INTEGRAL', estimatedGrams: 100, carbsG: 45 }),
      food({ name: 'Palta', estimatedGrams: null }),
      food({ name: 'Huevo', estimatedGrams: 60, carbsG: 1 }),
    ], AT);
    expect(entries).toHaveLength(2);
    const pan = entries.find((e) => e.key === 'pan integral')!;
    // Gana la última aparición: más probable que sea corrección que otro plato.
    expect(pan.carbsPer100g).toBe(45);
  });

  it('un análisis sin nada normalizable devuelve lista vacía', () => {
    expect(catalogEntriesFrom([food({ estimatedGrams: null })], AT)).toEqual([]);
  });
});

describe('scaleCatalogFood', () => {
  const stored: CatalogFood = {
    key: 'pan integral', name: 'Pan integral',
    carbsPer100g: 40, proteinPer100g: 10, fatPer100g: 4, fiberPer100g: 6, kcalPer100g: 260,
    timesSeen: 3, lastSeenAt: AT,
  };

  it('escala linealmente a la porción', () => {
    expect(scaleCatalogFood(stored, 50)).toEqual({
      carbsG: 20, proteinG: 5, fatG: 2, fiberG: 3, caloriesKcal: 130,
    });
  });

  it('la porción de 100 g devuelve los valores tal cual', () => {
    const scaled = scaleCatalogFood(stored, 100);
    expect(scaled.carbsG).toBe(40);
    expect(scaled.caloriesKcal).toBe(260);
  });

  it('rechaza porciones imposibles en vez de devolver ceros', () => {
    expect(() => scaleCatalogFood(stored, 0)).toThrow();
    expect(() => scaleCatalogFood(stored, -10)).toThrow();
    expect(() => scaleCatalogFood(stored, Number.NaN)).toThrow();
  });
});
