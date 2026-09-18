import { describe, expect, it } from 'vitest';

import { calculateCorrection } from './correction';

describe('lo que se imprime es la resta que se hizo', () => {
  const base = { targetGlucose: 100, correctionFactor: 30, doseIncrement: 1 };

  it('el caso de la captura: 171 con 5.98 U actuando', () => {
    const result = calculateCorrection({ ...base, currentGlucose: 171, activeInsulinUnits: 5.98 });
    // La corrección disponible era 2.37: eso es todo lo que se pudo descontar.
    expect(result.activeInsulinUnits).toBe(5.98);
    expect(result.activeInsulinAppliedUnits).toBeCloseTo(2.3667, 3);
    expect(result.roundedUnits).toBe(0);
    // La fórmula escrita tiene que cuadrar con el resultado. Antes decía
    // "− 5.98 U activas" sobre un resultado de 0.00, o sea una resta que da
    // −3.61 con un 0 al lado.
    expect(result.formula).toContain('− 2.37 U activas');
    expect(result.formula).toContain('(de 5.98 actuando)');
  });

  it('cuando el activo cabe entero, no se anota un sobrante que no existe', () => {
    const result = calculateCorrection({ ...base, currentGlucose: 250, activeInsulinUnits: 1 });
    expect(result.activeInsulinAppliedUnits).toBe(1);
    expect(result.formula).toContain('− 1 U activas');
    expect(result.formula).not.toContain('actuando)');
  });

  it('sin insulina configurada no se inventa un descuento de cero', () => {
    const result = calculateCorrection({ ...base, currentGlucose: 200 });
    expect(result.activeInsulinUnits).toBeUndefined();
    expect(result.activeInsulinAppliedUnits).toBeUndefined();
  });

  it('bajo objetivo no descuenta nada, porque no hay de qué', () => {
    const result = calculateCorrection({ ...base, currentGlucose: 80, activeInsulinUnits: 3 });
    expect(result.activeInsulinAppliedUnits).toBe(0);
    expect(result.roundedUnits).toBe(0);
  });
});
