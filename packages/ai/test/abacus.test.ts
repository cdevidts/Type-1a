import { describe, expect, it } from 'vitest';
import { glucoseInsightJsonSchema, mealAnalysisJsonSchema } from '@type1a/schemas';

import {
  AbacusGlucoseInsightService,
  AbacusMealVisionService,
  AbacusRouteLLMClient,
  AIServiceError,
  MEAL_EDIT_PROMPT_VERSION,
  MEAL_TEXT_PROMPT_VERSION,
  mealEditSystemPrompt,
  mealTextSystemPrompt,
  knownFoodsBlock,
  sanitizeForStrictJsonSchema,
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
        waterMl: null,
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

  it('analyzes from a text description alone, with no image block in the request', async () => {
    let sentMessages: unknown[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      sentMessages = (JSON.parse(String(init?.body)) as { messages: unknown[] }).messages;
      return routeResponse({
        foods: [
          {
            name: 'sopaipillas',
            estimatedGrams: null,
            carbsG: 40,
            proteinG: 3,
            fatG: 8,
            fiberG: 1,
            caloriesKcal: 260,
            confidence: 0.3,
          },
        ],
        waterMl: null,
        uncertaintyNotes: ['No hay foto: la porción es una suposición.'],
      });
    };
    const service = new AbacusMealVisionService(
      new AbacusRouteLLMClient({ apiKey: 'server-secret', fetcher }),
    );
    const result = await service.analyze({ description: 'tres sopaipillas con pebre' });

    expect(result.totals.carbsG).toBe(40);
    // The user message content must not contain an image_url block.
    const userMessage = sentMessages[1] as { content: unknown[] };
    expect(userMessage.content.some((part) => (part as { type: string }).type === 'image_url')).toBe(false);
    // Must use the text-only system prompt (lower-confidence, mandatory
    // uncertainty note), not the vision one — and tag the result so
    // downstream code can tell which path produced it. A future refactor
    // that silently swapped or dropped this branching would otherwise pass
    // every other assertion here.
    const systemMessage = sentMessages[0] as { content: string };
    expect(systemMessage.content).toBe(mealTextSystemPrompt);
    expect(result.analysisId.startsWith(MEAL_TEXT_PROMPT_VERSION)).toBe(true);
  });

  it('strips $schema/minItems/maxItems/minimum/maximum before sending, but still enforces bounds on the response', async () => {
    let sentSchema: Record<string, unknown> = {};
    const fetcher: typeof fetch = async (_input, init) => {
      const parsedBody = JSON.parse(String(init?.body)) as {
        response_format: { json_schema: { schema: Record<string, unknown> } };
      };
      sentSchema = parsedBody.response_format.json_schema.schema;
      // Abacus RouteLLM rejects requests containing these keywords in
      // strict mode; the response here is irrelevant to that check.
      return routeResponse({
        foods: [
          {
            name: 'arroz',
            estimatedGrams: 9999, // out of Zod's bound (max 3000) on purpose
            carbsG: 50,
            proteinG: 4,
            fatG: 1,
            fiberG: 2,
            caloriesKcal: 230,
            confidence: 0.7,
          },
        ],
        waterMl: null,
        uncertaintyNotes: [],
      });
    };
    const service = new AbacusMealVisionService(
      new AbacusRouteLLMClient({ apiKey: 'server-secret', fetcher }),
    );

    // estimatedGrams=9999 is out of Zod's bound (max 3000) — even though
    // the schema sent upstream no longer declares that bound, our own
    // re-validation of the response still catches it.
    await expect(
      service.analyze({ imageBase64: 'aGVsbG8=', mimeType: 'image/jpeg' }),
    ).rejects.toMatchObject({ code: 'invalid_output' });

    // The schema actually sent upstream must not contain the unsupported
    // keywords anywhere in its (nested) tree.
    const sentSerialized = JSON.stringify(sentSchema);
    expect(sentSerialized).not.toContain('$schema');
    expect(sentSerialized).not.toContain('minItems');
    expect(sentSerialized).not.toContain('maxItems');
    expect(sentSerialized).not.toContain('"minimum"');
    expect(sentSerialized).not.toContain('"maximum"');
  });

  it('sanitizeForStrictJsonSchema only strips real keyword positions, never an application field of the same name', () => {
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        // A hypothetical field literally named like a stripped keyword —
        // its key (under "properties") must survive, and its own value
        // (a real schema node) must still have ITS "maximum" keyword
        // stripped, same as any other field.
        maximum: { type: 'number', minimum: 0, maximum: 10 },
        dose: { type: 'number', minItems: 1, minimum: 0, maximum: 5 },
      },
      required: ['maximum', 'dose'],
    };

    const sanitized = sanitizeForStrictJsonSchema(schema) as Record<string, unknown>;
    const properties = sanitized.properties as Record<string, unknown>;

    expect(sanitized.$schema).toBeUndefined();
    expect(Object.keys(properties)).toContain('maximum'); // field name preserved
    expect(properties.maximum).toEqual({ type: 'number' }); // its own keywords stripped
    expect(properties.dose).toEqual({ type: 'number' });
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

describe('modo edición (Fase 17)', () => {
  const editResponse = {
    foods: [
      {
        name: 'sándwich de queso',
        estimatedGrams: 160,
        carbsG: 38,
        proteinG: 16,
        fatG: 14,
        fiberG: 3,
        caloriesKcal: 400,
        confidence: 0.5,
      },
    ],
    waterMl: null,
    uncertaintyNotes: ['El tipo de pan no se especifica.'],
  };

  it('usa el prompt de edición y manda la comida actual junto a la instrucción', async () => {
    let sentMessages: unknown[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      sentMessages = JSON.parse(String(init?.body)).messages;
      return routeResponse(editResponse);
    };
    const service = new AbacusMealVisionService(
      new AbacusRouteLLMClient({ apiKey: 'server-secret', fetcher }),
    );

    const result = await service.analyze({
      instruction: 'esto era un sándwich de queso',
      current: { confirmedCarbsG: 30, note: 'almuerzo' },
    });

    const [system, user] = sentMessages as [{ content: string }, { content: { text: string }[] }];
    expect(system.content).toBe(mealEditSystemPrompt);
    expect(user.content[0]!.text).toContain('esto era un sándwich de queso');
    expect(user.content[0]!.text).toContain('"confirmedCarbsG":30');
    // Sin bloque de imagen: la edición por instrucción no manda foto.
    expect(user.content).toHaveLength(1);
    expect(result.analysisId.startsWith(MEAL_EDIT_PROMPT_VERSION)).toBe(true);
    expect(result.totals.proteinG).toBe(16);
  });

  it('rechaza una instrucción que pide insulina SIN llamar al proveedor', async () => {
    // El punto de la prueba es el "sin llamar": una pregunta de dosis no
    // puede salir del teléfono hacia un servicio externo, ni siquiera para
    // que el filtro de salida la rechace después.
    let called = 0;
    const fetcher: typeof fetch = async () => {
      called += 1;
      return routeResponse(editResponse);
    };
    const service = new AbacusMealVisionService(
      new AbacusRouteLLMClient({ apiKey: 'server-secret', fetcher }),
    );

    await expect(
      service.analyze({
        instruction: '¿cuánta insulina me pongo con esto?',
        current: { confirmedCarbsG: 30 },
      }),
    ).rejects.toBeInstanceOf(AIServiceError);
    expect(called).toBe(0);
  });
});

describe('knownFoodsBlock', () => {
  it('vacío o ausente no cambia el mensaje', () => {
    expect(knownFoodsBlock(undefined)).toBe('');
    expect(knownFoodsBlock([])).toBe('');
    expect(knownFoodsBlock(['  '])).toBe('');
  });

  it('lista solo nombres, uno por línea, con la regla de "solo si es el mismo"', () => {
    const block = knownFoodsBlock(['Muslo de pollo', ' Arroz ']);
    expect(block).toContain('- Muslo de pollo');
    expect(block).toContain('- Arroz');
    expect(block).toMatch(/nombre EXACTO solo si es el mismo alimento/);
    // Nada más que el nombre viaja: ni macros ni veces vista.
    expect(block).not.toMatch(/\d/);
  });
});

describe('sanitizeForStrictJsonSchema — lista blanca de lo que sobrevive', () => {
  /**
   * Lo que el validador de esquemas de un proveedor acepta, comprobado contra
   * producción. Todo lo demás se filtra: son cotas que el modelo no necesita,
   * porque la respuesta se re-valida entera contra el Zod real después.
   */
  const ALLOWED = new Set([
    'type', 'properties', 'required', 'items', 'enum', 'anyOf', 'additionalProperties',
    'description', 'title', 'const', 'format', 'pattern', 'minLength', 'maxLength',
  ]);

  function keywordsOf(node: unknown, inProperties = false, out = new Set<string>()): Set<string> {
    if (Array.isArray(node)) { for (const item of node) keywordsOf(item, false, out); return out; }
    if (node === null || typeof node !== 'object') return out;
    for (const [key, value] of Object.entries(node)) {
      // Dentro de `properties` las claves son nombres de campo, no palabras
      // del esquema: un alimento podría llamarse "maximum".
      if (!inProperties) out.add(key);
      keywordsOf(value, key === 'properties', out);
    }
    return out;
  }

  for (const [name, schema] of [
    ['meal-analysis', mealAnalysisJsonSchema],
    ['glucose-insight', glucoseInsightJsonSchema],
  ] as const) {
    it(`${name}: nada fuera de la lista blanca llega al proveedor`, () => {
      // Este test existe por un incidente real: la lista de palabras filtradas
      // tenía cuatro de las cinco que importan, un `z.number().positive()`
      // nuevo emitió `exclusiveMinimum`, y todas las fotos empezaron a
      // responder 502 mientras el texto seguía bien. Enumerar lo que
      // SOBREVIVE lo habría atrapado; enumerar lo que se filtra, no.
      const survivors = [...keywordsOf(sanitizeForStrictJsonSchema(schema))].filter((k) => !ALLOWED.has(k));
      expect(survivors, `palabras no previstas en ${name}`).toEqual([]);
    });
  }

  it('las cotas numéricas se van, incluida la exclusiva', () => {
    const sanitized = JSON.stringify(sanitizeForStrictJsonSchema(mealAnalysisJsonSchema));
    for (const keyword of ['exclusiveMinimum', 'exclusiveMaximum', 'minimum', 'maximum', 'minItems', 'maxItems']) {
      expect(sanitized, keyword).not.toContain(`"${keyword}"`);
    }
  });

  it('no filtra un campo que se LLAME como una palabra del esquema', () => {
    const schema = { type: 'object', properties: { maximum: { type: 'number', maximum: 10 } } };
    const out = JSON.parse(JSON.stringify(sanitizeForStrictJsonSchema(schema)));
    expect(out.properties.maximum).toBeDefined();
    expect(out.properties.maximum.maximum).toBeUndefined();
  });
});
