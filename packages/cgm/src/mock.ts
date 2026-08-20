import { assessFreshness } from '@type1a/domain';
import type { CGMProviderStatus, CGMReading } from '@type1a/schemas';

import type { CGMProvider } from './provider';
import { addDerivedTrends } from './trend';

export interface MockCGMProviderOptions {
  now?: () => Date;
  staleAfterMinutes?: number;
}

export class MockCGMProvider implements CGMProvider {
  public readonly name = 'mock-synthetic';
  private readonly now: () => Date;
  private readonly staleAfterMinutes: number;

  public constructor(options: MockCGMProviderOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.staleAfterMinutes = options.staleAfterMinutes ?? 15;
  }

  public async getLatestReading(): Promise<CGMReading> {
    const to = this.now();
    const from = new Date(to.getTime() - 10 * 60_000);
    return (await this.getReadings({ from, to })).at(-1)!;
  }

  public async getReadings(params: { from: Date; to: Date }): Promise<CGMReading[]> {
    if (params.from > params.to) throw new Error('from must be before to');
    const start = Math.ceil(params.from.getTime() / 300_000) * 300_000;
    const end = Math.floor(params.to.getTime() / 300_000) * 300_000;
    const ingestedAt = this.now().toISOString();
    const readings: CGMReading[] = [];

    for (let timestamp = start; timestamp <= end; timestamp += 300_000) {
      const minutesOfDay = (timestamp / 60_000) % 1440;
      const baseline = 112 + 13 * Math.sin((minutesOfDay / 1440) * Math.PI * 2);
      const mealWave = 36 * Math.max(0, Math.sin(((minutesOfDay % 360) / 180) * Math.PI));
      const glucose = Math.max(55, Math.round(baseline + mealWave));
      const sourceTimestamp = new Date(timestamp).toISOString();
      readings.push({
        id: `mock:${sourceTimestamp}`,
        glucose,
        unit: 'mg/dL',
        timestamp: sourceTimestamp,
        trend: 'unknown',
        trendSource: 'unknown',
        source: this.name,
        origin: 'synthetic',
        sourceTimestamp,
        ingestedAt,
      });
    }

    return addDerivedTrends(readings);
  }

  public async getStatus(): Promise<CGMProviderStatus> {
    const latest = await this.getLatestReading();
    const freshness = assessFreshness(
      latest.sourceTimestamp,
      this.now(),
      this.staleAfterMinutes,
    );
    return {
      state: freshness.state,
      provider: this.name,
      detail: 'Datos sintéticos para desarrollo; no provienen de un sensor.',
      lastSourceTimestamp: latest.sourceTimestamp,
      checkedAt: this.now().toISOString(),
      isSynthetic: true,
    };
  }
}
