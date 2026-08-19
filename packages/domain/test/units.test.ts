import { describe, expect, it } from 'vitest';

import { convertGlucose, formatGlucose, formatGlucoseWithUnit } from '../src/units';

describe('convertGlucose', () => {
  it('is a no-op when both units match', () => {
    expect(convertGlucose(110, 'mg/dL', 'mg/dL')).toBe(110);
    expect(convertGlucose(6.1, 'mmol/L', 'mmol/L')).toBe(6.1);
  });

  it('converts mmol/L to whole mg/dL', () => {
    expect(convertGlucose(6.1, 'mmol/L', 'mg/dL')).toBe(110);
  });

  it('converts mg/dL to mmol/L with one decimal', () => {
    expect(convertGlucose(110, 'mg/dL', 'mmol/L')).toBe(6.1);
  });

  it('rejects a value that cannot be a real glucose reading', () => {
    expect(() => convertGlucose(0, 'mg/dL', 'mmol/L')).toThrow();
    expect(() => convertGlucose(-5, 'mg/dL', 'mmol/L')).toThrow();
    expect(() => convertGlucose(Number.NaN, 'mg/dL', 'mmol/L')).toThrow();
  });
});

describe('formatGlucose', () => {
  it('renders mg/dL as a whole number', () => {
    expect(formatGlucose(110, 'mg/dL')).toBe('110');
    expect(formatGlucose(110.4, 'mg/dL')).toBe('110');
  });

  it('renders mmol/L with exactly one decimal, including a trailing zero', () => {
    expect(formatGlucose(110, 'mmol/L')).toBe('6.1');
    // 180 mg/dL -> 9.99 mmol/L, which must not render as the bare "10".
    expect(formatGlucose(180, 'mmol/L')).toBe('10.0');
  });

  it('keeps the clinical thresholds recognizable in both units', () => {
    expect(formatGlucose(70, 'mg/dL')).toBe('70');
    expect(formatGlucose(70, 'mmol/L')).toBe('3.9');
    expect(formatGlucose(180, 'mg/dL')).toBe('180');
  });

  it('appends the unit label when asked', () => {
    expect(formatGlucoseWithUnit(110, 'mg/dL')).toBe('110 mg/dL');
    expect(formatGlucoseWithUnit(110, 'mmol/L')).toBe('6.1 mmol/L');
  });

  it('round-trips a displayed mmol/L value back to the same mg/dL reading', () => {
    // Guards the display layer against drifting from the calculation layer:
    // what the user reads has to mean the same number the app computed with.
    for (const mgDl of [54, 70, 110, 180, 250]) {
      const shown = Number(formatGlucose(mgDl, 'mmol/L'));
      expect(convertGlucose(shown, 'mmol/L', 'mg/dL')).toBeCloseTo(mgDl, -1);
    }
  });
});
