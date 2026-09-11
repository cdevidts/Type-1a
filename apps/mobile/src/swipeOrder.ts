import type { NavDestination } from './components/BottomNav';

/**
 * El recorrido del gesto lateral, y la función pura que lo camina.
 *
 * Vive aparte de `useSwipeNavigation` para poder tener test: la mitad del bug
 * que Verónica reportó el 2026-08-21 ("el swipe no me lleva a los otros
 * menús") no era de gestos sino de **orden**, y un orden es exactamente la
 * clase de cosa que se verifica sin un teléfono.
 *
 * `null` es la pantalla principal, y va en el centro para que el gesto y la
 * posición del botón en la barra cuenten la misma historia: Nutrición y
 * Catálogo a la izquierda del (+), Resumen a la derecha.
 *
 * Qué NO está acá, y por qué:
 *
 * - **`entry`** es una *acción*, no un lugar. Abrir un formulario con campos
 *   por un gesto accidental es justo lo que no se quiere en una app que se usa
 *   apurada y a veces en hipoglucemia.
 *
 * **`chat` sí entró, el 2026-09-10**, cuando dejó de ser un aviso de "todavía
 * no está" y pasó a abrir una pantalla real. Va entre la principal y Resumen,
 * que es su posición en la barra, para que el gesto y el botón sigan contando
 * la misma historia.
 *
 * Su modal **no** recibe `swipeHandlers`, y la asimetría es a propósito: se
 * entra deslizando, se sale tocando. Adentro hay un cuadro de texto, y perder
 * un mensaje a medio escribir por un gesto lateral es el mismo daño que perder
 * un formulario a medio llenar — el motivo por el que `entry` tampoco está acá.
 */
export const SWIPE_ORDER: readonly (NavDestination | null)[] = [
  'nutrition',
  'catalog',
  null,
  'chat',
  'summary',
];

/**
 * A dónde lleva un swipe, o `undefined` si no lleva a ninguna parte.
 *
 * `dx` es el desplazamiento horizontal del gesto: negativo = el dedo se movió
 * hacia la izquierda, que avanza hacia la derecha en la barra (igual que pasar
 * la página de un libro).
 *
 * Devuelve `undefined` —y no `null`— cuando no hay a dónde ir, porque `null`
 * ya significa "la pantalla principal". Son dos respuestas distintas: una es
 * "quédate donde estás", la otra es "anda a casa".
 */
export function nextSwipeDestination(
  active: NavDestination | null,
  dx: number,
): NavDestination | null | undefined {
  const currentIndex = SWIPE_ORDER.indexOf(active);
  // Un destino fuera del recorrido (`entry` abierto, por ejemplo) no navega a
  // ningún lado, en vez de saltar a un lugar arbitrario.
  if (currentIndex < 0) return undefined;
  const nextIndex = dx < 0 ? currentIndex + 1 : currentIndex - 1;
  if (nextIndex < 0 || nextIndex >= SWIPE_ORDER.length) return undefined;
  return SWIPE_ORDER[nextIndex];
}
