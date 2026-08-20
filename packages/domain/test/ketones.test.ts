import { describe, expect, it } from 'vitest';

import {
  assessKetones,
  KETONES_ELEVATED_MMOL_L,
  KETONES_HIGH_MMOL_L,
  KETONES_VERY_HIGH_MMOL_L,
} from '../src/ketones';

describe('assessKetones', () => {
  it('clasifica cada banda', () => {
    expect(assessKetones(0).band).toBe('normal');
    expect(assessKetones(0.3).band).toBe('normal');
    expect(assessKetones(0.9).band).toBe('elevated');
    expect(assessKetones(2).band).toBe('high');
    expect(assessKetones(4).band).toBe('veryHigh');
  });

  it('los bordes pertenecen a la banda superior', () => {
    expect(assessKetones(KETONES_ELEVATED_MMOL_L).band).toBe('elevated');
    expect(assessKetones(KETONES_HIGH_MMOL_L).band).toBe('high');
    expect(assessKetones(KETONES_VERY_HIGH_MMOL_L).band).toBe('veryHigh');
  });

  it('marca urgente solo de 1.5 mmol/L para arriba', () => {
    expect(assessKetones(1.4).urgent).toBe(false);
    expect(assessKetones(1.5).urgent).toBe(true);
    expect(assessKetones(5).urgent).toBe(true);
  });

  it('acepta 0 pero rechaza valores imposibles', () => {
    expect(() => assessKetones(0)).not.toThrow();
    expect(() => assessKetones(-1)).toThrow();
    expect(() => assessKetones(Number.NaN)).toThrow();
  });

  it('ninguna etiqueta menciona insulina ni una dosis', () => {
    // Frontera de AGENTS.md: la literatura de cetonas viene con protocolos de
    // corrección; nada de eso puede filtrarse a un texto que ve la usuaria.
    for (const value of [0, 0.7, 2, 4]) {
      const label = assessKetones(value).label.toLowerCase();
      // Con límites de palabra: sin ellos, "dosis" hace match dentro de
      // "cetoacidosis" y el test falla contra un texto que está bien.
      expect(label).not.toMatch(/\b(insulina|unidades?|dosis|corrige|corregir|ponte|inyecta)\b/u);
    }
  });
});
