import { describe, expect, it } from 'vitest';

import { MockCGMProvider } from '../src/index.js';

describe('MockCGMProvider', () => {
  it('is unmistakably synthetic', async () => {
    const now = () => new Date('2026-08-12T14:02:00.000Z');
    const provider = new MockCGMProvider({ now });

    const latest = await provider.getLatestReading();
    const status = await provider.getStatus();

    expect(latest.origin).toBe('synthetic');
    expect(latest.source).toContain('mock');
    expect(status.isSynthetic).toBe(true);
    expect(status.detail).toContain('sintéticos');
  });
});
