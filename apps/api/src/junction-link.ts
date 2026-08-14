import { JUNCTION_BASE_URLS, type JunctionEnvironment } from '@type1a/cgm';
import { z } from 'zod';

const LinkTokenResponseSchema = z.object({
  link_token: z.string().min(1),
});

const LinkResponseSchema = z.object({
  state: z.string().optional(),
  success: z.boolean().optional(),
  error: z.string().optional(),
}).passthrough();

export class JunctionLinkError extends Error {
  public constructor(message: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'JunctionLinkError';
  }
}

export interface JunctionLinkOptions {
  apiKey: string;
  userId: string;
  environment: JunctionEnvironment;
  fetcher?: typeof fetch;
}

export class JunctionLinkService {
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;

  public constructor(private readonly options: JunctionLinkOptions) {
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = JUNCTION_BASE_URLS[options.environment];
  }

  public async connectFreestyleLibre(email: string, region = 'cl'): Promise<{ state: string }> {
    const tokenResponse = await this.fetcher(`${this.baseUrl}/v2/link/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-vital-api-key': this.options.apiKey,
      },
      body: JSON.stringify({ user_id: this.options.userId, provider: 'freestyle_libre' }),
    });
    if (!tokenResponse.ok) {
      throw new JunctionLinkError(`No se pudo iniciar Junction (${tokenResponse.status}).`, tokenResponse.status >= 500);
    }
    const token = LinkTokenResponseSchema.safeParse(await tokenResponse.json());
    if (!token.success) throw new JunctionLinkError('Junction no devolvió un link token válido.', false);

    const linkResponse = await this.fetcher(
      `${this.baseUrl}/v2/link/provider/email/freestyle_libre`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-vital-link-token': token.data.link_token,
        },
        body: JSON.stringify({ email, region }),
      },
    );
    if (!linkResponse.ok) {
      throw new JunctionLinkError(`No se pudo conectar FreeStyle (${linkResponse.status}).`, linkResponse.status >= 500);
    }
    const linked = LinkResponseSchema.safeParse(await linkResponse.json());
    if (!linked.success) throw new JunctionLinkError('Junction devolvió una respuesta inválida.', false);
    if (linked.data.error !== undefined) throw new JunctionLinkError('Junction rechazó la conexión FreeStyle.', false);
    return { state: linked.data.state ?? (linked.data.success === false ? 'failed' : 'connected') };
  }
}
