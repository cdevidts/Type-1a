import { describe, expect, it } from 'vitest';

import type { CGMReading, InsulinEvent } from '@type1a/schemas';

import {
  durationHoursAt,
  MIN_EPISODES_PER_SEGMENT,
  observeCorrectionEpisode,
  observeCorrectionsFrom,
  segmentOf,
  summarizeObservedDuration,
  type CorrectionObservation,
} from '../src/insulin-duration';

/** Serie de glucosa a partir de un instante, cada 5 min, en mg/dL. */
function series(startIso: string, values: readonly number[]): CGMReading[] {
  const startMs = Date.parse(startIso);
  return values.map((glucose, index) => ({
    id: `r${index}`,
    glucose,
    unit: 'mg/dL' as const,
    timestamp: new Date(startMs + index * 5 * 60_000).toISOString(),
    trend: 'unknown' as const,
    trendSource: 'unknown' as const,
    source: 'test',
    origin: 'real' as const,
    sourceTimestamp: new Date(startMs + index * 5 * 60_000).toISOString(),
    ingestedAt: new Date(startMs + index * 5 * 60_000).toISOString(),
  }));
}

/** Una serie plana de `count` lecturas al valor `value`, para rellenar la ventana. */
function flat(value: number, count: number): number[] {
  return new Array<number>(count).fill(value);
}

describe('observeCorrectionEpisode — cuándo dejó de bajar', () => {
  const at = '2026-09-02T09:00:00.000Z';

  it('mide hasta el mínimo y confirma el final con un repunte', () => {
    // Baja de 250 a 120 en 40 min, repunta, y la ventana sigue hasta las 2 h.
    const readings = series(at, [250, 235, 215, 195, 175, 155, 140, 128, 120, 126, ...flat(132, 20)]);
    const result = observeCorrectionEpisode({ timestamp: at, units: 3, readings });
    expect(result).not.toBeNull();
    expect(result!.observedMinutes).toBe(40);
    expect(result!.dropMgDl).toBe(130);
  });

  it('UNA MESETA TAMBIÉN CIERRA EL EPISODIO, no solo un repunte', () => {
    // El filtro viejo pedía un repunte de +5 mg/dL y descartaba justo los
    // episodios que terminan planos — que son los que salieron bien.
    const readings = series(at, [240, 220, 200, 180, 165, 155, 150, ...flat(149, 20)]);
    const result = observeCorrectionEpisode({ timestamp: at, units: 3, readings });
    expect(result).not.toBeNull();
    expect(result!.dropMgDl).toBeGreaterThanOrEqual(90);
  });

  it('EL CASO DE UN BOLO DE COMIDA: la subida no anula la bajada', () => {
    // La glucosa sube por el plato y después baja. Medido desde el instante
    // de la dosis la "bajada" sería 0 y el episodio se perdía; medido desde
    // el máximo de la ventana, se ve.
    const readings = series(at, [110, 140, 175, 200, 210, 195, 175, 160, 148, 140, ...flat(142, 20)]);
    const result = observeCorrectionEpisode({ timestamp: at, units: 5, readings, carbsInWindowG: 45 });
    expect(result).not.toBeNull();
    expect(result!.dropMgDl).toBe(70);
    // Y el tiempo se sigue contando desde la dosis, que es lo comparable.
    expect(result!.observedMinutes).toBe(45);
    expect(result!.carbsInWindowG).toBe(45);
  });

  it('marca cuándo bajó más rápido: el pico de acción visible', () => {
    const readings = series(at, [260, 258, 255, 235, 210, 185, 175, 170, ...flat(169, 20)]);
    const result = observeCorrectionEpisode({ timestamp: at, units: 4, readings });
    expect(result).not.toBeNull();
    // La caída fuerte va del minuto 10 al 25; el pico cae dentro de ese tramo.
    expect(result!.peakMinutes).toBeGreaterThanOrEqual(10);
    expect(result!.peakMinutes).toBeLessThanOrEqual(30);
  });

  it('descarta un episodio que nunca deja de bajar', () => {
    const readings = series(at, [250, 240, 230, 220, 210, 200, 190, 180, 170, 160, 150, 140,
      130, 120, 110, 105, 100, 95, 90, 85, 80, 75, 70, 65, 60]);
    expect(observeCorrectionEpisode({ timestamp: at, units: 3, readings })).toBeNull();
  });

  it('descarta un episodio sin bajada real', () => {
    const readings = series(at, [150, 152, 149, 151, 150, 153, 152, ...flat(151, 20)]);
    expect(observeCorrectionEpisode({ timestamp: at, units: 1, readings })).toBeNull();
  });

  it('descarta una ventana más corta que 2 h: no se puede afirmar que terminó', () => {
    // Dos horas es el punto de control del test de factor de corrección
    // estándar. Con menos, el episodio no se mide, no se rellena.
    const readings = series(at, [250, 220, 190, 170, 160, 168, 175]);
    expect(observeCorrectionEpisode({ timestamp: at, units: 3, readings })).toBeNull();
  });

  it('un hueco del sensor no se cuenta como ventana cubierta', () => {
    // La ventana puede durar 5 h, pero si solo hay lecturas los primeros
    // 20 min no se midió nada.
    const readings = series(at, [250, 220, 190, 175]);
    const result = observeCorrectionEpisode({
      timestamp: at, units: 3, readings, windowEndMs: Date.parse(at) + 5 * 60 * 60_000,
    });
    expect(result).toBeNull();
  });

  it('ignora lecturas anteriores a la dosis', () => {
    const before = series('2026-09-02T08:00:00.000Z', [300, 290, 280]);
    const after = series(at, [250, 220, 190, 160, 140, 148, ...flat(150, 20)]);
    const result = observeCorrectionEpisode({ timestamp: at, units: 3, readings: [...before, ...after] });
    expect(result).not.toBeNull();
    expect(result!.dropMgDl).toBe(110);
  });

  it('sin lecturas suficientes no inventa nada', () => {
    expect(observeCorrectionEpisode({ timestamp: at, units: 3, readings: series(at, [250, 200]) })).toBeNull();
    expect(observeCorrectionEpisode({ timestamp: 'no es fecha', units: 3, readings: [] })).toBeNull();
  });
});

describe('segmentOf', () => {
  it('reparte las horas locales en los cuatro tramos', () => {
    expect(segmentOf(new Date(2026, 8, 2, 3, 0).toISOString())).toBe('madrugada');
    expect(segmentOf(new Date(2026, 8, 2, 8, 30).toISOString())).toBe('manana');
    expect(segmentOf(new Date(2026, 8, 2, 14, 0).toISOString())).toBe('tarde');
    expect(segmentOf(new Date(2026, 8, 2, 22, 0).toISOString())).toBe('noche');
  });

  it('los bordes caen en el tramo que empieza', () => {
    expect(segmentOf(new Date(2026, 8, 2, 6, 0).toISOString())).toBe('manana');
    expect(segmentOf(new Date(2026, 8, 2, 12, 0).toISOString())).toBe('tarde');
    expect(segmentOf(new Date(2026, 8, 2, 0, 0).toISOString())).toBe('madrugada');
  });
});

describe('summarizeObservedDuration', () => {
  const observation = (hour: number, minutes: number, carbs = 0): CorrectionObservation => ({
    timestamp: new Date(2026, 8, 2, hour, 0).toISOString(),
    observedMinutes: minutes,
    peakMinutes: Math.round(minutes / 3),
    dropMgDl: 80,
    units: 4,
    carbsInWindowG: carbs,
  });

  it('EL CASO QUE PIDIÓ VERÓNICA: la mañana se alarga y se ve', () => {
    const result = summarizeObservedDuration([
      observation(8, 300), observation(9, 320), observation(7, 280),
      observation(15, 180), observation(16, 200), observation(14, 190),
    ]);
    const manana = result.segments.find((s) => s.segment === 'manana')!;
    const tarde = result.segments.find((s) => s.segment === 'tarde')!;
    expect(manana.medianMinutes).toBe(300);
    expect(tarde.medianMinutes).toBe(190);
    expect(manana.medianMinutes!).toBeGreaterThan(tarde.medianMinutes!);
    // Y también responde "¿tarda más en pegar?", que es otra pregunta.
    expect(manana.medianPeakMinutes).toBeGreaterThan(tarde.medianPeakMinutes!);
  });

  it('cuenta cuántos episodios traían comida, y no los esconde', () => {
    const result = summarizeObservedDuration([
      observation(8, 300), observation(9, 320, 45), observation(7, 280, 30),
    ]);
    const manana = result.segments.find((s) => s.segment === 'manana')!;
    expect(manana.episodeCount).toBe(3);
    expect(manana.cleanCount).toBe(1);
    expect(result.cleanEpisodes).toBe(1);
  });

  it('con muestra chica NO ajusta, y lo declara', () => {
    // El ajuste por OLS pide al menos 8 observaciones. Por debajo se muestra
    // el crudo y `adjusted` dice que es crudo: es la regla de macro-glucose.
    const result = summarizeObservedDuration([
      observation(8, 300, 10), observation(9, 320, 40), observation(7, 280, 0),
    ]);
    expect(result.adjusted).toBe(false);
    expect(result.segments.find((s) => s.segment === 'manana')!.medianMinutes).toBe(300);
  });

  it('con muestra suficiente descuenta el aporte de los carbohidratos', () => {
    // Doce episodios donde los minutos suben exactamente con los
    // carbohidratos: la duración "verdadera" es 200 min en todos, y lo demás
    // lo pone la comida. El ajuste tiene que acercar la mediana a 200; el
    // crudo se quedaría en ~265, que es la comida contada como insulina.
    const carbs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
    const observations = carbs.map((grams, index) => ({
      ...observation(7 + (index % 5), 200 + grams, grams),
      units: 3 + (index % 4),
    }));
    const result = summarizeObservedDuration(observations);
    expect(result.totalEpisodes).toBe(12);
    expect(result.adjusted).toBe(true);
    // El ajuste está CENTRADO: conserva las diferencias entre tramos —que es
    // para lo que existe la pantalla— y también el nivel promedio observado.
    // Así que la mediana sigue incluyendo el aporte medio de la comida, y por
    // eso ninguno de estos episodios se puede adoptar como duración.
    expect(result.segments.every((s) => s.cleanMedianMinutes === undefined)).toBe(true);
  });

  it('SOLO los episodios sin comida se pueden adoptar como duración', () => {
    // Adoptar una mediana contaminada metería la digestión dentro de la
    // duración de la insulina, y la app descontaría IOB de más.
    const result = summarizeObservedDuration([
      observation(8, 300), observation(9, 310), observation(10, 290),
      observation(11, 600, 80), observation(7, 620, 90),
    ]);
    const manana = result.segments.find((s) => s.segment === 'manana')!;
    expect(manana.episodeCount).toBe(5);
    expect(manana.cleanCount).toBe(3);
    expect(manana.cleanMedianMinutes).toBe(300);
  });

  it('sin tres episodios limpios no hay cifra adoptable, aunque haya mediana', () => {
    const result = summarizeObservedDuration([
      observation(8, 300), observation(9, 310, 40), observation(10, 290, 50),
    ]);
    const manana = result.segments.find((s) => s.segment === 'manana')!;
    expect(manana.medianMinutes).toBe(300);
    expect(manana.cleanMedianMinutes).toBeUndefined();
  });

  it('no publica un tramo con muestra insuficiente, pero SÍ dice cuántos hay', () => {
    const result = summarizeObservedDuration([observation(8, 300), observation(9, 320)]);
    const manana = result.segments.find((s) => s.segment === 'manana')!;
    expect(manana.medianMinutes).toBeUndefined();
    expect(manana.episodeCount).toBe(2);
    expect(MIN_EPISODES_PER_SEGMENT).toBe(3);
  });

  it('usa mediana: un episodio raro no corre el número', () => {
    const result = summarizeObservedDuration([
      observation(8, 290), observation(9, 300), observation(10, 310), observation(11, 900),
    ]);
    const manana = result.segments.find((s) => s.segment === 'manana')!;
    expect(manana.medianMinutes).toBe(305);
    expect(manana.rangeMinutes).toEqual({ min: 290, max: 900 });
  });

  it('siempre devuelve los cuatro tramos, incluso vacíos', () => {
    const result = summarizeObservedDuration([]);
    expect(result.segments).toHaveLength(4);
    expect(result.segments.every((s) => s.episodeCount === 0)).toBe(true);
    expect(result.overallMedianMinutes).toBeUndefined();
    expect(result.totalEpisodes).toBe(0);
    expect(result.adjusted).toBe(false);
  });
});

describe('durationHoursAt — el override es de la usuaria', () => {
  const morning = new Date(2026, 8, 2, 8, 0).toISOString();
  const afternoon = new Date(2026, 8, 2, 15, 0).toISOString();

  it('usa el override del tramo cuando ella lo fijó', () => {
    expect(durationHoursAt(morning, {
      rapidInsulinDurationHours: 5,
      segmentDurationHours: { manana: 6 },
    })).toBe(6);
  });

  it('cae a la duración general en los tramos sin override', () => {
    expect(durationHoursAt(afternoon, {
      rapidInsulinDurationHours: 5,
      segmentDurationHours: { manana: 6 },
    })).toBe(5);
  });

  it('sin nada configurado sigue siendo undefined: no se adopta lo observado solo', () => {
    expect(durationHoursAt(morning, {})).toBeUndefined();
  });
});

describe('observeCorrectionsFrom — qué episodio cuenta ahora', () => {
  const at = (hour: number, minute = 0): string => new Date(2026, 8, 2, hour, minute).toISOString();
  const dose = (hour: number, over: Partial<InsulinEvent> = {}): InsulinEvent => ({
    id: `i${hour}`, timestamp: at(hour), type: 'rapid', units: 3,
    source: 'manual', createdAt: at(hour), purpose: 'correction', ...over,
  } as InsulinEvent);
  /** Baja, toca fondo a los 45 min y se queda plana el resto de las 3 h. */
  const falling = (hour: number) =>
    series(at(hour), [250, 232, 212, 194, 176, 160, 150, 143, 138, 144, ...flat(146, 26)]);

  it('cuenta una corrección aislada', () => {
    expect(observeCorrectionsFrom({ insulin: [dose(9)], meals: [], readings: falling(9) })).toHaveLength(1);
  });

  it('YA NO descarta la que tiene una comida cerca: la arrastra como covariable', () => {
    // Era el filtro que dejaba la pantalla vacía. Verónica: "obviamente que
    // ningún dato va a entrar si no pueden haber comidas en rangos de 5 horas".
    const meals = [{ id: 'm1', timestamp: at(9), createdAt: at(9), confirmedCarbsG: 40 }];
    const result = observeCorrectionsFrom({ insulin: [dose(9)], meals: meals as never, readings: falling(9) });
    expect(result).toHaveLength(1);
    expect(result[0]!.carbsInWindowG).toBe(40);
  });

  it('YA NO descarta la que tiene otra rápida después: recorta la ventana', () => {
    const insulin = [dose(9), dose(13, { id: 'i13', timestamp: at(13), createdAt: at(13) })];
    expect(observeCorrectionsFrom({ insulin, meals: [], readings: falling(9) })).toHaveLength(1);
  });

  it('descarta la dosis cuya ventana hasta la siguiente no llega a 2 h', () => {
    // Acá sí no hay nada que medir, y decirlo es correcto.
    const insulin = [dose(9), dose(10, { id: 'i10', timestamp: at(10), createdAt: at(10) })];
    expect(observeCorrectionsFrom({ insulin, meals: [], readings: falling(9) })).toHaveLength(0);
  });

  it('YA NO descarta un bolo de comida', () => {
    const insulin = [dose(9, { purpose: 'meal' })];
    expect(observeCorrectionsFrom({ insulin, meals: [], readings: falling(9) })).toHaveLength(1);
  });

  it('la basal sigue fuera: no produce una bajada atribuible', () => {
    const insulin = [dose(9, { type: 'basal', purpose: undefined })];
    expect(observeCorrectionsFrom({ insulin, meals: [], readings: falling(9) })).toHaveLength(0);
  });

  it('UN DÍA NORMAL PRODUCE DATOS, que es el punto de todo esto', () => {
    // Desayuno 8:00, almuerzo 13:00, once 18:00: tres bolos de comida
    // espaciados como los de cualquiera. Con el filtro viejo daban CERO
    // episodios; ahora dan tres, uno por tramo.
    const hours = [8, 13, 18];
    const insulin = hours.map((hour, index) => dose(hour, {
      id: `d${index}`, timestamp: at(hour), createdAt: at(hour), purpose: 'meal', units: 6,
    }));
    const meals = hours.map((hour, index) => ({
      id: `m${index}`, timestamp: at(hour), createdAt: at(hour), confirmedCarbsG: 50,
    }));
    // Cada comida: sube, hace pico y vuelve a bajar hasta una meseta.
    const readings = hours.flatMap((hour) =>
      series(at(hour), [120, 150, 185, 205, 200, 185, 168, 152, 143, 138, ...flat(140, 26)]));

    const result = observeCorrectionsFrom({ insulin, meals: meals as never, readings });
    expect(result).toHaveLength(3);
    expect(result.every((observation) => observation.carbsInWindowG > 0)).toBe(true);

    const summary = summarizeObservedDuration(result);
    expect(summary.totalEpisodes).toBe(3);
    expect(summary.segments.find((s) => s.segment === 'manana')!.episodeCount).toBe(1);
    expect(summary.segments.find((s) => s.segment === 'tarde')!.episodeCount).toBe(1);
    expect(summary.segments.find((s) => s.segment === 'noche')!.episodeCount).toBe(1);
  });
});
