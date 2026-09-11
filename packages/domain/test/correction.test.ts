import { describe, expect, it } from 'vitest';

import { calculateCorrection, calculateMealBolus, roundToIncrement } from '../src/index.js';

describe('correction calculator', () => {
  it('uses only explicit parameters and rounds to the configured increment', () => {
    expect(
      calculateCorrection({
        currentGlucose: 210,
        targetGlucose: 110,
        correctionFactor: 45,
        doseIncrement: 0.5,
      }),
    ).toMatchObject({ rawUnits: 100 / 45, roundedUnits: 2, isBelowTarget: false });
  });

  it('flags hypoglycemia separately from being under target, without changing the units', () => {
    const params = { targetGlucose: 110, correctionFactor: 45, doseIncrement: 0.5 } as const;
    expect(calculateCorrection({ ...params, currentGlucose: 95 })).toMatchObject({
      isBelowTarget: true,
      isHypoglycemic: false,
      roundedUnits: 0,
    });
    expect(calculateCorrection({ ...params, currentGlucose: 55 })).toMatchObject({
      isBelowTarget: true,
      isHypoglycemic: true,
      roundedUnits: 0,
    });
    expect(calculateCorrection({ ...params, currentGlucose: 210 }).isHypoglycemic).toBe(false);
  });

  it('never returns negative insulin', () => {
    expect(
      calculateCorrection({
        currentGlucose: 75,
        targetGlucose: 110,
        correctionFactor: 45,
        doseIncrement: 0.5,
      }).roundedUnits,
    ).toBe(0);
  });

  it.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid correction factor: %s',
    (correctionFactor) => {
      expect(() =>
        calculateCorrection({
          currentGlucose: 210,
          targetGlucose: 110,
          correctionFactor,
          doseIncrement: 0.5,
        }),
      ).toThrow();
    },
  );

  it('rejects invalid increments', () => {
    expect(() => roundToIncrement(2, 0)).toThrow();
  });
});

describe('IOB en la corrección suelta (2026-09-02)', () => {
  const base = { targetGlucose: 110, correctionFactor: 50, doseIncrement: 0.5 };

  it('descuenta lo que sigue actuando', () => {
    const result = calculateCorrection({ ...base, currentGlucose: 260, activeInsulinUnits: 1.5 });
    expect(result.beforeActiveUnits).toBe(3);
    expect(result.activeInsulinUnits).toBe(1.5);
    expect(result.rawUnits).toBe(1.5);
    expect(result.roundedUnits).toBe(1.5);
    expect(result.formula).toContain('1.5 U activas');
  });

  it('si ya tienes de sobra, propone 0 — no un número negativo', () => {
    const result = calculateCorrection({ ...base, currentGlucose: 160, activeInsulinUnits: 5 });
    expect(result.rawUnits).toBe(0);
    expect(result.roundedUnits).toBe(0);
    // Y no miente sobre la glucosa: 160 sigue estando sobre objetivo.
    expect(result.isBelowTarget).toBe(false);
  });

  it('sin insulina configurada se comporta exactamente como antes', () => {
    const desconocido = calculateCorrection({ ...base, currentGlucose: 260 });
    expect(desconocido.rawUnits).toBe(3);
    expect(desconocido.activeInsulinUnits).toBeUndefined();
    expect(desconocido.formula).not.toContain('activas');
  });

  it('sigue coincidiendo con calculateMealBolus a 0 g de carbohidratos', () => {
    // El invariante que ya existía, ahora también con IOB en el medio.
    const solo = calculateCorrection({ ...base, currentGlucose: 240, activeInsulinUnits: 1 });
    const conCarbos0 = calculateMealBolus({
      ...base, carbsG: 0, carbRatio: 10, currentGlucose: 240, activeInsulinUnits: 1,
    });
    expect(solo.roundedUnits).toBe(conCarbos0.totalRoundedUnits);
  });
});
