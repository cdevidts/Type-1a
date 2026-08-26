/**
 * Procedencia de los macros de una comida: quién puso esos gramos.
 *
 * `macrosSource` (`'ai' | 'user' | 'mixed' | undefined`) **se imprime en el
 * reporte que va al control médico**. "La IA estimó 30 g de proteína" y
 * "anotaste 30 g de proteína" no significan lo mismo para quien lee ese
 * reporte, así que esto es una decisión de dominio con consecuencia clínica,
 * no metadato cosmético.
 *
 * ## Por qué vive acá
 *
 * Vivía en cuatro lugares —`MealModal`, `MealEditModal`, `db.ts` y
 * `macrosSourceFor` en `App.tsx`— con reglas distintas, y produjo **tres bugs
 * distintos, uno por camino**: etiquetar `'ai'` pisando lo que la usuaria
 * escribió; inventar `'user'` desde `undefined`; y degradar `'user'` a
 * `'mixed'` al editar. Regla 1 de `systemPatterns.md`: una sola
 * implementación, pura, determinística y con test.
 *
 * ## Las cuatro reglas
 *
 * 1. **Sin macros no hay procedencia.** Si no queda ningún valor, el resultado
 *    es `undefined` — que significa "no anotado", no "cero gramos".
 * 2. **Lo que la usuaria escribe gana sobre lo de la IA.** Si tocó cualquier
 *    valor que la IA había propuesto, el conjunto es `'mixed'`.
 * 3. **Desconocido se queda desconocido.** Una comida vieja sin procedencia
 *    registrada, editada a mano, **no** pasa a `'user'`: eso afirmaría que ella
 *    los anotó, y `MealEventSchema` lo prohíbe explícitamente. Es la dirección
 *    peligrosa, porque `'user'` es la etiqueta que un equipo clínico lee como
 *    dato confirmado.
 * 4. **`'user'` no se degrada.** Lo que era de ella sigue siendo de ella
 *    aunque lo corrija después.
 *
 * ## La trampa del precargado
 *
 * Desde que los campos de macros **se prellenan** con lo que estimó la IA,
 * "el campo tiene valor" dejó de significar "ella lo escribió". Comparar
 * contra `undefined` etiquetaba `'mixed'` una comida analizada que ella nunca
 * tocó, sobreestimando su participación. Por eso la comparación es **contra el
 * valor que la IA propuso**, no contra la ausencia de valor.
 */

export type MacrosSource = 'ai' | 'user' | 'mixed';

/**
 * Los cuatro macros, en el lenguaje laxo de los formularios.
 *
 * `null` y `undefined` son ambos "no hay valor": los modales usan uno u otro
 * (`MealModal` deja `undefined` un campo vacío, `MealEditModal` usa `null` para
 * "borrar"), y normalizar acá evita que cada llamador recuerde cuál le toca.
 * Lo que **no** se colapsa es `0`: cero gramos es un dato que ella anotó.
 */
export interface MacroValues {
  proteinG?: number | null | undefined;
  fatG?: number | null | undefined;
  fiberG?: number | null | undefined;
  caloriesKcal?: number | null | undefined;
}

export interface MacrosSourceInput {
  /** Lo que quedó al guardar. Es lo único obligatorio. */
  entered: MacroValues;
  /**
   * Lo que la IA precargó **en esta captura**. `undefined` = no hubo análisis.
   * Con esto presente, la comparación es contra estos valores y no contra la
   * ausencia de valor — ver "la trampa del precargado".
   */
  aiProposed?: MacroValues | undefined;
  /**
   * Lo que ya estaba guardado, cuando se está editando una comida existente.
   * `undefined` = comida nueva.
   */
  previous?: { values: MacroValues; source: MacrosSource | undefined } | undefined;
}

const MACRO_KEYS = ['proteinG', 'fatG', 'fiberG', 'caloriesKcal'] as const;

/** `null` y `undefined` son lo mismo acá; `0` no. */
function present(value: number | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : value;
}

function hasAnyMacro(values: MacroValues | undefined): boolean {
  return values !== undefined && MACRO_KEYS.some((key) => present(values[key]) !== undefined);
}

/**
 * Iguales campo a campo, tratando `null` y `undefined` como el mismo "no hay".
 *
 * Solo se comparan los campos que el lado de referencia declara: `MealModal`
 * precarga tres macros y `MealEditModal` cuatro, y exigirle a la usuaria un
 * valor de calorías que la IA nunca propuso convertiría en `'mixed'` algo que
 * ella no tocó.
 */
function sameMacros(reference: MacroValues, actual: MacroValues): boolean {
  return MACRO_KEYS.every((key) => {
    const expected = present(reference[key]);
    if (expected === undefined) return true;
    return present(actual[key]) === expected;
  });
}

/**
 * Quién puso los macros que se están por guardar.
 *
 * Devuelve `undefined` cuando no hay ninguno: ausente significa **procedencia
 * desconocida**, y nunca se asume "confirmado por la usuaria".
 */
export function resolveMacrosSource(input: MacrosSourceInput): MacrosSource | undefined {
  const { entered, aiProposed, previous } = input;

  // Regla 1: sin macros no hay nada cuya procedencia declarar.
  if (!hasAnyMacro(entered)) return undefined;

  // Hubo análisis en esta captura: la referencia es lo que la IA propuso.
  if (hasAnyMacro(aiProposed)) {
    // Regla 2. Incluye el caso "lo borró a propósito": si la IA precargó un
    // valor y ella lo dejó en blanco, está diciendo "no lo sé", no "usa el de
    // la IA" — y eso es una intervención suya, así que `'mixed'`.
    return sameMacros(aiProposed as MacroValues, entered) ? 'ai' : 'mixed';
  }

  // Sin análisis, y sin nada guardado antes: los puso ella.
  if (previous === undefined || !hasAnyMacro(previous.values)) return 'user';

  // Sin análisis, sobre algo que ya existía: si no cambió nada, la procedencia
  // que tenía se conserva tal cual.
  if (sameMacros(previous.values, entered) && sameMacros(entered, previous.values)) {
    return previous.source;
  }

  // Cambió algo, a mano.
  // Regla 3: desconocido se queda desconocido.
  if (previous.source === undefined) return undefined;
  // Regla 4: lo de ella sigue siendo de ella.
  if (previous.source === 'user') return 'user';
  // Lo que la IA había puesto y ella corrigió es, por definición, mezcla.
  return 'mixed';
}
