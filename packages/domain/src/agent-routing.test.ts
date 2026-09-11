import { describe, expect, it } from 'vitest';

import { insulinQuestionOpensCalculator } from './agent-routing';
import { requestsInsulinAdvice } from './ai-safety';

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

describe('insulinQuestionOpensCalculator — lo que NO debe mover la pantalla', () => {
  it('no navega por preguntas informativas sobre insulina', () => {
    // Los tres casos que encontró la revisión de seguridad. `requestsInsulinAdvice`
    // los detecta y el backend los rechaza con palabras, que es lo correcto;
    // lo que no corresponde es dejarla en una calculadora de dosis que no pidió.
    for (const frase of [
      '¿qué pasa si me salto la basal?',
      'no sé qué pasó con la dosis de ayer',
      '¿cuántas horas dura mi insulina basal?',
      '¿cuántos días dura una pluma?',
      '¿qué insulina estoy usando?',
    ]) {
      expect(insulinQuestionOpensCalculator(frase), frase).toBeNull();
    }
  });

  it('sigue navegando cuando de verdad pregunta cuánto ponerse', () => {
    for (const frase of [
      'me quiero corregir, cuánto me pincho',
      '¿cuántas unidades me pongo?',
      'calcula mi dosis',
      'how many units should I take',
    ]) {
      expect(insulinQuestionOpensCalculator(frase), frase).not.toBeNull();
    }
  });
});

describe('las frases que ella escribió en el teléfono (2026-09-11)', () => {
  it('abre la calculadora, que es lo que no pasaba', () => {
    // Captura de pantalla: el asistente se negó con palabras, ofreció "puedo
    // abrirla" y después dijo "no puedo abrir pantallas". Ninguna de las dos
    // caía en `requestsInsulinAdvice`, así que ni siquiera llegaba acá.
    expect(insulinQuestionOpensCalculator('Quiero corregirme, dime cuánto.')).toBe('correction');
    expect(insulinQuestionOpensCalculator('Me quiero corregir dime cuanto')).toBe('correction');
  });

  it('el guardia del servidor también las ve ahora', () => {
    // Lo grave no era la comodidad: la pregunta llegaba al modelo. El guardia
    // existe para no depender de que el modelo se porte bien.
    expect(requestsInsulinAdvice('Quiero corregirme, dime cuánto.')).toBe(true);
    expect(requestsInsulinAdvice('Me quiero corregir dime cuanto')).toBe(true);
  });
});
