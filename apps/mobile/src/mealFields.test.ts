import { describe, expect, it } from 'vitest';

import {
  hasMealContent,
  MEAL_FIELDS,
  MEAL_FIELDS_BEYOND_CARBS,
  promotesLooseCarbToMeal,
  type MealField,
} from './mealFields';

/**
 * La verdad contra la que se compara está escrita acá, a mano, desde la
 * especificación — no se deriva de `MEAL_FIELDS`. Si el test se construyera a
 * partir de la propia constante, pasaría igual con la lista incompleta que
 * causó los dos bugs, que es exactamente lo que no puede volver a pasar
 * (`systemPatterns.md`, Regla 1: un test que confirma lo que la implementación
 * devuelve hoy no prueba nada).
 */
const CAMPOS_QUE_SON_COMIDA: readonly MealField[] = [
  'carbsG',
  'description',
  'imageUri',
  'proteinG',
  'fatG',
  'fiberG',
  'caloriesKcal',
  'aiEstimatedCarbsG',
  'aiAnalysisId',
];

/** Lo que puede venir en la misma entrada y NO es una comida. */
const CAMPOS_QUE_NO_SON_COMIDA = [
  'timestamp',
  'manualGlucose',
  'rapidUnits',
  'basalUnits',
  'note',
  'ketonesMmolL',
  'rapidIncludesCorrection',
  'macrosSource',
] as const;

describe('MEAL_FIELDS', () => {
  it('es exactamente lo que la comida persiste, sin faltantes ni de más', () => {
    expect([...MEAL_FIELDS].sort()).toEqual([...CAMPOS_QUE_SON_COMIDA].sort());
  });

  it('no incluye `macrosSource`: es procedencia, no un macro', () => {
    // Una entrada que solo trajera procedencia y ningún valor no es una
    // comida; contarla crearía una fila vacía.
    expect(MEAL_FIELDS).not.toContain('macrosSource');
  });
});

describe('hasMealContent', () => {
  it.each(CAMPOS_QUE_SON_COMIDA)('reconoce una entrada que solo trae %s', (field) => {
    expect(hasMealContent({ [field]: field === 'description' ? 'algo' : 1 })).toBe(true);
  });

  it.each(CAMPOS_QUE_NO_SON_COMIDA)('no inventa una comida desde %s', (field) => {
    expect(hasMealContent({ [field]: 1 } as Partial<Record<MealField, unknown>>)).toBe(false);
  });

  it('una entrada vacía no es una comida', () => {
    expect(hasMealContent({})).toBe(false);
  });

  /**
   * El bug 2, en su forma exacta: registrar una comida keto que se cuenta por
   * macros y no por carbohidratos. Antes esto devolvía `false` al crear, la
   * fila no se escribía, y la hoja igual decía "Entrada guardada".
   */
  it('una entrada de solo proteína y grasa ES una comida', () => {
    expect(hasMealContent({ proteinG: 45, fatG: 30 })).toBe(true);
  });

  /**
   * `0 g` es un dato que la usuaria anotó; `undefined` es "no lo anotó". La
   * distinción recorre toda la app ("en blanco no es lo mismo que 0 g") y un
   * chequeo por truthiness la rompería justo acá.
   */
  it('distingue 0 g de "no anotado"', () => {
    expect(hasMealContent({ carbsG: 0 })).toBe(true);
    expect(hasMealContent({ proteinG: 0 })).toBe(true);
    expect(hasMealContent({ carbsG: undefined })).toBe(false);
  });

  it('una descripción vacía sigue siendo una comida registrada', () => {
    // La usuaria escribió y borró: el campo existe. Borrar su fila por eso
    // sería decidir por ella que no hubo comida.
    expect(hasMealContent({ description: '' })).toBe(true);
  });
});

/**
 * Un carbohidrato manual suelto sigue siendo un carbohidrato suelto.
 *
 * Al editar una fila que nació desde el acceso rápido de carbohidratos, contar
 * los gramos como "comida" la convertía en un plato solo por abrirla y
 * guardar — con episodio nuevo y tres alarmas encima. Se vuelve comida cuando
 * la edición **agrega** algo que solo una comida tiene.
 */
describe('promotesLooseCarbToMeal', () => {
  it('corregir solo los gramos NO la convierte en comida', () => {
    expect(promotesLooseCarbToMeal({ carbsG: 30 })).toBe(false);
  });

  it('un formulario que no trae nada tampoco', () => {
    expect(promotesLooseCarbToMeal({})).toBe(false);
  });

  it.each(MEAL_FIELDS_BEYOND_CARBS)('agregar %s sí la convierte en comida', (field) => {
    expect(promotesLooseCarbToMeal({ [field]: 'algo' })).toBe(true);
  });

  it('quitar la foto (null) no cuenta como agregar una comida', () => {
    expect(promotesLooseCarbToMeal({ carbsG: 30, imageUri: null })).toBe(false);
  });

  it('la lista es MEAL_FIELDS sin carbsG: no puede desincronizarse', () => {
    expect([...MEAL_FIELDS_BEYOND_CARBS, 'carbsG'].sort()).toEqual([...MEAL_FIELDS].sort());
  });
});
