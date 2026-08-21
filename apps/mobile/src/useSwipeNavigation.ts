import { useMemo, useRef } from 'react';
import { AccessibilityInfo, PanResponder, type PanResponderInstance } from 'react-native';

import { isSwipeBlocked, resetSwipeGuard } from './swipeGuard';
import { nextSwipeDestination } from './swipeOrder';
import type { NavDestination } from './components/BottomNav';

/**
 * Navegación lateral por gesto entre las secciones de la barra inferior.
 *
 * ## Historia: la primera versión no navegaba a ninguna parte (2026-08-21)
 *
 * Verónica reportó que el swipe "no hace nada". Eran **dos** bugs
 * independientes, y cada uno bastaba para romperlo:
 *
 * 1. **Los `panHandlers` estaban pegados al `ScrollView` de la pantalla.** Un
 *    `ScrollView` es un componente nativo que maneja el arrastre él mismo; los
 *    props del sistema de responders de JS puestos encima nunca llegan a
 *    decidir nada. El gesto no se disparaba jamás — por eso tampoco "se rompía
 *    el gráfico": no había ningún reconocedor compitiendo. Ahora el
 *    `PanResponder` va en un `View` que **envuelve** al `ScrollView`, y reclama
 *    en **fase de captura**, que es la forma documentada de que un padre le
 *    gane un arrastre a un hijo que scrollea.
 *
 * 2. **El orden incluía `entry` y `chat`.** Desde la pantalla principal, los
 *    dos vecinos inmediatos eran justamente esos: uno abre un formulario y el
 *    otro es un aviso de "todavía no está". Aun con el gesto arreglado, jamás
 *    se habría llegado a Nutrición ni a Resumen deslizando. Ahora el orden del
 *    swipe salta lo que no es un destino navegable.
 *
 * ## Qué recorre el gesto
 *
 * `entry` queda fuera porque es una **acción**, no un lugar: abrir un
 * formulario con campos por un gesto accidental es exactamente lo que no se
 * quiere en una app que se usa apurada. `chat` queda fuera hasta que exista
 * (Fase 8). La pantalla principal es una posición más del recorrido — el
 * centro —, así que deslizar de vuelta al centro cierra el modal en el que
 * estés y te deja en casa.
 *
 * ## No robarle el gesto al gráfico
 *
 * `GlucoseChart` es un `ScrollView` horizontal. Reclamar en captura también le
 * ganaría a él, así que se coordina con `swipeGuard.ts`: si el toque empezó
 * dentro del gráfico, este reconocedor no reclama nada durante ese toque.
 */

/** Píxeles horizontales mínimos para considerar que hubo swipe. */
const MIN_DX = 60;
/** Cuánto más horizontal que vertical tiene que ser el gesto. */
const DIRECTION_RATIO = 1.8;

export function useSwipeNavigation({
  active,
  onNavigate,
  enabled = true,
}: {
  /** Destino actual; `null` = pantalla principal. */
  active: NavDestination | null;
  /** `null` = volver a la pantalla principal, cerrando lo que esté abierto. */
  onNavigate: (destination: NavDestination | null) => void;
  enabled?: boolean;
}): PanResponderInstance {
  // Se lee una vez y se guarda: consultarlo dentro del gesto lo haría async
  // justo cuando hay que decidir en el mismo frame.
  const reduceMotion = useRef(false);
  useMemo(() => {
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => { reduceMotion.current = value; })
      .catch(() => { reduceMotion.current = false; });
  }, []);

  return useMemo(
    () =>
      PanResponder.create({
        // No reclama el toque; lo usa para resetear el árbitro al empezar.
        // Corre antes que el marcador del gráfico, que está más abajo en el
        // árbol — esa es justamente la razón de que la coordinación funcione.
        onStartShouldSetPanResponderCapture: () => {
          resetSwipeGuard();
          return false;
        },
        // En captura, no en burbuja: el `ScrollView` de la pantalla es nativo
        // y no cede el arrastre si se le pide en burbuja.
        onMoveShouldSetPanResponderCapture: (_event, gesture) => {
          if (!enabled || isSwipeBlocked()) return false;
          return Math.abs(gesture.dx) > MIN_DX
            && Math.abs(gesture.dx) > Math.abs(gesture.dy) * DIRECTION_RATIO;
        },
        onPanResponderRelease: (_event, gesture) => {
          if (!enabled) return;
          if (Math.abs(gesture.dx) <= MIN_DX) return;
          const next = nextSwipeDestination(active, gesture.dx);
          // `undefined` = no hay a dónde ir. `null` sí es un destino: la
          // pantalla principal.
          if (next === undefined) return;
          onNavigate(next);
        },
      }),
    [active, onNavigate, enabled],
  );
}
