import { describe, expect, it } from 'vitest';

import { isPlausibleGlucose, parseLocalIntent, type LocalIntent } from '../src/local-intent';

const mg = (text: string) => parseLocalIntent(text, 'mg/dL');
const mmol = (text: string) => parseLocalIntent(text, 'mmol/L');
const kinds = (intents: readonly LocalIntent[]) => intents.map((i) => i.kind);

describe('lo que se entiende sin gastar un crédito', () => {
  it('agua con volumen explícito', () => {
    expect(mg('250 ml de agua').intents).toEqual([{ kind: 'water', ml: 250 }]);
    expect(mg('tomé 500 mililitros de agua').intents).toEqual([{ kind: 'water', ml: 500 }]);
    expect(mg('1,5 litros de agua').intents).toEqual([{ kind: 'water', ml: 1500 }]);
  });

  it('insulina, cuando dice de qué tipo', () => {
    expect(mg('6 de rápida').intents).toEqual([{ kind: 'insulin', units: 6, insulinType: 'rapid' }]);
    expect(mg('me puse 18 unidades de basal').intents).toEqual([{ kind: 'insulin', units: 18, insulinType: 'basal' }]);
    expect(mg('4,5 de ultrarrápida').intents).toEqual([{ kind: 'insulin', units: 4.5, insulinType: 'rapid' }]);
  });

  it('carbohidratos y glucosa', () => {
    expect(mg('40 g de carbos').intents).toEqual([{ kind: 'carbs', grams: 40 }]);
    expect(mg('glucosa 168').intents).toEqual([{ kind: 'glucose', value: 168, unit: 'mg/dL' }]);
    expect(mg('estoy en 210').intents).toEqual([{ kind: 'glucose', value: 210, unit: 'mg/dL' }]);
  });

  it('los acentos NO rompen el patrón', () => {
    // `\b` es ASCII en JavaScript: `azúcar\b` no matchea "azúcar". Ya rompió un
    // guardrail de seguridad en este repo, así que va con su test.
    expect(mg('azúcar 145').intents).toEqual([{ kind: 'glucose', value: 145, unit: 'mg/dL' }]);
    expect(mg('me inyecté 7 de rápida').intents).toEqual([{ kind: 'insulin', units: 7, insulinType: 'rapid' }]);
  });

  it('varias cosas en una frase, y queda completa', () => {
    const result = mg('me puse 6 de rápida y tomé 250 ml de agua');
    expect(kinds(result.intents).sort()).toEqual(['insulin', 'water']);
    expect(result.complete).toBe(true);
  });
});

describe('LA REGLA: ante la duda, no se interpreta', () => {
  it('"me puse 6" no dice si fue rápida o basal, así que no se toca', () => {
    const result = mg('me puse 6');
    expect(result.intents).toEqual([]);
    expect(result.complete).toBe(false);
  });

  it('un número suelto no se adivina', () => {
    expect(mg('168').intents).toEqual([]);
    expect(mg('anota 40').intents).toEqual([]);
  });

  it('"un vaso de agua" reconoce el agua pero NO inventa los mililitros', () => {
    // Misma regla que el prompt de la IA: inventar un volumen redondo sumaría
    // agua al total diario que nadie tomó. La pantalla ofrece los presets.
    expect(mg('me tomé un vaso de agua').intents).toEqual([{ kind: 'water', ml: null }]);
  });

  it('SEGURIDAD: una glucosa imposible para su unidad NO se registra', () => {
    // 6 mg/dL es incompatible con la vida; 400 mmol/L no existe. Interpretar el
    // número en la unidad equivocada registraría una glucosa falsa.
    expect(mg('glucosa 6').intents).toEqual([]);
    expect(mmol('glucosa 400').intents).toEqual([]);
  });

  it('y la MISMA cifra se lee distinto según la unidad configurada', () => {
    expect(mmol('glucosa 6').intents).toEqual([{ kind: 'glucose', value: 6, unit: 'mmol/L' }]);
    expect(mg('glucosa 168').intents).toEqual([{ kind: 'glucose', value: 168, unit: 'mg/dL' }]);
  });

  it('una dosis imposible no pasa', () => {
    expect(mg('500 de rápida').intents).toEqual([]);
    expect(mg('0 de rápida').intents).toEqual([]);
  });

  it('un volumen absurdo de agua no pasa', () => {
    expect(mg('20000 ml de agua').intents).toEqual([]);
  });

  it('PROMESA: si sobra algo con sustancia, la frase ENTERA va al modelo', () => {
    // Registrar la mitad es peor que no registrar: quien lo lea va a creer que
    // la app entendió todo.
    const result = mg('me puse 6 de rápida y comí un plato de tallarines');
    expect(kinds(result.intents)).toEqual(['insulin']);
    expect(result.complete).toBe(false);
  });

  it('los conectores sobrantes NO cuentan como sustancia', () => {
    expect(mg('registra 250 ml de agua por favor').complete).toBe(true);
  });

  it('un número sobrante SÍ cuenta, que es el caso peligroso', () => {
    const result = mg('250 ml de agua y 12');
    expect(result.complete).toBe(false);
  });

  it('texto vacío o sin nada reconocible no inventa nada', () => {
    expect(mg('')).toEqual({ intents: [], complete: false });
    expect(mg('hola cómo estás')).toEqual({ intents: [], complete: false });
  });

  it('dos glucosas en una frase son ambiguas: se queda con una y no da por completa', () => {
    const result = mg('glucosa 168 y glicemia 200');
    expect(result.intents).toHaveLength(1);
    expect(result.complete).toBe(false);
  });
});

describe('plausibilidad de una glucosa', () => {
  it('mg/dL', () => {
    expect(isPlausibleGlucose(70, 'mg/dL')).toBe(true);
    expect(isPlausibleGlucose(19, 'mg/dL')).toBe(false);
    expect(isPlausibleGlucose(601, 'mg/dL')).toBe(false);
  });

  it('mmol/L', () => {
    expect(isPlausibleGlucose(5.5, 'mmol/L')).toBe(true);
    expect(isPlausibleGlucose(0.9, 'mmol/L')).toBe(false);
    expect(isPlausibleGlucose(40, 'mmol/L')).toBe(false);
  });

  it('un valor no finito nunca es plausible', () => {
    expect(isPlausibleGlucose(Number.NaN, 'mg/dL')).toBe(false);
    expect(isPlausibleGlucose(Number.POSITIVE_INFINITY, 'mg/dL')).toBe(false);
  });
});
