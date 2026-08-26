import { describe, expect, it } from 'vitest';

import { adjustForNuisance, fitOls, fitOlsOnVaryingColumns } from '../src/regression';

describe('fitOls', () => {
  it('recupera exactamente una relación lineal conocida', () => {
    // y = 5 + 2·x₁ − 3·x₂
    const predictors = [[1, 0], [2, 1], [3, 2], [4, 1], [5, 3], [6, 0], [7, 2], [8, 4]];
    const outcome = predictors.map(([a, b]) => 5 + 2 * a! - 3 * b!);
    const fit = fitOls(outcome, predictors);
    expect(fit).not.toBeNull();
    expect(fit!.coefficients[0]).toBeCloseTo(5, 6);
    expect(fit!.coefficients[1]).toBeCloseTo(2, 6);
    expect(fit!.coefficients[2]).toBeCloseTo(-3, 6);
    expect(fit!.sampleSize).toBe(8);
  });

  it('se niega cuando hay menos observaciones que parámetros más margen', () => {
    // Con tantas observaciones como parámetros el ajuste es perfecto y no
    // dice nada. Devolver un ajuste ahí sería presentar ruido como patrón.
    expect(fitOls([1, 2, 3], [[1, 0], [2, 1], [3, 2]])).toBeNull();
  });

  it('se niega cuando una covariable es constante', () => {
    // Caso real: nadie registró actividad física en el rango. El sistema
    // queda singular y un solver ingenuo devolvería coeficientes enormes que
    // desplazarían el promedio que la usuaria lee como patrón.
    const predictors = [[1, 7], [2, 7], [3, 7], [4, 7], [5, 7], [6, 7], [7, 7], [8, 7]];
    expect(fitOls([1, 2, 3, 4, 5, 6, 7, 8], predictors)).toBeNull();
  });

  it('se niega ante dos covariables colineales', () => {
    const predictors = [[1, 2], [2, 4], [3, 6], [4, 8], [5, 10], [6, 12], [7, 14], [8, 16]];
    expect(fitOls([1, 2, 3, 4, 5, 6, 7, 8], predictors)).toBeNull();
  });

  it('respeta un mínimo de observaciones más alto que el estructural', () => {
    const predictors = [[1, 0], [2, 1], [3, 2], [4, 1], [5, 3]];
    const outcome = [1, 2, 3, 4, 5];
    expect(fitOls(outcome, predictors)).not.toBeNull();
    expect(fitOls(outcome, predictors, 8)).toBeNull();
  });

  it('devuelve null ante entradas mal formadas en vez de un número inventado', () => {
    expect(fitOls([], [])).toBeNull();
    expect(fitOls([1, 2], [[1]])).toBeNull();
    expect(fitOls([1, 2, 3, 4], [[1], [2, 3], [4], [5]])).toBeNull();
  });

  it('tolera escalas muy distintas entre covariables', () => {
    // Gramos de carbohidratos (0-500) contra unidades de insulina (0-10). Un
    // umbral de singularidad absoluto habría descartado este sistema sano.
    const predictors = [[200, 1], [300, 2], [150, 3], [400, 1], [250, 4], [350, 2], [100, 5], [450, 3]];
    const outcome = predictors.map(([carbs, units]) => 10 + 0.2 * carbs! - 30 * units!);
    const fit = fitOls(outcome, predictors);
    expect(fit).not.toBeNull();
    expect(fit!.coefficients[1]).toBeCloseTo(0.2, 6);
    expect(fit!.coefficients[2]).toBeCloseTo(-30, 6);
  });
});

describe('adjustForNuisance', () => {
  it('descuenta solo las columnas declaradas como confusor', () => {
    // y = 100 + 2·interés − 5·confusor. Al descontar el confusor, lo que
    // queda tiene que depender solo del predictor de interés.
    const predictors = [[10, 4], [20, 1], [30, 6], [40, 2], [50, 5], [60, 3], [70, 0], [80, 7]];
    const outcome = predictors.map(([interes, confusor]) => 100 + 2 * interes! - 5 * confusor!);
    const fit = fitOls(outcome, predictors)!;
    const adjusted = adjustForNuisance(outcome, predictors, [1], fit);
    for (const [index, value] of adjusted.entries()) {
      expect(value).toBeCloseTo(100 + 2 * predictors[index]![0]!, 6);
    }
  });

  it('sin columnas de confusor no cambia nada', () => {
    const predictors = [[1], [2], [3], [4]];
    const outcome = [5, 6, 7, 8];
    const fit = { coefficients: [0, 1], sampleSize: 4 };
    expect(adjustForNuisance(outcome, predictors, [], fit)).toEqual(outcome);
  });

  it('ignora un índice de columna que no existe en vez de romper', () => {
    const predictors = [[1], [2]];
    const fit = { coefficients: [0, 1], sampleSize: 2 };
    expect(adjustForNuisance([5, 6], predictors, [9], fit)).toEqual([5, 6]);
  });
});

describe('fitOlsOnVaryingColumns', () => {
  // Este bloque existe por un bug que los tests NO atraparon y sí encontró un
  // chequeo con datos realistas: los tests de arriba usaban covariables que
  // siempre varían, así que `fitOls` nunca devolvía null por columna
  // constante. En el dispositivo, la actividad física casi siempre es
  // constante (nadie la registra), y eso tumbaba el ajuste ENTERO. El
  // resultado: una solución "robusta" que caía siempre al promedio crudo.
  const outcome = [10, 20, 30, 40, 50, 60, 70, 80];

  it('ajusta descartando la covariable que no varía', () => {
    // Columna 1 constante en 0 — el caso "nadie registró actividad".
    const predictors = [[1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0]];
    expect(fitOls(outcome, predictors)).toBeNull();

    const fitted = fitOlsOnVaryingColumns(outcome, predictors);
    expect(fitted).not.toBeNull();
    expect(fitted!.columns).toEqual([0]);
    expect(fitted!.fit.coefficients[1]).toBeCloseTo(10, 6);
  });

  it('devuelve los índices originales, no los del arreglo reducido', () => {
    // Solo varía la tercera. Quien llama descuenta contra estos índices, así
    // que devolver [0] en vez de [2] descontaría la covariable equivocada.
    const predictors = [
      [5, 9, 1], [5, 9, 2], [5, 9, 3], [5, 9, 4],
      [5, 9, 5], [5, 9, 6], [5, 9, 7], [5, 9, 8],
    ];
    const fitted = fitOlsOnVaryingColumns(outcome, predictors);
    expect(fitted!.columns).toEqual([2]);
  });

  it('devuelve null cuando ninguna covariable varía', () => {
    // Nada que ajustar: su aporte es constante y ya vive en el intercepto.
    const predictors = Array.from({ length: 8 }, () => [3, 3]);
    expect(fitOlsOnVaryingColumns(outcome, predictors)).toBeNull();
  });

  it('sigue respetando el mínimo de observaciones', () => {
    const predictors = [[1, 0], [2, 0], [3, 0], [4, 0]];
    expect(fitOlsOnVaryingColumns([1, 2, 3, 4], predictors, 8)).toBeNull();
  });
});
