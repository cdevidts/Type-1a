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

describe('insulina activa (IOB) en la salida — agregado tras la revisión de la Fase 23', () => {
  // El prompt v3+ le pasa al modelo la lista de dosis de la ventana con sus
  // unidades y minutos. Con eso puede afirmar superposición sin recomendar
  // nada: "la segunda dosis se solapó con la primera, que todavía estaba
  // activa" es una descripción, y también es una estimación de insulina
  // activa — que `AGENTS.md` prohíbe en el MVP. Al crecer lo que el modelo
  // puede decir, crece el filtro.
  const iobClaims = [
    'La segunda dosis se solapó con la primera, que todavía estaba activa.',
    'Parte de la subida se explica porque aún había insulina activa.',
    'El bolo de las 13:00 seguía haciendo efecto a las 15:00.',
    'La dosis se quedó corta para la carga de la comida.',
    'Hizo falta más insulina para cubrir ese plato.',
    'La próxima vez conviene adelantar el bolo.',
  ];

  for (const claim of iobClaims) {
    it(`rechaza: "${claim}"`, () => {
      expect(containsTherapyRecommendation(claim)).toBe(true);
    });
  }

  // Contracara: describir lo que se registró, sin evaluarlo ni estimar
  // actividad residual, es exactamente lo que el insight SÍ debe poder decir.
  const descriptive = [
    'Se registró una dosis rápida de 2 U a las 2 horas.',
    'Se registraron 20 g de carbohidratos a los 90 minutos.',
    'La glucosa subió 62 mg/dL entre la comida y las 3 horas.',
    'Faltan lecturas entre las 2 y las 3 horas, así que el pico puede ser mayor.',
    'La próxima vez que haya más lecturas disponibles se podrá describir mejor el tramo.',
  ];

  for (const text of descriptive) {
    it(`deja pasar: "${text}"`, () => {
      expect(containsTherapyRecommendation(text)).toBe(false);
    });
  }
});
