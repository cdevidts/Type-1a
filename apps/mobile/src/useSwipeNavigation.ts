import { useMemo, useRef } from 'react';
import { AccessibilityInfo, PanResponder, type PanResponderInstance } from 'react-native';

import { NAV_ORDER, type NavDestination } from './components/BottomNav';

/**
 * Navegación lateral por gesto entre los cinco destinos de la barra inferior
 * (Fase 16), en el mismo orden que los botones.
 *
 * ## El riesgo real: robarle el gesto al gráfico
 *
 * `GlucoseChart` es un **`ScrollView` horizontal** — se desliza para ver días
 * anteriores. Un reconocedor de swipe ingenuo le roba ese gesto y deja el
 * gráfico principal de la app inservible. Dos defensas:
 *
 * 1. **Umbral direccional**: sólo se toma el gesto si el desplazamiento
 *    horizontal supera `MIN_DX` y es al menos `DIRECTION_RATIO` veces el
 *    vertical. Un arrastre diagonal o casi vertical se le deja al
 *    `ScrollView` de la pantalla.
 * 2. **`onMoveShouldSetPanResponder`, no `onStart...`**: no se reclama el
 *    gesto al tocar, sino recién cuando el movimiento ya demostró ser
 *    horizontal. Mientras tanto los hijos siguen recibiéndolo.
 *
 * Aun así, el contenedor que use esto **no debe envolver al gráfico**: se
 * aplica al contenedor de la pantalla, y el gráfico queda fuera de su
 * jerarquía de gestos o con su propio `onStartShouldSetPanResponderCapture`
 * devolviendo `false`.
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
  /** Destino actual; `null` = pantalla principal, que es el centro (`entry`). */
  active: NavDestination | null;
  onNavigate: (destination: NavDestination) => void;
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
        onMoveShouldSetPanResponder: (_event, gesture) => {
          if (!enabled) return false;
          return Math.abs(gesture.dx) > MIN_DX
            && Math.abs(gesture.dx) > Math.abs(gesture.dy) * DIRECTION_RATIO;
        },
        onPanResponderRelease: (_event, gesture) => {
          if (!enabled) return;
          if (Math.abs(gesture.dx) <= MIN_DX) return;
          const currentIndex = active === null
            ? NAV_ORDER.indexOf('entry')
            : NAV_ORDER.indexOf(active);
          if (currentIndex < 0) return;
          // Deslizar a la izquierda avanza hacia la derecha en la barra.
          const nextIndex = gesture.dx < 0 ? currentIndex + 1 : currentIndex - 1;
          if (nextIndex < 0 || nextIndex >= NAV_ORDER.length) return;
          const next = NAV_ORDER[nextIndex];
          if (next !== undefined) onNavigate(next);
        },
      }),
    [active, onNavigate, enabled],
  );
}
