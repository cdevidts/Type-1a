import { describe, expect, it } from 'vitest';

import { assessFreshness } from '../src/index.js';

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
