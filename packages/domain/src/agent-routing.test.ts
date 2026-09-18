import { describe, expect, it } from 'vitest';

import { calculatorOpensOnItsOwn, insulinQuestionOpensCalculator } from './agent-routing';
import { requestsInsulinAdvice } from './ai-safety';

/**
 * Las frases de las capturas que mandó Verónica, más las de la revisión de
 * seguridad. Cada una está acá porque falló de verdad en el teléfono, no
 * porque se me ocurrió.
 */
const ABRE_CORRECCION = [
  'Quiero corregirme',
  'Quiero corregirme, dime cuánto.',
  'Me quiero corregir dime cuanto',
  'Quiero hacerme una corregida',
  'Quiero hacerme una corregida?',
  'quiero hacerme una correccion',
  'me pincho?',
  '¿cuánto me pongo?',
  'cuanto me pincho',
  'ayúdame con la dosis',
  'calcula mi dosis',
  '¿debo ponerme insulina?',
  'me toca corregir',
  'how many units should I take',
];

const NO_ABRE = [
  'Que onda',
  '?',
  'hola',
  'me puse 6 de rápida',
  'me puse 18 de basal y 5 de rápida',
  'estoy en 180',
  'tomé dos vasos de agua',
  'comí un plato de tallarines',
  '¿cómo estuve ayer?',
  'cuántos carbohidratos comí hoy',
  '¿cuántas horas dura mi insulina basal?',
  '¿qué pasa si me salto la basal?',
  '¿cuántos días dura una pluma?',
];

describe('insulinQuestionOpensCalculator', () => {
  it('abre la corrección en todas las formas en que ella lo pide', () => {
    for (const frase of ABRE_CORRECCION) {
      expect(insulinQuestionOpensCalculator(frase), frase).toBe('correction');
    }
  });

  it('no mueve la pantalla por nada que no sea pedir una dosis', () => {
    for (const frase of NO_ABRE) {
      expect(insulinQuestionOpensCalculator(frase), frase).toBeNull();
    }
  });

  it('abre la de comida cuando la pregunta es por lo que va a comer', () => {
    expect(insulinQuestionOpensCalculator('cuánta insulina para un plato de tallarines')).toBe('meal');
    expect(insulinQuestionOpensCalculator('cuánto bolo para 60 g de carbohidratos')).toBe('meal');
  });

  it('funciona sin tildes y en minúsculas, como se escribe con apuro', () => {
    expect(insulinQuestionOpensCalculator('QUIERO CORREGIRME')).toBe('correction');
    expect(insulinQuestionOpensCalculator('cuanta insulina me pongo')).toBe('correction');
  });
});

describe('el guardia del servidor ve lo mismo', () => {
  it('rechaza todo lo que abre una calculadora', () => {
    // La invariante: si el teléfono decide llevarla a una calculadora de dosis,
    // el servidor tiene que considerar esa frase una petición de insulina. Si
    // divergieran, habría preguntas que navegan sin que nadie las rechace.
    for (const frase of ABRE_CORRECCION) {
      expect(requestsInsulinAdvice(frase), frase).toBe(true);
    }
  });
});

describe('calculatorOpensOnItsOwn — cuándo se mueve la pantalla sola', () => {
  it('se abre sola cuando el mensaje es solo eso', () => {
    for (const frase of ['Quiero corregirme', 'me pincho?', 'cuánto me pongo']) {
      expect(calculatorOpensOnItsOwn(frase), frase).toBe(true);
    }
  });

  it('NO se abre sola si el mensaje trae algo más', () => {
    // La queja de ella: "te abre un modal aunque no sea lo que quieres".
    for (const frase of [
      '¿cómo me fue con las correcciones esta semana?',
      'quiero corregirme pero antes dime cómo estuve ayer y qué comí',
      '¿me pincho? ¿o espero a comer?',
    ]) {
      expect(calculatorOpensOnItsOwn(frase), frase).toBe(false);
    }
  });

  it('una pregunta sobre correcciones pasadas no rutea a ninguna parte', () => {
    expect(insulinQuestionOpensCalculator('¿cómo me fue con las correcciones esta semana?')).toBeNull();
    expect(insulinQuestionOpensCalculator('cuántas correcciones me puse ayer')).toBeNull();
  });
});
