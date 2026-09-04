/**
 * Qué campos de una entrada unificada **son** una comida.
 *
 * Vive en su propio módulo, sin dependencias, por la misma razón que
 * `rowDecode.ts` y `swipeOrder.ts`: es una regla de datos con consecuencia
 * clínica, y una regla así se verifica sin teléfono. `db.ts` arrastra
 * `expo-sqlite`, así que dejarla ahí adentro la volvía intestable — y estuvo
 * mal dos veces sin que nada lo dijera.
 *
 * ## Los dos fallos que la produjeron
 *
 * `saveUnifiedEntry` (crear) y `updateUnifiedEntryGroup` (editar) mantenían
 * cada uno su propio booleano `hasMeal`, y se desincronizaron dos veces:
 *
 * 1. **Editar no contaba los macros ni la foto.** Cuando `hasMeal` es falso en
 *    el camino de edición se **borra la fila de la comida entera**: vaciar los
 *    carbohidratos de una entrada keto se llevaba proteína, grasa, nota y
 *    análisis de IA en silencio.
 * 2. **Crear tampoco contaba los macros.** Se arregló el camino de edición y
 *    no el de creación, así que una entrada de solo proteína y grasa se perdía
 *    entera mientras la hoja decía "Entrada guardada" — el peor mensaje
 *    posible, porque le dice a la usuaria que no revise.
 *
 * El modo de fallo es siempre el mismo: alguien agrega un campo de comida a
 * `UnifiedEntryInput` y se olvida de sumarlo a uno de los dos booleanos. Que la
 * lista sea **una sola** lo cierra.
 */

/**
 * Los campos que `writeMealWithEpisode` persiste en la fila de la comida.
 *
 * Si viene cualquiera de estos, hay comida que escribir. Mantener esta lista
 * alineada con lo que ese escritor guarda es la invariante.
 *
 * **`macrosSource` no está a propósito**: es la procedencia de los macros, no
 * un macro. Una entrada que solo trajera procedencia y ningún valor no es una
 * comida, y contarla como tal crearía una fila vacía.
 */
export const MEAL_FIELDS = [
  'carbsG',
  'description',
  'imageUri',
  'proteinG',
  'fatG',
  'fiberG',
  'caloriesKcal',
  'aiEstimatedCarbsG',
  'aiAnalysisId',
] as const;

export type MealField = (typeof MEAL_FIELDS)[number];

/**
 * True si la entrada trae algo que constituya una comida.
 *
 * Al crear decide si se escribe la fila; al editar, si se conserva. Un `false`
 * equivocado **borra datos**, así que ante la duda cuenta como comida: una fila
 * de más es un ítem raro en el timeline, una de menos es historial perdido.
 */
export function hasMealContent(input: Partial<Record<MealField, unknown>>): boolean {
  // `null` tampoco cuenta. Desde que la foto es un **parche**
  // (`undefined` = no se tocó, `null` = quitarla), un "quítale la foto" sobre
  // una entrada sin nada más habría mantenido viva una comida vacía solo
  // porque el campo venía presente.
  return MEAL_FIELDS.some((field) => input[field] !== undefined && input[field] !== null);
}

/**
 * Los campos que hacen de unos gramos **una comida**, más allá de los gramos.
 *
 * `MEAL_FIELDS` menos `carbsG`: descripción, foto, macros, calorías y el
 * rastro del análisis de IA. Todo lo que solo tiene sentido cuando lo que se
 * anotó es un plato y no una cifra de carbohidratos.
 */
export const MEAL_FIELDS_BEYOND_CARBS = MEAL_FIELDS.filter(
  (field): field is Exclude<MealField, 'carbsG'> => field !== 'carbsG',
);

/**
 * Si una edición convierte un **carbohidrato suelto** en una comida.
 *
 * ## El fallo que evita
 *
 * `hasMealContent` cuenta los gramos como comida, y para "Nueva entrada" eso
 * es correcto: anotar 25 g ahí es registrar lo que comiste. Pero al **editar**
 * una fila que nació como carbohidrato suelto —una colación anotada desde su
 * propio acceso rápido— aplicar la misma regla la convertía en comida solo por
 * abrirla y guardar, con episodio nuevo y tres alarmas encima. El registro
 * cambiaba de naturaleza sin que nadie lo pidiera.
 *
 * ## La regla
 *
 * Se vuelve comida cuando la edición **agrega** algo que solo una comida
 * tiene. Corregir los gramos, no; escribir qué era, sacarle una foto, anotar
 * los macros o pasarla por la IA, sí.
 *
 * Vive acá y no en `db.ts` por la misma razón que el resto de este módulo: es
 * una regla de datos con consecuencia clínica —decide si se crea un episodio y
 * si suenan alarmas— y `db.ts` no se puede verificar sin teléfono.
 */
export function promotesLooseCarbToMeal(
  input: Partial<Record<MealField, unknown>>,
): boolean {
  return MEAL_FIELDS_BEYOND_CARBS.some(
    (field) => input[field] !== undefined && input[field] !== null,
  );
}
