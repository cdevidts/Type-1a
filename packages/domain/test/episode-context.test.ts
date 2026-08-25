import type { ActivityEvent, CarbEvent, InsulinEvent, MealEvent, NoteEvent } from '@type1a/schemas';
import { describe, expect, it } from 'vitest';

import {
  collectEpisodeContext,
  EPISODE_GRACE_MINUTES,
  hasConfoundingEvent,
} from '../src/episode-context';

const MEAL_AT = '2026-08-22T12:00:00.000Z';
const mealMs = Date.parse(MEAL_AT);

function at(minutesAfter: number): string {
  return new Date(mealMs + minutesAfter * 60_000).toISOString();
}

function insulin(overrides: Partial<InsulinEvent> & { id: string; timestamp: string }): InsulinEvent {
  return {
    type: 'rapid',
    units: 4,
    source: 'manual',
    createdAt: overrides.timestamp,
    ...overrides,
  };
}

function carbs(id: string, timestamp: string, carbsG = 15): CarbEvent {
  return { id, timestamp, carbsG, source: 'manual', createdAt: timestamp };
}

function meal(id: string, timestamp: string): MealEvent {
  return { id, timestamp, confirmedCarbsG: 40, createdAt: timestamp };
}

function activity(id: string, timestamp: string): ActivityEvent {
  return { id, timestamp, durationMinutes: 30, source: 'manual', createdAt: timestamp };
}

function note(id: string, timestamp: string, text: string): NoteEvent {
  return { id, timestamp, text, source: 'manual', createdAt: timestamp };
}

describe('collectEpisodeContext', () => {
  it('captura lo que pasó dentro de la ventana, ordenado y con su distancia', () => {
    const events = collectEpisodeContext({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      insulin: [insulin({ id: 'i1', timestamp: at(90) })],
      carbs: [carbs('c1', at(120))],
    });

    expect(events.map((event) => [event.kind, event.minutesAfterAnchor])).toEqual([
      ['rapid_insulin', 90],
      ['carbs', 120],
    ]);
    expect(events[0]?.amount).toBe(4);
  });

  it('no cuenta como evento aparte lo que se registró junto con la comida', () => {
    // Al guardar una comida se escriben varias filas casi simultáneas (el
    // CarbEvent espejo, el bolo, a veces una nota). Sin la gracia, toda
    // comida sería su propio confusor y ningún episodio sería limpio jamás.
    const events = collectEpisodeContext({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      carbs: [carbs('espejo', MEAL_AT, 40)],
      insulin: [insulin({ id: 'bolo', timestamp: at(EPISODE_GRACE_MINUTES - 1) })],
    });

    expect(events).toEqual([]);
  });

  it('excluye lo que cae fuera de la ventana', () => {
    const events = collectEpisodeContext({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      carbs: [carbs('dentro', at(179)), carbs('fuera', at(181))],
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.minutesAfterAnchor).toBe(179);
  });

  it('ignora las filas que el episodio ya reconoce como suyas', () => {
    const events = collectEpisodeContext({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      insulin: [insulin({ id: 'bolo-de-esta-comida', timestamp: at(40) })],
      ignoreIds: ['bolo-de-esta-comida'],
    });

    expect(events).toEqual([]);
  });

  it('nunca copia el texto de una nota', () => {
    // El objeto viaja al servicio de IA dentro de MealEpisodeMetrics. El texto
    // libre de una nota es dato personal que AGENTS.md manda no mandar afuera,
    // y la garantía es que el tipo no tiene dónde ponerlo.
    const events = collectEpisodeContext({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      notes: [note('n1', at(60), 'me sentí mal, discutí con mi jefe')],
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('note');
    expect(JSON.stringify(events)).not.toContain('jefe');
  });
});

describe('hasConfoundingEvent', () => {
  it('una corrección dentro de la ventana confunde el episodio', () => {
    expect(hasConfoundingEvent({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      insulin: [insulin({ id: 'correccion', timestamp: at(90) })],
    })).toBe(true);
  });

  it('una colación y una caminata también confunden', () => {
    expect(hasConfoundingEvent({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 300,
      carbs: [carbs('colacion', at(120))],
    })).toBe(true);
    expect(hasConfoundingEvent({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 300,
      activity: [activity('caminata', at(150))],
    })).toBe(true);
    expect(hasConfoundingEvent({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 300,
      meals: [meal('otra-comida', at(200))],
    })).toBe(true);
  });

  it('una nota NO confunde: es texto, no mueve la glucosa', () => {
    // Excluir episodios por haber escrito una nota tiraría datos buenos.
    expect(hasConfoundingEvent({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      notes: [note('n1', at(60), 'cansada')],
    })).toBe(false);
  });

  it('un episodio sin nada en el medio queda limpio', () => {
    expect(hasConfoundingEvent({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      insulin: [insulin({ id: 'anterior', timestamp: at(-120) })],
      carbs: [carbs('posterior', at(400))],
    })).toBe(false);
  });

  it('la ventana es por horizonte: lo tardío no invalida lo temprano', () => {
    // Una colación a las 4 h no puede invalidar lo que se midió a las 2 h.
    const conColacionTardia = {
      anchorTimestamp: MEAL_AT,
      carbs: [carbs('colacion', at(240))],
    };
    expect(hasConfoundingEvent({ ...conColacionTardia, windowMinutes: 120 })).toBe(false);
    expect(hasConfoundingEvent({ ...conColacionTardia, windowMinutes: 300 })).toBe(true);
  });

  it('un ancla con timestamp inválido no rompe: no confunde nada', () => {
    expect(hasConfoundingEvent({
      anchorTimestamp: 'no-es-una-fecha',
      windowMinutes: 180,
      carbs: [carbs('c1', at(60))],
    })).toBe(false);
  });
});

describe('gracia por clase (corrección de la revisión de seguridad, 2026-08-22)', () => {
  it('la gracia larga NO tapa una dosis: es solo para comida y carbohidratos', () => {
    // El bug: con una gracia única de 60 min, una corrección real a los 45
    // min quedaba tratada como "parte del acto" y no confundía nada.
    expect(hasConfoundingEvent({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      mealGraceMinutes: 60,
      insulin: [insulin({ id: 'correccion', timestamp: at(45) })],
    })).toBe(true);
  });

  it('la gracia larga sí tapa la comida de esa dosis', () => {
    // El otro lado: pre-bolear y registrar la comida 45 min después es
    // normal, y no puede marcar la dosis como confundida.
    expect(hasConfoundingEvent({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      mealGraceMinutes: 60,
      meals: [meal('su-comida', at(45))],
      carbs: [carbs('sus-carbos', at(45), 40)],
    })).toBe(false);
  });

  it('con gracia larga, el horizonte de 1 h sigue pudiendo excluir', () => {
    // Antes, grace === window dejaba el intervalo vacío por construcción y
    // la hora 1 nunca podía marcarse confundida.
    expect(hasConfoundingEvent({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 60,
      mealGraceMinutes: 60,
      activity: [activity('caminata', at(30))],
    })).toBe(true);
  });

  it('la actividad tampoco recibe la gracia larga', () => {
    expect(hasConfoundingEvent({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      mealGraceMinutes: 60,
      activity: [activity('caminata', at(50))],
    })).toBe(true);
  });
});

describe('la fila espejo de una comida no se cuenta dos veces', () => {
  it('un CarbEvent al mismo timestamp que una comida se omite', () => {
    // `writeMealWithEpisode` escribe el MealEvent y un CarbEvent espejo con
    // el mismo timestamp. Contar los dos mostraba "Otra comida 30 g" y
    // "Carbohidratos 30 g" para un solo plato, y le mandaba 60 g al modelo.
    const events = collectEpisodeContext({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 300,
      meals: [meal('colacion', at(120))],
      carbs: [carbs('espejo-de-colacion', at(120), 30)],
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('meal');
  });

  it('unos carbohidratos sueltos a otra hora sí entran', () => {
    const events = collectEpisodeContext({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 300,
      meals: [meal('colacion', at(120))],
      carbs: [carbs('aparte', at(200), 15)],
    });

    expect(events.map((event) => event.kind)).toEqual(['meal', 'carbs']);
  });
});

describe('lookbackMinutes — dosis anterior que sigue actuando (2026-08-25)', () => {
  it('sin lookback, una dosis anterior no confunde (comportamiento previo)', () => {
    expect(hasConfoundingEvent({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      insulin: [insulin({ id: 'anterior', timestamp: at(-45) })],
    })).toBe(false);
  });

  it('con lookback, una dosis dentro de su duración sí confunde', () => {
    expect(hasConfoundingEvent({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      lookbackMinutes: 300,
      insulin: [insulin({ id: 'anterior', timestamp: at(-45) })],
    })).toBe(true);
  });

  it('una dosis más vieja que la duración de la insulina ya no confunde', () => {
    expect(hasConfoundingEvent({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      lookbackMinutes: 300,
      insulin: [insulin({ id: 'vieja', timestamp: at(-360) })],
    })).toBe(false);
  });

  it('el lookback NO aplica a comida ni actividad: no hay ficha técnica equivalente', () => {
    expect(hasConfoundingEvent({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      lookbackMinutes: 300,
      carbs: [carbs('antes', at(-60))],
      meals: [meal('antes', at(-90))],
      activity: [activity('antes', at(-30))],
    })).toBe(false);
  });

  it('el bolo propio, aunque sea anterior, sigue ignorándose por id', () => {
    // Pre-bolear 20 min antes es normal: si el lookback lo contara, toda
    // comida bien pre-boleada quedaría confundida.
    expect(hasConfoundingEvent({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      lookbackMinutes: 300,
      insulin: [insulin({ id: 'su-bolo', timestamp: at(-20) })],
      ignoreIds: ['su-bolo'],
    })).toBe(false);
  });

  it('una dosis anterior aparece en el contexto descriptivo con minutos negativos', () => {
    const events = collectEpisodeContext({
      anchorTimestamp: MEAL_AT,
      windowMinutes: 180,
      lookbackMinutes: 300,
      insulin: [insulin({ id: 'anterior', timestamp: at(-45) })],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.minutesAfterAnchor).toBe(-45);
  });
});
