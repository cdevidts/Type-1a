/**
 * Un único árbitro para el gesto lateral de la app.
 *
 * El swipe entre secciones vive en un `View` que envuelve toda la pantalla y
 * reclama el gesto en **fase de captura** (`onMoveShouldSetResponderCapture`),
 * que es la forma documentada de que un padre le gane un arrastre a un
 * `ScrollView` hijo. El problema es que así también le ganaría el gesto al
 * único scroller horizontal legítimo que tiene la app: el `ScrollView` de
 * `GlucoseChart`, que se desliza para ver días anteriores.
 *
 * La solución es una bandera compartida: cuando un toque empieza dentro de un
 * scroller horizontal, ese scroller lo marca, y el árbitro del swipe no
 * reclama nada durante ese toque. Se resetea en cada toque nuevo.
 *
 * ## Por qué un módulo con estado y no un prop
 *
 * Porque hay **un** gesto de navegación en toda la app, y el `ScrollView` del
 * gráfico está tres componentes más abajo (`App` → `GlucoseCard` →
 * `GlucoseChart`). Pasar una ref por props obligaría a `GlucoseCard`, que no
 * tiene nada que ver con la navegación, a transportarla. El acoplamiento real
 * acá es "un árbitro, un gesto", y así queda dicho.
 *
 * El orden de las llamadas es determinista y es lo que hace que funcione: en
 * un toque, la fase de captura corre de la raíz hacia la hoja. Primero
 * `resetSwipeGuard()` desde el contenedor de la pantalla, después —solo si el
 * dedo cayó dentro del gráfico— `blockSwipeForThisTouch()`. Cuando llega el
 * primer movimiento, la bandera ya dice la verdad.
 */

let blockedForThisTouch = false;

/** Lo llama el contenedor de la pantalla al empezar cualquier toque. */
export function resetSwipeGuard(): void {
  blockedForThisTouch = false;
}

/** Lo llama un scroller horizontal cuando el toque empezó dentro de él. */
export function blockSwipeForThisTouch(): void {
  blockedForThisTouch = true;
}

export function isSwipeBlocked(): boolean {
  return blockedForThisTouch;
}

/**
 * Para pegar en el `View` que envuelve un scroller horizontal.
 *
 * Devuelve `false` siempre: no reclama el gesto, solo se entera de que
 * empezó ahí. `onStartShouldSetResponderCapture` es el único enganche que
 * corre en cada toque sin alterar la negociación.
 */
export const horizontalScrollerGuardHandlers = {
  onStartShouldSetResponderCapture: (): boolean => {
    blockSwipeForThisTouch();
    return false;
  },
} as const;
