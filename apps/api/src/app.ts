import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import {
  AIServiceError,
  AbacusAgentChatService,
  AbacusGlucoseInsightService,
  AbacusMealVisionService,
  AbacusRouteLLMClient,
  type AgentChatService,
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
import { assessFreshness, insulinQuestionOpensCalculator, requestsInsulinAdvice } from '@type1a/domain';
import {
  KnownFoodNamesSchema,
  MealEditInputSchema,
  MealEpisodeMetricsSchema,
  SharedCatalogUploadSchema,
} from '@type1a/schemas';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { Pool } from 'pg';

import { z } from 'zod';

import {
  EmailAlreadyRegisteredError,
  InvalidCredentialsError,
  PostgresAccountsStore,
  type AuthenticatedUser,
} from './accounts-store.js';
import {
  ALLOWED_PHOTO_MIME_TYPES,
  MAX_PHOTO_BYTES,
  PostgresCatalogPhotoStore,
} from './catalog-photo-store.js';
import type { AppConfig } from './config.js';
import { PostgresFoodCatalogStore, type FoodCatalogStore } from './food-catalog-store.js';
import { JunctionLinkError, JunctionLinkService } from './junction-link.js';
import { PostgresPersonalCatalogStore, type PersonalCatalogStore } from './personal-catalog-store.js';

const ReadingsQuerySchema = z.object({
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
});

const FoodCatalogQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().positive().max(60).default(20),
});

const MealAnalysisBodySchema = z.union([
  z.object({
    imageBase64: z.string().min(16).max(10_000_000),
    mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    description: z.string().trim().max(500).optional(),
    knownFoodNames: KnownFoodNamesSchema.optional(),
  }),
  // Text-only path: no photo, just a description. `description` is required
  // here since it's the only signal the model has.
  z.object({
    description: z.string().trim().min(1).max(500),
    knownFoodNames: KnownFoodNamesSchema.optional(),
  }),
  // Edit path (Fase 17): an already-logged meal plus a correction in the
  // user's own words. `MealEditInputSchema` has no insulin/glucose/therapy
  // field by construction, so this route cannot forward one even if the
  // client sends it — Zod strips what the schema doesn't declare.
  MealEditInputSchema,
]);

const JunctionLinkBodySchema = z.object({
  email: z.email(),
  region: z.string().regex(/^[a-z]{2}$/u).default('cl'),
});

// ── Cuentas ─────────────────────────────────────────────────────────────
const RegisterBodySchema = z.object({
  email: z.email(),
  // Mínimo 10 caracteres, tope generoso para no truncar frases largas.
  password: z.string().min(10, 'La contraseña debe tener al menos 10 caracteres.').max(200),
});
// En login no se revalida el largo mínimo: una contraseña corta simplemente no
// coincidirá, con el MISMO error que un correo inexistente.
const LoginBodySchema = z.object({
  email: z.email(),
  password: z.string().min(1).max(200),
});

// ── Fotos y catálogo personal ───────────────────────────────────────────
const FoodKeyParamsSchema = z.object({
  foodKey: z.string().trim().min(1).max(160),
});
const CatalogKeyParamsSchema = z.object({
  key: z.string().trim().min(1).max(160),
});
// La app manda la foto como base64 dentro de un JSON, junto a su tipo MIME —
// es lo más simple de emitir desde el cliente móvil. El tope de bytes se
// verifica sobre los bytes YA decodificados, no sobre el largo del base64.
const PhotoUploadBodySchema = z.object({
  imageBase64: z.string().min(1).max(2_000_000),
  mimeType: z.enum(ALLOWED_PHOTO_MIME_TYPES),
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
  agentChatService?: AgentChatService;
  junctionLinkService?: JunctionLinkService;
  foodCatalogStore?: FoodCatalogStore;
  accountsStore?: PostgresAccountsStore;
  personalCatalogStore?: PersonalCatalogStore;
  catalogPhotoStore?: PostgresCatalogPhotoStore;
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
      sha256Hex: (input) => Promise.resolve(createHash('sha256').update(input).digest('hex')),
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
  agent?: AgentChatService;
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
    agent: new AbacusAgentChatService(client),
  };
}

/**
 * Construye el catálogo compartido cuando hay `DATABASE_URL`, y auto-provee
 * su esquema — ver el comentario de `ensureSchema` en `food-catalog-store.ts`
 * para por qué eso es a propósito.
 *
 * Un fallo de conexión acá **no puede tumbar el resto del backend**: CGM y
 * los otros endpoints de IA no tienen nada que ver con esta tabla, así que
 * degradan a 503 solo en `/v1/food-catalog` — el mismo principio de
 * "un proveedor que falla degrada a manual" de `AGENTS.md`, aplicado a esta
 * función en vez de a un CGM.
 */
interface DbStores {
  foodCatalog: FoodCatalogStore;
  accounts: PostgresAccountsStore;
  personalCatalog: PersonalCatalogStore;
  photos: PostgresCatalogPhotoStore;
}

/**
 * Construye TODO lo que necesita `DATABASE_URL` sobre un SOLO Pool de `pg`:
 * catálogo compartido, cuentas/sesiones, catálogo personal y fotos. Sin
 * `DATABASE_URL` no se construye nada y las rutas correspondientes degradan a
 * 503 — el resto del backend (CGM, IA) no depende de esto y sigue igual.
 *
 * El orden de `ensureSchema` importa: `users` primero, porque tanto la FK
 * `owner_user_id` de `food_catalog` como la de `catalog_photos` la referencian.
 */
async function createDbStores(config: AppConfig, log: FastifyInstance['log']): Promise<DbStores | undefined> {
  if (config.DATABASE_URL === undefined) return undefined;
  try {
    const pool = new Pool({ connectionString: config.DATABASE_URL });
    const accounts = new PostgresAccountsStore(pool);
    const foodCatalog = new PostgresFoodCatalogStore(pool);
    const personalCatalog = new PostgresPersonalCatalogStore(pool);
    const photos = new PostgresCatalogPhotoStore(pool);
    await accounts.ensureSchema();
    await foodCatalog.ensureSchema();
    await photos.ensureSchema();
    return { foodCatalog, accounts, personalCatalog, photos };
  } catch (error) {
    log.error({ err: error }, 'No se pudo preparar la base de datos; las rutas con estado degradan a 503.');
    return undefined;
  }
}

/**
 * Lo que el teléfono manda para un turno del agente.
 *
 * `context` se acepta como `unknown` a propósito: el backend no lo interpreta,
 * solo lo reenvía al modelo. Validar acá una forma que evoluciona en el móvil
 * obligaría a un redeploy por cada campo nuevo, y quien garantiza qué sale del
 * teléfono es `buildAgentContext`, que sí tiene test.
 */
const AgentChatRequestSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  context: z.unknown(),
  history: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(2000) }))
    .max(10)
    .optional(),
});

export async function buildApp(config: AppConfig, dependencies: AppDependencies = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.NODE_ENV !== 'test'
      ? { redact: ['req.headers.authorization', 'req.headers.x-vital-api-key'] }
      : false,
    bodyLimit: 12_000_000,
  });
  await app.register(cors, { origin: config.NODE_ENV === 'production' ? false : true });
  // Global generoso; el límite real que importa es el de la ruta de
  // escritura del catálogo compartido, registrado más abajo. Sin esto, un
  // endpoint anónimo de escritura queda abierto a que un bot lo inunde de
  // filas basura — antes de la Fase de catálogo compartido no había ningún
  // endpoint que aceptara escritura sin credencial, así que no hacía falta.
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  const cgm = dependencies.cgmProvider ?? createProvider(config);
  const ai = createAiServices(config);
  const mealVision = dependencies.mealVisionService ?? ai.meal;
  const glucoseInsight = dependencies.glucoseInsightService ?? ai.insight;
  const agentChat = dependencies.agentChatService ?? ai.agent;
  const dbStores = await createDbStores(config, app.log);
  const foodCatalog = dependencies.foodCatalogStore ?? dbStores?.foodCatalog;
  const accounts = dependencies.accountsStore ?? dbStores?.accounts;
  const personalCatalog = dependencies.personalCatalogStore ?? dbStores?.personalCatalog;
  const catalogPhotos = dependencies.catalogPhotoStore ?? dbStores?.photos;
  const junctionLink = dependencies.junctionLinkService ?? (
    config.JUNCTION_API_KEY !== undefined && config.JUNCTION_USER_ID !== undefined
      ? new JunctionLinkService({
          apiKey: config.JUNCTION_API_KEY,
          userId: config.JUNCTION_USER_ID,
          environment: config.JUNCTION_ENVIRONMENT,
        })
      : undefined
  );

  /**
   * Lee el token Bearer del header `Authorization`. Nunca se registra: el
   * logger de Fastify tiene `req.headers.authorization` en su lista de
   * `redact`, así que aunque una petición se logee, el token sale ofuscado.
   */
  function bearerToken(request: FastifyRequest): string | null {
    const header = request.headers.authorization;
    if (typeof header !== 'string') return null;
    const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
    return match?.[1] ?? null;
  }

  /**
   * Resuelve la usuaria autenticada, o `null` si no hay token válido. Si la
   * base de datos no está configurada, `accounts` es undefined → también null
   * (la ruta lo traduce a 503 antes de llegar acá cuando corresponde).
   */
  async function currentUser(request: FastifyRequest): Promise<AuthenticatedUser | null> {
    if (accounts === undefined) return null;
    const token = bearerToken(request);
    if (token === null) return null;
    return accounts.authenticate(token);
  }

  /**
   * Exige autenticación: devuelve la usuaria, o responde 401 y devuelve null.
   * Token ausente/ inválido/ expirado/ revocado → 401, nunca 500.
   */
  async function requireUser(request: FastifyRequest, reply: FastifyReply): Promise<AuthenticatedUser | null> {
    const user = await currentUser(request);
    if (user === null) {
      await reply.status(401).send({ error: { code: 'unauthorized', message: 'Falta un token de sesión válido.', retryable: false } });
      return null;
    }
    return user;
  }

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
    const known = body.data.knownFoodNames === undefined ? {} : { knownFoodNames: body.data.knownFoodNames };
    if ('instruction' in body.data) {
      return mealVision.analyze({ instruction: body.data.instruction, current: body.data.current, ...known });
    }
    return mealVision.analyze(
      'imageBase64' in body.data
        ? {
            imageBase64: body.data.imageBase64,
            mimeType: body.data.mimeType,
            ...(body.data.description === undefined ? {} : { description: body.data.description }),
            ...known,
          }
        : { description: body.data.description, ...known },
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

  /**
   * Un turno del agente. **Una llamada al modelo, nunca un bucle** (ADR 0008).
   *
   * El contexto lo arma el teléfono con `buildAgentContext`, que por diseño no
   * incluye los parámetros de terapia: sin el ratio y el factor, el modelo no
   * puede calcular una dosis aunque quisiera.
   */
  app.post('/v1/ai/chat', async (request, reply) => {
    if (agentChat === undefined) {
      return reply.status(503).send({ error: { code: 'ai_not_configured', message: 'El asistente no está configurado.', retryable: false } });
    }
    const body = AgentChatRequestSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: 'invalid_request', message: 'La consulta no es válida.', retryable: false } });
    }

    // El guardia corre ANTES de gastar la llamada: "¿cuánta insulina me pongo?"
    // no necesita un modelo para responderse, y pagarla sería tirar el crédito.
    if (requestsInsulinAdvice(body.data.message)) {
      return {
        kind: 'refusal',
        say: 'No puedo decirte cuánta insulina ponerte. Te abro la calculadora: lo saca de los parámetros que tú cargaste y te muestra de dónde sale cada unidad.',
        draft: null,
        question: null,
        cites: [],
        // El guardia atajó la pregunta sin gastar el modelo, así que decide él
        // la pantalla. Un rechazo que no lleva a ninguna parte es lo que esta
        // fase vino a eliminar.
        opens: insulinQuestionOpensCalculator(body.data.message) ?? 'correction',
      };
    }

    // `exactOptionalPropertyTypes`: para OMITIR hay que omitir la clave, no
    // pasar `undefined`.
    return agentChat.respond({
      context: body.data.context,
      message: body.data.message,
      ...(body.data.history === undefined ? {} : { history: body.data.history }),
    });
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

  // Catálogo de alimentos compartido — ver food-catalog-store.ts y el ADR.
  // Todavía NO lo consume la app móvil (Fase futura del roadmap); vive acá
  // ya funcionando para que esa fase, cuando llegue, sea puro trabajo de
  // apps/mobile sin volver a tocar el backend.
  app.get('/v1/food-catalog', async (request, reply) => {
    if (foodCatalog === undefined) {
      return reply.status(503).send({ error: { code: 'food_catalog_not_configured', message: 'El catálogo compartido no está configurado.', retryable: false } });
    }
    const query = FoodCatalogQuerySchema.safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: { code: 'invalid_query', message: 'Parámetros de búsqueda inválidos.', retryable: false } });
    const foods = await foodCatalog.search(query.data.q ?? '', query.data.limit, config.SHARED_CATALOG_MIN_TIMES_SEEN);
    return { foods };
  });

  app.post(
    '/v1/food-catalog',
    // Límite de cuerpo propio, mucho más chico que el global (pensado para
    // fotos): esta ruta solo recibe nombres y números.
    { bodyLimit: 20_000, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (foodCatalog === undefined) {
        return reply.status(503).send({ error: { code: 'food_catalog_not_configured', message: 'El catálogo compartido no está configurado.', retryable: false } });
      }
      const body = SharedCatalogUploadSchema.safeParse(request.body);
      if (!body.success) return reply.status(400).send({ error: { code: 'invalid_catalog_entries', message: 'Las entradas del catálogo no son válidas.', retryable: false } });
      const outcome = await foodCatalog.upsertMany(body.data.entries, new Date().toISOString());
      return outcome;
    },
  );

  // ── Cuentas y sesiones ──────────────────────────────────────────────────
  // Cuerpo pequeño (solo correo + contraseña) y límite de intentos por IP:
  // 10 cada 15 minutos, contra fuerza bruta y enumeración de cuentas. Nunca se
  // registra el cuerpo: Fastify no logea bodies por defecto y el token/header
  // Authorization está en la lista `redact`.
  const authRateLimit = { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } }, bodyLimit: 4_000 };

  app.post('/v1/auth/register', authRateLimit, async (request, reply) => {
    if (accounts === undefined) {
      return reply.status(503).send({ error: { code: 'accounts_not_configured', message: 'Las cuentas no están configuradas.', retryable: false } });
    }
    const body = RegisterBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: { code: 'invalid_credentials_input', message: 'Correo inválido o contraseña de menos de 10 caracteres.', retryable: false } });
    }
    try {
      const session = await accounts.register(body.data.email, body.data.password);
      return reply.status(201).send({ token: session.token, expiresAt: session.expiresAt });
    } catch (error) {
      if (error instanceof EmailAlreadyRegisteredError) {
        return reply.status(409).send({ error: { code: 'email_already_registered', message: 'Ya existe una cuenta con ese correo.', retryable: false } });
      }
      throw error;
    }
  });

  app.post('/v1/auth/login', authRateLimit, async (request, reply) => {
    if (accounts === undefined) {
      return reply.status(503).send({ error: { code: 'accounts_not_configured', message: 'Las cuentas no están configuradas.', retryable: false } });
    }
    const body = LoginBodySchema.safeParse(request.body);
    if (!body.success) {
      // Mismo cuerpo que un login fallido: no se distingue "mal formado" de
      // "credenciales incorrectas" hacia afuera más allá del código de forma.
      return reply.status(400).send({ error: { code: 'invalid_credentials_input', message: 'Correo o contraseña inválidos.', retryable: false } });
    }
    try {
      const session = await accounts.login(body.data.email, body.data.password);
      return reply.status(200).send({ token: session.token, expiresAt: session.expiresAt });
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        // IDÉNTICO tanto si el correo no existe como si la contraseña está mal.
        return reply.status(401).send({ error: { code: 'invalid_credentials', message: 'Correo o contraseña incorrectos.', retryable: false } });
      }
      throw error;
    }
  });

  app.post('/v1/auth/logout', async (request, reply) => {
    if (accounts === undefined) {
      return reply.status(503).send({ error: { code: 'accounts_not_configured', message: 'Las cuentas no están configuradas.', retryable: false } });
    }
    const token = bearerToken(request);
    if (token === null) {
      return reply.status(401).send({ error: { code: 'unauthorized', message: 'Falta un token de sesión válido.', retryable: false } });
    }
    await accounts.logout(token);
    return reply.status(200).send({ ok: true });
  });

  app.get('/v1/auth/me', async (request, reply) => {
    if (accounts === undefined) {
      return reply.status(503).send({ error: { code: 'accounts_not_configured', message: 'Las cuentas no están configuradas.', retryable: false } });
    }
    const user = await requireUser(request, reply);
    if (user === null) return reply;
    // Solo correo y estado de suscripción — nada más.
    return { email: user.email, subscriptionStatus: user.subscriptionStatus };
  });

  // ── Catálogo personal ───────────────────────────────────────────────────
  app.get('/v1/catalog/mine', async (request, reply) => {
    if (personalCatalog === undefined) {
      return reply.status(503).send({ error: { code: 'catalog_not_configured', message: 'El catálogo no está configurado.', retryable: false } });
    }
    const user = await requireUser(request, reply);
    if (user === null) return reply;
    return { foods: await personalCatalog.listMine(user.id) };
  });

  app.put(
    '/v1/catalog/mine',
    { bodyLimit: 40_000, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (personalCatalog === undefined) {
        return reply.status(503).send({ error: { code: 'catalog_not_configured', message: 'El catálogo no está configurado.', retryable: false } });
      }
      const user = await requireUser(request, reply);
      if (user === null) return reply;
      const body = SharedCatalogUploadSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: 'invalid_catalog_entries', message: 'Las entradas del catálogo no son válidas.', retryable: false } });
      }
      const outcome = await personalCatalog.upsertMine(user.id, body.data.entries, new Date().toISOString());
      return outcome;
    },
  );

  app.delete('/v1/catalog/mine/:key', async (request, reply) => {
    if (personalCatalog === undefined) {
      return reply.status(503).send({ error: { code: 'catalog_not_configured', message: 'El catálogo no está configurado.', retryable: false } });
    }
    const user = await requireUser(request, reply);
    if (user === null) return reply;
    const params = CatalogKeyParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: { code: 'invalid_key', message: 'Clave de alimento inválida.', retryable: false } });
    }
    const deleted = await personalCatalog.deleteMine(user.id, params.data.key);
    return reply.status(deleted ? 200 : 404).send(deleted ? { ok: true } : { error: { code: 'not_found', message: 'No existe ese alimento en tu catálogo.', retryable: false } });
  });

  // ── Fotos del catálogo ──────────────────────────────────────────────────
  app.get('/v1/catalog/photo/:foodKey', async (request, reply) => {
    if (catalogPhotos === undefined) {
      return reply.status(503).send({ error: { code: 'catalog_not_configured', message: 'El catálogo no está configurado.', retryable: false } });
    }
    const params = FoodKeyParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: { code: 'invalid_key', message: 'Clave de alimento inválida.', retryable: false } });
    }
    // Con token → foto personal; sin token → foto de la comunidad.
    const user = await currentUser(request);
    const photo = await catalogPhotos.get(user?.id ?? null, params.data.foodKey);
    if (photo === null) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'No hay foto para ese alimento.', retryable: false } });
    }
    return reply
      .header('Content-Type', photo.mimeType)
      .header('Cache-Control', 'private, max-age=86400')
      .send(photo.bytes);
  });

  app.put(
    '/v1/catalog/photo/:foodKey',
    // 700 KB de tope de cuerpo: deja pasar el base64 (≈1.34×) de una foto de
    // hasta 400 KB para poder responder 413 nosotros con un mensaje claro, en
    // vez de que Fastify corte con un 413 genérico antes de validar.
    { bodyLimit: 700_000, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (catalogPhotos === undefined) {
        return reply.status(503).send({ error: { code: 'catalog_not_configured', message: 'El catálogo no está configurado.', retryable: false } });
      }
      const user = await requireUser(request, reply);
      if (user === null) return reply;
      const params = FoodKeyParamsSchema.safeParse(request.params);
      if (!params.success) {
        return reply.status(400).send({ error: { code: 'invalid_key', message: 'Clave de alimento inválida.', retryable: false } });
      }
      const body = PhotoUploadBodySchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: { code: 'invalid_photo', message: 'Falta la imagen en base64 o el tipo MIME no es válido (jpeg, png o webp).', retryable: false } });
      }
      let bytes: Buffer;
      try {
        bytes = Buffer.from(body.data.imageBase64, 'base64');
      } catch {
        return reply.status(400).send({ error: { code: 'invalid_photo', message: 'La imagen no es base64 válido.', retryable: false } });
      }
      if (bytes.length === 0) {
        return reply.status(400).send({ error: { code: 'invalid_photo', message: 'La imagen está vacía.', retryable: false } });
      }
      if (bytes.length > MAX_PHOTO_BYTES) {
        return reply.status(413).send({ error: { code: 'photo_too_large', message: 'La foto supera el máximo de 400 KB. Comprímela antes de subirla.', retryable: false } });
      }
      await catalogPhotos.upsert(user.id, params.data.foodKey, bytes, body.data.mimeType);
      return reply.status(200).send({ ok: true });
    },
  );

  app.delete('/v1/catalog/photo/:foodKey', async (request, reply) => {
    if (catalogPhotos === undefined) {
      return reply.status(503).send({ error: { code: 'catalog_not_configured', message: 'El catálogo no está configurado.', retryable: false } });
    }
    const user = await requireUser(request, reply);
    if (user === null) return reply;
    const params = FoodKeyParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: { code: 'invalid_key', message: 'Clave de alimento inválida.', retryable: false } });
    }
    await catalogPhotos.delete(user.id, params.data.foodKey);
    return reply.status(200).send({ ok: true });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AIServiceError || error instanceof CGMProviderError || error instanceof JunctionLinkError) {
      const status = error instanceof AIServiceError && error.code === 'unsafe_output' ? 422 : 502;
      return reply.status(status).send({
        error: { code: error.name, message: error.message, retryable: error.retryable },
      });
    }
    // Fastify raises this when a request body exceeds a route's bodyLimit,
    // before the route handler runs. Translate it into a clear 413 instead of
    // the generic 500 below. Message is generic on purpose: this handler is
    // global and every route with a small bodyLimit (auth, catalog, photo…)
    // can trip it.
    const asError = error as { code?: unknown; statusCode?: unknown };
    if (asError.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || asError.statusCode === 413) {
      return reply.status(413).send({
        error: {
          code: 'payload_too_large',
          message: 'El cuerpo de la petición es demasiado grande.',
          retryable: false,
        },
      });
    }
    app.log.error({ err: error }, 'Unhandled request error');
    return reply.status(500).send({
      error: { code: 'internal_error', message: 'Ocurrió un error interno.', retryable: true },
    });
  });

  return app;
}
