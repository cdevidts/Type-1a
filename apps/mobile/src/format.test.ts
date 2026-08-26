import { describe, expect, it } from 'vitest';

import {
  capillaryReminderTimes,
  formatMinutesAsClock,
  parseBlankAsClear,
  parseBlankAsUnset,
  parseBlankAsUnsetPositive,
  parseClockToMinutes,
  parseNonNegativeNumber,
} from './format';

describe('parseClockToMinutes', () => {
  it('parses valid 24h times', () => {
    expect(parseClockToMinutes('08:00')).toBe(480);
    expect(parseClockToMinutes('8:05')).toBe(485);
    expect(parseClockToMinutes('23:59')).toBe(1439);
    expect(parseClockToMinutes('00:00')).toBe(0);
  });

  it('rejects malformed or out-of-range times', () => {
    expect(parseClockToMinutes('24:00')).toBeNull();
    expect(parseClockToMinutes('08:60')).toBeNull();
    expect(parseClockToMinutes('8')).toBeNull();
    expect(parseClockToMinutes('08-00')).toBeNull();
    expect(parseClockToMinutes('')).toBeNull();
  });
});

describe('formatMinutesAsClock', () => {
  it('zero-pads back to HH:MM', () => {
    expect(formatMinutesAsClock(480)).toBe('08:00');
    expect(formatMinutesAsClock(485)).toBe('08:05');
    expect(formatMinutesAsClock(0)).toBe('00:00');
  });
});

describe('capillaryReminderTimes', () => {
  it('spreads the count evenly, anchored at wakeStart', () => {
    // 08:00–23:00 is 900 min; 5 reminders => every 180 min (3 h).
    expect(capillaryReminderTimes('08:00', '23:00', 5)).toEqual([
      { hour: 8, minute: 0 },
      { hour: 11, minute: 0 },
      { hour: 14, minute: 0 },
      { hour: 17, minute: 0 },
      { hour: 20, minute: 0 },
    ]);
  });

  it('handles a single reminder (at wakeStart)', () => {
    expect(capillaryReminderTimes('09:30', '21:30', 1)).toEqual([{ hour: 9, minute: 30 }]);
  });

  it('rejects a non-positive window', () => {
    expect(capillaryReminderTimes('22:00', '08:00', 4)).toBeNull();
    expect(capillaryReminderTimes('08:00', '08:00', 4)).toBeNull();
  });

  it('rejects a count outside 1..12 or non-integer', () => {
    expect(capillaryReminderTimes('08:00', '22:00', 0)).toBeNull();
    expect(capillaryReminderTimes('08:00', '22:00', 13)).toBeNull();
    expect(capillaryReminderTimes('08:00', '22:00', 2.5)).toBeNull();
  });

  it('rejects malformed clock strings', () => {
    expect(capillaryReminderTimes('8am', '10pm', 3)).toBeNull();
  });
});

describe('parseNonNegativeNumber — la trampa de la cadena vacía', () => {
  it('devuelve 0 (no null) para una cadena vacía', () => {
    // Documentado a propósito: es el comportamiento real, y confundirlo con
    // "no hay dato" ya causó que cada comida se guardara con 0 g de macros.
    expect(parseNonNegativeNumber('')).toBe(0);
    expect(parseNonNegativeNumber('   ')).toBe(0);
  });

  it('devuelve null para algo que no es un número', () => {
    expect(parseNonNegativeNumber('abc')).toBeNull();
  });

  it('acepta 0 y decimales con coma', () => {
    expect(parseNonNegativeNumber('0')).toBe(0);
    expect(parseNonNegativeNumber('12,5')).toBe(12.5);
  });
});

/**
 * Los tres envoltorios que reemplazan las 53 copias a mano del chequeo del
 * blanco. La verdad de cada caso está escrita desde la regla: en blanco es
 * "no lo anoté" (o "bórralo", según el formulario), **nunca** cero.
 */
describe('parseBlankAsUnset — en blanco es "no lo anoté"', () => {
  it('el blanco no es cero, que es todo el punto', () => {
    expect(parseBlankAsUnset('')).toBeUndefined();
    expect(parseBlankAsUnset('   ')).toBeUndefined();
    // Y sin el envoltorio, esto sería 0 y llegaría al reporte médico como
    // dato medido. Ya pasó una vez.
    expect(parseNonNegativeNumber('')).toBe(0);
  });

  it('un cero escrito a mano SÍ es un dato', () => {
    expect(parseBlankAsUnset('0')).toBe(0);
  });

  it('acepta coma decimal, que es como se escribe en Chile', () => {
    expect(parseBlankAsUnset('3,5')).toBe(3.5);
  });

  it('texto inválido es null, distinto de en blanco', () => {
    expect(parseBlankAsUnset('mucho')).toBeNull();
    expect(parseBlankAsUnset('-2')).toBeNull();
  });
});

describe('parseBlankAsUnsetPositive — insulina y glucosa exigen > 0', () => {
  it('cero unidades no es una dosis', () => {
    expect(parseBlankAsUnsetPositive('0')).toBeNull();
  });

  it('en blanco sigue siendo "no lo anoté"', () => {
    expect(parseBlankAsUnsetPositive('')).toBeUndefined();
  });

  it('un valor válido pasa', () => {
    expect(parseBlankAsUnsetPositive('6,5')).toBe(6.5);
  });
});

describe('parseBlankAsClear — en un editor, vaciar es borrar', () => {
  /**
   * Los sentinelas están **invertidos** respecto de `parseBlankAsUnset`, a
   * propósito: es el lenguaje de `MealEditPatch` (`undefined` = no se tocó,
   * `null` = borrar). Tenerlo con nombre propio es lo que impide leer mal cuál
   * convención sigue cada formulario.
   */
  it('en blanco pide borrar el valor', () => {
    expect(parseBlankAsClear('')).toBeNull();
  });

  it('texto inválido es undefined, la señal de error de este formulario', () => {
    expect(parseBlankAsClear('mucho')).toBeUndefined();
  });

  it('cero sigue siendo un dato', () => {
    expect(parseBlankAsClear('0')).toBe(0);
  });

  it('no comparte sentinela con parseBlankAsUnset ante el mismo input', () => {
    expect(parseBlankAsUnset('')).toBeUndefined();
    expect(parseBlankAsClear('')).toBeNull();
  });
});
