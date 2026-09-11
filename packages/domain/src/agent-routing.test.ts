import { describe, expect, it } from 'vitest';

import { insulinQuestionOpensCalculator } from './agent-routing';

describe('insulinQuestionOpensCalculator', () => {
  it('abre la corrección con la frase exacta que ella reportó', () => {
    expect(insulinQuestionOpensCalculator('me quiero corregir, cuánto me pincho')).toBe('correction');
  });

  it('reconoce las otras formas de preguntar por una corrección', () => {
    for (const frase of [
      '¿cuántas unidades me pongo?',
      'cuanto me pongo',
      'dime cuánta insulina necesito',
      '¿debo ponerme insulina?',
      'calcula mi dosis',
      'how many units should I take',
    ]) {
      expect(insulinQuestionOpensCalculator(frase), frase).toBe('correction');
    }
  });

  it('abre la comida cuando la pregunta es por lo que va a comer', () => {
    for (const frase of [
      '¿cuánta insulina me pongo para esta comida?',
      'cuántas unidades para un plato de tallarines',
      'cuánto bolo para 60 gramos de carbohidratos',
    ]) {
      expect(insulinQuestionOpensCalculator(frase), frase).toBe('meal');
    }
  });

  it('NO abre nada cuando ella está registrando, no preguntando', () => {
    // El caso que más daño haría: "me puse 6 de rápida" es un registro y lo
    // entiende `local-intent`. Abrir una calculadora encima sería perderle el
    // dato y hacerle repetir el gesto.
    for (const frase of [
      'me puse 6 de rápida',
      'me puse 18 de basal y 5 de rápida',
      'comí un plato de tallarines',
      'estoy en 180',
      'tomé dos vasos de agua',
    ]) {
      expect(insulinQuestionOpensCalculator(frase), frase).toBeNull();
    }
  });

  it('NO abre nada con una pregunta que no es de dosis', () => {
    for (const frase of [
      '¿cómo estuve ayer?',
      'cuántos carbohidratos comí hoy',
      'me pongo nervioso antes de comer',
    ]) {
      expect(insulinQuestionOpensCalculator(frase), frase).toBeNull();
    }
  });

  it('ante la duda prefiere la corrección', () => {
    // Se puede agregar la comida desde el maestro; al revés obliga a cerrar y
    // empezar de nuevo.
    expect(insulinQuestionOpensCalculator('cuánto me pincho ahora')).toBe('correction');
  });
});
