import { describe, expect, it } from 'vitest';

import { MAX_SYNC_WINDOW_MS, MIN_SYNC_WINDOW_MS, syncWindowFrom } from './sync-window';

const now = new Date('2026-09-18T12:00:00.000Z');
const hoursAgo = (h: number): string => new Date(now.getTime() - h * 3_600_000).toISOString();

describe('syncWindowFrom', () => {
  it('cubre el hueco entero cuando la app estuvo dormida', () => {
    // El caso que perdía datos: dormida 9 h, se pedían solo las últimas 4.
    expect(syncWindowFrom(hoursAgo(9), now).toISOString()).toBe(hoursAgo(9));
  });

  it('nunca pide menos que la ventana mínima', () => {
    expect(syncWindowFrom(hoursAgo(1), now).getTime()).toBe(now.getTime() - MIN_SYNC_WINDOW_MS);
    expect(syncWindowFrom(now.toISOString(), now).getTime()).toBe(now.getTime() - MIN_SYNC_WINDOW_MS);
  });

  it('no pide más allá del tope, aunque lleve meses sin abrirse', () => {
    expect(syncWindowFrom(hoursAgo(2000), now).getTime()).toBe(now.getTime() - MAX_SYNC_WINDOW_MS);
  });

  it('una instalación nueva pide la ventana mínima', () => {
    expect(syncWindowFrom(null, now).getTime()).toBe(now.getTime() - MIN_SYNC_WINDOW_MS);
  });

  it('una fecha ilegible o futura no encoge la ventana en silencio', () => {
    expect(syncWindowFrom('no es una fecha', now).getTime()).toBe(now.getTime() - MIN_SYNC_WINDOW_MS);
    expect(syncWindowFrom(hoursAgo(-5), now).getTime()).toBe(now.getTime() - MIN_SYNC_WINDOW_MS);
  });
});
