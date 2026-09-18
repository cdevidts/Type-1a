import { describe, expect, it } from 'vitest';

import {
  MAX_WATER_TARGET_ML,
  MIN_WATER_TARGET_ML,
  summarizeWaterDay,
  TOTAL_WATER_AI_ML,
  WATER_FROM_BEVERAGES_FRACTION,
  waterTargetMl,
} from '../src/nutrition-targets';

describe('waterTargetMl — la meta sale del IOM, no de una regla inventada', () => {
  it('recupera la verdad de la fuente: el 80 % de la ingesta adecuada total', () => {
    // Regla 1, corolario: se siembra la cifra publicada y se comprueba que el
    // código la reproduce, en vez de aceptar lo que devuelva hoy.
    expect(TOTAL_WATER_AI_ML.female).toBe(2700);
    expect(TOTAL_WATER_AI_ML.male).toBe(3700);
    expect(WATER_FROM_BEVERAGES_FRACTION).toBe(0.8);
    // 2700 × 0,8 = 2160 → 2150 al redondear a 50.
    expect(waterTargetMl({ sex: 'female' })).toBe(2150);
    // 3700 × 0,8 = 2960 → 2950.
    expect(waterTargetMl({ sex: 'male' })).toBe(2950);
  });

  it('LO QUE ELLA ESCRIBE GANA: la referencia es poblacional, no de ella', () => {
    expect(waterTargetMl({ sex: 'female', waterMlTarget: 1500 })).toBe(1500);
    expect(waterTargetMl({ sex: 'male', waterMlTarget: 4000 })).toBe(4000);
  });

  it('UNA RESTRICCIÓN HÍDRICA SE RESPETA, aunque quede bajo el piso', () => {
    // El test anterior decía "lo que ella escribe gana" y solo probaba 1500 y
    // 4000, los dos por encima del piso: afirmaba la regla sin ejercerla.
    // Mientras tanto el código subía 1000 a 1200 en silencio.
    //
    // Insuficiencia cardíaca, enfermedad renal avanzada, diálisis: ahí la
    // indicación es beber MENOS, y una app que empuja un 20 % por encima de
    // esa indicación todos los días está contradiciendo a su equipo clínico.
    expect(waterTargetMl({ sex: 'female', waterMlTarget: 1000 })).toBe(1000);
    expect(waterTargetMl({ sex: 'female', waterMlTarget: 800 })).toBe(800);
    expect(waterTargetMl({ sex: 'male', waterMlTarget: 600 })).toBe(600);
  });

  it('el piso SÍ rige la referencia calculada, que no es de nadie en particular', () => {
    expect(waterTargetMl({ sex: 'female' })).toBeGreaterThanOrEqual(MIN_WATER_TARGET_ML);
  });

  it('acota hacia arriba: un cero de más es un dedo resbalado, no una meta', () => {
    // El tope que corta hacia arriba es un freno; uno que corta hacia abajo
    // contradice una indicación. No son simétricos.
    expect(waterTargetMl({ sex: 'male', waterMlTarget: 99_000 })).toBe(MAX_WATER_TARGET_ML);
  });

  it('un override inválido cae a la referencia en vez de romper', () => {
    expect(waterTargetMl({ sex: 'female', waterMlTarget: Number.NaN })).toBe(2150);
    expect(waterTargetMl({ sex: 'female', waterMlTarget: 0 })).toBe(2150);
    expect(waterTargetMl({ sex: 'female', waterMlTarget: undefined })).toBe(2150);
  });
});

describe('summarizeWaterDay', () => {
  it('suma el día y dice cuánto falta', () => {
    const result = summarizeWaterDay({
      events: [{ ml: 250 }, { ml: 500 }, { ml: 330 }],
      targetMl: 2150,
    });
    expect(result.totalMl).toBe(1080);
    expect(result.remainingMl).toBe(1070);
    expect(result.progress).toBeCloseTo(1080 / 2150, 5);
  });

  it('el progreso se queda en 100 %: pasarse no es un logro que crezca', () => {
    // Y en una app de diabetes la sed excesiva puede ser un síntoma de
    // hiperglucemia, no una meta superada.
    const result = summarizeWaterDay({ events: [{ ml: 5000 }], targetMl: 2150 });
    expect(result.progress).toBe(1);
    expect(result.remainingMl).toBe(0);
    // Pero el total real NO se recorta: el dato es el dato.
    expect(result.totalMl).toBe(5000);
  });

  it('ignora valores imposibles en vez de propagar NaN', () => {
    const result = summarizeWaterDay({
      events: [{ ml: Number.NaN }, { ml: -100 }, { ml: 250 }],
      targetMl: 2000,
    });
    expect(result.totalMl).toBe(250);
    expect(Number.isFinite(result.progress)).toBe(true);
  });

  it('sin registros el día está en cero, no vacío', () => {
    const result = summarizeWaterDay({ events: [], targetMl: 2150 });
    expect(result.totalMl).toBe(0);
    expect(result.progress).toBe(0);
    expect(result.remainingMl).toBe(2150);
  });
});
