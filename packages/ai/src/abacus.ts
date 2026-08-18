import { containsTherapyRecommendation, totalFoodEstimates } from '@type1a/domain';
import {
  GlucoseInsightSchema,
  MealAnalysisSchema,
  glucoseInsightJsonSchema,
  mealAnalysisJsonSchema,
  type GlucoseInsight,
  type MealAnalysisResult,
  type MealEpisodeMetrics,
} from '@type1a/schemas';
import { z } from 'zod';

import {
  GLUCOSE_INSIGHT_PROMPT_VERSION,
  MEAL_TEXT_PROMPT_VERSION,
  MEAL_VISION_PROMPT_VERSION,
  glucoseInsightSystemPrompt,
  mealTextSystemPrompt,
  mealVisionSystemPrompt,
} from './prompts.js';

const RouteLLMResponseSchema = z.object({
  choices: z.array(
    z.object({
      message: z.object({
        content: z.union([z.string(), z.null()]),
      }),
    }),
  ).min(1),
  model: z.string().optional(),
});

export class AIServiceError extends Error {
  public constructor(
    message: string,
    public readonly code: 'not_configured' | 'provider_error' | 'invalid_output' | 'unsafe_output',
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AIServiceError';
  }
}

export interface AbacusRouteLLMOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  fetcher?: typeof fetch;
  requestTimeoutMs?: number;
}

interface StructuredCompletionInput {
  messages: unknown[];
  schemaName: string;
  schema: object;
}

// Abacus RouteLLM's strict json_schema structured output rejects standard
// JSON Schema keywords our schemas legitimately emit: "$schema" itself
// ("Extra inputs are not permitted"), and, for schemas with enough nested
// numeric/array bounds, "minItems"/"maxItems"/"minimum"/"maximum" ("too
// many states for serving"). Stripping them here only loosens what we ask
// the *model* to constrain its output to — every response is still fully
// re-validated against the real Zod schema (including those same bounds)
// after parsing, so this never weakens what we accept.
const UNSUPPORTED_STRICT_JSON_SCHEMA_KEYWORDS = new Set([
  '$schema',
  'minItems',
  'maxItems',
  'minimum',
  'maximum',
]);

// `isPropertiesMap` is true only while recursing through the *values* of a
// "properties" object — there, keys are application field names (e.g. a
// hypothetical field literally called "maximum"), not JSON Schema
// keywords, so they must never be filtered. Every other object level is a
// real schema node, where these keys really are the keywords to strip.
export function sanitizeForStrictJsonSchema(schema: unknown, isPropertiesMap = false): unknown {
  if (Array.isArray(schema)) return schema.map((item) => sanitizeForStrictJsonSchema(item));
  if (schema !== null && typeof schema === 'object') {
    return Object.fromEntries(
      Object.entries(schema)
        .filter(([key]) => isPropertiesMap || !UNSUPPORTED_STRICT_JSON_SCHEMA_KEYWORDS.has(key))
        .map(([key, value]) => [key, sanitizeForStrictJsonSchema(value, key === 'properties')]),
    );
  }
  return schema;
}

export class AbacusRouteLLMClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetcher: typeof fetch;
  private readonly requestTimeoutMs: number;

  public constructor(private readonly options: AbacusRouteLLMOptions) {
    if (!options.apiKey) {
      throw new AIServiceError('Abacus RouteLLM is not configured.', 'not_configured', false);
    }
    this.baseUrl = (options.baseUrl ?? 'https://routellm.abacus.ai/v1').replace(/\/$/u, '');
    this.model = options.model ?? 'route-llm';
    this.fetcher = options.fetcher ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 45_000;
  }

  public async structuredCompletion(input: StructuredCompletionInput): Promise<{ content: unknown; model: string }> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          messages: input.messages,
          temperature: 0,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: input.schemaName,
              strict: true,
              schema: sanitizeForStrictJsonSchema(input.schema),
            },
          },
        }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch {
      throw new AIServiceError('Abacus RouteLLM is unreachable.', 'provider_error', true);
    }

    if (!response.ok) {
      throw new AIServiceError(`Abacus RouteLLM returned HTTP ${response.status}.`, 'provider_error', response.status >= 500);
    }

    const envelope = RouteLLMResponseSchema.safeParse(await response.json());
    if (!envelope.success) {
      throw new AIServiceError('Abacus returned an invalid response envelope.', 'invalid_output', false);
    }
    const rawContent = envelope.data.choices[0]!.message.content;
    if (rawContent === null) {
      throw new AIServiceError('Abacus returned no structured content.', 'invalid_output', true);
    }
    try {
      return { content: JSON.parse(rawContent), model: envelope.data.model ?? this.model };
    } catch {
      throw new AIServiceError('Abacus returned invalid JSON.', 'invalid_output', false);
    }
  }
}

export type MealVisionInput =
  | { imageBase64: string; mimeType: 'image/jpeg' | 'image/png' | 'image/webp'; description?: string }
  // Text-only: no photo. Verónica asked for this explicitly — being able to
  // type what she ate instead of always needing a picture. `description` is
  // required here (there's nothing else for the model to go on), unlike the
  // image case where it's optional context.
  | { description: string };

export interface MealVisionService {
  analyze(input: MealVisionInput): Promise<MealAnalysisResult>;
}

export class AbacusMealVisionService implements MealVisionService {
  public constructor(private readonly client: AbacusRouteLLMClient) {}

  public async analyze(input: MealVisionInput): Promise<MealAnalysisResult> {
    const hasImage = 'imageBase64' in input;
    const content: unknown[] = [
      {
        type: 'text',
        text: hasImage
          ? (input.description?.trim()
            ? `Analiza la comida. Contexto del usuario: ${input.description.trim()}`
            : 'Analiza la comida visible y explicita la incertidumbre de porción.')
          : `Analiza esta comida a partir únicamente de la descripción del usuario, sin foto. Descripción: ${input.description.trim()}`,
      },
    ];
    if (hasImage) {
      content.push({ type: 'image_url', image_url: { url: `data:${input.mimeType};base64,${input.imageBase64}` } });
    }
    const completion = await this.client.structuredCompletion({
      schemaName: 'type1a_meal_analysis',
      schema: mealAnalysisJsonSchema,
      messages: [
        { role: 'system', content: hasImage ? mealVisionSystemPrompt : mealTextSystemPrompt },
        { role: 'user', content },
      ],
    });
    const estimate = MealAnalysisSchema.safeParse(completion.content);
    if (!estimate.success) {
      throw new AIServiceError('Meal analysis did not match its schema.', 'invalid_output', false);
    }
    if (containsTherapyRecommendation(estimate.data)) {
      throw new AIServiceError('Unsafe therapy content was rejected.', 'unsafe_output', false);
    }

    return {
      analysisId: `${hasImage ? MEAL_VISION_PROMPT_VERSION : MEAL_TEXT_PROMPT_VERSION}:${crypto.randomUUID()}`,
      model: completion.model,
      estimate: estimate.data,
      totals: totalFoodEstimates(estimate.data.foods),
    };
  }
}

export interface GlucoseInsightService {
  summarize(metrics: MealEpisodeMetrics): Promise<GlucoseInsight>;
}

export class AbacusGlucoseInsightService implements GlucoseInsightService {
  public constructor(private readonly client: AbacusRouteLLMClient) {}

  public async summarize(metrics: MealEpisodeMetrics): Promise<GlucoseInsight> {
    const completion = await this.client.structuredCompletion({
      schemaName: 'type1a_glucose_insight',
      schema: glucoseInsightJsonSchema,
      messages: [
        { role: 'system', content: glucoseInsightSystemPrompt },
        {
          role: 'user',
          content: `${GLUCOSE_INSIGHT_PROMPT_VERSION}\nMétricas determinísticas:\n${JSON.stringify(metrics)}`,
        },
      ],
    });
    const insight = GlucoseInsightSchema.safeParse(completion.content);
    if (!insight.success) {
      throw new AIServiceError('Glucose insight did not match its schema.', 'invalid_output', false);
    }
    if (containsTherapyRecommendation(insight.data)) {
      throw new AIServiceError('Unsafe therapy recommendation was rejected.', 'unsafe_output', false);
    }
    return insight.data;
  }
}
