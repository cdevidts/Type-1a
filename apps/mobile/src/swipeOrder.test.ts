import { describe, expect, it } from 'vitest';

import { nextSwipeDestination, SWIPE_ORDER } from './swipeOrder';

/** Dedo hacia la izquierda = avanzar a la derecha en la barra. */
const LEFT = -80;
const RIGHT = 80;

describe('nextSwipeDestination', () => {
  it('desde la pantalla principal llega a un destino real en ambas direcciones', () => {
    // El bug de la Fase 16: los vecinos de la pantalla principal eran `entry`
    // (un formulario) y `chat` (un aviso de "todavía no está"), así que
    // deslizar no llevaba a ninguna sección de verdad.
    expect(nextSwipeDestination(null, RIGHT)).toBe('catalog');
    expect(nextSwipeDestination(null, LEFT)).toBe('summary');
  });

  it('vuelve a la pantalla principal deslizando hacia el centro', () => {
    expect(nextSwipeDestination('summary', RIGHT)).toBe(null);
    expect(nextSwipeDestination('catalog', LEFT)).toBe(null);
  });

  it('recorre las secciones de la izquierda en orden', () => {
    expect(nextSwipeDestination('catalog', RIGHT)).toBe('nutrition');
    expect(nextSwipeDestination('nutrition', LEFT)).toBe('catalog');
  });

  it('no sale por los extremos', () => {
    expect(nextSwipeDestination('nutrition', RIGHT)).toBeUndefined();
    expect(nextSwipeDestination('summary', LEFT)).toBeUndefined();
  });

  it('no navega desde un destino que no participa del recorrido', () => {
    // `entry` es una acción, no un lugar; `chat` todavía no existe.
    expect(nextSwipeDestination('entry', LEFT)).toBeUndefined();
    expect(nextSwipeDestination('chat', RIGHT)).toBeUndefined();
  });

  it('mantiene la pantalla principal al centro del recorrido', () => {
    // Si alguien agrega un destino, tiene que decidir de qué lado va — y este
    // test se lo recuerda en vez de dejar que el gesto y la barra se
    // contradigan en silencio.
    expect(SWIPE_ORDER.indexOf(null)).toBe(2);
    expect(SWIPE_ORDER).toHaveLength(4);
  });
});
