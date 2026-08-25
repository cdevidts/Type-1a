import { containsTherapyRecommendation } from '@type1a/domain';
import { describe, expect, it } from 'vitest';

import { GLUCOSE_INSIGHT_PROMPT_VERSION, glucoseInsightSystemPrompt } from '../src/prompts';

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

  it('la versión se movió al cambiar las reglas de seguridad', () => {
    // La versión viaja con cada respuesta guardada: si el texto cambia y la
    // versión no, no hay forma de saber después bajo qué reglas se generó un
    // insight ya almacenado.
    expect(GLUCOSE_INSIGHT_PROMPT_VERSION).toBe('glucose-insight.v4');
  });
});
