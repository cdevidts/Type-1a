import { describe, expect, it } from 'vitest';

import { calculateCorrection, calculateMealBolus } from '../src/index.js';

const BASE = {
  carbRatio: 10,
  targetGlucose: 110,
  correctionFactor: 45,
  doseIncrement: 0.5,
} as const;

describe('meal + correction bolus calculator', () => {
  it('adds carb coverage and correction, rounding only the total', () => {
    const result = calculateMealBolus({ ...BASE, carbsG: 60, currentGlucose: 200 });
    expect(result.mealUnits).toBe(6);
    expect(result.correctionUnits).toBeCloseTo(90 / 45, 10);
    expect(result.totalRawUnits).toBeCloseTo(8, 10);
    expect(result.totalRoundedUnits).toBe(8);
    expect(result).toMatchObject({ correctionApplied: true, isBelowTarget: false });
  });

  it('lets a below-target glucose reduce the meal dose instead of ignoring it', () => {
    const result = calculateMealBolus({ ...BASE, carbsG: 60, currentGlucose: 65 });
    expect(result.correctionUnits).toBeCloseTo(-1, 10);
    expect(result.totalRawUnits).toBeCloseTo(5, 10);
    expect(result.totalRoundedUnits).toBe(5);
    expect(result.isBelowTarget).toBe(true);
  });

  it('never returns a negative total, even when the correction outweighs the carbs', () => {
    const result = calculateMealBolus({ ...BASE, carbsG: 5, currentGlucose: 50 });
    expect(result.correctionUnits).toBeLessThan(0);
    expect(result.totalRawUnits).toBe(0);
    expect(result.totalRoundedUnits).toBe(0);
  });

  it('skips the correction half entirely when no current glucose is supplied', () => {
    const result = calculateMealBolus({ ...BASE, carbsG: 45 });
    expect(result.correctionApplied).toBe(false);
    expect(result.correctionUnits).toBe(0);
    expect(result.correctionFormula).toBeNull();
    expect(result.totalRawUnits).toBe(4.5);
    expect(result.totalRoundedUnits).toBe(4.5);
  });

  it('handles a carbs-only entry of zero grams as zero units', () => {
    const result = calculateMealBolus({ ...BASE, carbsG: 0, currentGlucose: 110 });
    expect(result.totalRoundedUnits).toBe(0);
  });

  it('rounds to the configured pen increment, not to whole units', () => {
    expect(calculateMealBolus({ ...BASE, doseIncrement: 1, carbsG: 34 }).totalRoundedUnits).toBe(3);
    expect(calculateMealBolus({ ...BASE, doseIncrement: 0.5, carbsG: 34 }).totalRoundedUnits).toBe(3.5);
  });

  it('reports both formulas so the UI can show its work', () => {
    const result = calculateMealBolus({ ...BASE, carbsG: 60, currentGlucose: 200 });
    expect(result.mealFormula).toBe('60 g ÷ 10 g/U');
    expect(result.correctionFormula).toBe('(200 − 110) ÷ 45');
  });

  it('flags hypoglycemia separately from merely being under target', () => {
    const underTarget = calculateMealBolus({ ...BASE, carbsG: 60, currentGlucose: 95 });
    expect(underTarget.isBelowTarget).toBe(true);
    expect(underTarget.isHypoglycemic).toBe(false);

    const low = calculateMealBolus({ ...BASE, carbsG: 60, currentGlucose: 58 });
    expect(low.isBelowTarget).toBe(true);
    expect(low.isHypoglycemic).toBe(true);

    // The threshold itself is not a dose input: the units are unchanged by
    // the flag, it only tells the UI to say "treat the low first".
    expect(low.totalRawUnits).toBeCloseTo(6 + (58 - 110) / 45, 10);
  });

  it('puts the hypoglycemia boundary at strictly under 70', () => {
    expect(calculateMealBolus({ ...BASE, carbsG: 30, currentGlucose: 69.9 }).isHypoglycemic).toBe(true);
    expect(calculateMealBolus({ ...BASE, carbsG: 30, currentGlucose: 70 }).isHypoglycemic).toBe(false);
    const correctionParams = { targetGlucose: 110, correctionFactor: 45, doseIncrement: 0.5 } as const;
    expect(calculateCorrection({ ...correctionParams, currentGlucose: 69.9 }).isHypoglycemic).toBe(true);
    expect(calculateCorrection({ ...correctionParams, currentGlucose: 70 }).isHypoglycemic).toBe(false);
  });

  it('never reports hypoglycemia when no glucose was supplied', () => {
    expect(calculateMealBolus({ ...BASE, carbsG: 60 }).isHypoglycemic).toBe(false);
  });

  it('agrees exactly with calculateCorrection when there are no carbs', () => {
    // The seam between the two calculators the UI picks between. If this
    // ever diverges, the same glucose yields two different doses depending
    // on whether the carbs field held "" or "0".
    for (const currentGlucose of [50, 70, 110, 180, 260]) {
      const params = { targetGlucose: 110, correctionFactor: 45, doseIncrement: 0.5 } as const;
      const bolus = calculateMealBolus({ ...params, carbRatio: 10, carbsG: 0, currentGlucose });
      const correction = calculateCorrection({ ...params, currentGlucose });
      expect(bolus.totalRoundedUnits).toBe(correction.roundedUnits);
      expect(bolus.totalRawUnits).toBeCloseTo(correction.rawUnits, 10);
    }
  });

  it('rejects therapy parameters that are missing, zero, or negative', () => {
    expect(() => calculateMealBolus({ ...BASE, carbRatio: 0, carbsG: 30 })).toThrow();
    expect(() => calculateMealBolus({ ...BASE, correctionFactor: -45, carbsG: 30 })).toThrow();
    expect(() => calculateMealBolus({ ...BASE, carbsG: -1 })).toThrow();
    expect(() => calculateMealBolus({ ...BASE, doseIncrement: 2, carbsG: 30 })).toThrow();
  });
});

describe('IOB: el bolo descuenta la insulina activa (2026-09-02)', () => {
  const base = { carbsG: 60, carbRatio: 10, targetGlucose: 110, correctionFactor: 50, doseIncrement: 0.5 };

  it('EL CASO QUE ORIGINÓ ESTO: la segunda comida no vuelve a corregir entera', () => {
    // Comida chica + corrección a las 13:00 → deja ~2,7 U activas.
    // Comida grande a las 13:05 con la glucosa todavía alta.
    const sinIob = calculateMealBolus({ ...base, currentGlucose: 260 });
    const conIob = calculateMealBolus({ ...base, currentGlucose: 260, activeInsulinUnits: 2.7 });
    // Antes proponía la corrección completa otra vez: eso es stacking.
    expect(sinIob.totalRawUnits).toBeCloseTo(9, 5);
    expect(conIob.totalRawUnits).toBeCloseTo(6.3, 5);
    expect(conIob.totalRoundedUnits).toBe(6.5);
  });

  it('LA REGLA DURA: el IOB sale de la corrección, NUNCA de la comida', () => {
    // 60 g siguen necesitando sus 6 U aunque haya 10 U activas. Restarlas de
    // los carbohidratos dejaría corta la cobertura del plato.
    const result = calculateMealBolus({ ...base, currentGlucose: 110, activeInsulinUnits: 10 });
    expect(result.mealUnits).toBe(6);
    // La corrección era 0 y queda en −10, así que el total baja... pero por
    // la corrección, no porque se haya tocado la comida.
    expect(result.correctionUnits).toBe(0);
    expect(result.correctionAfterActiveUnits).toBe(-10);
  });

  it('el total nunca baja de 0 por mucha insulina activa que haya', () => {
    const result = calculateMealBolus({ ...base, currentGlucose: 120, activeInsulinUnits: 50 });
    expect(result.totalRawUnits).toBe(0);
    expect(result.totalRoundedUnits).toBe(0);
  });

  it('sin insulina configurada no se resta nada y el resultado es el de siempre', () => {
    // "No sé cuánta hay activa" nunca puede convertirse en "hay 0".
    const desconocido = calculateMealBolus({ ...base, currentGlucose: 200 });
    const cero = calculateMealBolus({ ...base, currentGlucose: 200, activeInsulinUnits: 0 });
    expect(desconocido.totalRawUnits).toBe(cero.totalRawUnits);
    expect(desconocido.activeInsulinUnits).toBeUndefined();
    expect(cero.activeInsulinUnits).toBe(0);
  });

  it('expone el desglose entero para que la pantalla pueda mostrarlo', () => {
    const result = calculateMealBolus({ ...base, currentGlucose: 210, activeInsulinUnits: 1.5 });
    expect(result.mealUnits).toBe(6);
    expect(result.correctionUnits).toBe(2);
    expect(result.activeInsulinUnits).toBe(1.5);
    expect(result.correctionAfterActiveUnits).toBe(0.5);
    expect(result.totalRawUnits).toBe(6.5);
    expect(result.correctionFormula).toContain('1.5 U activas');
  });

  it('isBelowTarget sigue describiendo la GLUCOSA, no el resultado de la resta', () => {
    // Estar en objetivo con insulina activa no es "estar bajo objetivo": son
    // dos avisos distintos y la pantalla los dice distinto.
    const result = calculateMealBolus({ ...base, currentGlucose: 110, activeInsulinUnits: 3 });
    expect(result.isBelowTarget).toBe(false);
    expect(result.correctionAfterActiveUnits).toBeLessThan(0);
  });
});
