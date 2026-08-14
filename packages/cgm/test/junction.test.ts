import { describe, expect, it } from 'vitest';

import { JunctionCGMProvider, reinterpretFloatingTimestamp } from '../src/index.js';

describe('Junction LibreView normalization', () => {
  it('reinterprets FreeStyle floating time in America/Santiago instead of treating +00:00 as UTC', () => {
    expect(reinterpretFloatingTimestamp('2026-08-12T10:00:00+00:00', 'America/Santiago')).toBe(
      '2026-08-12T14:00:00.000Z',
    );
  });

  it('normalizes and deduplicates Junction glucose samples', async () => {
    const payload = {
      groups: {
        freestyle_libre: [
          {
            data: [
              { timestamp: '2026-08-12T09:55:00+00:00', type: 'automatic', unit: 'mmol/L', value: 6 },
              { timestamp: '2026-08-12T10:00:00+00:00', type: 'automatic', unit: 'mmol/L', value: 6.5 },
              { timestamp: '2026-08-12T10:00:00+00:00', type: 'automatic', unit: 'mmol/L', value: 6.5 },
            ],
            source: { provider: 'freestyle_libre', type: 'cgm' },
          },
        ],
      },
    };
    const fetcher: typeof fetch = async () => new Response(JSON.stringify(payload), { status: 200 });
    const provider = new JunctionCGMProvider({
      apiKey: 'test',
      userId: 'user-1',
      environment: 'sandbox_eu',
      userTimeZone: 'America/Santiago',
      fetcher,
      now: () => new Date('2026-08-12T14:02:00.000Z'),
    });

    const readings = await provider.getReadings({
      from: new Date('2026-08-12T13:50:00.000Z'),
      to: new Date('2026-08-12T14:02:00.000Z'),
    });

    expect(readings).toHaveLength(2);
    expect(readings[0]).toMatchObject({ glucose: 108, origin: 'synthetic', unit: 'mg/dL' });
    expect(readings[1]).toMatchObject({ glucose: 117, trendSource: 'derived' });
  });

  it('maps authentication failures to an explicit status', async () => {
    const fetcher: typeof fetch = async () => new Response('', { status: 401 });
    const provider = new JunctionCGMProvider({
      apiKey: 'bad',
      userId: 'user-1',
      environment: 'production_eu',
      userTimeZone: 'America/Santiago',
      fetcher,
      now: () => new Date('2026-08-12T14:02:00.000Z'),
    });

    expect(await provider.getStatus()).toMatchObject({
      state: 'authentication_required',
      isSynthetic: false,
    });
  });
});
