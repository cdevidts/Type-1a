import type { CGMReading, InsulinEvent } from '@type1a/schemas';
import { describe, expect, it } from 'vitest';

import {
  calculateMealEpisodeMetrics,
  containsTherapyRecommendation,
  findRapidInsulinCandidates,
} from '../src/index.js';

function reading(minutes: number, glucose: number, overrides: Partial<CGMReading> = {}): CGMReading {
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
    ...overrides,
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

  it('normalizes mmol/L readings to mg/dL before computing any metric — never mixes units in one episode', () => {
    // 6 mmol/L * 18.0182 = 108.1 -> convertGlucose rounds mg/dL to the
    // nearest integer, matching the mg/dL fixture above (108) exactly.
    const metrics = calculateMealEpisodeMetrics({
      mealTimestamp: '2026-08-12T12:00:00.000Z',
      readings: [
        reading(0, 6, { unit: 'mmol/L' }),
        reading(60, 151),
        reading(96, 172),
        reading(120, 167),
        reading(180, 131),
      ],
      confirmedCarbsG: 64,
    });

    expect(metrics.startingGlucose).toBe(108);
    expect(metrics.peakGlucose).toBe(172);
    expect(metrics.peakDelta).toBe(64);
  });

  it('compares mmol/L readings against the mg/dL range thresholds correctly, not just labels them wrong', () => {
    // 3 mmol/L ~= 54 mg/dL (below the default 70 mg/dL low threshold) and
    // 12 mmol/L ~= 216 mg/dL (above the default 180 mg/dL high threshold).
    // Before normalizing, these raw numbers (3, 12) would never trip either
    // threshold, silently hiding a real hypo/hyper from timeAbove/BelowRange.
    const metrics = calculateMealEpisodeMetrics({
      mealTimestamp: '2026-08-12T12:00:00.000Z',
      readings: [
        reading(0, 8, { unit: 'mmol/L' }),
        reading(5, 3, { unit: 'mmol/L' }),
        reading(10, 12, { unit: 'mmol/L' }),
      ],
    });

    expect(metrics.timeBelowRangeMinutes).toBeGreaterThan(0);
    expect(metrics.timeAboveRangeMinutes).toBeGreaterThan(0);
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

describe('contextEvents dentro de MealEpisodeMetrics (Fase 23)', () => {
  // Este objeto es EL payload que se serializa hacia el servicio de IA
  // externo, así que lo que entra acá sale del dispositivo.
  const readings: CGMReading[] = [
    { id: 'r0', glucose: 120, unit: 'mg/dL', timestamp: '2026-08-22T12:00:00.000Z', trend: 'stable', trendSource: 'provider', source: 'test', origin: 'real', sourceTimestamp: '2026-08-22T12:00:00.000Z', ingestedAt: '2026-08-22T12:00:00.000Z' },
    { id: 'r1', glucose: 180, unit: 'mg/dL', timestamp: '2026-08-22T14:00:00.000Z', trend: 'stable', trendSource: 'provider', source: 'test', origin: 'real', sourceTimestamp: '2026-08-22T14:00:00.000Z', ingestedAt: '2026-08-22T14:00:00.000Z' },
  ];

  it('viaja con las métricas y no altera ningún cálculo', () => {
    const withContext = calculateMealEpisodeMetrics({
      mealTimestamp: '2026-08-22T12:00:00.000Z',
      readings,
      contextEvents: [{ kind: 'rapid_insulin', timestamp: '2026-08-22T13:30:00.000Z', minutesAfterAnchor: 90, amount: 2 }],
    });
    const without = calculateMealEpisodeMetrics({ mealTimestamp: '2026-08-22T12:00:00.000Z', readings });

    expect(withContext.contextEvents).toHaveLength(1);
    // Descriptivo: ninguna métrica cambia por tener contexto.
    const metricsWithout = { ...withContext };
    delete metricsWithout.contextEvents;
    expect(metricsWithout).toEqual(without);
  });

  it('una lista vacía se omite en vez de viajar como []', () => {
    // `exactOptionalPropertyTypes`: la propiedad ausente y la propiedad en
    // `[]` no son lo mismo, y al modelo se le manda el mínimo necesario.
    const metrics = calculateMealEpisodeMetrics({
      mealTimestamp: '2026-08-22T12:00:00.000Z',
      readings,
      contextEvents: [],
    });
    expect('contextEvents' in metrics).toBe(false);
  });

  it('lo serializado no puede contener texto libre de una nota', () => {
    // La garantía es estructural: `EpisodeContextEvent` no tiene campo de
    // texto. Este test fija que nadie se lo agregue sin darse cuenta.
    const metrics = calculateMealEpisodeMetrics({
      mealTimestamp: '2026-08-22T12:00:00.000Z',
      readings,
      contextEvents: [{ kind: 'note', timestamp: '2026-08-22T13:00:00.000Z', minutesAfterAnchor: 60 }],
    });
    expect(Object.keys(metrics.contextEvents![0]!)).toEqual(['kind', 'timestamp', 'minutesAfterAnchor']);
  });
});
