import type { CGMReading } from '@type1a/schemas';
import { describe, expect, it } from 'vitest';

import { buildAmbulatoryProfile, percentile } from '../src/index.js';

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

/** Un timestamp local a una hora dada, para no depender del huso del runtime. */
function atLocal(day: number, hour: number, minute = 0): string {
  return new Date(2026, 7, day, hour, minute, 0).toISOString();
}

describe('percentile', () => {
  it('interpolates linearly between neighbours', () => {
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0)).toBe(10);
    expect(percentile([10, 20, 30, 40], 1)).toBe(40);
  });

  it('returns the only value for a single-element sample', () => {
    expect(percentile([42], 0.05)).toBe(42);
  });

  it('rejects an empty sample rather than inventing a value', () => {
    expect(() => percentile([], 0.5)).toThrow();
  });
});

describe('buildAmbulatoryProfile', () => {
  it('returns null when there is nothing eligible to profile', () => {
    expect(buildAmbulatoryProfile([])).toBeNull();
    expect(buildAmbulatoryProfile([reading({ origin: 'synthetic' })])).toBeNull();
  });

  it('excludes synthetic readings from the percentile bands', () => {
    const profile = buildAmbulatoryProfile([
      reading({ id: '1', glucose: 100, origin: 'real', sourceTimestamp: atLocal(18, 8) }),
      reading({ id: '2', glucose: 400, origin: 'synthetic', sourceTimestamp: atLocal(18, 8) }),
    ])!;
    expect(profile.readingCount).toBe(1);
    expect(profile.excludedSyntheticCount).toBe(1);
    expect(profile.buckets).toHaveLength(1);
    expect(profile.buckets[0]!.p50).toBe(100);
  });

  it('collapses several days onto one 24h profile, bucketed by local time', () => {
    const readings: CGMReading[] = [
      reading({ id: '1', glucose: 100, sourceTimestamp: atLocal(17, 8, 5) }),
      reading({ id: '2', glucose: 200, sourceTimestamp: atLocal(18, 8, 20) }),
      reading({ id: '3', glucose: 150, sourceTimestamp: atLocal(19, 20, 0) }),
    ];
    const profile = buildAmbulatoryProfile(readings)!;
    expect(profile.daysCovered).toBe(3);
    // 08:05 and 08:20 share the 08:00-08:30 bucket; 20:00 is its own.
    expect(profile.buckets).toHaveLength(2);
    const morning = profile.buckets.find((b) => b.startMinute === 8 * 60)!;
    expect(morning.readingCount).toBe(2);
    expect(morning.p50).toBe(150);
    expect(morning.p05).toBeCloseTo(105, 5);
    expect(morning.p95).toBeCloseTo(195, 5);
  });

  it('omits buckets with no readings instead of emitting zeros', () => {
    const profile = buildAmbulatoryProfile([reading({ sourceTimestamp: atLocal(18, 3) })])!;
    expect(profile.buckets).toHaveLength(1);
    expect(profile.buckets[0]!.startMinute).toBe(3 * 60);
  });

  it('converts mmol/L before bucketing', () => {
    const profile = buildAmbulatoryProfile([
      reading({ glucose: 10, unit: 'mmol/L', sourceTimestamp: atLocal(18, 9) }),
    ])!;
    expect(profile.buckets[0]!.p50).toBe(180);
  });

  it('rejects a bucket width that does not divide the day', () => {
    expect(() => buildAmbulatoryProfile([reading({})], 7)).toThrow();
    expect(() => buildAmbulatoryProfile([reading({})], 0)).toThrow();
  });
});
