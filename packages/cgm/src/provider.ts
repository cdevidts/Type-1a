import type { CGMProviderStatus, CGMReading } from '@type1a/schemas';

export interface CGMProvider {
  readonly name: string;
  getLatestReading(): Promise<CGMReading | null>;
  getReadings(params: { from: Date; to: Date }): Promise<CGMReading[]>;
  getStatus(): Promise<CGMProviderStatus>;
}

export class CGMProviderError extends Error {
  public constructor(
    message: string,
    public readonly code:
      | 'authentication_required'
      | 'provider_error'
      | 'not_connected'
      | 'invalid_response',
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'CGMProviderError';
  }
}
