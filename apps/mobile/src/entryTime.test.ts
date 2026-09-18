import { describe, expect, it } from 'vitest';

import {
  clampDayToMonth,
  combineDayAndTime,
  dayOfMonthISO,
  dayRange,
  isFutureDay,
  isSameDay,
  monthDays,
  monthLabel,
  parseDayISO,
  shiftMonth,
  startOfDay,
  timeOfDay,
  weekdayLetter,
} from './entryTime';

/**
 * "Cuándo pasó" es la columna por la que se agrupan episodios, se recortan
 * ventanas de patrones y se ordena el reporte médico. Un error de un día no se
 * ve en pantalla: se ve tres semanas después, en un promedio.
 *
 * Todo es hora **local**, así que los tests construyen fechas locales y nunca
 * comparan contra literales UTC.
 */

describe('dayRange — el día es un rango semiabierto', () => {
  it('empieza a medianoche y termina en la medianoche siguiente', () => {
    const { from, to } = dayRange(new Date(2026, 7, 27, 14, 30));
    expect(from.getFullYear()).toBe(2026);
    expect(from.getMonth()).toBe(7);
    expect(from.getDate()).toBe(27);
    expect(from.getHours()).toBe(0);
    expect(to.getDate()).toBe(28);
    expect(to.getHours()).toBe(0);
  });

  /**
   * Con `to` en "23:59:59" se pierde el último segundo del día, y ese segundo
   * existe: un registro de las 23:59:59.500 caería fuera del día en que pasó.
   */
  it('un registro de las 23:59:59.999 cae dentro del día', () => {
    const { from, to } = dayRange(new Date(2026, 7, 27));
    const tarde = new Date(2026, 7, 27, 23, 59, 59, 999);
    expect(tarde.getTime()).toBeGreaterThanOrEqual(from.getTime());
    expect(tarde.getTime()).toBeLessThan(to.getTime());
  });

  it('cruza el fin de mes sin saltarse nada', () => {
    const { to } = dayRange(new Date(2026, 0, 31));
    expect(to.getMonth()).toBe(1);
    expect(to.getDate()).toBe(1);
  });

  it('cruza el fin de año', () => {
    const { to } = dayRange(new Date(2026, 11, 31));
    expect(to.getFullYear()).toBe(2027);
    expect(to.getMonth()).toBe(0);
    expect(to.getDate()).toBe(1);
  });
});

describe('isFutureDay — se comparan días, no instantes', () => {
  const ahora = new Date(2026, 7, 27, 14, 0);

  it('hoy a las 00:00 NO es futuro aunque sean las 14:00', () => {
    expect(isFutureDay(new Date(2026, 7, 27), ahora)).toBe(false);
  });

  it('mañana sí es futuro', () => {
    expect(isFutureDay(new Date(2026, 7, 28), ahora)).toBe(true);
  });

  it('ayer no es futuro', () => {
    expect(isFutureDay(new Date(2026, 7, 26), ahora)).toBe(false);
  });
});

describe('monthDays — el mes completo, con los futuros marcados', () => {
  const ahora = new Date(2026, 7, 15, 10, 0);

  it('agosto tiene 31 días y febrero bisiesto 29', () => {
    expect(monthDays(2026, 7, ahora)).toHaveLength(31);
    expect(monthDays(2024, 1, ahora)).toHaveLength(29);
    expect(monthDays(2026, 1, ahora)).toHaveLength(28);
  });

  /**
   * Una fila que se corta en hoy se lee como si el mes terminara ahí. Los
   * futuros existen, van marcados y no se pueden tocar.
   */
  it('los días posteriores a hoy vienen marcados como futuros, no omitidos', () => {
    const days = monthDays(2026, 7, ahora);
    expect(days.filter((d) => d.isFuture)).toHaveLength(16); // 16..31
    expect(days.find((d) => d.dayOfMonth === 15)?.isToday).toBe(true);
    expect(days.find((d) => d.dayOfMonth === 15)?.isFuture).toBe(false);
  });

  it('un mes pasado no tiene ningún día futuro ni ningún "hoy"', () => {
    const days = monthDays(2026, 6, ahora);
    expect(days.some((d) => d.isFuture)).toBe(false);
    expect(days.some((d) => d.isToday)).toBe(false);
  });

  it('las letras del día son las iniciales en español', () => {
    // 2026-08-27 cae jueves.
    expect(weekdayLetter(new Date(2026, 7, 27))).toBe('J');
    expect(weekdayLetter(new Date(2026, 7, 30))).toBe('D');
  });
});

describe('navegación de mes — siempre queda una fecha válida', () => {
  const ahora = new Date(2026, 7, 27);

  it('shiftMonth arrastra el año', () => {
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
  });

  it('del 31 de enero a febrero cae al último día que existe', () => {
    const day = clampDayToMonth(2026, 1, 31, ahora);
    expect(day.getMonth()).toBe(1);
    expect(day.getDate()).toBe(28);
  });

  it('conserva el día del mes cuando existe', () => {
    expect(clampDayToMonth(2026, 5, 15, ahora).getDate()).toBe(15);
  });

  it('nunca devuelve una fecha futura: se topa en hoy', () => {
    const day = clampDayToMonth(2026, 7, 31, ahora);
    expect(isFutureDay(day, ahora)).toBe(false);
    expect(isSameDay(day, ahora)).toBe(true);
  });

  it('el rótulo del mes lleva nombre y año', () => {
    expect(monthLabel(2026, 7)).toBe('agosto 2026');
  });
});

describe('combineDayAndTime — la hora del pasado no se inventa', () => {
  const day = new Date(2026, 7, 25);

  it('combina el día elegido con la hora escrita, en hora local', () => {
    const iso = combineDayAndTime(day, '13:45');
    expect(iso).not.toBeNull();
    const parsed = new Date(iso!);
    expect(parsed.getFullYear()).toBe(2026);
    expect(parsed.getMonth()).toBe(7);
    expect(parsed.getDate()).toBe(25);
    expect(parsed.getHours()).toBe(13);
    expect(parsed.getMinutes()).toBe(45);
  });

  it.each(['', '25:00', '12:60', '1245', 'mediodía', '12:5'])(
    'rechaza "%s" en vez de caer a un default',
    (bad) => { expect(combineDayAndTime(day, bad)).toBeNull(); },
  );

  it('acepta la medianoche y el último minuto del día', () => {
    expect(combineDayAndTime(day, '00:00')).not.toBeNull();
    expect(combineDayAndTime(day, '23:59')).not.toBeNull();
  });
});

describe('parseDayISO — un ISO de solo fecha no se lee como UTC', () => {
  /**
   * `new Date('2026-08-27')` se interpreta como UTC, así que en Chile
   * (UTC-4/-3) daría el 26 a las 20:00 y el registro caería el día anterior.
   */
  it('construye el día local que se escribió', () => {
    const day = parseDayISO('2026-08-27');
    expect(day?.getFullYear()).toBe(2026);
    expect(day?.getMonth()).toBe(7);
    expect(day?.getDate()).toBe(27);
  });

  it('rechaza una fecha que no existe en vez de rebotar al mes siguiente', () => {
    expect(parseDayISO('2026-02-31')).toBeNull();
    expect(parseDayISO('2026-13-01')).toBeNull();
  });

  it.each(['27-08-2026', '2026/08/27', '', 'hoy'])('rechaza el formato "%s"', (bad) => {
    expect(parseDayISO(bad)).toBeNull();
  });

  it('es la inversa de dayOfMonthISO', () => {
    const original = new Date(2026, 1, 29 - 1); // 28 de febrero de 2026
    const round = parseDayISO(dayOfMonthISO(original.toISOString()));
    expect(round).not.toBeNull();
    expect(isSameDay(round!, original)).toBe(true);
  });
});

describe('siembra de los campos de fecha y hora', () => {
  it('timeOfDay devuelve HH:MM con cero a la izquierda', () => {
    expect(timeOfDay(new Date(2026, 7, 27, 9, 5).toISOString())).toBe('09:05');
  });

  it('un timestamp ilegible devuelve cadena vacía, no una hora inventada', () => {
    expect(timeOfDay('no-es-una-fecha')).toBe('');
    expect(dayOfMonthISO('no-es-una-fecha')).toBe('');
  });

  it('startOfDay descarta la hora y conserva el día', () => {
    const start = startOfDay(new Date(2026, 7, 27, 23, 59));
    expect(start.getDate()).toBe(27);
    expect(start.getHours()).toBe(0);
  });
});
