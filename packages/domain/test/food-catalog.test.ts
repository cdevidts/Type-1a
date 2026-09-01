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
  applyCatalogEdit,
  catalogEntryFromPortion,
  DEFAULT_SERVING_GRAMS,
  isValidServingGrams,
  MAX_SERVING_GRAMS,
  isValidServings,
  scaleCatalogFoodByServings,
  servingGramsOf,
  type CatalogFood,
} from '../src/food-catalog';

const AT = '2026-08-20T12:00:00.000Z';

function food(overrides: Partial<FoodEstimate> = {}): FoodEstimate {
  return {
    name: 'Pan integral',
    estimatedGrams: 50,
    servingGrams: null,
    servingLabel: null,
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

describe('porciones de referencia (Fase 18)', () => {
  const base: CatalogFood = {
    key: 'arroz',
    name: 'Arroz',
    carbsPer100g: 28,
    proteinPer100g: 2.7,
    fatPer100g: 0.3,
    fiberPer100g: 0.4,
    kcalPer100g: 130,
    timesSeen: 3,
    lastSeenAt: '2026-08-21T12:00:00.000Z',
  };

  it('un alimento sin porción definida se comporta como antes: 100 g', () => {
    // Las filas ya guardadas en el teléfono de Verónica no tienen el campo.
    // Si esto cambia, una migración le rompió datos reales.
    expect(servingGramsOf(base)).toBe(DEFAULT_SERVING_GRAMS);
    expect(scaleCatalogFoodByServings(base, 1)).toEqual(scaleCatalogFood(base, 100));
  });

  it('escala por porciones usando el tamaño definido', () => {
    const conPorcion: CatalogFood = { ...base, servingGrams: 150, servingLabel: 'taza' };
    expect(scaleCatalogFoodByServings(conPorcion, 2)).toEqual(scaleCatalogFood(conPorcion, 300));
  });

  it('acepta el rango 0,1 a 10 y nada fuera de él', () => {
    expect(isValidServings(0.1)).toBe(true);
    expect(isValidServings(10)).toBe(true);
    expect(isValidServings(0.09)).toBe(false);
    expect(isValidServings(10.1)).toBe(false);
    expect(isValidServings(0)).toBe(false);
    expect(isValidServings(Number.NaN)).toBe(false);
    expect(() => scaleCatalogFoodByServings(base, 0)).toThrow();
  });

  it('una identificación nueva de la IA no borra la porción que definió la usuaria', () => {
    const conPorcion: CatalogFood = { ...base, servingGrams: 150, servingLabel: 'taza' };
    const desdeIA = {
      key: 'arroz',
      name: 'Arroz blanco',
      carbsPer100g: 30,
      proteinPer100g: 2.5,
      fatPer100g: 0.4,
      fiberPer100g: 0.5,
      kcalPer100g: 135,
      lastSeenAt: '2026-08-22T12:00:00.000Z',
    };
    const merged = blendCatalogEntry(conPorcion, desdeIA);
    expect(merged.servingGrams).toBe(150);
    expect(merged.servingLabel).toBe('taza');
  });

  it('convierte una porción corregida a mano de vuelta a la base por 100 g', () => {
    const entry = catalogEntryFromPortion(
      base,
      { grams: 200, carbsG: 50, proteinG: 6, fatG: 1, fiberG: 1, caloriesKcal: 240 },
      '2026-08-21T13:00:00.000Z',
    );
    expect(entry?.carbsPer100g).toBe(25);
    expect(entry?.kcalPer100g).toBe(120);
  });

  it('rechaza una corrección físicamente imposible en vez de fosilizarla', () => {
    // 100 g de algo no pueden tener 150 g de carbohidratos. Sin este rechazo
    // el error queda en el catálogo sugiriendo esa cifra para siempre.
    const entry = catalogEntryFromPortion(
      base,
      { grams: 100, carbsG: 150, proteinG: 6, fatG: 1, fiberG: 1, caloriesKcal: 240 },
      '2026-08-21T13:00:00.000Z',
    );
    expect(entry).toBeNull();
  });
});

describe('applyCatalogEdit (la puerta de toda escritura manual al catálogo)', () => {
  const base: CatalogFood = {
    key: 'arroz',
    name: 'Arroz',
    carbsPer100g: 28,
    proteinPer100g: 2.7,
    fatPer100g: 0.3,
    fiberPer100g: 0.4,
    kcalPer100g: 130,
    timesSeen: 4,
    lastSeenAt: '2026-08-21T12:00:00.000Z',
  };

  it('corrige solo lo que se le pasa y deja el resto igual', () => {
    const next = applyCatalogEdit(base, { carbsPer100g: 25 });
    expect(next?.carbsPer100g).toBe(25);
    expect(next?.proteinPer100g).toBe(2.7);
    expect(next?.name).toBe('Arroz');
  });

  it('no cambia la clave aunque cambie el nombre', () => {
    // Si cambiara, el alimento corregido sería uno nuevo y el viejo —con la
    // estimación mala— seguiría sugiriéndose. Es justo lo que la pantalla de
    // catálogo viene a resolver.
    const next = applyCatalogEdit(base, { name: 'Arroz integral' });
    expect(next?.key).toBe('arroz');
    expect(next?.name).toBe('Arroz integral');
  });

  it('no toca timesSeen: es el peso del algoritmo, no un dato de la comida', () => {
    expect(applyCatalogEdit(base, { carbsPer100g: 25 })?.timesSeen).toBe(4);
  });

  it('rechaza valores imposibles por 100 g en vez de fosilizarlos', () => {
    expect(applyCatalogEdit(base, { carbsPer100g: 150 })).toBeNull();
    expect(applyCatalogEdit(base, { kcalPer100g: 5000 })).toBeNull();
    // Más fibra que carbohidratos es incoherente, no un alimento raro.
    expect(applyCatalogEdit(base, { fiberPer100g: 90 })).toBeNull();
  });

  it('rechaza una porción de referencia absurda', () => {
    // `isPlausibleCatalogEntry` solo miraba los macros, así que un 1500 donde
    // iban 150 pasaba entero y multiplicaba cada sugerencia por diez.
    expect(applyCatalogEdit(base, { servingGrams: 5000 })).toBeNull();
    expect(applyCatalogEdit(base, { servingGrams: 0.5 })).toBeNull();
    expect(applyCatalogEdit(base, { servingGrams: 150 })?.servingGrams).toBe(150);
    expect(isValidServingGrams(MAX_SERVING_GRAMS)).toBe(true);
    expect(isValidServingGrams(MAX_SERVING_GRAMS + 1)).toBe(false);
  });

  it('distingue borrar la porción de no tocarla', () => {
    const conPorcion: CatalogFood = { ...base, servingGrams: 150, servingLabel: 'taza' };
    expect(applyCatalogEdit(conPorcion, {})?.servingGrams).toBe(150);
    const borrada = applyCatalogEdit(conPorcion, { servingGrams: null, servingLabel: null });
    expect(borrada).not.toBeNull();
    expect('servingGrams' in borrada!).toBe(false);
    expect('servingLabel' in borrada!).toBe(false);
    // Y sin porción vuelve a comportarse como 100 g, como antes de la Fase 18.
    expect(servingGramsOf(borrada!)).toBe(DEFAULT_SERVING_GRAMS);
  });

  it('un nombre en blanco no borra el que había', () => {
    expect(applyCatalogEdit(base, { name: '   ' })?.name).toBe('Arroz');
  });
});

/**
 * La foto del alimento (2026-08-27).
 *
 * Es **representación**, no evidencia de macros: nada la vuelve a analizar al
 * leer el catálogo. Lo que sí exige es no perderse — una foto solo se
 * recupera volviendo a fotografiar el plato.
 */
describe('imagen del catálogo', () => {
  const base: CatalogFood = {
    key: 'pan',
    name: 'Pan',
    carbsPer100g: 50,
    proteinPer100g: 8,
    fatPer100g: 3,
    fiberPer100g: 4,
    kcalPer100g: 260,
    timesSeen: 3,
    lastSeenAt: '2026-08-20T12:00:00.000Z',
    imageUri: 'file:///pan.jpg',
  };

  it('toCatalogEntry propaga la foto de la comida analizada, sin inventarla', () => {
    const conFoto = toCatalogEntry(
      { name: 'Pan', estimatedGrams: 100, servingGrams: null, servingLabel: null, carbsG: 50, proteinG: 8, fatG: 3, fiberG: 4, caloriesKcal: 260, confidence: 0.8 },
      '2026-08-27T12:00:00.000Z',
      'file:///nueva.jpg',
    );
    expect(conFoto?.imageUri).toBe('file:///nueva.jpg');

    const sinFoto = toCatalogEntry(
      { name: 'Pan', estimatedGrams: 100, servingGrams: null, servingLabel: null, carbsG: 50, proteinG: 8, fatG: 3, fiberG: 4, caloriesKcal: 260, confidence: 0.8 },
      '2026-08-27T12:00:00.000Z',
    );
    expect(sinFoto?.imageUri).toBeUndefined();
  });

  /**
   * Un análisis por texto no trae imagen. Sin conservar la anterior, reconocer
   * el mismo alimento sin foto borraría la que ya había.
   */
  it('blendCatalogEntry conserva la foto anterior cuando la nueva no trae una', () => {
    const merged = blendCatalogEntry(base, {
      key: 'pan',
      name: 'Pan',
      carbsPer100g: 52,
      proteinPer100g: 8,
      fatPer100g: 3,
      fiberPer100g: 4,
      kcalPer100g: 262,
      lastSeenAt: '2026-08-27T12:00:00.000Z',
    });
    expect(merged.imageUri).toBe('file:///pan.jpg');
  });

  it('una foto nueva reemplaza a la anterior', () => {
    const merged = blendCatalogEntry(base, {
      key: 'pan',
      name: 'Pan',
      carbsPer100g: 50,
      proteinPer100g: 8,
      fatPer100g: 3,
      fiberPer100g: 4,
      kcalPer100g: 260,
      lastSeenAt: '2026-08-27T12:00:00.000Z',
      imageUri: 'file:///pan-2.jpg',
    });
    expect(merged.imageUri).toBe('file:///pan-2.jpg');
  });

  it('un alimento sin foto sigue siendo válido: no se le inventa una', () => {
    const { imageUri: _omitted, ...sinFoto } = base;
    void _omitted;
    const merged = blendCatalogEntry(sinFoto, {
      key: 'pan',
      name: 'Pan',
      carbsPer100g: 50,
      proteinPer100g: 8,
      fatPer100g: 3,
      fiberPer100g: 4,
      kcalPer100g: 260,
      lastSeenAt: '2026-08-27T12:00:00.000Z',
    });
    expect(merged.imageUri).toBeUndefined();
  });

  it('applyCatalogEdit conserva la foto por defecto y la quita solo con null', () => {
    expect(applyCatalogEdit(base, { name: 'Pan integral' })?.imageUri).toBe('file:///pan.jpg');
    expect(applyCatalogEdit(base, { imageUri: null })?.imageUri).toBeUndefined();
  });
});
