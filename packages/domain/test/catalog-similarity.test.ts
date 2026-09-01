import { describe, expect, it } from 'vitest';

import type { CatalogFood } from '../src/food-catalog';
import {
  findSimilarFood,
  matchAnalysedFoods,
  significantTokens,
  similarityLabel,
  singularize,
} from '../src/catalog-similarity';

const AT = '2026-09-01T12:00:00.000Z';

function food(name: string, over: Partial<CatalogFood> = {}): CatalogFood {
  return {
    key: name.toLowerCase(), name,
    carbsPer100g: 20, proteinPer100g: 5, fatPer100g: 2, fiberPer100g: 1, kcalPer100g: 120,
    timesSeen: 1, lastSeenAt: AT,
    ...over,
  };
}

describe('singularize — conservador a propósito', () => {
  it('quita la -s tras vocal', () => {
    expect(singularize('manzanas')).toBe('manzana');
  });

  it('quita el -es tras consonante', () => {
    expect(singularize('panes')).toBe('pan');
  });

  it('no toca palabras cortas, donde el riesgo de confundir es alto', () => {
    expect(singularize('mes')).toBe('mes');
    expect(singularize('pan')).toBe('pan');
  });
});

describe('significantTokens', () => {
  it('ignora el orden y las palabras de unión', () => {
    expect(significantTokens('Arroz con pollo')).toEqual(significantTokens('pollo y arroz'));
  });

  it('ignora acentos y mayúsculas, como `foodKey`', () => {
    expect(significantTokens('Plátano')).toEqual(significantTokens('platano'));
  });
});

describe('findSimilarFood', () => {
  const catalogo = [food('Arroz'), food('Pollo'), food('Manzana')];

  it('la coincidencia exacta siempre gana', () => {
    const hit = findSimilarFood('arroz', catalogo);
    expect(hit?.reason).toBe('exacto');
    expect(hit?.food.name).toBe('Arroz');
  });

  it('empareja singular con plural', () => {
    const hit = findSimilarFood('Manzanas', catalogo);
    expect(hit?.reason).toBe('mismas-palabras');
    expect(hit?.food.name).toBe('Manzana');
  });

  it('empareja el mismo plato con las palabras en otro orden', () => {
    const conRecetas = [food('Arroz con pollo')];
    expect(findSimilarFood('Pollo con arroz', conRecetas)?.food.name).toBe('Arroz con pollo');
  });

  it('NO empareja por subconjunto: "arroz integral" no es "arroz"', () => {
    expect(findSimilarFood('Arroz integral', catalogo)).toBeNull();
  });

  it('NO empareja palabras distintas de largo parecido', () => {
    expect(findSimilarFood('Pera', [food('Pena')])).toBeNull();
  });

  it('devuelve null cuando no hay nada parecido', () => {
    expect(findSimilarFood('Quinoa', catalogo)).toBeNull();
  });

  it('desempata por el más usado: es el que ella ya viene reutilizando', () => {
    const dos = [food('Panes', { key: 'panes', timesSeen: 1 }), food('Pan', { key: 'pan', timesSeen: 9 })];
    expect(findSimilarFood('pan', dos)?.food.name).toBe('Pan');
    // "panes" normaliza al mismo token que "pan"; gana el de más usos.
    expect(findSimilarFood('panecillos', dos)).toBeNull();
  });

  it('cada razón tiene texto propio para la usuaria', () => {
    expect(similarityLabel('exacto')).toContain('Ya tienes');
    expect(similarityLabel('mismas-palabras')).toContain('parece');
  });
});

describe('matchAnalysedFoods — armar una receta con lo que ya existe', () => {
  const catalogo = [food('Arroz'), food('Pollo')];

  it('separa lo que ya existe de lo que habría que dar de alta', () => {
    const result = matchAnalysedFoods(['Arroz', 'Pollo', 'Salsa de soya'], catalogo);
    expect(result.matched.map((m) => m.similar.food.name)).toEqual(['Arroz', 'Pollo']);
    expect(result.unmatched).toEqual(['Salsa de soya']);
  });

  it('un alimento del catálogo no cubre dos líneas del análisis', () => {
    // Si la foto trae "arroz" y "arroces", emparejar los dos con el mismo
    // `Arroz` colapsaría dos líneas distintas en una.
    const result = matchAnalysedFoods(['Arroz', 'Arroces'], catalogo);
    expect(result.matched).toHaveLength(1);
    expect(result.unmatched).toEqual(['Arroces']);
  });

  it('sin catálogo, todo queda por dar de alta', () => {
    expect(matchAnalysedFoods(['Arroz'], []).unmatched).toEqual(['Arroz']);
  });
});
