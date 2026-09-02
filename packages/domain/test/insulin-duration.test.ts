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

describe('observeCorrectionEpisode — cuándo dejó de bajar', () => {
  const at = '2026-09-02T09:00:00.000Z';

  it('mide hasta el mínimo, y exige un repunte que lo confirme', () => {
    // Baja de 250 a 120 en 60 min y después repunta: el efecto terminó ahí.
    const readings = series(at, [250, 235, 215, 195, 175, 155, 140, 128, 120, 126, 132]);
    const result = observeCorrectionEpisode({ timestamp: at, units: 3, readings });
    expect(result).not.toBeNull();
    expect(result!.observedMinutes).toBe(40);
    expect(result!.dropMgDl).toBe(130);
  });

  it('descarta un episodio que nunca repunta: no se puede afirmar que terminó', () => {
    // Sigue bajando hasta el final de la ventana. Rellenar con el máximo
    // alargaría la mediana con un dato inventado.
    const readings = series(at, [250, 230, 210, 190, 170, 150, 130, 110]);
    expect(observeCorrectionEpisode({ timestamp: at, units: 3, readings })).toBeNull();
  });

  it('descarta un episodio sin bajada real', () => {
    const readings = series(at, [150, 152, 149, 151, 150, 153, 152]);
    expect(observeCorrectionEpisode({ timestamp: at, units: 1, readings })).toBeNull();
  });

  it('el ruido del sensor no marca el final por sí solo', () => {
    // Un repunte de 2 mg/dL a mitad de la bajada no es el final: el umbral
    // existe justo para eso.
    const readings = series(at, [250, 230, 210, 212, 190, 170, 150, 140, 148, 155]);
    const result = observeCorrectionEpisode({ timestamp: at, units: 3, readings });
    expect(result).not.toBeNull();
    // El mínimo real está a los 35 min, no en el bache de los 15.
    expect(result!.observedMinutes).toBe(35);
  });

  it('ignora lecturas anteriores a la dosis', () => {
    const before = series('2026-09-02T08:00:00.000Z', [300, 290, 280]);
    const after = series(at, [250, 220, 190, 160, 140, 148]);
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
  const observation = (hour: number, minutes: number): CorrectionObservation => ({
    timestamp: new Date(2026, 8, 2, hour, 0).toISOString(),
    observedMinutes: minutes,
    dropMgDl: 80,
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
  });

  it('no publica un tramo con muestra insuficiente, pero SÍ dice cuántos hay', () => {
    // Un "tu insulina dura 2 h en la mañana" sacado de un episodio se lee
    // como patrón, y acá puede terminar cambiando una dosis.
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
    // Y la dispersión se declara, para que el número no esconda al raro.
    expect(manana.rangeMinutes).toEqual({ min: 290, max: 900 });
  });

  it('siempre devuelve los cuatro tramos, incluso vacíos', () => {
    const result = summarizeObservedDuration([]);
    expect(result.segments).toHaveLength(4);
    expect(result.segments.every((s) => s.episodeCount === 0)).toBe(true);
    expect(result.overallMedianMinutes).toBeUndefined();
    expect(result.totalEpisodes).toBe(0);
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
    // Medir es de la app; fijar un parámetro de terapia es de ella.
    expect(durationHoursAt(morning, {})).toBeUndefined();
  });
});

describe('observeCorrectionsFrom — qué episodio cuenta', () => {
  const at = (hour: number): string => new Date(2026, 8, 2, hour, 0).toISOString();
  const dose = (hour: number, over: Partial<InsulinEvent> = {}) => ({
    id: `i${hour}`, timestamp: at(hour), type: 'rapid' as const, units: 3,
    source: 'manual' as const, createdAt: at(hour), purpose: 'correction' as const, ...over,
  });
  const falling = (hour: number) => series(at(hour), [250, 230, 205, 180, 160, 145, 138, 145, 152]);

  it('cuenta una corrección aislada', () => {
    const result = observeCorrectionsFrom({ insulin: [dose(9)], meals: [], readings: falling(9) });
    expect(result).toHaveLength(1);
  });

  it('descarta la que tiene una comida cerca', () => {
    // Con comida al lado la glucosa deja de bajar porque empezó a subir el
    // plato, no porque se acabó la insulina.
    const meals = [{ id: 'm1', timestamp: at(9), createdAt: at(9), confirmedCarbsG: 40 }];
    expect(observeCorrectionsFrom({ insulin: [dose(9)], meals, readings: falling(9) })).toHaveLength(0);
  });

  it('descarta la que tiene otra rápida encima', () => {
    const insulin = [dose(9), dose(11, { id: 'i11', timestamp: at(11), createdAt: at(11) })];
    expect(observeCorrectionsFrom({ insulin, meals: [], readings: falling(9) })).toHaveLength(0);
  });

  it('descarta un bolo de comida aunque baje la glucosa', () => {
    const insulin = [dose(9, { purpose: 'meal' })];
    expect(observeCorrectionsFrom({ insulin, meals: [], readings: falling(9) })).toHaveLength(0);
  });

  it('descarta la basal', () => {
    const insulin = [dose(9, { type: 'basal', purpose: undefined })];
    expect(observeCorrectionsFrom({ insulin, meals: [], readings: falling(9) })).toHaveLength(0);
  });
});
