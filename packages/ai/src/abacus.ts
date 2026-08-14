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
  MEAL_VISION_PROMPT_VERSION,
  glucoseInsightSystemPrompt,
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
              schema: input.schema,
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

export interface MealVisionInput {
  imageBase64: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  description?: string;
}

export interface MealVisionService {
  analyze(input: MealVisionInput): Promise<MealAnalysisResult>;
}

export class AbacusMealVisionService implements MealVisionService {
  public constructor(private readonly client: AbacusRouteLLMClient) {}

  public async analyze(input: MealVisionInput): Promise<MealAnalysisResult> {
    const completion = await this.client.structuredCompletion({
      schemaName: 'type1a_meal_analysis',
      schema: mealAnalysisJsonSchema,
      messages: [
        { role: 'system', content: mealVisionSystemPrompt },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: input.description?.trim()
                ? `Analiza la comida. Contexto del usuario: ${input.description.trim()}`
                : 'Analiza la comida visible y explicita la incertidumbre de porción.',
            },
            {
              type: 'image_url',
              image_url: { url: `data:${input.mimeType};base64,${input.imageBase64}` },
            },
          ],
        },
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
      analysisId: `${MEAL_VISION_PROMPT_VERSION}:${crypto.randomUUID()}`,
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
