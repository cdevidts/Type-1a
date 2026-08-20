import type { FoodEstimate } from '@type1a/schemas';
import { describe, expect, it } from 'vitest';

import {
  catalogEntriesFrom,
  foodKey,
  MIN_CATALOG_GRAMS,
  scaleCatalogFood,
  blendCatalogEntry,
  isPlausibleCatalogEntry,
  MAX_BLEND_WEIGHT,
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
      food({ name: 'Huevo', estimatedGrams: 60, carbsG: 1, fiberG: 0 }),
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

describe('isPlausibleCatalogEntry', () => {
  const base = {
    key: 'x', name: 'X', lastSeenAt: AT,
    carbsPer100g: 40, proteinPer100g: 10, fatPer100g: 4, fiberPer100g: 6, kcalPer100g: 260,
  };

  it('acepta un alimento normal', () => {
    expect(isPlausibleCatalogEntry(base)).toBe(true);
  });

  it('rechaza más de 100 g de un macro en 100 g de alimento', () => {
    // Viene de una porción muy mal estimada. Sin este filtro quedaba
    // fosilizado y el catálogo sugería cientos de gramos de carbohidratos.
    expect(isPlausibleCatalogEntry({ ...base, carbsPer100g: 480 })).toBe(false);
    expect(isPlausibleCatalogEntry({ ...base, proteinPer100g: 101 })).toBe(false);
  });

  it('rechaza energía imposible', () => {
    expect(isPlausibleCatalogEntry({ ...base, kcalPer100g: 2000 })).toBe(false);
  });

  it('rechaza más fibra que carbohidratos', () => {
    // La fibra es un subconjunto de los carbos: al revés es incoherente.
    expect(isPlausibleCatalogEntry({ ...base, carbsPer100g: 5, fiberPer100g: 20 })).toBe(false);
  });

  it('rechaza negativos', () => {
    expect(isPlausibleCatalogEntry({ ...base, fatPer100g: -1 })).toBe(false);
  });

  it('catalogEntriesFrom filtra los implausibles', () => {
    // 200 g de plato estimados como 20 g -> per100 sale 10x alto.
    const entries = catalogEntriesFrom([food({ name: 'Plato', estimatedGrams: 20, carbsG: 100 })], AT);
    expect(entries).toEqual([]);
  });
});

describe('blendCatalogEntry', () => {
  function stored(overrides: Partial<CatalogFood> = {}): CatalogFood {
    return {
      key: 'pan', name: 'Pan', carbsPer100g: 40, proteinPer100g: 10,
      fatPer100g: 4, fiberPer100g: 6, kcalPer100g: 260, timesSeen: 1, lastSeenAt: AT, ...overrides,
    };
  }
  const incoming = {
    key: 'pan', name: 'Pan integral', carbsPer100g: 50, proteinPer100g: 12,
    fatPer100g: 5, fiberPer100g: 7, kcalPer100g: 300, lastSeenAt: '2026-08-21T10:00:00.000Z',
  };

  it('promedia ponderado por las veces vistas', () => {
    const merged = blendCatalogEntry(stored({ timesSeen: 1 }), incoming);
    expect(merged.carbsPer100g).toBe(45);       // (40*1 + 50) / 2
    expect(merged.timesSeen).toBe(2);
  });

  it('cuantas más veces vista, menos la mueve una estimación nueva', () => {
    const pocas = blendCatalogEntry(stored({ timesSeen: 1 }), incoming);
    const muchas = blendCatalogEntry(stored({ timesSeen: 9 }), incoming);
    expect(Math.abs(muchas.carbsPer100g - 40)).toBeLessThan(Math.abs(pocas.carbsPer100g - 40));
  });

  it('el peso está acotado, así que un error temprano SÍ se puede corregir', () => {
    // Sin tope, un alimento visto 200 veces queda inmutable y una estimación
    // mala temprana no se arregla nunca. La inercia crecería al revés de lo
    // deseable.
    const a = blendCatalogEntry(stored({ timesSeen: MAX_BLEND_WEIGHT }), incoming);
    const b = blendCatalogEntry(stored({ timesSeen: 500 }), incoming);
    expect(a.carbsPer100g).toBe(b.carbsPer100g);
    expect(b.carbsPer100g).not.toBe(40);
  });

  it('adopta el nombre y la fecha más recientes, y conserva la clave', () => {
    const merged = blendCatalogEntry(stored(), incoming);
    expect(merged.name).toBe('Pan integral');
    expect(merged.lastSeenAt).toBe(incoming.lastSeenAt);
    expect(merged.key).toBe('pan');
  });
});
