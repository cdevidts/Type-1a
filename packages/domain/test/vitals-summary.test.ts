import { describe, expect, it } from 'vitest';

import { summarizeVitals } from '../src/vitals-summary';

import type { VitalsEvent } from '@type1a/schemas';

const base = {
  id: 'v1',
  timestamp: '2026-08-26T10:00:00.000Z',
  source: 'manual',
  createdAt: '2026-08-26T10:00:00.000Z',
} satisfies Omit<VitalsEvent, 'ketonesMmolL'>;

/**
 * Las verdades están escritas desde los umbrales clínicos (0,6 / 1,5 / 3,0
 * mmol/L), no derivadas de lo que devuelve la implementación.
 */
describe('summarizeVitals', () => {
  it('nombra la banda en el texto, no solo en el color', () => {
    const summary = summarizeVitals({ ...base, ketonesMmolL: 2 });
    expect(summary.title).toBe('Cetonas');
    // La banda tiene que poder leerse sin distinguir tonos.
    expect(summary.detail).toContain('2 mmol/L');
    expect(summary.detail.toLowerCase()).toContain('altas');
  });

  it('marca urgente desde 1,5 mmol/L, no antes', () => {
    expect(summarizeVitals({ ...base, ketonesMmolL: 1.4 }).urgent).toBe(false);
    expect(summarizeVitals({ ...base, ketonesMmolL: 1.5 }).urgent).toBe(true);
    expect(summarizeVitals({ ...base, ketonesMmolL: 3 }).urgent).toBe(true);
  });

  it('un valor normal se describe igual, sin urgencia', () => {
    const summary = summarizeVitals({ ...base, ketonesMmolL: 0.2 });
    expect(summary.urgent).toBe(false);
    expect(summary.detail).toContain('0.2 mmol/L');
    expect(summary.detail.toLowerCase()).toContain('normales');
  });

  it('cero cetonas es una medición, no una ausencia', () => {
    expect(summarizeVitals({ ...base, ketonesMmolL: 0 }).detail).toContain('0 mmol/L');
  });

  it('describe peso y presión cuando no hay cetonas', () => {
    expect(summarizeVitals({ ...base, weightKg: 62.5 })).toMatchObject({
      title: 'Peso',
      detail: '62.5 kg',
      urgent: false,
    });
    expect(summarizeVitals({ ...base, systolicBP: 120, diastolicBP: 80 })).toMatchObject({
      title: 'Presión',
      detail: '120/80 mmHg',
    });
  });

  it('un evento con varias medidas se nombra por las cetonas, que son las graves', () => {
    const summary = summarizeVitals({ ...base, ketonesMmolL: 2, weightKg: 62 });
    expect(summary.title).toBe('Cetonas y otros');
    expect(summary.urgent).toBe(true);
    expect(summary.detail).toContain('2 mmol/L');
    expect(summary.detail).toContain('62 kg');
  });
});
