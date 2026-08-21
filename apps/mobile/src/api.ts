import { Platform } from 'react-native';
import { z } from 'zod';

import {
  CGMProviderStatusSchema,
  CGMReadingSchema,
  GlucoseInsightSchema,
  MealAnalysisResultSchema,
  type CGMProviderStatus,
  type CGMReading,
  type GlucoseInsight,
  type MealAnalysisResult,
  type MealEpisodeMetrics,
  type MealSnapshot,
} from '@type1a/schemas';

const ApiErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }),
});

const ReadingsEnvelopeSchema = z.object({ readings: z.array(CGMReadingSchema) });
const LinkEnvelopeSchema = z.object({
  provider: z.literal('freestyle_libre'),
  state: z.string(),
});

const DEFAULT_API_URL = Platform.OS === 'android'
  ? 'http://10.0.2.2:4100'
  : 'http://127.0.0.1:4100';

export const API_BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL ?? DEFAULT_API_URL).replace(/\/$/u, '');

export class MobileApiError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'MobileApiError';
  }
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...init?.headers,
      },
    });
  } catch {
    throw new MobileApiError('No se pudo contactar el backend. El registro local sigue disponible.', 'offline', true, 0);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ApiErrorEnvelopeSchema.safeParse(payload);
    throw new MobileApiError(
      parsed.success ? parsed.data.error.message : `El backend respondió HTTP ${response.status}.`,
      parsed.success ? parsed.data.error.code : 'http_error',
      parsed.success ? parsed.data.error.retryable : response.status >= 500,
      response.status,
    );
  }
  return payload;
}

export async function fetchCGMStatus(): Promise<CGMProviderStatus> {
  return CGMProviderStatusSchema.parse(await requestJson('/v1/cgm/status'));
}

export async function fetchCGMReadings(from: Date, to: Date): Promise<CGMReading[]> {
  const query = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
  return ReadingsEnvelopeSchema.parse(await requestJson(`/v1/cgm/readings?${query.toString()}`)).readings;
}

export async function analyzeMealImage(input: {
  imageBase64: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  description?: string;
}): Promise<MealAnalysisResult> {
  const payload = await requestJson('/v1/ai/meal-analysis', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return MealAnalysisResultSchema.parse(payload);
}

/** Same endpoint, no photo — just a typed description of what was eaten. */
export async function analyzeMealDescription(description: string): Promise<MealAnalysisResult> {
  const payload = await requestJson('/v1/ai/meal-analysis', {
    method: 'POST',
    body: JSON.stringify({ description }),
  });
  return MealAnalysisResultSchema.parse(payload);
}

/**
 * Modo de edición (Fase 17): la comida guardada más una corrección en
 * lenguaje natural. Mismo endpoint que los otros dos modos.
 *
 * `current` es un `MealSnapshot`, que **no tiene** campo de insulina, glucosa
 * ni parámetro de terapia. Es la frontera de `AGENTS.md` hecha estructura: no
 * hay forma de que una dosis registrada viaje a un servicio externo por esta
 * ruta, porque no hay dónde ponerla.
 */
export async function editMealWithInstruction(input: {
  instruction: string;
  current: MealSnapshot;
}): Promise<MealAnalysisResult> {
  const payload = await requestJson('/v1/ai/meal-analysis', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return MealAnalysisResultSchema.parse(payload);
}

export async function fetchGlucoseInsight(metrics: MealEpisodeMetrics): Promise<GlucoseInsight> {
  const payload = await requestJson('/v1/ai/glucose-insight', {
    method: 'POST',
    body: JSON.stringify(metrics),
  });
  return GlucoseInsightSchema.parse(payload);
}

export async function connectFreestyleLibre(email: string): Promise<string> {
  const payload = await requestJson('/v1/provider/junction/link', {
    method: 'POST',
    body: JSON.stringify({ email, region: 'cl' }),
  });
  return LinkEnvelopeSchema.parse(payload).state;
}
