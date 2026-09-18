import { describe, expect, it } from 'vitest';

import type { InsulinEvent } from '@type1a/schemas';

import { dosesExcluding, recentMealOnlyDose } from './meal-only-dose';

const now = '2026-09-18T22:26:00.000Z';
const minutesBefore = (m: number): string =>
  new Date(Date.parse(now) - m * 60_000).toISOString();

const dose = (over: Partial<InsulinEvent> & { id: string }): InsulinEvent => ({
  timestamp: over.timestamp ?? minutesBefore(4),
  type: 'rapid',
  units: 6,
  source: 'manual',
  createdAt: over.timestamp ?? minutesBefore(4),
  ...over,
} as InsulinEvent);

describe('recentMealOnlyDose', () => {
  it('reconoce el caso exacto que ella vivió', () => {
    // 6 U hace 4 minutos, todas de comida, sin corrección adentro.
    const found = recentMealOnlyDose(
      [dose({ id: 'a', units: 6, mealUnits: 6, correctionUnits: 0 })],
      now,
    );
    expect(found?.event.id).toBe('a');
    expect(found?.minutesAgo).toBe(4);
  });

  it('NO ofrece nada si la dosis ya traía corrección adentro', () => {
    // Ahí la resta del ADR 0006 es la correcta: sumarle otra sería apilar.
    expect(recentMealOnlyDose(
      [dose({ id: 'a', units: 8, mealUnits: 6, correctionUnits: 2 })],
      now,
    )).toBeNull();
  });

  it('NO ofrece nada sin desglose: ausente es "no se sabe", no cero', () => {
    // Una dosis escrita a mano o importada no permite afirmar que no traía
    // corrección, y afirmarlo sería inventar el dato que decide la resta.
    expect(recentMealOnlyDose([dose({ id: 'a', units: 6 })], now)).toBeNull();
    expect(recentMealOnlyDose([dose({ id: 'a', units: 6, mealUnits: 6 })], now)).toBeNull();
  });

  it('deja de ofrecerlo cuando ya son dos decisiones distintas', () => {
    const vieja = dose({ id: 'a', mealUnits: 6, correctionUnits: 0, timestamp: minutesBefore(45) });
    expect(recentMealOnlyDose([vieja], now)).toBeNull();
  });

  it('elige la más reciente si hay varias', () => {
    const found = recentMealOnlyDose([
      dose({ id: 'vieja', mealUnits: 4, correctionUnits: 0, timestamp: minutesBefore(15) }),
      dose({ id: 'nueva', mealUnits: 6, correctionUnits: 0, timestamp: minutesBefore(2) }),
    ], now);
    expect(found?.event.id).toBe('nueva');
  });

  it('ignora la basal', () => {
    expect(recentMealOnlyDose(
      [dose({ id: 'a', type: 'basal', mealUnits: 6, correctionUnits: 0 })],
      now,
    )).toBeNull();
  });
});

describe('dosesExcluding', () => {
  it('saca solo la dosis que se está por completar', () => {
    const doses = [dose({ id: 'a' }), dose({ id: 'b' })];
    expect(dosesExcluding(doses, 'a').map((d) => d.id)).toEqual(['b']);
  });
});
