import { z } from 'zod';

const EmptyToUndefined = z.preprocess((value) => (value === '' ? undefined : value), z.string().optional());

const EnvironmentSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ABACUS_ROUTE_LLM_API_KEY: EmptyToUndefined,
  ABACUS_ROUTE_LLM_BASE_URL: z.url().default('https://routellm.abacus.ai/v1'),
  ABACUS_ROUTE_LLM_MODEL: z.string().min(1).default('route-llm'),
  CGM_PROVIDER: z.enum(['mock', 'junction', 'librelinkup']).default('mock'),
  CGM_STALE_AFTER_MINUTES: z.coerce.number().positive().max(120).default(15),
  JUNCTION_API_KEY: EmptyToUndefined,
  JUNCTION_USER_ID: EmptyToUndefined,
  JUNCTION_ENVIRONMENT: z
    .enum(['sandbox_eu', 'production_eu', 'sandbox_us', 'production_us'])
    .default('sandbox_eu'),
  JUNCTION_USER_TIMEZONE: z.string().min(1).default('America/Santiago'),
  // LibreLinkUp is an unofficial, reverse-engineered API (no Abbott SDK exists).
  // LIBRELINKUP_EMAIL/PASSWORD must be a follower account, not the patient's own login.
  LIBRELINKUP_EMAIL: EmptyToUndefined,
  LIBRELINKUP_PASSWORD: EmptyToUndefined,
  LIBRELINKUP_REGION: z
    .enum(['ae', 'ap', 'au', 'ca', 'de', 'eu', 'eu2', 'fr', 'jp', 'us', 'la', 'ru', 'cn'])
    .default('la'),
  // Catálogo de alimentos compartido (backend preparado 2026-08-21, ver
  // docs/adr/0003-shared-food-catalog.md). Ausente → los endpoints
  // /v1/food-catalog degradan a 503, el mismo patrón de "sin configurar" que
  // ya usa cada integración externa de este archivo. Es la ÚNICA variable
  // de este config que le da estado al backend — el resto son credenciales
  // hacia servicios externos sin estado.
  DATABASE_URL: EmptyToUndefined,
  // Piso de moderación: cuántas veces tiene que haberse visto un alimento
  // antes de servírselo a otra usuaria. Ver food-catalog-store.ts.
  SHARED_CATALOG_MIN_TIMES_SEEN: z.coerce.number().int().nonnegative().default(3),
});

export type AppConfig = z.infer<typeof EnvironmentSchema>;

export function readConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvironmentSchema.parse(environment);
}
