import { describe, expect, it } from 'vitest';

import type { MealEpisodeMetrics } from '@type1a/schemas';
import { MealEpisodeMetricsSchema } from '@type1a/schemas';

import { isoWithOffset, localizeEpisodeMetrics, offsetSuffix } from '../src/episode-local-time';

/** Chile continental: −04:00 en verano, −03:00 en horario de invierno. */
const CHILE_SUMMER = -240;

function metrics(overrides: Partial<MealEpisodeMetrics> = {}): MealEpisodeMetrics {
  return {
    mealTimestamp: '2026-09-01T21:30:00.000Z',
    timeAboveRangeMinutes: 0,
    timeBelowRangeMinutes: 0,
    readingCount: 12,
    ...overrides,
  };
}

describe('isoWithOffset', () => {
  it('escribe la hora de pared local sin mover el instante', () => {
    // El bug exacto: el modelo leía "21:30" de una comida de las 17:30.
    const local = isoWithOffset('2026-09-01T21:30:00.000Z', CHILE_SUMMER);
    expect(local).toBe('2026-09-01T17:30:00.000-04:00');
    expect(Date.parse(local)).toBe(Date.parse('2026-09-01T21:30:00.000Z'));
  });

  it('cruza el día hacia atrás cuando corresponde', () => {
    const local = isoWithOffset('2026-09-02T02:15:00.000Z', CHILE_SUMMER);
    expect(local).toBe('2026-09-01T22:15:00.000-04:00');
  });

  it('acepta una entrada que ya trae desfase y la reescribe al pedido', () => {
    expect(isoWithOffset('2026-09-01T17:30:00.000-04:00', 60)).toBe('2026-09-01T22:30:00.000+01:00');
  });

  it('el cero se dice, no se calla', () => {
    expect(offsetSuffix(0)).toBe('+00:00');
    expect(isoWithOffset('2026-09-01T21:30:00.000Z', 0)).toBe('2026-09-01T21:30:00.000+00:00');
  });

  it('sirve zonas con media hora y con tres cuartos', () => {
    expect(offsetSuffix(330)).toBe('+05:30');
    expect(offsetSuffix(345)).toBe('+05:45');
    expect(offsetSuffix(-570)).toBe('-09:30');
  });

  it('rechaza un desfase imposible en vez de producir una hora inventada', () => {
    expect(() => offsetSuffix(15 * 60)).toThrow();
    expect(() => offsetSuffix(30.5)).toThrow();
    expect(() => isoWithOffset('no es una fecha', CHILE_SUMMER)).toThrow();
  });
});

describe('localizeEpisodeMetrics', () => {
  it('traduce todas las horas del episodio, no solo la de inicio', () => {
    const localized = localizeEpisodeMetrics(
      metrics({
        rapidInsulinTimestamp: '2026-09-01T21:15:00.000Z',
        rapidInsulinUnits: 4,
        contextEvents: [
          { kind: 'carbs', timestamp: '2026-09-01T23:00:00.000Z', minutesAfterAnchor: 90, amount: 20 },
          { kind: 'rapid_insulin', timestamp: '2026-09-01T20:45:00.000Z', minutesAfterAnchor: -45, amount: 2 },
        ],
      }),
      () => CHILE_SUMMER,
    );

    expect(localized.mealTimestamp).toBe('2026-09-01T17:30:00.000-04:00');
    expect(localized.rapidInsulinTimestamp).toBe('2026-09-01T17:15:00.000-04:00');
    expect(localized.contextEvents?.[0]?.timestamp).toBe('2026-09-01T19:00:00.000-04:00');
    expect(localized.contextEvents?.[1]?.timestamp).toBe('2026-09-01T16:45:00.000-04:00');
  });

  it('no toca minutesAfterAnchor: es una diferencia, no una hora', () => {
    const localized = localizeEpisodeMetrics(
      metrics({
        contextEvents: [
          { kind: 'rapid_insulin', timestamp: '2026-09-01T20:45:00.000Z', minutesAfterAnchor: -45, amount: 2 },
        ],
      }),
      () => CHILE_SUMMER,
    );
    // El signo negativo es "antes de la comida" y el prompt lo lee; una
    // traducción de zona que lo tocara invertiría la lectura clínica.
    expect(localized.contextEvents?.[0]?.minutesAfterAnchor).toBe(-45);
  });

  it('pide el desfase de CADA marca, porque el horario de verano existe', () => {
    // Un episodio de marzo y uno de julio no comparten desfase en Chile.
    // Resolver una sola vez y reusar reintroduce el mismo error, una hora
    // más chico.
    const asked: string[] = [];
    localizeEpisodeMetrics(
      metrics({
        rapidInsulinTimestamp: '2026-09-01T21:15:00.000Z',
        rapidInsulinUnits: 4,
        contextEvents: [
          { kind: 'note', timestamp: '2026-09-01T22:00:00.000Z', minutesAfterAnchor: 30 },
        ],
      }),
      (iso) => { asked.push(iso); return CHILE_SUMMER; },
    );
    expect(asked).toEqual([
      '2026-09-01T21:30:00.000Z',
      '2026-09-01T21:15:00.000Z',
      '2026-09-01T22:00:00.000Z',
    ]);
  });

  it('lo que sale sigue siendo un MealEpisodeMetrics válido', () => {
    // El esquema acepta desfase (`z.iso.datetime({ offset: true })`); si
    // alguien lo endureciera a solo UTC, este test lo agarra antes que el
    // backend rechace el episodio entero.
    const localized = localizeEpisodeMetrics(metrics({ startingGlucose: 120 }), () => CHILE_SUMMER);
    expect(MealEpisodeMetricsSchema.parse(localized).mealTimestamp).toBe('2026-09-01T17:30:00.000-04:00');
  });

  it('deja intacto lo que no es una hora', () => {
    const original = metrics({ startingGlucose: 118, peakGlucose: 190, peakDelta: 72 });
    const localized = localizeEpisodeMetrics(original, () => CHILE_SUMMER);
    expect(localized.startingGlucose).toBe(118);
    expect(localized.peakGlucose).toBe(190);
    expect(localized.readingCount).toBe(12);
    // Y no muta la entrada: lo guardado en SQLite sigue siendo UTC canónico.
    expect(original.mealTimestamp).toBe('2026-09-01T21:30:00.000Z');
  });
});
