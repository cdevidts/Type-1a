/**
 * Mínimos cuadrados ordinarios (OLS) para ajustar por covariables.
 *
 * ## Por qué existe
 *
 * Verónica lo pidió textualmente el 2026-08-25, después de que la pantalla de
 * Patrones le quedara vacía: *"fuiste muy binario con esta solución,
 * esperaría que buscaras en internet para dar con formulas matematicas que
 * permitieran solucionar este tema, no que decidieras obviar cualquier dato
 * que no venga en formato fácil"*. Tenía razón.
 *
 * El enfoque anterior era **excluir** todo episodio que tuviera algo
 * registrado en su ventana. En diabetes tipo 1 con múltiples dosis diarias se
 * come cada 4-5 h, así que a las 4 y 5 h *ningún* episodio queda limpio: la
 * exclusión no filtraba ruido, borraba la pantalla. Y encima sesgaba, porque
 * las comidas altas en grasa y proteína son justo las que más se corrigen
 * tarde: la muestra que sobrevivía era la que se había portado bien.
 *
 * Lo que hace la literatura, en cambio (ver `docs/RESEARCH_SOURCES.md`):
 *
 * 1. **Truncar, no descartar.** El estándar de iAUC post-prandial mide desde
 *    la comida hasta que empieza la siguiente y corta ahí, en vez de tirar la
 *    comida entera.
 * 2. **Ajustar por la covariable, no eliminar la observación.** Es la
 *    respuesta estándar a un confusor medido: se modela su efecto y se
 *    descuenta, conservando todos los datos.
 *
 * Este módulo es la pieza 2. Es aritmética pura y determinística, con test,
 * como manda `AGENTS.md` para todo lo que decide un número que la usuaria lee
 * como patrón.
 *
 * ## Qué NO es
 *
 * No predice, no extrapola y no toca insulina. Devuelve coeficientes que solo
 * se usan para **descontar de un promedio descriptivo** la parte atribuible a
 * lo que pasó en el medio. Ningún coeficiente se muestra, ninguno entra a una
 * calculadora de dosis.
 */

export interface OlsFit {
  /** Intercepto seguido de un coeficiente por columna de `predictors`. */
  coefficients: number[];
  /** Observaciones usadas. */
  sampleSize: number;
}

/**
 * Resuelve `A x = b` por eliminación gaussiana con pivoteo parcial.
 *
 * Devuelve `null` si la matriz es singular o casi — que es el caso normal
 * cuando una covariable es constante (por ejemplo, nadie registró actividad).
 * Quien llama debe entonces caer a la versión sin ajustar en vez de inventar
 * un número: un sistema mal condicionado da coeficientes enormes y sin
 * sentido, y acá eso terminaría desplazando un promedio que se lee como
 * patrón clínico.
 */
function solve(matrix: number[][], vector: number[]): number[] | null {
  const n = vector.length;
  const a = matrix.map((row, index) => [...row, vector[index]!]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row]![col]!) > Math.abs(a[pivot]![col]!)) pivot = row;
    }
    // Umbral relativo, no absoluto: las escalas de acá van de gramos (0-500)
    // a unidades de insulina (0-100), y un epsilon fijo trataría como
    // singular un sistema perfectamente sano.
    const scale = Math.max(...a.map((row) => Math.abs(row[col]!)));
    if (scale === 0 || Math.abs(a[pivot]![col]!) < scale * 1e-10) return null;
    [a[col], a[pivot]] = [a[pivot]!, a[col]!];

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row]![col]! / a[col]![col]!;
      for (let k = col; k <= n; k += 1) a[row]![k]! -= factor * a[col]![k]!;
    }
  }

  const solution = a.map((row, index) => row[n]! / row[index]!);
  return solution.every((value) => Number.isFinite(value)) ? solution : null;
}

/**
 * Ajusta `outcome ~ 1 + predictors` por mínimos cuadrados.
 *
 * `null` cuando no hay material para un ajuste honesto:
 *
 * - menos observaciones que parámetros más un margen (ver `minObservations`);
 * - alguna covariable constante, que hace singular el sistema;
 * - un sistema mal condicionado.
 *
 * En todos esos casos quien llama debe mostrar el promedio **sin ajustar** y
 * decirlo, nunca un ajuste inventado.
 */
export function fitOls(
  outcome: readonly number[],
  predictors: readonly (readonly number[])[],
  minObservations = 0,
): OlsFit | null {
  const n = outcome.length;
  if (n === 0 || predictors.length !== n) return null;
  const p = predictors[0]!.length;
  if (predictors.some((row) => row.length !== p)) return null;

  // Regla de dedo estándar contra el sobreajuste: con tantas observaciones
  // como parámetros el ajuste es perfecto y no dice nada. Se pide un mínimo
  // explícito además de `p + 1`.
  const required = Math.max(p + 2, minObservations);
  if (n < required) return null;

  // Diseño con intercepto.
  const design = predictors.map((row) => [1, ...row]);
  const k = p + 1;

  // Ecuaciones normales: (XᵀX) β = Xᵀy.
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i += 1) {
    const row = design[i]!;
    for (let r = 0; r < k; r += 1) {
      xty[r]! += row[r]! * outcome[i]!;
      for (let c = 0; c < k; c += 1) xtx[r]![c]! += row[r]! * row[c]!;
    }
  }

  const coefficients = solve(xtx, xty);
  if (coefficients === null) return null;
  return { coefficients, sampleSize: n };
}

/**
 * Descuenta de cada observación la parte que el modelo atribuye a las
 * covariables, dejando el resto.
 *
 * Es la operación que permite conservar un episodio "sucio" en vez de
 * tirarlo: si a las 2 h se comieron 20 g de más, se resta lo que el modelo
 * dice que aportan esos 20 g y el episodio sigue contando.
 *
 * **El intercepto y el predictor de interés no se tocan** — solo se
 * descuentan las columnas que quien llama declara como confusores en
 * `nuisanceColumns` (índices dentro de `predictors`, base 0).
 */
export function adjustForNuisance(
  outcome: readonly number[],
  predictors: readonly (readonly number[])[],
  nuisanceColumns: readonly number[],
  fit: OlsFit,
): number[] {
  return outcome.map((value, index) => {
    let adjusted = value;
    for (const column of nuisanceColumns) {
      // +1 porque `coefficients[0]` es el intercepto.
      const beta = fit.coefficients[column + 1];
      const x = predictors[index]?.[column];
      if (beta === undefined || x === undefined) continue;
      adjusted -= beta * x;
    }
    return adjusted;
  });
}
