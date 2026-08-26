import { describe, expect, it } from 'vitest';

import { mealOf, sectionStartsOpen } from './masterModal';

import type { EntryFocus, TimelineItem } from './types';

const meal = {
  id: 'm1',
  timestamp: '2026-08-26T12:00:00.000Z',
  createdAt: '2026-08-26T12:00:00.000Z',
  confirmedCarbsG: 40,
};

const SECTIONS = ['glucose', 'meal', 'insulin', 'ketones', 'note'] as const;

describe('sectionStartsOpen', () => {
  it("'all' abre todo: es la entrada completa", () => {
    for (const section of SECTIONS) {
      expect(sectionStartsOpen('all', section)).toBe(true);
    }
  });

  it.each(SECTIONS)('el foco %s abre esa sección y solo esa', (focus) => {
    for (const section of SECTIONS) {
      expect(sectionStartsOpen(focus, section)).toBe(section === focus);
    }
  });

  /**
   * La regla que no puede romperse: **el foco decide qué se ve primero, nunca
   * qué se puede guardar.** Si una sección quedara inalcanzable desde algún
   * foco, volveríamos a tener formularios que saben hacer cosas distintas —
   * que es de donde salió la Fase 21 entera.
   */
  it('ninguna sección queda inalcanzable desde ningún foco', () => {
    const focos: EntryFocus[] = ['all', ...SECTIONS];
    for (const section of SECTIONS) {
      expect(focos.some((focus) => sectionStartsOpen(focus, section))).toBe(true);
    }
  });
});

describe('mealOf — las herramientas aparecen por contenido, no por tipo', () => {
  it('una comida suelta tiene comida', () => {
    const item = { id: 'm1', kind: 'meal', timestamp: meal.timestamp, title: '', detail: '', tone: 'orange', raw: meal } as TimelineItem;
    expect(mealOf(item)).toBe(meal);
  });

  /**
   * El caso que la condición vieja (`kind === 'meal'`) dejaba fuera: la misma
   * comida, guardada desde "Nueva entrada", quedaba sin acceso a su propio
   * editor con IA aunque tuviera foto y macros.
   */
  it('una entrada empaquetada CON comida también', () => {
    const item = {
      id: 'g1',
      kind: 'entry',
      timestamp: meal.timestamp,
      title: '',
      detail: '',
      tone: 'teal',
      raw: { entryGroupId: 'g1', meal },
    } as TimelineItem;
    expect(mealOf(item)).toBe(meal);
  });

  it('una entrada empaquetada SIN comida no la inventa', () => {
    const item = {
      id: 'g2',
      kind: 'entry',
      timestamp: meal.timestamp,
      title: '',
      detail: '',
      tone: 'teal',
      raw: { entryGroupId: 'g2', glucose: 110 },
    } as TimelineItem;
    expect(mealOf(item)).toBeNull();
  });

  it.each(['insulin', 'glucose', 'note', 'vitals', 'episode', 'carbs'] as const)(
    'un ítem de tipo %s no ofrece herramientas de comida',
    (kind) => {
      const item = { id: 'x', kind, timestamp: meal.timestamp, title: '', detail: '', tone: 'navy', raw: {} } as unknown as TimelineItem;
      expect(mealOf(item)).toBeNull();
    },
  );
});
