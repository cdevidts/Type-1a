import { describe, expect, it } from 'vitest';

import {
  findCatalogInsulin,
  INSULIN_CATALOG,
  insulinsByCategory,
  isPlausibleInsulinDuration,
  MAX_INSULIN_DURATION_HOURS,
  MIN_INSULIN_DURATION_HOURS,
  rapidInsulinLookbackMinutes,
} from '../src/insulin-catalog';

describe('INSULIN_CATALOG', () => {
  it('incluye las insulinas que Verónica pidió explícitamente', () => {
    // Pedido textual (2026-08-25): "insulinas que no pueden faltar:
    // novorapid, fiasp [...] tresiba, lentus [Lantus]".
    for (const id of ['novorapid', 'fiasp', 'tresiba', 'lantus']) {
      expect(findCatalogInsulin(id), id).toBeDefined();
    }
  });

  it('los ids son únicos y estables', () => {
    // Se guardan en la base: renombrar uno dejaría huérfano el perfil ya
    // guardado en el teléfono.
    const ids = INSULIN_CATALOG.map((insulin) => insulin.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('toda duración del catálogo es plausible', () => {
    for (const insulin of INSULIN_CATALOG) {
      expect(isPlausibleInsulinDuration(insulin.durationHours), insulin.id).toBe(true);
    }
  });

  it('separa rápidas de basales, y las basales duran mucho más', () => {
    const rapid = insulinsByCategory('rapid');
    const basal = insulinsByCategory('basal');
    expect(rapid.length).toBeGreaterThanOrEqual(5);
    expect(basal.length).toBeGreaterThanOrEqual(4);
    // La rápida más larga (regular humana, 8 h) sigue siendo más corta que la
    // basal más corta (24 h). Si esto se rompe, alguien mezcló categorías.
    expect(Math.max(...rapid.map((i) => i.durationHours)))
      .toBeLessThan(Math.min(...basal.map((i) => i.durationHours)));
  });

  it('Tresiba dura bastante más que Lantus', () => {
    // No es un detalle: usar 24 h para alguien con Tresiba sería mirar poco
    // más de la mitad de la ventana real.
    expect(findCatalogInsulin('tresiba')!.durationHours)
      .toBeGreaterThan(findCatalogInsulin('lantus')!.durationHours);
  });

  it('la regular humana dura más que las análogas rápidas', () => {
    const regular = findCatalogInsulin('regular')!;
    for (const id of ['novorapid', 'fiasp', 'humalog', 'apidra']) {
      expect(regular.durationHours).toBeGreaterThan(findCatalogInsulin(id)!.durationHours);
    }
  });
});

describe('rapidInsulinLookbackMinutes', () => {
  it('sin insulina elegida NO inventa un default', () => {
    // Lo más importante del módulo: un 5 supuesto excluiría episodios por una
    // suposición que nadie confirmó, y el resultado se lee como patrón.
    expect(rapidInsulinLookbackMinutes({})).toBeUndefined();
    expect(rapidInsulinLookbackMinutes({ rapidInsulinDurationHours: undefined })).toBeUndefined();
  });

  it('convierte horas a minutos', () => {
    expect(rapidInsulinLookbackMinutes({ rapidInsulinDurationHours: 5 })).toBe(300);
    expect(rapidInsulinLookbackMinutes({ rapidInsulinDurationHours: 8 })).toBe(480);
  });

  it('un valor fuera de rango se ignora en vez de aplicarse', () => {
    expect(rapidInsulinLookbackMinutes({ rapidInsulinDurationHours: 0.1 })).toBeUndefined();
    expect(rapidInsulinLookbackMinutes({ rapidInsulinDurationHours: 500 })).toBeUndefined();
    expect(rapidInsulinLookbackMinutes({ rapidInsulinDurationHours: Number.NaN })).toBeUndefined();
  });

  it('los límites son inclusivos', () => {
    expect(isPlausibleInsulinDuration(MIN_INSULIN_DURATION_HOURS)).toBe(true);
    expect(isPlausibleInsulinDuration(MAX_INSULIN_DURATION_HOURS)).toBe(true);
  });
});
