import type { MealAnalysisResult } from '@type1a/schemas';

/**
 * Qué texto queda como **nota** de una comida, para que al tocar el registro
 * en el timeline se vea qué se comió.
 *
 * ## El bug que arregla
 *
 * `TimelineDetailModal` ya mostraba `Nota` para una comida —el campo existe en
 * `MealEventSchema` y se dibuja— pero el **botón rápido nunca lo escribía**.
 * `MealModal` usaba su cuadro de texto solo para la llamada a la IA y lo
 * tiraba; `confirmMeal` armaba el `MealEvent` sin `note`. El resultado: la
 * misma comida registrada desde el Modal Maestro decía qué era, y desde el
 * acceso rápido quedaba como una fila de gramos sin nombre.
 *
 * ## El orden de preferencia, y por qué
 *
 * 1. **Lo que ella escribió.** Si tecleó "dos sopaipillas con pebre", eso es
 *    lo que quiso decir; ninguna reconstrucción lo mejora.
 * 2. **Los alimentos que identificó la IA.** Cubre la foto sin descripción,
 *    que es el caso más común del botón rápido.
 * 3. **El alimento del catálogo que reusó.**
 *
 * Y `undefined` si no hay nada de eso: **no se inventa un texto**. Una nota
 * autogenerada del tipo "Comida de 45 g" repite lo que la fila ya dice y
 * ensucia el detalle sin agregar información.
 *
 * ## Por qué es un módulo puro
 *
 * Decide qué se **guarda**, no cómo se ve, y su recorte tiene un límite duro
 * del esquema (`note: max(300)`): pasarse hace que Zod rechace la comida
 * entera al guardarla. Eso no se verifica a ojo.
 */

/** El techo de `MealEventSchema.note`. Pasarse tumba el guardado completo. */
export const MAX_MEAL_NOTE_LENGTH = 300;

/**
 * Recorta a `MAX_MEAL_NOTE_LENGTH` cortando en un espacio cuando se puede, para
 * no dejar una palabra partida a la mitad. El `…` entra dentro del límite.
 */
export function clampMealNote(text: string): string {
  const trimmed = text.trim().replace(/\s+/gu, ' ');
  if (trimmed.length <= MAX_MEAL_NOTE_LENGTH) return trimmed;
  const hard = trimmed.slice(0, MAX_MEAL_NOTE_LENGTH - 1);
  const lastSpace = hard.lastIndexOf(' ');
  // Un espacio demasiado temprano significa que no hay dónde cortar bien
  // (una sola palabra larguísima); ahí manda el corte duro.
  const cut = lastSpace > MAX_MEAL_NOTE_LENGTH / 2 ? hard.slice(0, lastSpace) : hard;
  return `${cut.trimEnd()}…`;
}

export function mealNoteFrom(input: {
  /** Lo que la usuaria escribió en el cuadro de texto, si escribió algo. */
  description?: string | undefined;
  analysis?: MealAnalysisResult | undefined;
  /** Nombre del alimento del catálogo que se reusó, si se reusó uno. */
  catalogFoodName?: string | undefined;
}): string | undefined {
  const typed = input.description?.trim() ?? '';
  if (typed !== '') return clampMealNote(typed);

  const foods = input.analysis?.estimate.foods ?? [];
  const names = foods
    .map((food) => food.name.trim())
    .filter((name) => name !== '');
  if (names.length > 0) return clampMealNote(names.join(', '));

  const catalogName = input.catalogFoodName?.trim() ?? '';
  if (catalogName !== '') return clampMealNote(catalogName);

  return undefined;
}
