import { describe, expect, it } from 'vitest';
import type { FoodEstimate } from '@type1a/schemas';

import {
  buildCatalogProposals,
  confirmProposal,
  initialServingGrams,
  rejectionMessage,
} from '../src/catalog-proposal';
import { blendCatalogEntry, normalizationBasis, toCatalogEntry, type CatalogFood } from '../src/food-catalog';

const AT = '2026-09-01T12:00:00.000Z';

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

/** El caso que reportó Verónica: una bebida sin gramos de plato y con 0 macros. */
const monsterZero = food({
  name: 'Monster Zero',
  estimatedGrams: null,
  servingGrams: 473,
  servingLabel: '1 lata (473 ml)',
  carbsG: 0,
  proteinG: 0,
  fatG: 0,
  fiberG: 0,
  caloriesKcal: 0,
});

describe('normalizationBasis — el denominador que faltaba', () => {
  it('prefiere los gramos del plato, que es lo que la IA midió', () => {
    expect(normalizationBasis(food({ estimatedGrams: 80, servingGrams: 30 }))).toBe(80);
  });

  it('cae a la porción típica cuando no hay gramos del plato', () => {
    expect(normalizationBasis(monsterZero)).toBe(473);
  });

  it('sigue devolviendo null cuando no hay ninguno de los dos', () => {
    expect(normalizationBasis(food({ estimatedGrams: null }))).toBeNull();
  });

  it('ignora un plato por debajo del mínimo y usa la porción', () => {
    expect(normalizationBasis(food({ estimatedGrams: 2, servingGrams: 60 }))).toBe(60);
  });
});

describe('buildCatalogProposals', () => {
  it('la Monster Zero llega al catálogo con sus ceros reales', () => {
    const { proposals, rejected } = buildCatalogProposals([monsterZero], { seenAt: AT });
    expect(rejected).toEqual([]);
    expect(proposals).toHaveLength(1);
    const [only] = proposals;
    expect(only?.basis).toBe('serving');
    expect(only?.basisGrams).toBe(473);
    // Cero declarado, no faltante: 0/473*100 sigue siendo 0.
    expect(only?.entry.carbsPer100g).toBe(0);
    expect(only?.entry.kcalPer100g).toBe(0);
    expect(only?.proposedServingGrams).toBe(473);
    expect(only?.proposedServingLabel).toBe('1 lata (473 ml)');
  });

  it('un alimento sin base se rechaza CON su razón, no en silencio', () => {
    const { proposals, rejected } = buildCatalogProposals(
      [food({ name: 'Salsa', estimatedGrams: null })],
      { seenAt: AT },
    );
    expect(proposals).toEqual([]);
    expect(rejected).toEqual([{ name: 'Salsa', reason: 'sin-base' }]);
    expect(rejectionMessage(rejected[0]!)).toContain('Salsa');
  });

  it('normaliza igual por plato que por porción cuando ambos coinciden', () => {
    const porPlato = buildCatalogProposals([food({ estimatedGrams: 50 })], { seenAt: AT });
    const porPorcion = buildCatalogProposals(
      [food({ estimatedGrams: null, servingGrams: 50 })],
      { seenAt: AT },
    );
    expect(porPorcion.proposals[0]?.entry.carbsPer100g)
      .toBe(porPlato.proposals[0]?.entry.carbsPer100g);
  });

  it('marca si el alimento ya existía: confirmar fusiona, no da de alta', () => {
    const existente: CatalogFood = {
      key: 'pan integral', name: 'Pan integral',
      carbsPer100g: 40, proteinPer100g: 10, fatPer100g: 4, fiberPer100g: 6, kcalPer100g: 260,
      timesSeen: 3, lastSeenAt: AT, servingGrams: 30, servingSource: 'user',
    };
    const { proposals } = buildCatalogProposals([food({ servingGrams: 200 })], {
      seenAt: AT,
      existingByKey: new Map([['pan integral', existente]]),
    });
    expect(proposals[0]?.existing).toBe(true);
    expect(proposals[0]?.existingServingGrams).toBe(30);
  });

  it('un alimento inverosímil se rechaza con su razón', () => {
    const { proposals, rejected } = buildCatalogProposals(
      [food({ name: 'Azúcar', estimatedGrams: 5, carbsG: 400 })],
      { seenAt: AT },
    );
    expect(proposals).toEqual([]);
    expect(rejected[0]?.reason).toBe('inverosimil');
  });

  it('dedupe por clave: el último gana', () => {
    const { proposals } = buildCatalogProposals(
      [food({ carbsG: 20 }), food({ carbsG: 25 })],
      { seenAt: AT },
    );
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.entry.carbsPer100g).toBe(50);
  });
});

describe('propuesta de duplicado y de receta', () => {
  const existente: CatalogFood = {
    key: 'manzana', name: 'Manzana',
    carbsPer100g: 14, proteinPer100g: 0.3, fatPer100g: 0.2, fiberPer100g: 2.4, kcalPer100g: 52,
    timesSeen: 4, lastSeenAt: AT,
  };

  it('marca el parecido cuando el nombre no coincide exacto', () => {
    const { proposals } = buildCatalogProposals([food({ name: 'Manzanas' })], {
      seenAt: AT,
      existingByKey: new Map([['manzana', existente]]),
    });
    expect(proposals[0]?.existing).toBe(false);
    expect(proposals[0]?.similarTo?.food.name).toBe('Manzana');
    expect(proposals[0]?.similarTo?.reason).toBe('mismas-palabras');
  });

  it('no marca parecido cuando ya es el mismo por clave: la fusión ya es un hecho', () => {
    const { proposals } = buildCatalogProposals([food({ name: 'Manzana' })], {
      seenAt: AT,
      existingByKey: new Map([['manzana', existente]]),
    });
    expect(proposals[0]?.existing).toBe(true);
    expect(proposals[0]?.similarTo).toBeNull();
  });

  it('propone nombre de receta solo con más de un alimento', () => {
    const uno = buildCatalogProposals([food({ name: 'Arroz' })], { seenAt: AT });
    expect(uno.suggestedRecipeName).toBeUndefined();

    const dos = buildCatalogProposals(
      [food({ name: 'Arroz' }), food({ name: 'Pollo' })],
      { seenAt: AT },
    );
    expect(dos.suggestedRecipeName).toBe('Arroz con Pollo');
  });

  it('conserva la foto del plato para que la receta la herede', () => {
    const set = buildCatalogProposals([food()], { seenAt: AT, imageUri: 'file:///plato.jpg' });
    expect(set.imageUri).toBe('file:///plato.jpg');
  });
});

describe('initialServingGrams — lo de la usuaria manda sobre lo de la IA', () => {
  it('precarga la porción que ella ya había fijado, no la nueva propuesta', () => {
    const existente: CatalogFood = {
      key: 'pan integral', name: 'Pan integral',
      carbsPer100g: 40, proteinPer100g: 10, fatPer100g: 4, fiberPer100g: 6, kcalPer100g: 260,
      timesSeen: 3, lastSeenAt: AT, servingGrams: 30, servingSource: 'user',
    };
    const { proposals } = buildCatalogProposals([food({ servingGrams: 200 })], {
      seenAt: AT,
      existingByKey: new Map([['pan integral', existente]]),
    });
    expect(initialServingGrams(proposals[0]!)).toBe(30);
  });

  it('usa la de la IA cuando el alimento es nuevo', () => {
    const { proposals } = buildCatalogProposals([food({ servingGrams: 200 })], { seenAt: AT });
    expect(initialServingGrams(proposals[0]!)).toBe(200);
  });
});

describe('confirmProposal', () => {
  it('lo confirmado queda marcado como de la usuaria, aunque no cambiara el número', () => {
    const { proposals } = buildCatalogProposals([monsterZero], { seenAt: AT });
    const entry = confirmProposal(proposals[0]!, { servingGrams: 473, servingLabel: '1 lata (473 ml)' });
    expect(entry?.servingGrams).toBe(473);
    expect(entry?.servingSource).toBe('user');
  });

  it('confirmar sin porción es válido: hay alimentos sin porción convencional', () => {
    const { proposals } = buildCatalogProposals([food()], { seenAt: AT });
    const entry = confirmProposal(proposals[0]!, { servingGrams: null, servingLabel: null });
    expect(entry).not.toBeNull();
    expect(entry?.servingGrams).toBeUndefined();
    expect(entry?.servingSource).toBeUndefined();
  });

  it('una porción imposible se rechaza en vez de guardarse', () => {
    const { proposals } = buildCatalogProposals([food()], { seenAt: AT });
    expect(confirmProposal(proposals[0]!, { servingGrams: 99_999, servingLabel: null })).toBeNull();
  });
});

describe('la porción de la usuaria sobrevive a un análisis nuevo', () => {
  const suya: CatalogFood = {
    key: 'pan integral', name: 'Pan integral',
    carbsPer100g: 40, proteinPer100g: 10, fatPer100g: 4, fiberPer100g: 6, kcalPer100g: 260,
    timesSeen: 3, lastSeenAt: AT, servingGrams: 150, servingLabel: 'una taza', servingSource: 'user',
  };

  it('una propuesta sin confirmar NO pisa su "una taza son 150 g"', () => {
    const deLaIA = toCatalogEntry(food({ servingGrams: 30, servingLabel: '1 rebanada' }), AT)!;
    expect(deLaIA.servingSource).toBe('ai');
    const merged = blendCatalogEntry(suya, deLaIA);
    expect(merged.servingGrams).toBe(150);
    expect(merged.servingLabel).toBe('una taza');
  });

  it('pero una confirmación suya sí la reemplaza', () => {
    const { proposals } = buildCatalogProposals([food({ servingGrams: 30, servingLabel: '1 rebanada' })], {
      seenAt: AT,
      existingByKey: new Map([['pan integral', suya]]),
    });
    const confirmada = confirmProposal(proposals[0]!, { servingGrams: 30, servingLabel: '1 rebanada' })!;
    const merged = blendCatalogEntry(suya, confirmada);
    expect(merged.servingGrams).toBe(30);
    expect(merged.servingSource).toBe('user');
  });

  it('una fila sin `servingSource` (anterior al campo) se protege igual', () => {
    const vieja: CatalogFood = { ...suya };
    delete vieja.servingSource;
    const deLaIA = toCatalogEntry(food({ servingGrams: 30 }), AT)!;
    expect(blendCatalogEntry(vieja, deLaIA).servingGrams).toBe(150);
  });
});
