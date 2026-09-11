import type { CatalogFood } from '@type1a/domain';

/**
 * Los nombres del catálogo que viajan con un análisis de comida, para que la
 * IA reuse el nombre exacto de lo que ya existe en vez de inventar un
 * duplicado ("pata de pollo" cuando ella ya tiene "Muslo de pollo").
 *
 * ## Qué sale del teléfono, y qué no
 *
 * **Solo el nombre.** Ni macros, ni veces vista, ni cuándo, ni si está oculto
 * dentro de una receta. Es el mínimo que sirve para deduplicar
 * (`AGENTS.md`, "send the minimum necessary data"), y el esquema del servidor
 * (`KnownFoodNamesSchema`) no tiene dónde poner otra cosa. Que sea un dato
 * que antes no salía queda dicho acá como costo aceptado: es la única forma
 * de que el modelo sepa cómo se llama lo que ella ya guardó.
 *
 * ## Por qué los más vistos y por qué el tope
 *
 * Con un catálogo grande no se manda entero: los 300 más usados son los que
 * de verdad se repiten en el plato, y el tope del esquema es el mismo. Los
 * ocultos ("solo receta") van también: si vuelve a fotografiar el plato, sus
 * componentes tienen que reconocerse como los mismos.
 */
export const MAX_KNOWN_FOOD_NAMES = 300;

export function knownFoodNamesFrom(foods: readonly CatalogFood[]): string[] {
  return [...foods]
    .sort((a, b) => b.timesSeen - a.timesSeen)
    .slice(0, MAX_KNOWN_FOOD_NAMES)
    .map((food) => food.name.trim())
    .filter((name) => name !== '' && name.length <= 80);
}
