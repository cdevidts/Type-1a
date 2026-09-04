import { describe, expect, it } from 'vitest';
import type { MealAnalysisResult } from '@type1a/schemas';

import { clampMealNote, MAX_MEAL_NOTE_LENGTH, mealNoteFrom } from './mealNote';

function analysis(names: string[]): MealAnalysisResult {
  return {
    analysisId: 'a-1',
    model: 'test',
    estimate: {
      foods: names.map((name) => ({
        name,
        estimatedGrams: 50,
        servingGrams: null,
        servingLabel: null,
        carbsG: 10,
        proteinG: 2,
        fatG: 1,
        fiberG: 1,
        caloriesKcal: 60,
        confidence: 0.7,
      })),
      waterMl: null,
      uncertaintyNotes: [],
    },
    totals: { carbsG: 10, proteinG: 2, fatG: 1, fiberG: 1, caloriesKcal: 60 },
  };
}

describe('mealNoteFrom', () => {
  it('lo que ella escribió manda sobre todo lo demás', () => {
    expect(mealNoteFrom({
      description: '  dos sopaipillas con pebre ',
      analysis: analysis(['Sopaipilla', 'Pebre']),
      catalogFoodName: 'Sopaipilla',
    })).toBe('dos sopaipillas con pebre');
  });

  it('sin texto, usa los alimentos que identificó la IA', () => {
    expect(mealNoteFrom({ analysis: analysis(['Arroz', 'Pollo']) })).toBe('Arroz, Pollo');
  });

  it('sin texto ni análisis, usa el alimento del catálogo que se reusó', () => {
    expect(mealNoteFrom({ catalogFoodName: 'Pan integral' })).toBe('Pan integral');
  });

  it('sin nada, NO inventa una nota', () => {
    expect(mealNoteFrom({})).toBeUndefined();
    expect(mealNoteFrom({ description: '   ' })).toBeUndefined();
  });

  it('un análisis sin alimentos utilizables cae al catálogo', () => {
    expect(mealNoteFrom({ analysis: analysis(['  ']), catalogFoodName: 'Arroz' })).toBe('Arroz');
  });

  it('colapsa los espacios: el cuadro de texto admite saltos de línea', () => {
    expect(mealNoteFrom({ description: 'pan\n\ncon    palta' })).toBe('pan con palta');
  });
});

describe('clampMealNote — el techo del esquema es duro', () => {
  it('deja intacto lo que cabe', () => {
    expect(clampMealNote('pan con palta')).toBe('pan con palta');
  });

  it('nunca devuelve más de lo que acepta `MealEventSchema`', () => {
    // Pasarse no trunca: Zod rechaza y **la comida entera no se guarda**.
    const largo = mealNoteFrom({ description: 'sopaipilla '.repeat(60) });
    expect(largo).toBeDefined();
    expect(largo!.length).toBeLessThanOrEqual(MAX_MEAL_NOTE_LENGTH);
    expect(largo!.endsWith('…')).toBe(true);
  });

  it('corta en un espacio, sin partir una palabra', () => {
    const recortado = clampMealNote(`${'a'.repeat(10)} ${'b'.repeat(400)}`);
    expect(recortado.length).toBeLessThanOrEqual(MAX_MEAL_NOTE_LENGTH);
  });

  it('una sola palabra larguísima se corta duro en vez de quedar vacía', () => {
    const recortado = clampMealNote('z'.repeat(500));
    expect(recortado.length).toBe(MAX_MEAL_NOTE_LENGTH);
    expect(recortado.startsWith('z')).toBe(true);
  });

  it('una lista larga de alimentos también respeta el techo', () => {
    const nota = mealNoteFrom({ analysis: analysis(Array.from({ length: 30 }, (_, i) => `Alimento número ${i}`)) });
    expect(nota!.length).toBeLessThanOrEqual(MAX_MEAL_NOTE_LENGTH);
  });
});
