import { MockCGMProvider } from '@type1a/cgm';
import type { GlucoseInsightService, MealVisionService } from '@type1a/ai';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import type { FoodCatalogStore } from '../src/food-catalog-store.js';

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
          foods: [{ name: 'pan', estimatedGrams: 50, servingGrams: 30, servingLabel: '1 rebanada', carbsG: 25, proteinG: 4, fatG: 1, fiberG: 2, caloriesKcal: 130, confidence: 0.8 }],
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
            foods: [{ name: 'sopaipillas', estimatedGrams: null, servingGrams: null, servingLabel: null, carbsG: 40, proteinG: 3, fatG: 8, fiberG: 1, caloriesKcal: 260, confidence: 0.3 }],
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

  it('routes an edit instruction and strips any insulin field the client sends', async () => {
    let receivedInput: unknown = null;
    const mealVisionService: MealVisionService = {
      analyze: async (input) => {
        receivedInput = input;
        return {
          analysisId: 'edit-1',
          model: 'test',
          estimate: {
            foods: [{ name: 'sándwich de queso', estimatedGrams: 160, servingGrams: null, servingLabel: null, carbsG: 38, proteinG: 16, fatG: 14, fiberG: 3, caloriesKcal: 400, confidence: 0.5 }],
            uncertaintyNotes: ['El tipo de pan no se especifica.'],
          },
          totals: { carbsG: 38, proteinG: 16, fatG: 14, fiberG: 3, caloriesKcal: 400 },
        };
      },
    };
    const app = await buildApp(testConfig(), { mealVisionService });
    apps.push(app);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/ai/meal-analysis',
      payload: {
        instruction: 'esto era un sándwich de queso',
        // Un cliente mal escrito (o modificado) manda la dosis igual. El
        // schema no la declara, así que Zod la descarta antes de que llegue
        // al proveedor: la frontera de AGENTS.md no depende de que el
        // cliente se porte bien.
        current: { confirmedCarbsG: 30, rapidUnits: 4, glucose: 180 },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(receivedInput).toEqual({
      instruction: 'esto era un sándwich de queso',
      current: { confirmedCarbsG: 30 },
    });
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

  describe('shared food catalog (backend prepared, not yet consumed by the app)', () => {
    it('returns a manual/local-only fallback when the store is not configured', async () => {
      const app = await buildApp(testConfig());
      apps.push(app);

      const get = await app.inject({ method: 'GET', url: '/v1/food-catalog?q=arroz' });
      const post = await app.inject({ method: 'POST', url: '/v1/food-catalog', payload: { entries: [] } });

      expect(get.statusCode).toBe(503);
      expect(get.json().error.code).toBe('food_catalog_not_configured');
      expect(post.statusCode).toBe(503);
    });

    it('passes the search term and the configured moderation floor through to the store', async () => {
      let receivedArgs: unknown[] = [];
      const foodCatalogStore: FoodCatalogStore = {
        search: async (...args) => { receivedArgs = args; return []; },
        upsertMany: async () => ({ accepted: 0, rejected: 0 }),
      };
      const app = await buildApp(readConfig({ NODE_ENV: 'test', CGM_PROVIDER: 'mock', SHARED_CATALOG_MIN_TIMES_SEEN: '5' }), { foodCatalogStore });
      apps.push(app);

      const response = await app.inject({ method: 'GET', url: '/v1/food-catalog?q=arroz&limit=10' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ foods: [] });
      expect(receivedArgs).toEqual(['arroz', 10, 5]);
    });

    it('forwards only the validated entries to the store, stripping anything the schema does not declare', async () => {
      let received: unknown = null;
      const foodCatalogStore: FoodCatalogStore = {
        search: async () => [],
        upsertMany: async (entries) => { received = entries; return { accepted: entries.length, rejected: 0 }; },
      };
      const app = await buildApp(testConfig(), { foodCatalogStore });
      apps.push(app);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/food-catalog',
        payload: {
          entries: [{
            name: 'Arroz',
            carbsPer100g: 28,
            proteinPer100g: 2.7,
            fatPer100g: 0.3,
            fiberPer100g: 0.4,
            kcalPer100g: 130,
            // Ningún cliente debería mandar esto, pero si uno mal escrito lo
            // hace, Zod lo descarta antes de llegar al store — la misma
            // frontera estructural que MealSnapshotSchema (Fase 17).
            key: 'deberia-desaparecer',
            timesSeen: 999,
          }],
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ accepted: 1, rejected: 0 });
      expect(received).toEqual([{
        name: 'Arroz',
        carbsPer100g: 28,
        proteinPer100g: 2.7,
        fatPer100g: 0.3,
        fiberPer100g: 0.4,
        kcalPer100g: 130,
      }]);
    });

    it('rejects an implausible entry body before it reaches the store', async () => {
      const app = await buildApp(testConfig(), {
        foodCatalogStore: {
          search: async () => [],
          upsertMany: async () => { throw new Error('should not be called'); },
        },
      });
      apps.push(app);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/food-catalog',
        // 150 g de carbohidratos por 100 g del alimento no es posible; el
        // límite del schema de red (max 100) lo rechaza antes de tocar el store.
        payload: { entries: [{ name: 'Arroz', carbsPer100g: 150, proteinPer100g: 0, fatPer100g: 0, fiberPer100g: 0, kcalPer100g: 0 }] },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe('invalid_catalog_entries');
    });
  });
});
