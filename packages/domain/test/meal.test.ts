import type { CGMReading, InsulinEvent } from '@type1a/schemas';
import { describe, expect, it } from 'vitest';

import {
  calculateMealEpisodeMetrics,
  containsTherapyRecommendation,
  findRapidInsulinCandidates,
} from '../src/index.js';

function reading(minutes: number, glucose: number): CGMReading {
  const timestamp = new Date(Date.parse('2026-08-12T12:00:00.000Z') + minutes * 60_000).toISOString();
  return {
    id: `${minutes}`,
    glucose,
    unit: 'mg/dL',
    timestamp,
    trend: 'unknown',
    trendSource: 'unknown',
    source: 'test',
    origin: 'synthetic',
    sourceTimestamp: timestamp,
    ingestedAt: timestamp,
  };
}

describe('meal episodes', () => {
  it('computes episode metrics deterministically', () => {
    const metrics = calculateMealEpisodeMetrics({
      mealTimestamp: '2026-08-12T12:00:00.000Z',
      readings: [reading(0, 108), reading(60, 151), reading(96, 172), reading(120, 167), reading(180, 131)],
      confirmedCarbsG: 64,
    });

    expect(metrics).toMatchObject({
      startingGlucose: 108,
      glucose60: 151,
      glucose120: 167,
      glucose180: 131,
      peakGlucose: 172,
      peakDelta: 64,
      timeToPeakMinutes: 96,
      confirmedCarbsG: 64,
      readingCount: 5,
    });
  });

  it('requires confirmation when multiple rapid events could match a meal', () => {
    const events: InsulinEvent[] = [-20, -5].map((minutes, index) => ({
      id: `i-${index}`,
      timestamp: new Date(Date.parse('2026-08-12T12:00:00.000Z') + minutes * 60_000).toISOString(),
      type: 'rapid',
      units: 2 + index,
      source: 'manual',
      createdAt: '2026-08-12T12:00:00.000Z',
    }));

    expect(findRapidInsulinCandidates('2026-08-12T12:00:00.000Z', events)).toMatchObject({
      candidateIds: ['i-1', 'i-0'],
      recommendedId: 'i-1',
      requiresConfirmation: true,
    });
  });
});

describe('AI safety', () => {
  it('detects a dose-changing recommendation', () => {
    expect(containsTherapyRecommendation('La próxima vez ponte 2 U más.')).toBe(true);
  });

  it('allows descriptive glucose observations', () => {
    expect(
      containsTherapyRecommendation('La glucosa alcanzó 172 mg/dL a los 96 minutos.'),
    ).toBe(false);
  });
});
