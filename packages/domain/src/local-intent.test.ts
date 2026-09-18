import { describe, expect, it } from 'vitest';

import { parseElapsedMinutes, parseLocalIntent, toPrefill } from './local-intent';

describe('parseElapsedMinutes — el tiempo no es relleno', () => {
  it('entiende cómo se dice de verdad', () => {
    expect(parseElapsedMinutes('me puse 6 de rápida hace 2 horas')).toBe(120);
    expect(parseElapsedMinutes('hace 40 minutos')).toBe(40);
    expect(parseElapsedMinutes('hace una hora')).toBe(60);
    expect(parseElapsedMinutes('hace media hora')).toBe(30);
    expect(parseElapsedMinutes('hace 3 hrs')).toBe(180);
  });

  it('NO inventa un tiempo cuando ella no lo dice', () => {
    // "un rato" no son 30 minutos. Inventarlos mueve la insulina activa y con
    // ella la corrección que la app propone.
    expect(parseElapsedMinutes('me puse 6 de rápida hace un rato')).toBeNull();
    expect(parseElapsedMinutes('me puse 6 de rápida')).toBeNull();
    expect(parseElapsedMinutes('recién me puse 6')).toBeNull();
  });

  it('descarta un tiempo absurdo en vez de registrarlo', () => {
    expect(parseElapsedMinutes('hace 200 horas')).toBeNull();
  });

  it('el prefill lleva los minutos, y el resto se entiende igual', () => {
    const parsed = parseLocalIntent('me puse 6 de rápida hace 2 horas', 'mg/dL');
    const prefill = toPrefill(parsed.intents);
    expect(prefill.rapidUnits).toBe(6);
    expect(prefill.minutesAgo).toBe(120);
  });
});
