import { describe, expect, it } from 'vitest';

import { calculateCorrection, roundToIncrement } from '../src/index.js';

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
