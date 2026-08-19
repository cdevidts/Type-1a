import type { CGMReading } from '@type1a/schemas';
import { describe, expect, it } from 'vitest';

import { estimateA1cFromMeanGlucose, summarizeGlucose } from '../src/index.js';

function reading(overrides: Partial<CGMReading>): CGMReading {
  return {
    id: 'r1',
    glucose: 120,
    unit: 'mg/dL',
    timestamp: '2026-08-18T10:00:00.000Z',
    trend: 'stable',
    trendSource: 'provider',
    source: 'freestyle_libre',
    origin: 'real',
    sourceTimestamp: '2026-08-18T10:00:00.000Z',
    ingestedAt: '2026-08-18T10:00:05.000Z',
    ...overrides,
  };
}

describe('estimateA1cFromMeanGlucose', () => {
  it('applies the GMI formula (Bergenstal et al. 2018)', () => {
    // 3.31 + 0.02392 * 154 = 6.99
    expect(estimateA1cFromMeanGlucose(154)).toBeCloseTo(6.994, 3);
  });

  it('rejects non-positive or non-finite input', () => {
    expect(() => estimateA1cFromMeanGlucose(0)).toThrow();
    expect(() => estimateA1cFromMeanGlucose(-5)).toThrow();
    expect(() => estimateA1cFromMeanGlucose(Number.NaN)).toThrow();
  });
});

describe('summarizeGlucose', () => {
  it('returns null for an empty reading set', () => {
    expect(summarizeGlucose([])).toBeNull();
  });

  it('excludes synthetic readings from every computed statistic', () => {
    const real = reading({ id: 'r1', glucose: 100, origin: 'real' });
    const synthetic = reading({ id: 's1', glucose: 400, origin: 'synthetic' });
    const summary = summarizeGlucose([real, synthetic]);
    expect(summary).not.toBeNull();
    expect(summary!.readingCount).toBe(1);
    expect(summary!.excludedSyntheticCount).toBe(1);
    expect(summary!.meanGlucoseMgDl).toBe(100);
  });

  it('returns null when every reading is synthetic', () => {
    const summary = summarizeGlucose([reading({ origin: 'synthetic' })]);
    expect(summary).toBeNull();
  });

  it('converts mmol/L readings to mg/dL before aggregating', () => {
    // 10 mmol/L * 18.0182 = 180.182, and convertGlucose rounds mmol/L->mg/dL to the nearest integer.
    const summary = summarizeGlucose([reading({ glucose: 10, unit: 'mmol/L' })]);
    expect(summary!.meanGlucoseMgDl).toBe(180);
  });

  it('buckets readings into the ATTD/ADA Time in Range bands', () => {
    const readings: CGMReading[] = [
      reading({ id: '1', glucose: 40 }), // very low
      reading({ id: '2', glucose: 60 }), // low
      reading({ id: '3', glucose: 120 }), // target
      reading({ id: '4', glucose: 200 }), // high
      reading({ id: '5', glucose: 300 }), // very high
    ];
    const summary = summarizeGlucose(readings)!;
    expect(summary.range.veryLowPct).toBe(20);
    expect(summary.range.lowPct).toBe(20);
    expect(summary.range.targetPct).toBe(20);
    expect(summary.range.highPct).toBe(20);
    expect(summary.range.veryHighPct).toBe(20);
    const total =
      summary.range.veryLowPct + summary.range.lowPct + summary.range.targetPct +
      summary.range.highPct + summary.range.veryHighPct;
    expect(total).toBeCloseTo(100, 6);
  });

  it('treats the 70 and 180 mg/dL band edges as inclusive of target', () => {
    const summary = summarizeGlucose([
      reading({ id: '1', glucose: 70 }),
      reading({ id: '2', glucose: 180 }),
    ])!;
    expect(summary.range.targetPct).toBe(100);
  });

  it('counts distinct local calendar days covered', () => {
    const summary = summarizeGlucose([
      reading({ id: '1', sourceTimestamp: '2026-08-17T23:50:00.000Z' }),
      reading({ id: '2', sourceTimestamp: '2026-08-18T00:10:00.000Z' }),
      reading({ id: '3', sourceTimestamp: '2026-08-18T12:00:00.000Z' }),
    ])!;
    expect(summary.daysCovered).toBe(2);
  });

  it('computes coefficient of variation from mean and standard deviation', () => {
    const summary = summarizeGlucose([
      reading({ id: '1', glucose: 100 }),
      reading({ id: '2', glucose: 100 }),
    ])!;
    expect(summary.standardDeviationMgDl).toBe(0);
    expect(summary.coefficientOfVariationPct).toBe(0);
  });
});
