import { describe, expect, it } from 'vitest';

import { resolveMacrosSource } from '../src/macros-source';

/**
 * La verdad de cada caso está escrita a mano desde la regla, no derivada de la
 * implementación. `systemPatterns.md`, Regla 1: un test que confirma lo que el
 * código devuelve hoy no prueba nada — y estos cuatro casos son exactamente los
 * que fallaron en producción, uno por cada copia divergente de esta lógica.
 */
describe('resolveMacrosSource', () => {
  describe('sin macros no hay procedencia', () => {
    it('nada escrito y sin análisis es "no anotado", no "cero"', () => {
      expect(resolveMacrosSource({ entered: {} })).toBeUndefined();
    });

    it('un análisis que no propuso ningún macro tampoco inventa procedencia', () => {
      expect(resolveMacrosSource({ entered: {}, aiProposed: {} })).toBeUndefined();
    });

    it('0 g es un dato anotado, no una ausencia', () => {
      expect(resolveMacrosSource({ entered: { proteinG: 0 } })).toBe('user');
    });
  });

  describe('captura nueva sin IA', () => {
    it('lo que escribe ella sin análisis de por medio es suyo', () => {
      expect(resolveMacrosSource({ entered: { proteinG: 45, fatG: 30 } })).toBe('user');
    });
  });

  describe('captura nueva con IA', () => {
    const aiProposed = { proteinG: 38, fatG: 30, fiberG: 4 };

    /**
     * **El bug que este refactor cierra.** Los campos se prellenan con lo que
     * estimó la IA, así que "el campo tiene valor" ya no significa "ella lo
     * escribió". Comparar contra `undefined` etiquetaba `'mixed'` una comida
     * analizada que nunca tocó.
     */
    it('lo que la IA propuso y ella no tocó es de la IA, no mezcla', () => {
      expect(resolveMacrosSource({ entered: { ...aiProposed }, aiProposed })).toBe('ai');
    });

    it('corregir un solo valor la vuelve mezcla', () => {
      expect(resolveMacrosSource({ entered: { ...aiProposed, proteinG: 45 }, aiProposed })).toBe('mixed');
    });

    /**
     * Borrar lo que la IA precargó es decir "no lo sé", no "usa el de la IA".
     * Sin esto, el análisis se volvía a escribir y encima quedaba rotulado
     * como revisado por ella.
     */
    it('vaciar un macro precargado cuenta como intervención suya', () => {
      expect(resolveMacrosSource({ entered: { ...aiProposed, fatG: undefined }, aiProposed })).toBe('mixed');
      expect(resolveMacrosSource({ entered: { ...aiProposed, fatG: null }, aiProposed })).toBe('mixed');
    });

    it('no exige valores que la IA nunca propuso', () => {
      // La IA propuso tres macros; que las calorías queden en blanco no es una
      // corrección suya.
      expect(resolveMacrosSource({ entered: { ...aiProposed }, aiProposed })).toBe('ai');
    });

    it('agregar un macro que la IA no propuso sí es intervención suya', () => {
      expect(resolveMacrosSource({
        entered: { ...aiProposed, caloriesKcal: 520 },
        aiProposed: { proteinG: 38, fatG: 30, fiberG: 4, caloriesKcal: 500 },
      })).toBe('mixed');
    });
  });

  describe('editando una comida que ya existía', () => {
    /**
     * **La dirección peligrosa.** Una comida vieja de procedencia desconocida,
     * con UN macro editado, quedaba etiquetada como si ella hubiera escrito
     * los tres. `MealEventSchema` lo prohíbe: ausente significa "procedencia
     * desconocida" y nunca se asume "confirmado por la usuaria".
     */
    it('desconocido NO pasa a "user" al editarse', () => {
      expect(resolveMacrosSource({
        entered: { proteinG: 45, fatG: 30 },
        previous: { values: { proteinG: 38, fatG: 30 }, source: undefined },
      })).toBeUndefined();
    });

    it('lo que era de ella sigue siendo de ella tras corregirlo', () => {
      expect(resolveMacrosSource({
        entered: { proteinG: 45, fatG: 30 },
        previous: { values: { proteinG: 38, fatG: 30 }, source: 'user' },
      })).toBe('user');
    });

    it('corregir a mano lo que puso la IA lo vuelve mezcla', () => {
      expect(resolveMacrosSource({
        entered: { proteinG: 45, fatG: 30 },
        previous: { values: { proteinG: 38, fatG: 30 }, source: 'ai' },
      })).toBe('mixed');
    });

    it('una mezcla corregida sigue siendo mezcla', () => {
      expect(resolveMacrosSource({
        entered: { proteinG: 45 },
        previous: { values: { proteinG: 38 }, source: 'mixed' },
      })).toBe('mixed');
    });

    it('guardar sin cambiar nada conserva la procedencia exacta', () => {
      for (const source of ['ai', 'user', 'mixed', undefined] as const) {
        expect(resolveMacrosSource({
          entered: { proteinG: 38, fatG: 30 },
          previous: { values: { proteinG: 38, fatG: 30 }, source },
        })).toBe(source);
      }
    });

    it('agregar macros a una comida que no tenía ninguno es de ella', () => {
      expect(resolveMacrosSource({
        entered: { proteinG: 45 },
        previous: { values: {}, source: undefined },
      })).toBe('user');
    });

    it('vaciar todos los macros devuelve la procedencia a "no anotado"', () => {
      expect(resolveMacrosSource({
        entered: {},
        previous: { values: { proteinG: 38 }, source: 'user' },
      })).toBeUndefined();
    });

    /**
     * Un re-análisis sobre una comida existente manda sobre lo que hubiera
     * antes: la referencia pasa a ser lo que la IA acaba de proponer.
     */
    it('un análisis nuevo sobre una comida vieja manda sobre su procedencia', () => {
      const aiProposed = { proteinG: 38, fatG: 30 };
      expect(resolveMacrosSource({
        entered: { ...aiProposed },
        aiProposed,
        previous: { values: { proteinG: 12 }, source: 'user' },
      })).toBe('ai');
    });
  });

  describe('null y undefined son el mismo "no hay"', () => {
    it('da igual cuál use el formulario', () => {
      expect(resolveMacrosSource({ entered: { proteinG: null, fatG: undefined } })).toBeUndefined();
      expect(resolveMacrosSource({
        entered: { proteinG: 38, fatG: null },
        previous: { values: { proteinG: 38, fatG: undefined }, source: 'user' },
      })).toBe('user');
    });
  });
});

/**
 * El carrito del catálogo es una estimación, igual que una foto.
 *
 * El fallo que fija este test: los macros del carrito se precargaban en los
 * campos y se guardaban marcados `'user'`, porque quien resolvía la
 * procedencia comparaba solo contra el análisis de una foto — y el carrito no
 * tiene análisis. El reporte del control médico imprimía "anotados por la
 * usuaria" sobre una media de estimaciones de IA.
 */
describe('procedencia de unos macros venidos del catálogo o del carrito', () => {
  const delCarrito = { proteinG: 20.8, fatG: 15.3, fiberG: 2.4, caloriesKcal: 347 };

  it('sin tocar nada son de la IA, no de la usuaria', () => {
    expect(resolveMacrosSource({ entered: delCarrito, aiProposed: delCarrito })).toBe('ai');
  });

  it('corregir uno los vuelve mezcla, nunca "user"', () => {
    expect(resolveMacrosSource({
      entered: { ...delCarrito, proteinG: 25 },
      aiProposed: delCarrito,
    })).toBe('mixed');
  });

  it('sin declarar de dónde vinieron se marcarían "user": ese es el fallo', () => {
    // Documenta por qué `aiProposed` **tiene** que viajar. Con la referencia
    // ausente, la misma entrada produce la afirmación equivocada.
    expect(resolveMacrosSource({ entered: delCarrito })).toBe('user');
  });
});
