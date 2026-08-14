import { assessFreshness, convertGlucose } from '@type1a/domain';
import type { CGMProviderStatus, CGMReading, GlucoseUnit } from '@type1a/schemas';
import { fromZonedTime } from 'date-fns-tz';
import { z } from 'zod';

import { CGMProviderError, type CGMProvider } from './provider.js';
import { addDerivedTrends } from './trend.js';

const JunctionSampleSchema = z.object({
  timestamp: z.string().min(1),
  type: z.string().optional(),
  unit: z.string().min(1),
  value: z.number().positive().finite(),
});

const JunctionGroupSchema = z.object({
  data: z.array(JunctionSampleSchema),
  source: z.object({
    provider: z.string().min(1),
    type: z.string().optional(),
  }),
});

const JunctionGlucoseResponseSchema = z.object({
  groups: z.record(z.string(), z.array(JunctionGroupSchema)),
});

export type JunctionEnvironment = 'sandbox_eu' | 'production_eu' | 'sandbox_us' | 'production_us';

export const JUNCTION_BASE_URLS: Record<JunctionEnvironment, string> = {
  sandbox_eu: 'https://api.sandbox.eu.junction.com',
  production_eu: 'https://api.eu.junction.com',
  sandbox_us: 'https://api.sandbox.us.junction.com',
  production_us: 'https://api.us.junction.com',
};

export interface JunctionCGMProviderOptions {
  apiKey: string;
  userId: string;
  environment: JunctionEnvironment;
  userTimeZone: string;
  staleAfterMinutes?: number;
  fetcher?: typeof fetch;
  now?: () => Date;
}

export function reinterpretFloatingTimestamp(timestamp: string, userTimeZone: string): string {
  const wallTime = timestamp.replace(/(?:Z|[+-]\d{2}:\d{2})$/u, '');
  return fromZonedTime(wallTime, userTimeZone).toISOString();
}

function normalizeUnit(unit: string): GlucoseUnit {
  const normalized = unit.toLowerCase().replaceAll(' ', '');
  if (normalized === 'mg/dl') return 'mg/dL';
  if (normalized === 'mmol/l') return 'mmol/L';
  throw new CGMProviderError(`Unsupported Junction glucose unit: ${unit}`, 'invalid_response', false);
}

export class JunctionCGMProvider implements CGMProvider {
  public readonly name = 'junction-freestyle-libre';
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly staleAfterMinutes: number;

  public constructor(private readonly options: JunctionCGMProviderOptions) {
    if (!options.apiKey || !options.userId) {
      throw new CGMProviderError('Junction credentials are not configured.', 'not_connected', false);
    }
    this.baseUrl = JUNCTION_BASE_URLS[options.environment];
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.staleAfterMinutes = options.staleAfterMinutes ?? 15;
  }

  public async getLatestReading(): Promise<CGMReading | null> {
    const to = this.now();
    const from = new Date(to.getTime() - 24 * 60 * 60_000);
    return (await this.getReadings({ from, to })).at(-1) ?? null;
  }

  public async getReadings(params: { from: Date; to: Date }): Promise<CGMReading[]> {
    if (params.from > params.to) throw new Error('from must be before to');

    const url = new URL(
      `/v2/timeseries/${encodeURIComponent(this.options.userId)}/glucose/grouped`,
      this.baseUrl,
    );
    url.searchParams.set('start_date', params.from.toISOString().slice(0, 10));
    url.searchParams.set('end_date', params.to.toISOString().slice(0, 10));

    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: {
          Accept: 'application/json',
          'x-vital-api-key': this.options.apiKey,
        },
      });
    } catch {
      throw new CGMProviderError('Junction is unreachable.', 'provider_error', true);
    }

    if (response.status === 401 || response.status === 403) {
      throw new CGMProviderError('Junction authentication failed.', 'authentication_required', false);
    }
    if (!response.ok) {
      throw new CGMProviderError(`Junction returned HTTP ${response.status}.`, 'provider_error', response.status >= 500);
    }

    const parsed = JunctionGlucoseResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new CGMProviderError('Junction returned an invalid glucose payload.', 'invalid_response', false);
    }

    const ingestedAt = this.now().toISOString();
    const isSynthetic = this.options.environment.startsWith('sandbox');
    const readings = Object.values(parsed.data.groups)
      .flat()
      .flatMap((group) =>
        group.data.map((sample) => {
          const sourceTimestamp = reinterpretFloatingTimestamp(sample.timestamp, this.options.userTimeZone);
          const sourceUnit = normalizeUnit(sample.unit);
          const glucose = convertGlucose(sample.value, sourceUnit, 'mg/dL');
          return {
            id: `junction:${group.source.provider}:${sourceTimestamp}:${glucose}`,
            glucose,
            unit: 'mg/dL' as const,
            timestamp: sourceTimestamp,
            trend: 'unknown' as const,
            trendSource: 'unknown' as const,
            source: `${this.name}:${group.source.provider}`,
            origin: isSynthetic ? ('synthetic' as const) : ('real' as const),
            sourceTimestamp,
            ingestedAt,
          };
        }),
      )
      .filter((reading) => {
        const timestamp = Date.parse(reading.sourceTimestamp);
        return timestamp >= params.from.getTime() && timestamp <= params.to.getTime();
      });

    const deduplicated = [...new Map(readings.map((reading) => [reading.id, reading])).values()];
    return addDerivedTrends(deduplicated);
  }

  public async getStatus(): Promise<CGMProviderStatus> {
    const checkedAt = this.now().toISOString();
    try {
      const latest = await this.getLatestReading();
      if (latest === null) {
        return {
          state: 'offline',
          provider: this.name,
          detail: 'No hay lecturas disponibles en las últimas 24 horas.',
          checkedAt,
          isSynthetic: this.options.environment.startsWith('sandbox'),
        };
      }
      const freshness = assessFreshness(latest.sourceTimestamp, this.now(), this.staleAfterMinutes);
      return {
        state: freshness.state,
        provider: this.name,
        lastSourceTimestamp: latest.sourceTimestamp,
        checkedAt,
        isSynthetic: latest.origin === 'synthetic',
      };
    } catch (error) {
      if (error instanceof CGMProviderError) {
        return {
          state: error.code === 'authentication_required' ? 'authentication_required' : 'provider_error',
          provider: this.name,
          detail: error.message,
          checkedAt,
          isSynthetic: this.options.environment.startsWith('sandbox'),
        };
      }
      return {
        state: 'provider_error',
        provider: this.name,
        detail: 'Unexpected provider error.',
        checkedAt,
        isSynthetic: this.options.environment.startsWith('sandbox'),
      };
    }
  }
}
