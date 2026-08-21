import { describe, expect, it } from 'vitest';

import { containsTherapyRecommendation, requestsInsulinAdvice } from '../src/ai-safety';

describe('containsTherapyRecommendation', () => {
  it('rechaza una salida que recomienda dosis', () => {
    expect(containsTherapyRecommendation('Deberías ponerte más insulina.')).toBe(true);
    expect(containsTherapyRecommendation('Ajusta tu ratio de carbohidratos.')).toBe(true);
    expect(containsTherapyRecommendation({ summary: 'Ponte 2 unidades más.' })).toBe(true);
  });

  it('deja pasar una descripción de lo que pasó', () => {
    expect(containsTherapyRecommendation('La glucosa subió a 210 mg/dL a los 60 minutos.')).toBe(false);
    expect(containsTherapyRecommendation({ foods: [{ name: 'Pan integral', carbsG: 24 }] })).toBe(false);
  });
});

describe('requestsInsulinAdvice', () => {
  it('rechaza una instrucción de edición que pide calcular insulina', () => {
    // El caso que motiva la función: son preguntas, no recomendaciones, así
    // que el filtro de salida no las ve.
    expect(requestsInsulinAdvice('¿cuánta insulina me pongo con esto?')).toBe(true);
    expect(requestsInsulinAdvice('cuántas unidades necesito')).toBe(true);
    expect(requestsInsulinAdvice('calcula el bolo para esta comida')).toBe(true);
    expect(requestsInsulinAdvice('sugiéreme una corrección')).toBe(true);
    expect(requestsInsulinAdvice('qué dosis corresponde')).toBe(true);
    expect(requestsInsulinAdvice('¿cuánto me pongo?')).toBe(true);
    expect(requestsInsulinAdvice('debo ponerme algo antes de comer?')).toBe(true);
    expect(requestsInsulinAdvice('how much insulin should I take')).toBe(true);
  });

  it('deja pasar una edición legítima de la comida', () => {
    expect(requestsInsulinAdvice('agrégale una cucharada de aceite')).toBe(false);
    expect(requestsInsulinAdvice('en realidad fue media porción')).toBe(false);
    expect(requestsInsulinAdvice('esto era pan integral, no blanco')).toBe(false);
    expect(requestsInsulinAdvice('sácale el arroz y déjale solo el pollo')).toBe(false);
    expect(requestsInsulinAdvice('eran dos huevos, no uno')).toBe(false);
  });

  it('no confunde una nota emocional con una pregunta de dosis', () => {
    // "me pongo" suelto no alcanza: aparece en notas legítimas, y rechazar
    // esta edición sería un falso positivo que la usuaria no entendería.
    expect(requestsInsulinAdvice('me pongo nerviosa antes de comer, agrégalo a la nota')).toBe(false);
  });
});
