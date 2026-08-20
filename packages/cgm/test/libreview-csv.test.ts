import { describe, expect, it } from 'vitest';

import { parseLibreViewCsv } from '../src/index';

describe('LibreView CSV fallback', () => {
  it('imports historical readings without presenting them as live', () => {
    const csv = [
      'Generated,2026-08-12',
      'Device,Device Timestamp,Historic Glucose mg/dL,Scan Glucose mg/dL',
      'Libre 2,2026-08-12 10:00:00,112,',
    ].join('\n');

    const result = parseLibreViewCsv(csv, {
      userTimeZone: 'America/Santiago',
      ingestedAt: '2026-08-12T14:05:00.000Z',
    });

    expect(result.readings[0]).toMatchObject({
      glucose: 112,
      origin: 'imported',
      source: 'libreview-csv',
      sourceTimestamp: '2026-08-12T14:00:00.000Z',
    });
  });
});
