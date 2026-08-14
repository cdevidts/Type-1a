import { describe, expect, it } from 'vitest';

import {
  AbacusGlucoseInsightService,
  AbacusMealVisionService,
  AbacusRouteLLMClient,
} from '../src/index.js';

function routeResponse(content: unknown): Response {
  return new Response(
    JSON.stringify({
      model: 'vision-test',
      choices: [{ message: { content: JSON.stringify(content) } }],
    }),
    { status: 200 },
  );
}

describe('Abacus RouteLLM services', () => {
  it('keeps the key behind the client and validates structured meal output', async () => {
    let authorization = '';
    let body = '';
    const fetcher: typeof fetch = async (_input, init) => {
      authorization = new Headers(init?.headers).get('Authorization') ?? '';
      body = String(init?.body);
      return routeResponse({
        foods: [
          {
            name: 'arroz',
            estimatedGrams: 180,
            carbsG: 50,
            proteinG: 4,
            fatG: 1,
            fiberG: 2,
            caloriesKcal: 230,
            confidence: 0.7,
          },
        ],
        uncertaintyNotes: ['La porción se estima visualmente.'],
      });
    };
    const service = new AbacusMealVisionService(
      new AbacusRouteLLMClient({ apiKey: 'server-secret', fetcher }),
    );
    const result = await service.analyze({
      imageBase64: 'aGVsbG8=',
      mimeType: 'image/jpeg',
    });

    expect(authorization).toBe('Bearer server-secret');
    expect(body).toContain('json_schema');
    expect(result.totals.carbsG).toBe(50);
  });

  it('rejects therapeutic advice even if it matches the output schema', async () => {
    const fetcher: typeof fetch = async () =>
      routeResponse({
        summary: 'La próxima vez ponte 2 U más.',
        observations: [],
        limitations: [],
      });
    const service = new AbacusGlucoseInsightService(
      new AbacusRouteLLMClient({ apiKey: 'server-secret', fetcher }),
    );

    await expect(
      service.summarize({
        mealTimestamp: '2026-08-12T12:00:00.000Z',
        readingCount: 20,
        timeAboveRangeMinutes: 0,
        timeBelowRangeMinutes: 0,
      }),
    ).rejects.toMatchObject({ code: 'unsafe_output' });
  });
});
