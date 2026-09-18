import { describe, expect, it } from 'vitest';

import { describeCoverage, RELIABLE_COVERAGE_DAYS } from '../src/coverage';

describe('describeCoverage — el bug de los 30 y 90 días', () => {
  it('dice la cobertura SIEMPRE, aunque supere el umbral clínico', () => {
    // Este es el caso exacto que reportó Verónica: a 90 días con 22 días de
    // datos, la pantalla no decía nada porque 22 >= 14, y quedaba leyéndose
    // como si el promedio resumiera tres meses.
    const c = describeCoverage({ daysCovered: 22, rangeDays: 90 });
    expect(c.text).toBe('22 de 90 días con datos');
    expect(c.isPartial).toBe(true);
    expect(c.isBelowReliableThreshold).toBe(false);
  });

  it('separa "falta cobertura" de "no alcanza para la HbA1c estimada"', () => {
    const pocos = describeCoverage({ daysCovered: 5, rangeDays: 7 });
    expect(pocos.isPartial).toBe(true);
    expect(pocos.isBelowReliableThreshold).toBe(true);

    const completo = describeCoverage({ daysCovered: 7, rangeDays: 7 });
    // Rango completo, pero 7 días siguen siendo pocos para una HbA1c estimada.
    expect(completo.isPartial).toBe(false);
    expect(completo.isBelowReliableThreshold).toBe(true);
  });

  it('un rango lleno no se marca como parcial', () => {
    const c = describeCoverage({ daysCovered: 90, rangeDays: 90 });
    expect(c.isPartial).toBe(false);
    expect(c.text).toBe('90 de 90 días con datos');
  });

  it('el umbral de confiabilidad es el de consenso, no uno inventado', () => {
    expect(RELIABLE_COVERAGE_DAYS).toBe(14);
    expect(describeCoverage({ daysCovered: 13, rangeDays: 30 }).isBelowReliableThreshold).toBe(true);
    expect(describeCoverage({ daysCovered: 14, rangeDays: 30 }).isBelowReliableThreshold).toBe(false);
  });

  it('nunca dice más días cubiertos que días del rango', () => {
    // Un registro importado con hora rara podría contar un día de más; el
    // texto no puede decir "31 de 30".
    expect(describeCoverage({ daysCovered: 31, rangeDays: 30 }).text).toBe('30 de 30 días con datos');
  });

  it('sin datos lo dice en vez de callar', () => {
    const c = describeCoverage({ daysCovered: 0, rangeDays: 30 });
    expect(c.text).toBe('0 de 30 días con datos');
    expect(c.isPartial).toBe(true);
  });

  it('singular correcto', () => {
    expect(describeCoverage({ daysCovered: 1, rangeDays: 1 }).text).toBe('1 de 1 día con datos');
  });

  it('un rango inválido no produce un texto absurdo', () => {
    expect(describeCoverage({ daysCovered: 5, rangeDays: 0 }).text).toBe('5 días con datos');
    expect(describeCoverage({ daysCovered: 5, rangeDays: Number.NaN }).text).toBe('5 días con datos');
  });
});
