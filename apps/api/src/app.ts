import cors from '@fastify/cors';
import {
  AIServiceError,
  AbacusGlucoseInsightService,
  AbacusMealVisionService,
  AbacusRouteLLMClient,
  type GlucoseInsightService,
  type MealVisionService,
} from '@type1a/ai';
import {
  CGMProviderError,
  JunctionCGMProvider,
  LibreLinkUpCGMProvider,
  MockCGMProvider,
  type CGMProvider,
} from '@type1a/cgm';
import { assessFreshness } from '@type1a/domain';
import { MealEpisodeMetricsSchema } from '@type1a/schemas';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { AppConfig } from './config.js';
import { JunctionLinkError, JunctionLinkService } from './junction-link.js';

const ReadingsQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});

const MealAnalysisBodySchema = z.union([
  z.object({
    imageBase64: z.string().min(16).max(10_000_000),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    description: z.string().trim().max(500).optional(),
  }),
  // Text-only path: no photo, just a description. `description` is required
  // here since it's the only signal the model has.
  z.object({
    description: z.string().trim().min(1).max(500),
  }),
]);

const JunctionLinkBodySchema = z.object({
  email: z.email(),
  region: z.string().regex(/^[a-z]{2}$/u).default('cl'),
});

class UnconfiguredCGMProvider implements CGMProvider {
  public constructor(
    public readonly name: string,
    private readonly detail: string,
  ) {}
  public async getLatestReading(): Promise<null> { return null; }
  public async getReadings(): Promise<[]> { return []; }
  public async getStatus() {
    return {
      state: 'not_connected' as const,
      provider: this.name,
      detail: this.detail,
      checkedAt: new Date().toISOString(),
      isSynthetic: false,
    };
  }
}

export interface AppDependencies {
  cgmProvider?: CGMProvider;
  mealVisionService?: MealVisionService;
  glucoseInsightService?: GlucoseInsightService;
  junctionLinkService?: JunctionLinkService;
}

function createProvider(config: AppConfig): CGMProvider {
  if (config.CGM_PROVIDER === 'mock') {
    return new MockCGMProvider({ staleAfterMinutes: config.CGM_STALE_AFTER_MINUTES });
  }

  if (config.CGM_PROVIDER === 'librelinkup') {
    if (config.LIBRELINKUP_EMAIL === undefined || config.LIBRELINKUP_PASSWORD === undefined) {
      return new UnconfiguredCGMProvider(
        'librelinkup-unconfigured',
        'LibreLinkUp está seleccionado, pero faltan credenciales del backend.',
      );
    }
    return new LibreLinkUpCGMProvider({
      email: config.LIBRELINKUP_EMAIL,
      password: config.LIBRELINKUP_PASSWORD,
      region: config.LIBRELINKUP_REGION,
      staleAfterMinutes: config.CGM_STALE_AFTER_MINUTES,
    });
  }

  if (config.JUNCTION_API_KEY === undefined || config.JUNCTION_USER_ID === undefined) {
    return new UnconfiguredCGMProvider(
      'junction-unconfigured',
      'Junction está seleccionado, pero faltan credenciales del backend.',
    );
  }
  return new JunctionCGMProvider({
    apiKey: config.JUNCTION_API_KEY,
    userId: config.JUNCTION_USER_ID,
    environment: config.JUNCTION_ENVIRONMENT,
    userTimeZone: config.JUNCTION_USER_TIMEZONE,
    staleAfterMinutes: config.CGM_STALE_AFTER_MINUTES,
  });
}

function createAiServices(config: AppConfig): {
  meal?: MealVisionService;
  insight?: GlucoseInsightService;
} {
  if (config.ABACUS_ROUTE_LLM_API_KEY === undefined) return {};
  const client = new AbacusRouteLLMClient({
    apiKey: config.ABACUS_ROUTE_LLM_API_KEY,
    baseUrl: config.ABACUS_ROUTE_LLM_BASE_URL,
    model: config.ABACUS_ROUTE_LLM_MODEL,
  });
  return {
    meal: new AbacusMealVisionService(client),
    insight: new AbacusGlucoseInsightService(client),
  };
}

export async function buildApp(config: AppConfig, dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.NODE_ENV !== 'test'
      ? { redact: ['req.headers.authorization', 'req.headers.x-vital-api-key'] }
      : false,
    bodyLimit: 12_000_000,
  });
  await app.register(cors, { origin: config.NODE_ENV === 'production' ? false : true });

  const cgm = dependencies.cgmProvider ?? createProvider(config);
  const ai = createAiServices(config);
  const mealVision = dependencies.mealVisionService ?? ai.meal;
  const glucoseInsight = dependencies.glucoseInsightService ?? ai.insight;
  const junctionLink = dependencies.junctionLinkService ?? (
    config.JUNCTION_API_KEY !== undefined && config.JUNCTION_USER_ID !== undefined
      ? new JunctionLinkService({
          apiKey: config.JUNCTION_API_KEY,
          userId: config.JUNCTION_USER_ID,
          environment: config.JUNCTION_ENVIRONMENT,
        })
      : undefined
  );

  app.get('/health', async () => ({ status: 'ok', version: '0.1.0' }));

  app.get('/v1/cgm/status', async () => cgm.getStatus());

  app.get('/v1/cgm/latest', async () => {
    const reading = await cgm.getLatestReading();
    if (reading === null) return { reading: null, freshness: null };
    return {
      reading,
      freshness: assessFreshness(
        reading.sourceTimestamp,
        new Date(),
        config.CGM_STALE_AFTER_MINUTES,
      ),
    };
  });

  app.get('/v1/cgm/readings', async (request, reply) => {
    const query = ReadingsQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: { code: 'invalid_query', message: 'from y to deben ser timestamps ISO válidos.', retryable: false } });
    const from = new Date(query.data.from);
    const to = new Date(query.data.to);
    if (from > to || to.getTime() - from.getTime() > 31 * 24 * 60 * 60_000) {
      return reply.status(400).send({ error: { code: 'invalid_range', message: 'El rango debe ser positivo y no superar 31 días.', retryable: false } });
    }
    return { readings: await cgm.getReadings({ from, to }) };
  });

  app.post('/v1/ai/meal-analysis', async (request, reply) => {
    if (mealVision === undefined) {
      return reply.status(503).send({ error: { code: 'ai_not_configured', message: 'El análisis IA no está configurado; usa el ingreso manual.', retryable: false } });
    }
    const body = MealAnalysisBodySchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: 'invalid_meal_input', message: 'Falta una imagen válida o una descripción de texto.', retryable: false } });
    return mealVision.analyze(
      'imageBase64' in body.data
        ? {
            imageBase64: body.data.imageBase64,
            mimeType: body.data.mimeType,
            ...(body.data.description === undefined ? {} : { description: body.data.description }),
          }
        : { description: body.data.description },
    );
  });

  app.post('/v1/ai/glucose-insight', async (request, reply) => {
    if (glucoseInsight === undefined) {
      return reply.status(503).send({ error: { code: 'ai_not_configured', message: 'Los insights IA no están configurados.', retryable: false } });
    }
    const metrics = MealEpisodeMetricsSchema.safeParse(request.body);
    if (!metrics.success) return reply.status(400).send({ error: { code: 'invalid_metrics', message: 'Las métricas del episodio no son válidas.', retryable: false } });
    return glucoseInsight.summarize(metrics.data);
  });

  app.post('/v1/provider/junction/link', async (request, reply) => {
    if (junctionLink === undefined) {
      return reply.status(503).send({ error: { code: 'junction_not_configured', message: 'Junction no está configurado en el backend.', retryable: false } });
    }
    const body = JunctionLinkBodySchema.safeParse(request.body);
    if (!body.success) return reply.status(400).send({ error: { code: 'invalid_link_request', message: 'Email o región inválidos.', retryable: false } });
    const result = await junctionLink.connectFreestyleLibre(body.data.email, body.data.region);
    return { provider: 'freestyle_libre', state: result.state };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AIServiceError || error instanceof CGMProviderError || error instanceof JunctionLinkError) {
      const status = error instanceof AIServiceError && error.code === 'unsafe_output' ? 422 : 502;
      return reply.status(status).send({
        error: { code: error.name, message: error.message, retryable: error.retryable },
      });
    }
    app.log.error({ err: error }, 'Unhandled request error');
    return reply.status(500).send({
      error: { code: 'internal_error', message: 'Ocurrió un error interno.', retryable: true },
    });
  });

  return app;
}
