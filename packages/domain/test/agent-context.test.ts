import { describe, expect, it } from 'vitest';

import {
  buildAgentContext,
  describeOrigin,
  forbiddenKeysIn,
  type AgentContextInput,
} from '../src/agent-context';
import type { GlucoseSummary } from '../src/glucose-metrics';

const summary = (over: Partial<GlucoseSummary> = {}): GlucoseSummary => ({
  readingCount: 812,
  excludedSyntheticCount: 0,
  daysCovered: 12,
  meanGlucoseMgDl: 154.4,
  standardDeviationMgDl: 52,
  coefficientOfVariationPct: 33.7,
  estimatedA1cPct: 7.06,
  range: { veryLowPct: 1, lowPct: 3, targetPct: 62, highPct: 28, veryHighPct: 6 },
  ...over,
} as GlucoseSummary);

const input = (over: Partial<AgentContextInput> = {}): AgentContextInput => ({
  now: '2026-09-10T15:00:00.000-03:00',
  timeZone: 'America/Santiago',
  range: { fromIso: '2026-08-29T00:00:00.000-03:00', toIso: '2026-09-10T15:00:00.000-03:00', label: '14 días' },
  summary: summary(),
  tally: { unreadable: 0 },
  counts: { meals: 31, rapidDoses: 44, basalDoses: 12, activity: 3, waterMl: 18400 },
  therapyConfigured: true,
  latest: { valueMgDl: 168.2, minutesAgo: 7, origin: 'real' },
  ...over,
});

describe('LA FRONTERA: los parámetros de terapia no viajan', () => {
  it('un contexto normal no lleva ratio, factor ni objetivo', () => {
    // Con el ratio, el factor y una glucosa, calcular una dosis es una división
    // que el modelo hace de memoria: el filtro de salida no lo notaría porque el
    // número sería correcto. La única defensa real es que el dato NO esté.
    expect(forbiddenKeysIn(buildAgentContext(input()))).toEqual([]);
  });

  it('el detector encuentra una clave prohibida aunque esté anidada', () => {
    // Si mañana alguien la agrega "para que el chat pueda explicar mejor", esto
    // falla y le cuenta por qué no.
    expect(forbiddenKeysIn({ a: { b: { carbRatio: 10 } } })).toEqual(['carbRatio']);
    expect(forbiddenKeysIn({ lista: [{ correctionFactor: 50 }] })).toEqual(['correctionFactor']);
  });

  it('solo viaja SI está configurada, nunca con qué valores', () => {
    const context = buildAgentContext(input({ therapyConfigured: true }));
    expect(context.terapiaConfigurada).toBe(true);
    expect(JSON.stringify(context)).not.toMatch(/ratio|factor|correcci[oó]n/iu);
  });
});

describe('lo que sí viaja', () => {
  it('las métricas ya calculadas, no la serie cruda', () => {
    const context = buildAgentContext(input());
    expect(context.glucosa).toEqual({
      lecturas: 812,
      diasCubiertos: 12,
      promedioMgDl: 154,
      cv: 34,
      hba1cEstimadaGmi: 7.1,
      bajoPct: 4,
      enRangoPct: 62,
      altoPct: 34,
    });
  });

  it('los TRES lados del rango, nunca "en rango" a secas', () => {
    // "70% en rango" esconde si el 30% fueron hipos o hipers —problemas
    // opuestos— e invita a concluir que falta insulina.
    const g = buildAgentContext(input()).glucosa;
    expect(g).not.toBeNull();
    expect((g?.bajoPct ?? 0) + (g?.enRangoPct ?? 0) + (g?.altoPct ?? 0)).toBe(100);
  });

  it('la última glucosa dice DE DÓNDE salió, no solo cuánto', () => {
    expect(buildAgentContext(input()).ultimaGlucosa?.procedencia).toBe('sensor');
    const manual = buildAgentContext(input({ latest: { valueMgDl: 140, minutesAgo: 2, origin: 'manual' } }));
    expect(manual.ultimaGlucosa?.procedencia).toMatch(/capilar/u);
  });

  it('una procedencia nunca se puede leer como sensor en vivo', () => {
    expect(describeOrigin('manual')).not.toBe('sensor');
    expect(describeOrigin('imported')).not.toBe('sensor');
    expect(describeOrigin('imported')).toMatch(/importado/u);
  });
});

describe('lo que falta se dice antes que cualquier promedio', () => {
  it('los registros ilegibles viajan', () => {
    // Un TIR sobre una muestra recortada en silencio no es un dato omitido: es
    // un número inventado.
    const context = buildAgentContext(input({ tally: { unreadable: 17 } }));
    expect(context.integridad.registrosIlegibles).toBe(17);
  });

  it('sin lecturas utilizables, `glucosa` es null y se declara', () => {
    const context = buildAgentContext(input({ summary: null }));
    expect(context.glucosa).toBeNull();
    expect(context.integridad.sinDatos).toBe(true);
  });

  it('y con datos, `sinDatos` es false', () => {
    expect(buildAgentContext(input()).integridad.sinDatos).toBe(false);
  });
});

describe('el reloj y la zona', () => {
  it('viajan, porque el modelo no tiene ninguno de los dos', () => {
    // Sin zona, "ayer" no significa lo mismo para los dos, y con horario de
    // verano ni siquiera es un desfase fijo.
    const context = buildAgentContext(input());
    expect(context.ahora).toBe('2026-09-10T15:00:00.000-03:00');
    expect(context.zonaHoraria).toBe('America/Santiago');
  });
});
