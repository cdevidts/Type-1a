import { assessFreshness } from '@type1a/domain';
import type { CGMProviderStatus, CGMReading, CGMTrend } from '@type1a/schemas';
import { z } from 'zod';

import { CGMProviderError, type CGMProvider } from './provider';
import { addDerivedTrends } from './trend';

export const LLU_REGIONS = [
  'ae', 'ap', 'au', 'ca', 'de', 'eu', 'eu2', 'fr', 'jp', 'us', 'la', 'ru', 'cn',
] as const;
export type LibreLinkUpRegion = (typeof LLU_REGIONS)[number];

function regionHost(region: LibreLinkUpRegion): string {
  if (region === 'ru') return 'api.libreview.ru';
  if (region === 'cn') return 'api-cn.myfreestyle.cn';
  return `api-${region}.libreview.io`;
}

// Undocumented, reverse-engineered LibreLinkUp mobile API. These constants mirror
// what the LibreLinkUp app itself sends; the API rejects requests without them.
const LLU_VERSION = '4.16.0';
const LLU_PRODUCT = 'llu.ios';
const LLU_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU OS 17_4.1 like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/17.4.1 Mobile/10A5355d Safari/8536.25';

const GlucoseMeasurementSchema = z.object({
  FactoryTimestamp: z.string().min(1),
  ValueInMgPerDl: z.number().positive().finite(),
  TrendArrow: z.number().optional(),
});

const LoginResponseSchema = z.object({
  status: z.number(),
  data: z
    .object({
      redirect: z.boolean().optional(),
      region: z.string().optional(),
      authTicket: z
        .object({
          token: z.string().min(1),
          expires: z.number(),
        })
        .optional(),
      user: z.object({ id: z.string().min(1) }).optional(),
    })
    .optional(),
});

const ConnectionsResponseSchema = z.object({
  status: z.number(),
  data: z.array(
    z.object({
      patientId: z.string().min(1),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      glucoseMeasurement: GlucoseMeasurementSchema.nullable().optional(),
    }),
  ),
});

const GraphResponseSchema = z.object({
  status: z.number(),
  data: z.object({
    connection: z.object({
      glucoseMeasurement: GlucoseMeasurementSchema.nullable().optional(),
    }),
    graphData: z.array(GlucoseMeasurementSchema),
  }),
});

/**
 * LibreLinkUp's FactoryTimestamp ("M/D/YYYY h:mm:ss AM/PM") carries no timezone
 * marker, but the wall-clock numbers are UTC. Parsed explicitly (not via the
 * environment-dependent `new Date(string)`) so this doesn't drift with the
 * runtime's timezone.
 */
export function parseLibreFactoryTimestamp(value: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/u.exec(value.trim());
  if (!match) {
    throw new CGMProviderError(`Unrecognized LibreLinkUp timestamp: ${value}`, 'invalid_response', false);
  }
  const [, monthStr, dayStr, yearStr, hourStr, minuteStr, secondStr, meridiem] = match;
  let hour = Number(hourStr) % 12;
  if (meridiem === 'PM') hour += 12;
  return new Date(
    Date.UTC(Number(yearStr), Number(monthStr) - 1, Number(dayStr), hour, Number(minuteStr), Number(secondStr)),
  ).toISOString();
}

function mapTrendArrow(raw: number | undefined): CGMTrend {
  switch (raw) {
    case 1: return 'rapid_down';
    case 2: return 'down';
    case 3: return 'stable';
    case 4: return 'up';
    case 5: return 'rapid_up';
    default: return 'unknown';
  }
}

interface LibreLinkUpSession {
  region: LibreLinkUpRegion;
  token: string;
  expiresAtEpochSeconds: number;
  accountIdHash: string;
  patientId: string;
}

export interface LibreLinkUpProviderOptions {
  email: string;
  password: string;
  /** Starting region guess. If wrong, the API redirects and we retry once automatically. */
  region?: LibreLinkUpRegion;
  /** Pin to a specific connection when the follower account has more than one. */
  patientId?: string;
  staleAfterMinutes?: number;
  fetcher?: typeof fetch;
  now?: () => Date;
  /**
   * SHA-256 hex de una cadena. Se inyecta en vez de importar `node:crypto`
   * arriba, porque este mismo proveedor corre en dos runtimes: el backend
   * (`apps/api`, con `node:crypto`) y **el teléfono** (`apps/mobile`, con
   * `expo-crypto`), donde un `import 'node:crypto'` a nivel de módulo rompe
   * el bundle de Metro aunque nunca se ejecute. Es `async` porque la API de
   * `expo-crypto` lo es; la de Node se envuelve trivialmente.
   *
   * Se usa solo para el header `account-id` que exige la API de LibreLinkUp
   * — no es una primitiva de seguridad nuestra.
   */
  sha256Hex: (input: string) => Promise<string>;
}

export class LibreLinkUpCGMProvider implements CGMProvider {
  public readonly name = 'librelinkup-freestyle-libre';
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly staleAfterMinutes: number;
  private session: LibreLinkUpSession | undefined;

  public constructor(private readonly options: LibreLinkUpProviderOptions) {
    if (!options.email || !options.password) {
      throw new CGMProviderError('LibreLinkUp credentials are not configured.', 'not_connected', false);
    }
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.staleAfterMinutes = options.staleAfterMinutes ?? 15;
  }

  private headers(session?: LibreLinkUpSession): HeadersInit {
    const headers: Record<string, string> = {
      'User-Agent': LLU_USER_AGENT,
      'Content-Type': 'application/json;charset=UTF-8',
      Accept: 'application/json',
      version: LLU_VERSION,
      product: LLU_PRODUCT,
      'account-id': session?.accountIdHash ?? '',
    };
    if (session) headers.Authorization = `Bearer ${session.token}`;
    return headers;
  }

  private async loginAtRegion(
    region: LibreLinkUpRegion,
    visitedRegions: ReadonlySet<LibreLinkUpRegion> = new Set(),
  ): Promise<LibreLinkUpSession> {
    let response: Response;
    try {
      response = await this.fetcher(`https://${regionHost(region)}/llu/auth/login`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ email: this.options.email, password: this.options.password }),
      });
    } catch {
      throw new CGMProviderError('LibreLinkUp is unreachable.', 'provider_error', true);
    }

    if (response.status === 401 || response.status === 403) {
      throw new CGMProviderError('LibreLinkUp authentication failed.', 'authentication_required', false);
    }
    if (!response.ok) {
      throw new CGMProviderError(`LibreLinkUp returned HTTP ${response.status}.`, 'provider_error', response.status >= 500);
    }

    const parsed = LoginResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new CGMProviderError('LibreLinkUp login response was invalid.', 'invalid_response', false);
    }
    if (parsed.data.status !== 0 || parsed.data.data === undefined) {
      throw new CGMProviderError('LibreLinkUp rejected the login (bad credentials or unaccepted terms).', 'authentication_required', false);
    }

    const { redirect, region: redirectRegion, authTicket, user } = parsed.data.data;
    if (redirect === true && redirectRegion) {
      const correctRegion = redirectRegion.toLowerCase();
      if (!LLU_REGIONS.includes(correctRegion as LibreLinkUpRegion)) {
        throw new CGMProviderError(`LibreLinkUp redirected to an unknown region: ${redirectRegion}.`, 'invalid_response', false);
      }
      const nextVisited = new Set(visitedRegions).add(region);
      if (nextVisited.has(correctRegion as LibreLinkUpRegion)) {
        throw new CGMProviderError('LibreLinkUp redirect loop.', 'provider_error', false);
      }
      return this.loginAtRegion(correctRegion as LibreLinkUpRegion, nextVisited);
    }

    if (!authTicket || !user) {
      throw new CGMProviderError('LibreLinkUp credentials were rejected.', 'authentication_required', false);
    }

    const accountIdHash = await this.options.sha256Hex(user.id);
    const patientId = await this.fetchPrimaryPatientId(region, {
      region,
      token: authTicket.token,
      expiresAtEpochSeconds: authTicket.expires,
      accountIdHash,
      patientId: '',
    });

    return { region, token: authTicket.token, expiresAtEpochSeconds: authTicket.expires, accountIdHash, patientId };
  }

  private async fetchPrimaryPatientId(region: LibreLinkUpRegion, session: LibreLinkUpSession): Promise<string> {
    const connections = await this.fetchConnections(region, session);
    const chosen = this.options.patientId
      ? connections.find((connection) => connection.patientId === this.options.patientId)
      : connections[0];
    if (!chosen) {
      throw new CGMProviderError('No LibreLinkUp connection (shared patient) found for this account.', 'not_connected', false);
    }
    return chosen.patientId;
  }

  private async fetchConnections(
    region: LibreLinkUpRegion,
    session: LibreLinkUpSession,
  ): Promise<z.infer<typeof ConnectionsResponseSchema>['data']> {
    let response: Response;
    try {
      response = await this.fetcher(`https://${regionHost(region)}/llu/connections`, {
        headers: this.headers(session),
      });
    } catch {
      throw new CGMProviderError('LibreLinkUp is unreachable.', 'provider_error', true);
    }
    if (response.status === 401 || response.status === 403) {
      throw new CGMProviderError('LibreLinkUp session expired.', 'authentication_required', false);
    }
    if (!response.ok) {
      throw new CGMProviderError(`LibreLinkUp returned HTTP ${response.status}.`, 'provider_error', response.status >= 500);
    }
    const parsed = ConnectionsResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new CGMProviderError('LibreLinkUp connections response was invalid.', 'invalid_response', false);
    }
    return parsed.data.data;
  }

  private async ensureSession(): Promise<LibreLinkUpSession> {
    const nowSeconds = this.now().getTime() / 1000;
    if (this.session && this.session.expiresAtEpochSeconds - 60 > nowSeconds) {
      return this.session;
    }
    this.session = await this.loginAtRegion(this.options.region ?? 'la');
    return this.session;
  }

  private toReading(sample: z.infer<typeof GlucoseMeasurementSchema>, session: LibreLinkUpSession): CGMReading {
    const sourceTimestamp = parseLibreFactoryTimestamp(sample.FactoryTimestamp);
    return {
      id: `librelinkup:${session.patientId}:${sourceTimestamp}:${sample.ValueInMgPerDl}`,
      glucose: sample.ValueInMgPerDl,
      unit: 'mg/dL',
      timestamp: sourceTimestamp,
      trend: mapTrendArrow(sample.TrendArrow),
      trendSource: sample.TrendArrow === undefined ? 'unknown' : 'provider',
      source: this.name,
      origin: 'real',
      sourceTimestamp,
      ingestedAt: this.now().toISOString(),
    };
  }

  public async getLatestReading(): Promise<CGMReading | null> {
    const session = await this.ensureSession();
    const connections = await this.fetchConnections(session.region, session);
    const connection = connections.find((entry) => entry.patientId === session.patientId);
    if (!connection?.glucoseMeasurement) return null;
    return this.toReading(connection.glucoseMeasurement, session);
  }

  public async getReadings(params: { from: Date; to: Date }): Promise<CGMReading[]> {
    if (params.from > params.to) throw new Error('from must be before to');
    const session = await this.ensureSession();

    let response: Response;
    try {
      response = await this.fetcher(
        `https://${regionHost(session.region)}/llu/connections/${encodeURIComponent(session.patientId)}/graph`,
        { headers: this.headers(session) },
      );
    } catch {
      throw new CGMProviderError('LibreLinkUp is unreachable.', 'provider_error', true);
    }
    if (response.status === 401 || response.status === 403) {
      throw new CGMProviderError('LibreLinkUp session expired.', 'authentication_required', false);
    }
    if (!response.ok) {
      throw new CGMProviderError(`LibreLinkUp returned HTTP ${response.status}.`, 'provider_error', response.status >= 500);
    }
    const parsed = GraphResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new CGMProviderError('LibreLinkUp graph response was invalid.', 'invalid_response', false);
    }

    const samples = [...parsed.data.data.graphData];
    if (parsed.data.data.connection.glucoseMeasurement) {
      samples.push(parsed.data.data.connection.glucoseMeasurement);
    }

    const readings = samples
      .map((sample) => this.toReading(sample, session))
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
          detail: 'No hay lecturas disponibles desde LibreLinkUp.',
          checkedAt,
          isSynthetic: false,
        };
      }
      const freshness = assessFreshness(latest.sourceTimestamp, this.now(), this.staleAfterMinutes);
      return {
        state: freshness.state,
        provider: this.name,
        lastSourceTimestamp: latest.sourceTimestamp,
        checkedAt,
        isSynthetic: false,
      };
    } catch (error) {
      if (error instanceof CGMProviderError) {
        return {
          state: error.code === 'authentication_required' ? 'authentication_required' : 'provider_error',
          provider: this.name,
          detail: error.message,
          checkedAt,
          isSynthetic: false,
        };
      }
      return {
        state: 'provider_error',
        provider: this.name,
        detail: 'Unexpected provider error.',
        checkedAt,
        isSynthetic: false,
      };
    }
  }
}
