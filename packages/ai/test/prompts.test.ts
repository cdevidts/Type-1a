import { containsTherapyRecommendation } from '@type1a/domain';
import { describe, expect, it } from 'vitest';

import {
  GLUCOSE_INSIGHT_PROMPT_VERSION,
  MEAL_EDIT_PROMPT_VERSION,
  MEAL_TEXT_PROMPT_VERSION,
  MEAL_VISION_PROMPT_VERSION,
  glucoseInsightSystemPrompt,
  mealEditSystemPrompt,
  mealTextSystemPrompt,
  mealVisionSystemPrompt,
} from '../src/prompts';

/**
 * El prompt del insight es superficie de seguridad, no copy. Estos tests
 * fijan las prohibiciones que `AGENTS.md` exige y que la revisión de la
 * Fase 23 encontró incompletas: describir eventos está permitido, evaluarlos
 * o estimar insulina activa no.
 */
describe('glucoseInsightSystemPrompt', () => {
  it('prohíbe explícitamente recomendar terapia', () => {
    expect(glucoseInsightSystemPrompt).toMatch(/Never recommend insulin, dose changes/i);
  });

  it('prohíbe evaluar los eventos de contexto', () => {
    expect(glucoseInsightSystemPrompt).toMatch(/Never judge whether any of those events was appropriate/i);
  });

  it('prohíbe afirmar insulina activa o superposición de dosis', () => {
    // Agregado tras la revisión de seguridad del 2026-08-22: con la lista de
    // dosis de la ventana, el modelo puede afirmar solapamiento sin
    // recomendar nada — y eso es una estimación de IOB, prohibida en el MVP.
    expect(glucoseInsightSystemPrompt).toMatch(/still acting, still active, wearing off, accumulating, stacking, or overlapping/i);
    expect(glucoseInsightSystemPrompt).toMatch(/insulin-on-board estimate/i);
  });

  it('prohíbe inferir que una dosis rápida fue una corrección', () => {
    // El esquema solo conoce `rapid_insulin`; la intención de corrección es
    // una marca aparte que el modelo no recibe.
    expect(glucoseInsightSystemPrompt).toMatch(/not "una correcci[oó]n"/i);
  });

  it('aclara que la ausencia de contexto no significa que no pasó nada', () => {
    expect(glucoseInsightSystemPrompt).toMatch(/that means nothing was captured, not that nothing happened/i);
  });

  it('el propio prompt no dispara el filtro de salida', () => {
    // Si el texto de las prohibiciones matcheara los patrones, cualquier eco
    // del prompt en la respuesta suprimiría insights legítimos.
    expect(containsTherapyRecommendation(glucoseInsightSystemPrompt)).toBe(false);
  });

  it('declara que minutesAfterAnchor puede ser negativo', () => {
    // Desde el 2026-08-25 una dosis ANTERIOR al ancla entra al contexto. El
    // prompt decía "minutos después"; un modelo que lea -45 bajo ese contrato
    // describe una dosis pre-comida como post-comida, que invierte la lectura
    // clínica del episodio.
    expect(glucoseInsightSystemPrompt).toMatch(/negative for before it/i);
  });

  it('prohíbe convertir la hora a otra zona', () => {
    // El resumen decía "el episodio empezó a las 21:30" para una comida de
    // las 17:30: recibía UTC y lo citaba tal cual. Ahora las marcas viajan
    // con desfase local explícito (`localizeEpisodeMetrics`), y esta regla es
    // la mitad del arreglo que vive en el prompt.
    expect(glucoseInsightSystemPrompt).toMatch(/explicit UTC offset/i);
    expect(glucoseInsightSystemPrompt).toMatch(/Never convert a timestamp to UTC/i);
  });

  it('prohíbe juzgar o aconsejar sobre la hora de comer', () => {
    // La hora local le da al modelo, por primera vez, material para juzgar un
    // hábito: en UTC no significaba nada. La prohibición viaja en el mismo
    // cambio que la hora local, y `containsTherapyRecommendation` la respalda
    // en estructura — al crecer lo que el modelo puede decir, crece el filtro.
    expect(glucoseInsightSystemPrompt).toMatch(/too late or too early/i);
    expect(glucoseInsightSystemPrompt).toMatch(/not a habit to correct/i);
  });

  it('la versión se movió al cambiar las reglas de seguridad', () => {
    // La versión viaja con cada respuesta guardada: si el texto cambia y la
    // versión no, no hay forma de saber después bajo qué reglas se generó un
    // insight ya almacenado.
    expect(GLUCOSE_INSIGHT_PROMPT_VERSION).toBe('glucose-insight.v6');
  });
});

describe('nombres conocidos del catálogo (2026-09-02)', () => {
  it('los tres prompts de comida piden reusar el nombre EXACTO solo si es el mismo alimento', () => {
    // La mitad del arreglo de los duplicados vive acá; la otra mitad es que
    // el cliente mande los nombres. Un prompt que reuse de más mezcla macros
    // de dos alimentos, así que la regla lleva su propio freno escrito.
    for (const prompt of [mealVisionSystemPrompt, mealTextSystemPrompt, mealEditSystemPrompt]) {
      expect(prompt).toMatch(/return its name EXACTLY as listed/i);
      expect(prompt).toMatch(/a different cut, preparation, variety or brand is a different food/i);
    }
  });

  it('las versiones de los tres se movieron con la regla', () => {
    expect(MEAL_VISION_PROMPT_VERSION).toBe('meal-analysis.v4');
    expect(MEAL_TEXT_PROMPT_VERSION).toBe('meal-analysis-text.v4');
    expect(MEAL_EDIT_PROMPT_VERSION).toBe('meal-analysis-edit.v4');
  });
});

describe('el agua es agua, y solo agua (2026-09-03)', () => {
  /**
   * La regla que no se puede aflojar: un jugo tiene carbohidratos y necesita
   * su dosis. Si el modelo lo manda a `waterMl` en vez de a `foods`, esos
   * carbohidratos desaparecen del registro y de la dosis propuesta. Por eso
   * el prompt enumera las bebidas que NO son agua en vez de decir "solo agua"
   * y confiar en que se entienda.
   */
  const prompts = [
    ['visión', mealVisionSystemPrompt],
    ['texto', mealTextSystemPrompt],
    ['edición', mealEditSystemPrompt],
  ] as const;

  it.each(prompts)('el prompt de %s manda el agua a waterMl y no a foods', (_name, prompt) => {
    expect(prompt).toContain('waterMl');
    expect(prompt).toContain('Only plain water counts');
    expect(prompt).toContain('never in waterMl');
  });

  it.each(prompts)('el prompt de %s nombra las bebidas que NO son agua', (_name, prompt) => {
    for (const drink of ['juice', 'soft drink', 'milk', 'coffee with milk', 'soup']) {
      expect(prompt).toContain(drink);
    }
  });

  it.each(prompts)('el prompt de %s prohíbe inventar un volumen', (_name, prompt) => {
    expect(prompt).toContain('return null');
    expect(prompt).toContain('Never guess a round volume');
  });
});
