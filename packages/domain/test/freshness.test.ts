import type { CGMReading } from '@type1a/schemas';
import { describe, expect, it } from 'vitest';

import { assessFreshness, latestLiveReading, liveReadings } from '../src/index.js';

describe('CGM freshness', () => {
  const now = new Date('2026-08-12T14:00:00.000Z');

  it('marks recent source data as connected', () => {
    expect(assessFreshness('2026-08-12T13:52:00.000Z', now, 15)).toMatchObject({
      ageMinutes: 8,
      state: 'connected',
    });
  });

  it('marks old source data stale even when it was ingested now', () => {
    expect(assessFreshness('2026-08-12T13:40:00.000Z', now, 15).state).toBe('stale');
  });

  it('treats an implausible future source time as provider error', () => {
    expect(assessFreshness('2026-08-12T14:05:00.000Z', now, 15).state).toBe('provider_error');
  });
});

function reading(overrides: Partial<CGMReading>): CGMReading {
  return {
    id: 'r1',
    glucose: 120,
    unit: 'mg/dL',
    timestamp: '2026-08-12T13:58:00.000Z',
    trend: 'unknown',
    trendSource: 'unknown',
    source: 'test',
    origin: 'real',
    sourceTimestamp: '2026-08-12T13:58:00.000Z',
    ingestedAt: '2026-08-12T13:58:00.000Z',
    ...overrides,
  };
}

describe('latestLiveReading', () => {
  it('skips a trailing imported reading, even one more recent than the last live one', () => {
    const readings = [
      reading({ id: 'live-1', sourceTimestamp: '2026-08-12T13:50:00.000Z', origin: 'real' }),
      reading({ id: 'imported-1', sourceTimestamp: '2026-08-12T13:59:00.000Z', origin: 'imported' }),
    ];
    expect(latestLiveReading(readings)?.id).toBe('live-1');
  });

  it('treats synthetic readings as legitimately current (visibly labelled, not history)', () => {
    const readings = [reading({ id: 'synthetic-1', origin: 'synthetic' })];
    expect(latestLiveReading(readings)?.id).toBe('synthetic-1');
  });

  it('returns null when every reading is imported', () => {
    const readings = [reading({ origin: 'imported' })];
    expect(latestLiveReading(readings)).toBeNull();
  });

  it('returns null for an empty list', () => {
    expect(latestLiveReading([])).toBeNull();
  });
});

describe('liveReadings', () => {
  it('filters out imported readings but keeps everything else, preserving order', () => {
    const readings = [
      reading({ id: 'live-1', sourceTimestamp: '2026-08-12T13:00:00.000Z', origin: 'real' }),
      reading({ id: 'imported-1', sourceTimestamp: '2026-08-12T13:30:00.000Z', origin: 'imported' }),
      reading({ id: 'synthetic-1', sourceTimestamp: '2026-08-12T13:45:00.000Z', origin: 'synthetic' }),
      reading({ id: 'live-2', sourceTimestamp: '2026-08-12T13:59:00.000Z', origin: 'real' }),
    ];
    expect(liveReadings(readings).map((entry) => entry.id)).toEqual(['live-1', 'synthetic-1', 'live-2']);
  });

  it('returns an empty array when every reading is imported', () => {
    expect(liveReadings([reading({ origin: 'imported' })])).toEqual([]);
  });
});
