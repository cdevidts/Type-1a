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
 * Lo que hace la literatura, en cambio (ver `memory-bank/reference/clinical-sources.md`):
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
 *
 * ## ⚠️ Los coeficientes no pueden salir de `macro-glucose.ts`
 *
 * Éste es un módulo genérico, y ahí está el riesgo: el coeficiente de la
 * columna de unidades de insulina es, dimensionalmente, **un factor de
 * corrección empírico derivado de los datos de la usuaria**. `AGENTS.md`
 * prohíbe inferir parámetros de terapia — objetivo, factor de corrección e
 * incremento son valores que ella ingresa.
 *
 * Hoy no se viola: el único llamador es `macro-glucose.ts`, que usa los
 * coeficientes para residualizar y los descarta. Pero un
 * `fitOls(deltas, [[unidades]])` desde otro lado produce un factor de
 * corrección inferido en tres líneas.
 *
 * Por eso: **este módulo no se cataloga como alcanzable por el chat de IA**
 * (ver `memory-bank/reference/ai-chat-capabilities.md`), y cualquier llamador nuevo tiene que
 * justificar por qué sus coeficientes no son un parámetro de terapia
 * disfrazado.
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
 * Ajusta descartando primero las covariables que no varían.
 *
 * ## Por qué existe (2026-08-26)
 *
 * `fitOls` devuelve `null` ante una columna constante, y con razón: el
 * sistema es singular. Pero pasarle las tres covariables juntas hacía que
 * **el ajuste no se aplicara nunca en la práctica**, porque basta que una no
 * varíe para tumbar el ajuste completo — y la que no varía es casi siempre la
 * actividad física, que muchísima gente no registra. El resultado era una
 * solución "robusta" que en el dispositivo caía siempre al promedio crudo.
 *
 * Lo encontró un chequeo con datos realistas, no un test: los tests usaban
 * covariables que siempre variaban. Por eso hay uno acá abajo que fija justo
 * este caso.
 *
 * Devuelve también **qué columnas sobrevivieron**, en índices del arreglo
 * original, porque quien llama necesita saber cuáles descontar después.
 */
export function fitOlsOnVaryingColumns(
  outcome: readonly number[],
  predictors: readonly (readonly number[])[],
  minObservations = 0,
): { fit: OlsFit; columns: number[] } | null {
  if (predictors.length === 0) return null;
  const width = predictors[0]!.length;

  const columns: number[] = [];
  for (let column = 0; column < width; column += 1) {
    const first = predictors[0]![column];
    if (predictors.some((row) => row[column] !== first)) columns.push(column);
  }
  // Ninguna covariable varía: no hay nada que ajustar, y decirlo es correcto
  // (todas valen lo mismo, así que su aporte es parte del intercepto).
  if (columns.length === 0) return null;

  const reduced = predictors.map((row) => columns.map((column) => row[column]!));
  const fit = fitOls(outcome, reduced, minObservations);
  return fit === null ? null : { fit, columns };
}

/**
 * Descuenta de cada observación su **desbalance** respecto del promedio en
 * las covariables de confusión.
 *
 * ## Por qué se centra (2026-08-26) — el error que esto corrige
 *
 * La primera versión restaba `β_j · x_ij` a secas. Eso no produce un promedio
 * ajustado: produce **la predicción del modelo para una ventana con cero
 * carbohidratos, cero insulina y cero actividad**. Ese contrafáctico casi no
 * existe en los datos —a las 4-5 h toda ventana tiene la comida siguiente
 * adentro—, así que era extrapolar fuera del rango observado y publicar el
 * resultado bajo la etiqueta "cambio promedio de glucosa desde el momento de
 * comer". Con datos donde la verdad era +10 mg/dL, la pantalla llegaba a
 * mostrar +57, y ese número se imprime en el reporte que va al control
 * médico.
 *
 * Centrando (`x_ij − x̄_j`) el promedio ajustado queda **anclado en el
 * promedio observado**: el ajuste corrige el desbalance *entre* episodios sin
 * mover el nivel general a un régimen que nunca se midió. Es lo que en la
 * literatura se llama media marginal estimada, y es la forma estándar de
 * "ajustar por una covariable" precisamente por esto.
 *
 * Y lo importante para esta pantalla: **la diferencia entre dos grupos se
 * conserva exacta**. Centrar suma la misma constante a los dos, así que la
 * comparación —que es lo que la pantalla existe para mostrar— no se toca,
 * mientras que los niveles siguen siendo comparables con lo observado.
 *
 * **El intercepto y el predictor de interés no se tocan**: solo se descuentan
 * las columnas que quien llama declara en `nuisanceColumns`.
 */
export function adjustForNuisance(
  outcome: readonly number[],
  predictors: readonly (readonly number[])[],
  nuisanceColumns: readonly number[],
  fit: OlsFit,
): number[] {
  const means = new Map<number, number>();
  for (const column of nuisanceColumns) {
    const values = predictors.map((row) => row[column] ?? 0);
    means.set(column, values.reduce((sum, value) => sum + value, 0) / (values.length || 1));
  }
  return outcome.map((value, index) => {
    let adjusted = value;
    for (const column of nuisanceColumns) {
      // +1 porque `coefficients[0]` es el intercepto.
      const beta = fit.coefficients[column + 1];
      const x = predictors[index]?.[column];
      if (beta === undefined || x === undefined) continue;
      adjusted -= beta * (x - (means.get(column) ?? 0));
    }
    return adjusted;
  });
}

/**
 * ¿El ajuste movió el promedio más de lo que un ajuste sano movería?
 *
 * Último freno contra un `β` disparatado. `fitOls` atrapa la singularidad
 * exacta, pero no el **mal condicionamiento**, y en datos reales carbohidratos
 * y unidades de insulina van casi proporcionales (se bolea por ratio): eso
 * puede producir coeficientes enormes que se cancelan dentro del rango de los
 * datos y dejan de cancelarse ante un solo episodio atípico —una hipo tratada
 * con 15 g y sin insulina, cosa rutinaria.
 *
 * En vez de estimar el número de condición, se mira el efecto: si el promedio
 * ajustado se corrió más de una desviación estándar del crudo, el ajuste está
 * haciendo más de lo que puede justificar y quien llama debe quedarse con el
 * crudo. Es un criterio grueso a propósito — acá el error caro es publicar un
 * número movido, no perderse una corrección fina.
 */
export function adjustmentIsPlausible(raw: readonly number[], adjusted: readonly number[]): boolean {
  if (raw.length === 0 || raw.length !== adjusted.length) return false;
  const mean = (values: readonly number[]): number =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const rawMean = mean(raw);
  const variance = mean(raw.map((value) => (value - rawMean) ** 2));
  const sd = Math.sqrt(variance);
  // Con dispersión ~0 cualquier corrimiento es sospechoso; se tolera un
  // margen mínimo para no rechazar por ruido de punto flotante.
  return Math.abs(mean(adjusted) - rawMean) <= Math.max(sd, 1e-9);
}
