import { describe, expect, it } from 'vitest';

import {
  activeInsulinUnits,
  fractionRemaining,
  rapidInsulinActionModel,
  type InsulinActionModel,
} from '../src/iob';

/** Fiasp con la duración del catálogo: 5 h, pico a los 55 min. */
const FIASP: InsulinActionModel = { durationMinutes: 300, peakMinutes: 55 };
/** Análoga clásica: 5 h, pico a los 75 min — el preset de Loop. */
const NOVORAPID: InsulinActionModel = { durationMinutes: 300, peakMinutes: 75 };

describe('fractionRemaining — la curva exponencial', () => {
  it('empieza en 1 y termina en 0', () => {
    expect(fractionRemaining(0, NOVORAPID)).toBe(1);
    expect(fractionRemaining(-10, NOVORAPID)).toBe(1);
    expect(fractionRemaining(300, NOVORAPID)).toBe(0);
    expect(fractionRemaining(1000, NOVORAPID)).toBe(0);
  });

  it('decrece siempre: nunca vuelve a subir', () => {
    let previous = 1;
    for (let minute = 0; minute <= 300; minute += 5) {
      const current = fractionRemaining(minute, NOVORAPID);
      expect(current, `minuto ${minute}`).toBeLessThanOrEqual(previous);
      expect(current).toBeGreaterThanOrEqual(0);
      expect(current).toBeLessThanOrEqual(1);
      previous = current;
    }
  });

  it('casi no baja en los primeros minutos — que es el punto de no usar una recta', () => {
    // Con una recta a 5 h, a los 15 min quedaría 95 %. La curva real deja
    // bastante más, porque la insulina todavía no empezó a actuar de verdad.
    const exponential = fractionRemaining(15, NOVORAPID);
    const linear = 1 - 15 / 300;
    expect(exponential).toBeGreaterThan(linear);
    expect(exponential).toBeGreaterThan(0.95);
  });

  it('a mitad de camino queda bastante menos que la mitad', () => {
    // A las 2,5 h de una insulina de 5 h, una recta diría 50 %. La curva ya
    // pasó el pico y va en ~20 %: restar de más temprano es el error que la
    // recta comete y el que más importa evitar acá.
    const half = fractionRemaining(150, NOVORAPID);
    expect(half).toBeLessThan(0.3);
    expect(half).toBeGreaterThan(0.1);
  });

  it('una insulina acelerada deja menos activo al mismo minuto', () => {
    // Fiasp entra antes (pico 55 vs 75) con la misma duración total, así que
    // a las 2 h le queda menos por hacer.
    expect(fractionRemaining(120, FIASP)).toBeLessThan(fractionRemaining(120, NOVORAPID));
  });

  it('rechaza una entrada que no es un número', () => {
    expect(() => fractionRemaining(Number.NaN, NOVORAPID)).toThrow();
  });
});

describe('rapidInsulinActionModel — sale de lo que ella configuró', () => {
  it('toma duración y pico del catálogo', () => {
    expect(rapidInsulinActionModel({ rapidInsulinId: 'fiasp' })).toEqual({ durationMinutes: 300, peakMinutes: 55 });
    expect(rapidInsulinActionModel({ rapidInsulinId: 'novorapid' })).toEqual({ durationMinutes: 300, peakMinutes: 75 });
    // La regular humana es la excepción real: 8 h y pico mucho más tarde.
    expect(rapidInsulinActionModel({ rapidInsulinId: 'regular' })).toEqual({ durationMinutes: 480, peakMinutes: 150 });
  });

  it('la duración escrita a mano gana sobre la del catálogo', () => {
    // Es la que le dio su equipo clínico, o la que observó en sus datos.
    expect(rapidInsulinActionModel({ rapidInsulinId: 'fiasp', rapidInsulinDurationHours: 4 }))
      .toEqual({ durationMinutes: 240, peakMinutes: 55 });
  });

  it('sin nada configurado devuelve undefined, NO un default', () => {
    // La regla que gobierna todo este módulo: "no lo sé" y "no queda nada"
    // son afirmaciones opuestas. Un default silencioso restaría unidades que
    // nadie confirmó de una dosis que sí se inyecta.
    expect(rapidInsulinActionModel({})).toBeUndefined();
    expect(rapidInsulinActionModel({ rapidInsulinId: 'no-existe' })).toBeUndefined();
    // Una duración fuera de rango tampoco vale.
    expect(rapidInsulinActionModel({ rapidInsulinDurationHours: 0.2 })).toBeUndefined();
  });

  it('una basal elegida como rápida no produce modelo', () => {
    expect(rapidInsulinActionModel({ rapidInsulinId: 'tresiba' })).toBeUndefined();
  });

  it('con una duración muy corta, el pico se acomoda debajo de la mitad', () => {
    // El modelo exige tp < td/2 o la fórmula se indefine. Con 1 h de duración
    // el pico del catálogo (55 min) no cabe y se acota.
    const model = rapidInsulinActionModel({ rapidInsulinId: 'fiasp', rapidInsulinDurationHours: 1 });
    expect(model).toBeDefined();
    expect(model!.peakMinutes).toBeLessThan(model!.durationMinutes / 2);
    // Y la curva sigue siendo válida de punta a punta.
    for (let minute = 0; minute <= 60; minute += 5) {
      expect(Number.isFinite(fractionRemaining(minute, model!))).toBe(true);
    }
  });
});

describe('activeInsulinUnits — el caso que originó todo esto', () => {
  const at = '2026-09-02T14:00:00.000Z';

  it('dos bolos seguidos suman: es el stacking que la app proponía', () => {
    // Comida chica con corrección a las 13:00, comida grande a las 13:55.
    // Antes, la segunda pantalla calculaba la corrección completa otra vez,
    // como si la primera dosis no existiera.
    const result = activeInsulinUnits(
      [
        { type: 'rapid', timestamp: '2026-09-02T13:00:00.000Z', units: 3 },
        { type: 'rapid', timestamp: '2026-09-02T13:55:00.000Z', units: 6 },
      ],
      at,
      NOVORAPID,
    );
    expect(result.doseCount).toBe(2);
    // La de hace 5 min está casi entera; la de hace 1 h ya bajó bastante.
    expect(result.units).toBeGreaterThan(6);
    expect(result.units).toBeLessThan(9);
    expect(result.latestContributingAt).toBe('2026-09-02T13:55:00.000Z');
  });

  it('una dosis más vieja que la duración no aporta nada', () => {
    const result = activeInsulinUnits(
      [{ type: 'rapid', timestamp: '2026-09-02T08:00:00.000Z', units: 10 }],
      at,
      NOVORAPID,
    );
    expect(result.units).toBe(0);
    expect(result.doseCount).toBe(0);
    expect(result.latestContributingAt).toBeUndefined();
  });

  it('la basal NUNCA entra', () => {
    // Una Tresiba de 20 U sumada a un bolo de comida sería un error grave: el
    // filtro vive acá y no en quien llama, para que no se pueda olvidar.
    const result = activeInsulinUnits(
      [
        { type: 'basal', timestamp: '2026-09-02T13:00:00.000Z', units: 20 },
        { type: 'rapid', timestamp: '2026-09-02T13:00:00.000Z', units: 4 },
      ],
      at,
      NOVORAPID,
    );
    expect(result.doseCount).toBe(1);
    expect(result.units).toBeLessThan(4);
  });

  it('una dosis con hora futura se ignora, no se cuenta entera', () => {
    // Un registro con la hora mal tecleada no puede inflar el activo y
    // hacer que la app proponga menos insulina de la que corresponde.
    const result = activeInsulinUnits(
      [{ type: 'rapid', timestamp: '2026-09-02T18:00:00.000Z', units: 8 }],
      at,
      NOVORAPID,
    );
    expect(result.units).toBe(0);
    expect(result.doseCount).toBe(0);
  });

  it('ignora unidades imposibles en vez de propagar NaN', () => {
    const result = activeInsulinUnits(
      [
        { type: 'rapid', timestamp: '2026-09-02T13:50:00.000Z', units: Number.NaN },
        { type: 'rapid', timestamp: '2026-09-02T13:50:00.000Z', units: 0 },
        { type: 'rapid', timestamp: 'no es una fecha', units: 5 },
        { type: 'rapid', timestamp: '2026-09-02T13:50:00.000Z', units: 2 },
      ],
      at,
      NOVORAPID,
    );
    expect(result.doseCount).toBe(1);
    expect(Number.isFinite(result.units)).toBe(true);
    expect(result.units).toBeGreaterThan(1.8);
  });

  it('sin dosis, cero activo y ninguna dosis contribuyendo', () => {
    const result = activeInsulinUnits([], at, NOVORAPID);
    expect(result.units).toBe(0);
    expect(result.doseCount).toBe(0);
  });

  it('nunca devuelve más unidades de las que se inyectaron', () => {
    const doses = [
      { type: 'rapid' as const, timestamp: '2026-09-02T12:30:00.000Z', units: 5 },
      { type: 'rapid' as const, timestamp: '2026-09-02T13:40:00.000Z', units: 3 },
    ];
    const result = activeInsulinUnits(doses, at, NOVORAPID);
    expect(result.units).toBeLessThanOrEqual(8);
  });
});

describe('la duración por tramo alimenta el modelo (2026-09-02)', () => {
  it('usa el override del tramo en que se está dosificando', () => {
    const morning = new Date(2026, 8, 2, 8, 0).toISOString();
    const afternoon = new Date(2026, 8, 2, 15, 0).toISOString();
    const profile = {
      rapidInsulinId: 'fiasp',
      rapidInsulinDurationHours: 5,
      segmentDurationHours: { manana: 7 },
    };
    // En la mañana su insulina dura más, así que a la misma hora post-dosis
    // le queda más activo — y la app propone menos corrección.
    expect(rapidInsulinActionModel(profile, morning)!.durationMinutes).toBe(420);
    expect(rapidInsulinActionModel(profile, afternoon)!.durationMinutes).toBe(300);
  });

  it('sin override se comporta igual que antes en todos los tramos', () => {
    const profile = { rapidInsulinId: 'fiasp', rapidInsulinDurationHours: 5 };
    for (const hour of [3, 8, 15, 22]) {
      const at = new Date(2026, 8, 2, hour, 0).toISOString();
      expect(rapidInsulinActionModel(profile, at)!.durationMinutes).toBe(300);
    }
  });
});

describe('la ventana de dosis tiene que cubrir la duración del modelo (2026-09-02)', () => {
  /**
   * El bug que la revisión clínica encontró: `getRecentRapidInsulin` traía
   * 6 h fijas, pero la regular humana dura 8 h. Una dosis de hace 7 h quedaba
   * fuera de la consulta, el activo salía de menos, y el activo de menos
   * **sube** la dosis propuesta. Este test fija la propiedad que hace que esa
   * ventana importe: a las 7 h de una insulina de 8 h todavía queda insulina.
   */
  it('la regular humana sigue activa más allá de las 6 h', () => {
    const regular = rapidInsulinActionModel({ rapidInsulinId: 'regular' });
    expect(regular?.durationMinutes).toBe(480);
    expect(fractionRemaining(6 * 60, regular!)).toBeGreaterThan(0);
    expect(fractionRemaining(7 * 60, regular!)).toBeGreaterThan(0);
    expect(fractionRemaining(8 * 60, regular!)).toBe(0);
  });

  it('una dosis de hace 7 h aporta activo con la regular, y nada con una análoga', () => {
    const at = '2026-09-02T14:00:00.000Z';
    const doses = [{ type: 'rapid' as const, timestamp: '2026-09-02T07:00:00.000Z', units: 8 }];
    const regular = activeInsulinUnits(doses, at, rapidInsulinActionModel({ rapidInsulinId: 'regular' })!);
    expect(regular.units).toBeGreaterThan(0);
    expect(activeInsulinUnits(doses, at, NOVORAPID).units).toBe(0);
  });

  it('un override por tramo puede alargar la duración más allá del catálogo', () => {
    // Y entonces la ventana de la consulta también tiene que crecer: es por
    // esto que `App.tsx` la deriva del modelo y no de una constante.
    const morning = new Date(2026, 8, 2, 8, 0).toISOString();
    const model = rapidInsulinActionModel(
      { rapidInsulinId: 'fiasp', segmentDurationHours: { manana: 9 } },
      morning,
    );
    expect(model?.durationMinutes).toBe(540);
    expect(model!.durationMinutes / 60).toBeGreaterThan(6);
  });
});
