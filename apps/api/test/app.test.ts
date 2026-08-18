import { MockCGMProvider } from '@type1a/cgm';
import type { GlucoseInsightService, MealVisionService } from '@type1a/ai';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function testConfig() {
  return readConfig({ NODE_ENV: 'test', CGM_PROVIDER: 'mock' });
}

describe('Type 1A API', () => {
  it('exposes an explicit synthetic CGM source', async () => {
    const app = await buildApp(testConfig(), {
      cgmProvider: new MockCGMProvider({ now: () => new Date('2026-08-12T14:02:00.000Z') }),
    });
    apps.push(app);
    const response = await app.inject({ method: 'GET', url: '/v1/cgm/latest' });

    expect(response.statusCode).toBe(200);
    expect(response.json().reading).toMatchObject({ origin: 'synthetic', source: 'mock-synthetic' });
  });

  it('returns a manual fallback when Abacus is not configured', async () => {
    const app = await buildApp(testConfig());
    apps.push(app);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ai/meal-analysis',
      payload: { imageBase64: 'aGVsbG8gaGVsbG8=', mimeType: 'image/jpeg' },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('ai_not_configured');
  });

  it('wires validated meal and insight services', async () => {
    const mealVisionService: MealVisionService = {
      analyze: async () => ({
        analysisId: 'a-1',
        model: 'test',
        estimate: {
          foods: [{ name: 'pan', estimatedGrams: 50, carbsG: 25, proteinG: 4, fatG: 1, fiberG: 2, caloriesKcal: 130, confidence: 0.8 }],
          uncertaintyNotes: [],
        },
        totals: { carbsG: 25, proteinG: 4, fatG: 1, fiberG: 2, caloriesKcal: 130 },
      }),
    };
    const glucoseInsightService: GlucoseInsightService = {
      summarize: async () => ({ summary: 'Descripción.', observations: [], limitations: [] }),
    };
    const app = await buildApp(testConfig(), { mealVisionService, glucoseInsightService });
    apps.push(app);

    const meal = await app.inject({
      method: 'POST',
      url: '/v1/ai/meal-analysis',
      payload: { imageBase64: 'aGVsbG8gaGVsbG8=', mimeType: 'image/jpeg' },
    });
    const insight = await app.inject({
      method: 'POST',
      url: '/v1/ai/glucose-insight',
      payload: {
        mealTimestamp: '2026-08-12T12:00:00.000Z',
        readingCount: 20,
        timeAboveRangeMinutes: 0,
        timeBelowRangeMinutes: 0,
      },
    });

    expect(meal.statusCode).toBe(200);
    expect(meal.json().totals.carbsG).toBe(25);
    expect(insight.statusCode).toBe(200);
  });

  it('accepts a text-only meal description with no image', async () => {
    let receivedInput: unknown = null;
    const mealVisionService: MealVisionService = {
      analyze: async (input) => {
        receivedInput = input;
        return {
          analysisId: 'text-1',
          model: 'test',
          estimate: {
            foods: [{ name: 'sopaipillas', estimatedGrams: null, carbsG: 40, proteinG: 3, fatG: 8, fiberG: 1, caloriesKcal: 260, confidence: 0.3 }],
            uncertaintyNotes: ['No hay foto.'],
          },
          totals: { carbsG: 40, proteinG: 3, fatG: 8, fiberG: 1, caloriesKcal: 260 },
        };
      },
    };
    const app = await buildApp(testConfig(), { mealVisionService });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ai/meal-analysis',
      payload: { description: 'tres sopaipillas con pebre' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().totals.carbsG).toBe(40);
    expect(receivedInput).toEqual({ description: 'tres sopaipillas con pebre' });
  });

  it('rejects a meal-analysis body with neither an image nor a description', async () => {
    const app = await buildApp(testConfig(), {
      mealVisionService: { analyze: async () => { throw new Error('should not be called'); } },
    });
    apps.push(app);

    const response = await app.inject({ method: 'POST', url: '/v1/ai/meal-analysis', payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('invalid_meal_input');
  });
});
