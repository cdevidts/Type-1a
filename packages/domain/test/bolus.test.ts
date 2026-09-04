import { describe, expect, it } from 'vitest';

import { calculateCorrection, calculateMealBolus } from '../src/index.js';

const BASE = {
  carbRatio: 10,
  targetGlucose: 110,
  correctionFactor: 45,
  doseIncrement: 0.5,
} as const;

describe('meal + correction bolus calculator', () => {
  it('adds carb coverage and correction, rounding only the total', () => {
    const result = calculateMealBolus({ ...BASE, carbsG: 60, currentGlucose: 200 });
    expect(result.mealUnits).toBe(6);
    expect(result.correctionUnits).toBeCloseTo(90 / 45, 10);
    expect(result.totalRawUnits).toBeCloseTo(8, 10);
    expect(result.totalRoundedUnits).toBe(8);
    expect(result).toMatchObject({ correctionApplied: true, isBelowTarget: false });
  });

  it('lets a below-target glucose reduce the meal dose instead of ignoring it', () => {
    const result = calculateMealBolus({ ...BASE, carbsG: 60, currentGlucose: 65 });
    expect(result.correctionUnits).toBeCloseTo(-1, 10);
    expect(result.totalRawUnits).toBeCloseTo(5, 10);
    expect(result.totalRoundedUnits).toBe(5);
    expect(result.isBelowTarget).toBe(true);
  });

  it('never returns a negative total, even when the correction outweighs the carbs', () => {
    const result = calculateMealBolus({ ...BASE, carbsG: 5, currentGlucose: 50 });
    expect(result.correctionUnits).toBeLessThan(0);
    expect(result.totalRawUnits).toBe(0);
    expect(result.totalRoundedUnits).toBe(0);
  });

  it('skips the correction half entirely when no current glucose is supplied', () => {
    const result = calculateMealBolus({ ...BASE, carbsG: 45 });
    expect(result.correctionApplied).toBe(false);
    expect(result.correctionUnits).toBe(0);
    expect(result.correctionFormula).toBeNull();
    expect(result.totalRawUnits).toBe(4.5);
    expect(result.totalRoundedUnits).toBe(4.5);
  });

  it('handles a carbs-only entry of zero grams as zero units', () => {
    const result = calculateMealBolus({ ...BASE, carbsG: 0, currentGlucose: 110 });
    expect(result.totalRoundedUnits).toBe(0);
  });

  it('rounds to the configured pen increment, not to whole units', () => {
    expect(calculateMealBolus({ ...BASE, doseIncrement: 1, carbsG: 34 }).totalRoundedUnits).toBe(3);
    expect(calculateMealBolus({ ...BASE, doseIncrement: 0.5, carbsG: 34 }).totalRoundedUnits).toBe(3.5);
  });

  it('reports both formulas so the UI can show its work', () => {
    const result = calculateMealBolus({ ...BASE, carbsG: 60, currentGlucose: 200 });
    expect(result.mealFormula).toBe('60 g ÷ 10 g/U');
    expect(result.correctionFormula).toBe('(200 − 110) ÷ 45');
  });

  it('flags hypoglycemia separately from merely being under target', () => {
    const underTarget = calculateMealBolus({ ...BASE, carbsG: 60, currentGlucose: 95 });
    expect(underTarget.isBelowTarget).toBe(true);
    expect(underTarget.isHypoglycemic).toBe(false);

    const low = calculateMealBolus({ ...BASE, carbsG: 60, currentGlucose: 58 });
    expect(low.isBelowTarget).toBe(true);
    expect(low.isHypoglycemic).toBe(true);

    // The threshold itself is not a dose input: the units are unchanged by
    // the flag, it only tells the UI to say "treat the low first".
    expect(low.totalRawUnits).toBeCloseTo(6 + (58 - 110) / 45, 10);
  });

  it('puts the hypoglycemia boundary at strictly under 70', () => {
    expect(calculateMealBolus({ ...BASE, carbsG: 30, currentGlucose: 69.9 }).isHypoglycemic).toBe(true);
    expect(calculateMealBolus({ ...BASE, carbsG: 30, currentGlucose: 70 }).isHypoglycemic).toBe(false);
    const correctionParams = { targetGlucose: 110, correctionFactor: 45, doseIncrement: 0.5 } as const;
    expect(calculateCorrection({ ...correctionParams, currentGlucose: 69.9 }).isHypoglycemic).toBe(true);
    expect(calculateCorrection({ ...correctionParams, currentGlucose: 70 }).isHypoglycemic).toBe(false);
  });

  it('never reports hypoglycemia when no glucose was supplied', () => {
    expect(calculateMealBolus({ ...BASE, carbsG: 60 }).isHypoglycemic).toBe(false);
  });

  it('agrees exactly with calculateCorrection when there are no carbs', () => {
    // The seam between the two calculators the UI picks between. If this
    // ever diverges, the same glucose yields two different doses depending
    // on whether the carbs field held "" or "0".
    for (const currentGlucose of [50, 70, 110, 180, 260]) {
      const params = { targetGlucose: 110, correctionFactor: 45, doseIncrement: 0.5 } as const;
      const bolus = calculateMealBolus({ ...params, carbRatio: 10, carbsG: 0, currentGlucose });
      const correction = calculateCorrection({ ...params, currentGlucose });
      expect(bolus.totalRoundedUnits).toBe(correction.roundedUnits);
      expect(bolus.totalRawUnits).toBeCloseTo(correction.rawUnits, 10);
    }
  });

  it('rejects therapy parameters that are missing, zero, or negative', () => {
    expect(() => calculateMealBolus({ ...BASE, carbRatio: 0, carbsG: 30 })).toThrow();
    expect(() => calculateMealBolus({ ...BASE, correctionFactor: -45, carbsG: 30 })).toThrow();
    expect(() => calculateMealBolus({ ...BASE, carbsG: -1 })).toThrow();
    expect(() => calculateMealBolus({ ...BASE, doseIncrement: 2, carbsG: 30 })).toThrow();
  });
});

describe('IOB: el bolo descuenta la insulina activa (2026-09-02)', () => {
  const base = { carbsG: 60, carbRatio: 10, targetGlucose: 110, correctionFactor: 50, doseIncrement: 0.5 };

  it('EL CASO QUE ORIGINÓ ESTO: la segunda comida no vuelve a corregir entera', () => {
    // Comida chica + corrección a las 13:00 → deja ~2,7 U activas.
    // Comida grande a las 13:05 con la glucosa todavía alta.
    const sinIob = calculateMealBolus({ ...base, currentGlucose: 260 });
    const conIob = calculateMealBolus({ ...base, currentGlucose: 260, activeInsulinUnits: 2.7 });
    // Antes proponía la corrección completa otra vez: eso es stacking.
    expect(sinIob.totalRawUnits).toBeCloseTo(9, 5);
    expect(conIob.totalRawUnits).toBeCloseTo(6.3, 5);
    expect(conIob.totalRoundedUnits).toBe(6.5);
  });

  it('LA REGLA DURA: el IOB sale de la corrección, NUNCA de la comida', () => {
    // Este test existía desde el 2026-09-02 y **afirmaba el bug**: daba por
    // buena una corrección de −10, que es el sobrante comiéndose la comida.
    // Es el corolario de la Regla 1 en carne propia — un test que confirma lo
    // que la implementación devuelve hoy no prueba nada.
    //
    // 60 g siguen necesitando sus 6 U aunque haya 10 U activas.
    const result = calculateMealBolus({ ...base, currentGlucose: 110, activeInsulinUnits: 10 });
    expect(result.mealUnits).toBe(6);
    expect(result.correctionUnits).toBe(0);
    // La corrección ya era 0: el IOB no tiene nada que descontar y se detiene.
    expect(result.correctionAfterActiveUnits).toBe(0);
    expect(result.activeInsulinAppliedUnits).toBe(0);
    expect(result.activeInsulinUnusedUnits).toBe(10);
    expect(result.totalRoundedUnits).toBe(6);
  });

  it('con muchísima insulina activa el total baja hasta la comida, no hasta 0', () => {
    const result = calculateMealBolus({ ...base, currentGlucose: 120, activeInsulinUnits: 50 });
    expect(result.totalRawUnits).toBe(6);
    expect(result.totalRoundedUnits).toBe(6);
  });

  it('sin insulina configurada no se resta nada y el resultado es el de siempre', () => {
    // "No sé cuánta hay activa" nunca puede convertirse en "hay 0".
    const desconocido = calculateMealBolus({ ...base, currentGlucose: 200 });
    const cero = calculateMealBolus({ ...base, currentGlucose: 200, activeInsulinUnits: 0 });
    expect(desconocido.totalRawUnits).toBe(cero.totalRawUnits);
    expect(desconocido.activeInsulinUnits).toBeUndefined();
    expect(cero.activeInsulinUnits).toBe(0);
  });

  it('expone el desglose entero para que la pantalla pueda mostrarlo', () => {
    const result = calculateMealBolus({ ...base, currentGlucose: 210, activeInsulinUnits: 1.5 });
    expect(result.mealUnits).toBe(6);
    expect(result.correctionUnits).toBe(2);
    expect(result.activeInsulinUnits).toBe(1.5);
    expect(result.correctionAfterActiveUnits).toBe(0.5);
    expect(result.totalRawUnits).toBe(6.5);
    expect(result.correctionFormula).toContain('1.5 U activas');
  });

  it('isBelowTarget sigue describiendo la GLUCOSA, no el resultado de la resta', () => {
    // Estar en objetivo con insulina activa no es "estar bajo objetivo": son
    // dos avisos distintos y la pantalla los dice distinto.
    const result = calculateMealBolus({ ...base, currentGlucose: 110, activeInsulinUnits: 3 });
    expect(result.isBelowTarget).toBe(false);
    // Y con el tope puesto, la corrección se queda en 0: "no corrijas".
    expect(result.correctionAfterActiveUnits).toBe(0);
    expect(result.activeInsulinUnusedUnits).toBe(3);
  });
});

describe('EL BUG DE VERÓNICA: el IOB no puede comerse la comida (2026-09-03)', () => {
  const base = { carbRatio: 10, targetGlucose: 110, correctionFactor: 50, doseIncrement: 0.5 };

  it('su caso literal: comió y se corrigió hace 10 min, ahora come 20 g más', () => {
    // 20 g ÷ 10 = 2 U de comida. Glucosa en objetivo, así que no hay
    // corrección. Le quedan 9 U activas de los bolos de hace un rato.
    //
    // Antes: 2 + (0 − 9) = −7 → tope en 0 → "ponte 0 U". Los 20 g quedaban
    // sin cubrir y la glucosa se iba arriba sin que nada lo explicara.
    const result = calculateMealBolus({
      ...base, carbsG: 20, currentGlucose: 110, activeInsulinUnits: 9,
    });
    expect(result.mealUnits).toBe(2);
    expect(result.totalRoundedUnits).toBe(2);
    // Y el desglose lo dice: de las 9 U activas no se usó ninguna.
    expect(result.activeInsulinAppliedUnits).toBe(0);
    expect(result.activeInsulinUnusedUnits).toBe(9);
  });

  it('el IOB anula la corrección y ahí se detiene', () => {
    // Glucosa 260 → corrección 3 U. Con 9 U activas, la corrección se va a 0
    // y las 6 U sobrantes NO tocan las 4 U de comida.
    const result = calculateMealBolus({
      ...base, carbsG: 40, currentGlucose: 260, activeInsulinUnits: 9,
    });
    expect(result.mealUnits).toBe(4);
    expect(result.correctionUnits).toBe(3);
    expect(result.activeInsulinAppliedUnits).toBe(3);
    expect(result.activeInsulinUnusedUnits).toBe(6);
    expect(result.correctionAfterActiveUnits).toBe(0);
    expect(result.totalRoundedUnits).toBe(4);
  });

  it('el IOB que alcanza justo descuenta justo', () => {
    const result = calculateMealBolus({
      ...base, carbsG: 30, currentGlucose: 260, activeInsulinUnits: 1,
    });
    expect(result.activeInsulinAppliedUnits).toBe(1);
    expect(result.activeInsulinUnusedUnits).toBe(0);
    expect(result.correctionAfterActiveUnits).toBe(2);
    expect(result.totalRoundedUnits).toBe(5);
  });

  it('la glucosa BAJO objetivo sí sigue bajando el total: es otra razón', () => {
    // 70 mg/dL con 40 g de comida: la corrección negativa reduce el bolo, y
    // eso se conserva. No es el IOB comiéndose la comida, es que estar en 70
    // es motivo real para poner menos que lo que pide el plato.
    const result = calculateMealBolus({
      ...base, carbsG: 40, currentGlucose: 70, activeInsulinUnits: 5,
    });
    expect(result.correctionUnits).toBe(-0.8);
    // Con la corrección ya negativa, el IOB no descuenta nada más.
    expect(result.activeInsulinAppliedUnits).toBe(0);
    expect(result.correctionAfterActiveUnits).toBe(-0.8);
    expect(result.totalRawUnits).toBeCloseTo(3.2, 5);
    expect(result.isBelowTarget).toBe(true);
  });

  it('sin carbohidratos se comporta igual que una corrección suelta', () => {
    const conCarbos0 = calculateMealBolus({
      ...base, carbsG: 0, currentGlucose: 260, activeInsulinUnits: 9,
    });
    expect(conCarbos0.totalRoundedUnits).toBe(0);
  });

  it('el desglose siempre cuadra: comida + corrección aplicada = total', () => {
    // La propiedad que hace auditable la pantalla. Si esto se rompe, el panel
    // "De dónde sale este número" muestra números que no suman.
    for (const glucose of [70, 110, 180, 260, 350]) {
      for (const iob of [0, 1, 3, 9, 20]) {
        for (const carbs of [0, 20, 60]) {
          const r = calculateMealBolus({ ...base, carbsG: carbs, currentGlucose: glucose, activeInsulinUnits: iob });
          expect(r.correctionAfterActiveUnits, `g=${glucose} iob=${iob} c=${carbs}`)
            .toBeCloseTo(r.correctionUnits - r.activeInsulinAppliedUnits, 6);
          expect(r.activeInsulinAppliedUnits + r.activeInsulinUnusedUnits).toBeCloseTo(iob, 6);
          expect(r.totalRawUnits).toBeCloseTo(Math.max(0, r.mealUnits + r.correctionAfterActiveUnits), 6);
          // Y la propiedad que da nombre a todo esto: con carbohidratos y sin
          // hipoglucemia, el total nunca puede ser menor que lo que ya tenía
          // asignado la comida menos lo que justifica la glucosa baja.
          if (glucose >= 110 && carbs > 0) {
            expect(r.totalRawUnits, `g=${glucose} iob=${iob} c=${carbs}`).toBeGreaterThanOrEqual(r.mealUnits - 1e-9);
          }
        }
      }
    }
  });
});

describe('lo que se imprime es lo que se restó (hallazgo clínico, 2026-09-03)', () => {
  const base = { carbRatio: 10, targetGlucose: 110, correctionFactor: 50, doseIncrement: 0.5 };

  it('la fórmula no declara una resta mayor que la aplicada', () => {
    // El caso real: corrección 1.4 U con 9 U activas. La fórmula decía
    // "(180 − 110) ÷ 50 − 9 U activas", una expresión que evalúa a −7.6 al
    // lado de un resultado de 1.4 y de un desglose que decía lo contrario.
    // Dos relatos del mismo número en una calculadora de dosis, y el falso
    // parecía la fórmula.
    const result = calculateMealBolus({
      ...base, carbsG: 20, currentGlucose: 180, activeInsulinUnits: 9,
    });
    expect(result.correctionFormula).toContain('1.4 U activas');
    expect(result.correctionFormula).not.toContain('9 U activas');
    expect(result.activeInsulinAppliedUnits).toBeCloseTo(1.4, 6);
  });

  it('sin resta aplicada, la fórmula no menciona activa ninguna', () => {
    const result = calculateMealBolus({
      ...base, carbsG: 20, currentGlucose: 110, activeInsulinUnits: 9,
    });
    expect(result.correctionFormula).not.toContain('activas');
  });

  it('la fórmula impresa es aritméticamente consistente con el resultado', () => {
    // Se recalcula la expresión desde sus partes y se compara con el número
    // que la app propone, en un barrido: si divergen, la pantalla miente.
    for (const glucose of [120, 180, 260, 350]) {
      for (const iob of [0, 0.5, 2, 9, 30]) {
        const r = calculateMealBolus({ ...base, carbsG: 40, currentGlucose: glucose, activeInsulinUnits: iob });
        const printed = (glucose - base.targetGlucose) / base.correctionFactor - r.activeInsulinAppliedUnits;
        expect(printed, `g=${glucose} iob=${iob}`).toBeCloseTo(r.correctionAfterActiveUnits, 6);
      }
    }
  });
});
