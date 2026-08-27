import { describe, expect, it } from 'vitest';

import {
  HISTORIC_CALCULATOR_TITLE,
  historicCalculatorWarning,
  isHistoricCalculation,
  isMasterEditable,
  masterSectionsFor,
  masterSeedFrom,
  masterTargetOf,
  masterTitleFor,
  mealOf,
  sectionStartsOpen,
} from './masterModal';

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

/**
 * La edición retroactiva, en reglas puras.
 *
 * Lo que estos tests fijan es la arquitectura de `projectbrief.md`: **el tipo
 * con el que nació un evento no restringe lo que se le puede sumar después**, y
 * las secciones que arrancan abiertas dependen del contenido y no de qué botón
 * abrió el modal. Antes esto vivía repartido en cinco ramas de un `.tsx`, cada
 * una sabiendo guardar un subconjunto distinto.
 */

const AT = '2026-08-27T13:00:00.000Z';

const insulinItem: TimelineItem = {
  id: 'i1', kind: 'insulin', timestamp: AT, title: '', detail: '', tone: 'blue',
  raw: { id: 'i1', timestamp: AT, type: 'rapid', units: 4, source: 'manual', createdAt: AT, insulinName: 'Fiasp' },
};
const sensorItem: TimelineItem = {
  id: 'r1', kind: 'glucose', timestamp: AT, title: '', detail: '', tone: 'teal',
  raw: {
    id: 'r1', glucose: 142, unit: 'mg/dL', timestamp: AT, trend: 'stable', trendSource: 'provider',
    source: 'librelinkup', origin: 'real', sourceTimestamp: AT, ingestedAt: '2026-08-27T13:05:00.000Z',
  },
};
const manualGlucoseItem: TimelineItem = {
  ...sensorItem,
  raw: { ...sensorItem.raw, id: 'r2', origin: 'manual', source: 'entrada manual' },
  id: 'r2',
};
const noteItem: TimelineItem = {
  id: 'n1', kind: 'note', timestamp: AT, title: '', detail: '', tone: 'navy',
  raw: { id: 'n1', timestamp: AT, text: 'caminata larga', source: 'manual', createdAt: AT },
};
const vitalsItem: TimelineItem = {
  id: 'v1', kind: 'vitals', timestamp: AT, title: '', detail: '', tone: 'red',
  raw: { id: 'v1', timestamp: AT, ketonesMmolL: 1.8, weightKg: 62, source: 'manual', createdAt: AT },
};
const episodeItem: TimelineItem = {
  id: 'e1', kind: 'episode', timestamp: AT, title: '', detail: '', tone: 'green',
};
const mealItem: TimelineItem = {
  id: 'm1', kind: 'meal', timestamp: meal.timestamp, title: '', detail: '', tone: 'orange', raw: meal,
};
const carbsItem: TimelineItem = {
  id: 'c1', kind: 'carbs', timestamp: AT, title: '', detail: '', tone: 'orange',
  raw: { carbsG: 25, source: 'manual' },
};
const entryItem: TimelineItem = {
  id: 'g1', kind: 'entry', timestamp: AT, title: '', detail: '', tone: 'teal',
  raw: { entryGroupId: 'g1', glucose: 110, glucoseOrigin: 'manual', rapidUnits: 3, rapidInsulinName: 'Fiasp' },
};

describe('masterTargetOf — a dónde escribe la edición de cada tipo', () => {
  it('una entrada ya agrupada se edita en su sitio', () => {
    expect(masterTargetOf(entryItem)).toEqual({ kind: 'group', entryGroupId: 'g1' });
  });

  it('una lectura suelta se adjunta sin tocar su valor', () => {
    expect(masterTargetOf(sensorItem)).toEqual({ kind: 'reading', readingId: 'r1' });
  });

  it.each([
    [insulinItem, 'insulin_events', 'i1'],
    [noteItem, 'note_events', 'n1'],
    [vitalsItem, 'vitals_events', 'v1'],
    [mealItem, 'meal_events', 'm1'],
    [carbsItem, 'carb_events', 'c1'],
  ] as const)('un evento suelto se PROMUEVE a grupo (%#)', (item, table, rowId) => {
    expect(masterTargetOf(item)).toEqual({ kind: 'promote', table, rowId });
  });

  /**
   * Un episodio es un agregado calculado: sus métricas salen del CGM, nadie
   * las tecleó. Un formulario para "corregirlas" sería inventar el dato.
   */
  it('un episodio calculado es de solo lectura', () => {
    expect(masterTargetOf(episodeItem)).toEqual({ kind: 'readonly' });
    expect(isMasterEditable(episodeItem)).toBe(false);
  });

  it('todo lo demás es editable — el botón Editar enruta al maestro', () => {
    for (const item of [entryItem, sensorItem, manualGlucoseItem, insulinItem, noteItem, vitalsItem, mealItem, carbsItem]) {
      expect(isMasterEditable(item)).toBe(true);
    }
  });
});

describe('masterSeedFrom — lo que el maestro carga, sin inventar ni perder', () => {
  it('una insulina rápida siembra sus unidades y su nombre estampado', () => {
    const seed = masterSeedFrom(insulinItem);
    expect(seed.rapidUnits).toBe(4);
    expect(seed.rapidInsulinName).toBe('Fiasp');
    expect(seed.basalUnits).toBeUndefined();
    expect(seed.timestamp).toBe(AT);
  });

  it('una insulina basal siembra el campo de basal, no el de rápida', () => {
    const basal: TimelineItem = {
      ...insulinItem,
      raw: { ...insulinItem.raw, type: 'basal', units: 20, insulinName: 'Tresiba' },
    };
    const seed = masterSeedFrom(basal);
    expect(seed.basalUnits).toBe(20);
    expect(seed.basalInsulinName).toBe('Tresiba');
    expect(seed.rapidUnits).toBeUndefined();
  });

  /**
   * El valor de una lectura externa es un registro de lo que reportó su
   * fuente. Ni el valor ni la hora se editan; lo que se le cuelgue encima, sí.
   */
  it('una lectura de sensor viene de solo lectura y con la hora fija', () => {
    const seed = masterSeedFrom(sensorItem);
    expect(seed.glucose).toBe(142);
    expect(seed.glucoseReadOnly).toBe(true);
    expect(seed.timestampEditable).toBe(false);
  });

  it('una capilar tecleada por ella sí se puede corregir, valor y hora', () => {
    const seed = masterSeedFrom(manualGlucoseItem);
    expect(seed.glucoseReadOnly).toBe(false);
    expect(seed.timestampEditable).toBe(true);
  });

  it('un evento importado conserva la hora de su fuente', () => {
    const importado: TimelineItem = {
      ...insulinItem,
      raw: { ...insulinItem.raw, source: 'imported' },
    };
    expect(masterSeedFrom(importado).timestampEditable).toBe(false);
  });

  it('los vitales siembran cetonas, peso y presión sin mezclarlos', () => {
    const seed = masterSeedFrom(vitalsItem);
    expect(seed.ketonesMmolL).toBe(1.8);
    expect(seed.weightKg).toBe(62);
    expect(seed.systolicBP).toBeUndefined();
  });

  it('una comida siembra su comida entera, no solo los gramos', () => {
    const seed = masterSeedFrom(mealItem);
    expect(seed.meal).toBe(meal);
    expect(seed.carbsG).toBe(40);
  });

  it('un campo ausente queda ausente: no se rellena con cero', () => {
    const seed = masterSeedFrom(noteItem);
    expect(seed.note).toBe('caminata larga');
    expect(seed.carbsG).toBeUndefined();
    expect(seed.proteinG).toBeUndefined();
    expect(seed.rapidUnits).toBeUndefined();
    expect(seed.ketonesMmolL).toBeUndefined();
  });

  it('un grupo anclado a un sensor no permite mover la hora', () => {
    const anclado: TimelineItem = {
      ...entryItem,
      raw: { ...entryItem.raw, glucoseOrigin: 'real' },
    };
    const seed = masterSeedFrom(anclado);
    expect(seed.glucoseReadOnly).toBe(true);
    expect(seed.timestampEditable).toBe(false);
  });
});

describe('masterSectionsFor — las secciones dependen del contenido', () => {
  it('una insulina suelta abre Insulina, y las demás quedan disponibles pero plegadas', () => {
    const open = masterSectionsFor(masterSeedFrom(insulinItem));
    expect(open.has('insulin')).toBe(true);
    expect(open.has('meal')).toBe(false);
    expect(open.has('glucose')).toBe(false);
    expect(open.has('note')).toBe(false);
  });

  /**
   * La corrección conceptual central: editar una glucosa **sin** comida abre
   * Glucosa, y la sección Comida queda plegada pero alcanzable — con todas sus
   * herramientas. Antes ahí solo había un formulario básico.
   */
  it('una glucosa sin comida abre Glucosa y NO cierra la puerta a Comida', () => {
    const open = masterSectionsFor(masterSeedFrom(sensorItem));
    expect(open.has('glucose')).toBe(true);
    expect(open.has('meal')).toBe(false);
  });

  it('un registro con comida abre Comida', () => {
    expect(masterSectionsFor(masterSeedFrom(mealItem)).has('meal')).toBe(true);
  });

  it('unos carbohidratos sueltos abren Comida: es donde viven', () => {
    expect(masterSectionsFor(masterSeedFrom(carbsItem)).has('meal')).toBe(true);
  });

  it('los vitales abren su sección', () => {
    expect(masterSectionsFor(masterSeedFrom(vitalsItem)).has('ketones')).toBe(true);
  });

  it('una entrada empaquetada abre exactamente lo que trae', () => {
    const open = masterSectionsFor(masterSeedFrom(entryItem));
    expect([...open].sort()).toEqual(['glucose', 'insulin']);
  });

  /**
   * La calculadora nunca arranca abierta: no es un dato del registro, es una
   * herramienta, y desplegarla sola sugiere que hay algo que calcular.
   */
  it('la calculadora nunca arranca abierta', () => {
    for (const item of [entryItem, sensorItem, insulinItem, mealItem, vitalsItem, noteItem, carbsItem]) {
      expect(masterSectionsFor(masterSeedFrom(item)).has('calculator')).toBe(false);
    }
  });

  it('el foco del botón NO influye en qué se abre al editar', () => {
    // Dos ítems distintos abren secciones distintas aunque el botón sea el
    // mismo: la regla es por contenido, no por origen.
    expect(masterSectionsFor(masterSeedFrom(insulinItem)))
      .not.toEqual(masterSectionsFor(masterSeedFrom(mealItem)));
  });
});

describe('la calculadora histórica', () => {
  it('el título es literal y no una plantilla', () => {
    expect(HISTORIC_CALCULATOR_TITLE).toBe('¿Se te olvidó cuánto te pinchaste?');
  });

  /**
   * El número grande de la calculadora es lo que se mira. Sin la fecha pegada
   * a él, un resultado reconstruido es indistinguible de uno calculado con la
   * glucosa de ahora.
   */
  it('la advertencia lleva la fecha y dice que NO es para inyectarse ahora', () => {
    const warning = historicCalculatorWarning('27 ago, 13:00');
    expect(warning).toContain('27 ago, 13:00');
    expect(warning).toContain('NO es una sugerencia para inyectarte ahora');
    expect(warning).toContain('IOB');
  });

  it('sin fecha conocida no inventa una', () => {
    expect(historicCalculatorWarning(null)).toContain('de ese momento');
  });
});

describe('masterTitleFor — el título nombra el registro, no el componente', () => {
  it.each([
    [insulinItem, 'Editar insulina'],
    [sensorItem, 'Editar glucosa'],
    [mealItem, 'Editar comida'],
    [noteItem, 'Editar nota'],
    [vitalsItem, 'Editar cetonas y vitales'],
    [carbsItem, 'Editar carbohidratos'],
    [entryItem, 'Editar entrada'],
  ] as const)('%# → %s', (item, expected) => {
    expect(masterTitleFor(item)).toBe(expected);
  });
});

/**
 * Dos caminos llegan a la calculadora con una glucosa que no es de ahora, y la
 * primera versión de este trabajo solo cubrió uno: la advertencia histórica
 * estaba condicionada a modo edición, así que el "+" contextual de Nutrición
 * —que crea con una fecha heredada— mostraba "Calculadora de dosis",
 * "Calcular dosis sugerida" y un resultado en unidades sin decir de cuándo era.
 */
describe('isHistoricCalculation — la advertencia cubre TODOS los caminos', () => {
  it('editar un registro es histórico', () => {
    expect(isHistoricCalculation({ editing: true, hasPresetDay: false })).toBe(true);
  });

  it('crear con una fecha heredada del calendario TAMBIÉN es histórico', () => {
    expect(isHistoricCalculation({ editing: false, hasPresetDay: true })).toBe(true);
  });

  it('crear ahora, sin fecha heredada, no lo es', () => {
    expect(isHistoricCalculation({ editing: false, hasPresetDay: false })).toBe(false);
  });

  it('no hay combinación con fecha vieja que se escape', () => {
    const combos = [
      { editing: true, hasPresetDay: true },
      { editing: true, hasPresetDay: false },
      { editing: false, hasPresetDay: true },
    ];
    for (const combo of combos) expect(isHistoricCalculation(combo)).toBe(true);
  });
});
