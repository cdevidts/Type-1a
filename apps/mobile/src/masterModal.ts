import type { MealEvent } from '@type1a/schemas';

import type { EntryFocus, TimelineItem } from './types';

/**
 * Las dos reglas del Modal Maestro, puras y con test.
 *
 * `projectbrief.md` las fija como arquitectura inquebrantable, así que no
 * pueden vivir dentro de un `.tsx` donde solo se verifican a ojo. Las dos ya
 * tuvieron su versión equivocada: la primera repartida en tres modales
 * distintos, la segunda como un `item.kind === 'meal'` que dejaba fuera a la
 * misma comida guardada de otra forma.
 */

/**
 * Qué sección arranca abierta.
 *
 * **El foco decide qué se ve primero, nunca qué se puede guardar.** Desde
 * cualquiera se llega a todo lo demás: es la diferencia entre un acceso rápido
 * —pocos toques para lo de siempre— y cuatro formularios que sabían hacer
 * cosas distintas.
 */
export function sectionStartsOpen(focus: EntryFocus, section: EntryFocus): boolean {
  return focus === 'all' || focus === section;
}

/**
 * La comida de un ítem del timeline, venga suelta o dentro de una entrada
 * empaquetada.
 *
 * Es lo que hace que las herramientas potentes aparezcan **por contenido y no
 * por qué botón abrió el modal**. Con la condición vieja (`kind === 'meal'`),
 * una comida registrada desde "Nueva entrada" quedaba fuera de su propio
 * editor: tenía foto y macros, y no había forma de re-analizarla.
 */
export function mealOf(item: TimelineItem): MealEvent | null {
  if (item.kind === 'meal') return item.raw;
  if (item.kind === 'entry') return item.raw.meal ?? null;
  return null;
}
