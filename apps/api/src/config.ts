import { z } from 'zod';

const EmptyToUndefined = z.preprocess((value) => (value === '' ? undefined : value), z.string().optional());

const EnvironmentSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  ABACUS_ROUTE_LLM_API_KEY: EmptyToUndefined,
  ABACUS_ROUTE_LLM_BASE_URL: z.url().default('https://routellm.abacus.ai/v1'),
  ABACUS_ROUTE_LLM_MODEL: z.string().min(1).default('route-llm'),
  CGM_PROVIDER: z.enum(['mock', 'junction']).default('mock'),
  CGM_STALE_AFTER_MINUTES: z.coerce.number().positive().max(120).default(15),
  JUNCTION_API_KEY: EmptyToUndefined,
  JUNCTION_USER_ID: EmptyToUndefined,
  JUNCTION_ENVIRONMENT: z
    .enum(['sandbox_eu', 'production_eu', 'sandbox_us', 'production_us'])
    .default('sandbox_eu'),
  JUNCTION_USER_TIMEZONE: z.string().min(1).default('America/Santiago'),
});

export type AppConfig = z.infer<typeof EnvironmentSchema>;

export function readConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  return EnvironmentSchema.parse(environment);
}
