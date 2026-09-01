import { describe, expect, it } from 'vitest';

import {
  ACTIVITY_LEVELS,
  CALORIE_FLOOR_FEMALE,
  CALORIE_FLOOR_MALE,
  FIBER_G_PER_1000_KCAL,
  MAX_DAILY_DEFICIT_KCAL,
  MAX_FIBER_TARGET_G,
  calculateBMR,
  calculateNutritionTargets,
  calculateTDEE,
  energyFromMacros,
  type NutritionProfileInput,
} from '../src/nutrition-targets';

const baseProfile: NutritionProfileInput = {
  sex: 'female',
  ageYears: 30,
  heightCm: 165,
  weightKg: 70,
  activityLevel: 'moderate',
  goal: 'maintain',
};

describe('calculateBMR (Mifflin-St Jeor)', () => {
  it('coincide con el valor publicado de la ecuación para mujeres', () => {
    // 10*70 + 6.25*165 - 5*30 - 161 = 1420.25
    expect(calculateBMR(baseProfile)).toBeCloseTo(1420.25, 2);
  });

  it('coincide para hombres (el término constante es la única diferencia)', () => {
    // 10*70 + 6.25*165 - 5*30 + 5 = 1586.25
    expect(calculateBMR({ ...baseProfile, sex: 'male' })).toBeCloseTo(1586.25, 2);
  });

  it('rechaza medidas imposibles en vez de devolver un número inventado', () => {
    expect(() => calculateBMR({ ...baseProfile, weightKg: 0 })).toThrow();
    expect(() => calculateBMR({ ...baseProfile, heightCm: -1 })).toThrow();
    expect(() => calculateBMR({ ...baseProfile, ageYears: Number.NaN })).toThrow();
  });
});

describe('calculateTDEE', () => {
  it('aplica el multiplicador de actividad', () => {
    expect(calculateTDEE(baseProfile)).toBeCloseTo(1420.25 * 1.55, 2);
  });

  it('cada nivel de actividad sube el gasto', () => {
    const values = ACTIVITY_LEVELS.map((level) =>
      calculateTDEE({ ...baseProfile, activityLevel: level.key }));
    const sorted = [...values].sort((a, b) => a - b);
    expect(values).toEqual(sorted);
  });
});

describe('calculateNutritionTargets — seguridad', () => {
  it('el déficit nunca supera los 500 kcal, aunque la meta sea perder', () => {
    const maintain = calculateNutritionTargets(baseProfile);
    const lose = calculateNutritionTargets({ ...baseProfile, goal: 'lose' });
    expect(maintain.caloriesKcal - lose.caloriesKcal).toBeLessThanOrEqual(MAX_DAILY_DEFICIT_KCAL);
  });

  it('nunca baja del metabolismo basal', () => {
    // Persona pequeña y sedentaria: el déficit la llevaría bajo su BMR.
    const target = calculateNutritionTargets({
      sex: 'female', ageYears: 60, heightCm: 150, weightKg: 48,
      activityLevel: 'sedentary', goal: 'lose',
    });
    expect(target.caloriesKcal).toBeGreaterThanOrEqual(target.bmrKcal);
    expect(target.clampedBy).toBeDefined();
  });

  it('respeta el piso absoluto y lo reporta', () => {
    const target = calculateNutritionTargets({
      sex: 'female', ageYears: 70, heightCm: 145, weightKg: 40,
      activityLevel: 'sedentary', goal: 'lose',
    });
    expect(target.caloriesKcal).toBeGreaterThanOrEqual(CALORIE_FLOOR_FEMALE);
  });

  it('el piso de los hombres es más alto', () => {
    const target = calculateNutritionTargets({
      sex: 'male', ageYears: 75, heightCm: 155, weightKg: 45,
      activityLevel: 'sedentary', goal: 'lose',
    });
    expect(target.caloriesKcal).toBeGreaterThanOrEqual(CALORIE_FLOOR_MALE);
  });

  it('no marca clampedBy cuando el cálculo salió limpio', () => {
    expect(calculateNutritionTargets(baseProfile).clampedBy).toBeUndefined();
  });
});

describe('calculateNutritionTargets — reparto de macros', () => {
  it('los macros suman aproximadamente las calorías de la meta', () => {
    for (const goal of ['lose', 'maintain', 'gain'] as const) {
      const t = calculateNutritionTargets({ ...baseProfile, goal });
      const fromMacros = t.carbsG * 4 + t.proteinG * 4 + t.fatG * 9;
      // Tolerancia por el redondeo a gramos enteros de los tres macros.
      expect(Math.abs(fromMacros - t.caloriesKcal)).toBeLessThan(20);
    }
  });

  it('sube la proteína por kilo cuando hay déficit (ADA: cuidar la masa magra)', () => {
    const maintain = calculateNutritionTargets(baseProfile);
    const lose = calculateNutritionTargets({ ...baseProfile, goal: 'lose' });
    expect(lose.proteinG).toBeGreaterThan(maintain.proteinG);
    expect(lose.proteinG).toBe(Math.round(70 * 1.6));
  });

  it('la grasa se mantiene dentro del 20–35 % de la energía', () => {
    const profiles: NutritionProfileInput[] = [
      baseProfile,
      { ...baseProfile, goal: 'lose' },
      { ...baseProfile, goal: 'gain' },
      { ...baseProfile, weightKg: 110, goal: 'lose' },
      { sex: 'male', ageYears: 20, heightCm: 190, weightKg: 95, activityLevel: 'veryActive', goal: 'gain' },
    ];
    for (const profile of profiles) {
      const t = calculateNutritionTargets(profile);
      const fatFraction = (t.fatG * 9) / t.caloriesKcal;
      expect(fatFraction).toBeGreaterThanOrEqual(0.19);
      expect(fatFraction).toBeLessThanOrEqual(0.36);
    }
  });

  it('ningún macro sale negativo, ni con mucho peso y pocas calorías', () => {
    // Peso alto + déficit empuja la proteína hacia arriba y los carbos hacia
    // abajo; el reparto tiene que seguir siendo válido.
    const t = calculateNutritionTargets({
      sex: 'female', ageYears: 55, heightCm: 150, weightKg: 130,
      activityLevel: 'sedentary', goal: 'lose',
    });
    expect(t.carbsG).toBeGreaterThanOrEqual(0);
    expect(t.proteinG).toBeGreaterThanOrEqual(0);
    expect(t.fatG).toBeGreaterThanOrEqual(0);
  });

  it('trackOnly es exactamente mantenimiento', () => {
    const track = calculateNutritionTargets({ ...baseProfile, goal: 'trackOnly' });
    const maintain = calculateNutritionTargets(baseProfile);
    expect(track.caloriesKcal).toBe(maintain.caloriesKcal);
  });
});

describe('energyFromMacros', () => {
  it('usa los factores de Atwater', () => {
    expect(energyFromMacros({ carbsG: 50, proteinG: 20, fatG: 10 }).kcal).toBe(50 * 4 + 20 * 4 + 10 * 9);
  });

  it('marca parcial cuando falta cualquier macro', () => {
    expect(energyFromMacros({ carbsG: 50 }).partial).toBe(true);
    expect(energyFromMacros({ carbsG: 50, proteinG: 20 }).partial).toBe(true);
    expect(energyFromMacros({ carbsG: 50, proteinG: 20, fatG: 10 }).partial).toBe(false);
  });

  it('un macro en 0 anotado NO es lo mismo que ausente', () => {
    // La distinción que sostiene todo el módulo de insights.
    expect(energyFromMacros({ carbsG: 50, proteinG: 20, fatG: 0 }).partial).toBe(false);
    expect(energyFromMacros({ carbsG: 50, proteinG: 20, fatG: undefined }).partial).toBe(true);
  });
});

describe('los carbohidratos no pueden colapsar', () => {
  it('nunca bajan del 40 % de la energía, en ningún perfil que el schema acepte', () => {
    // Regresión de un bug real: sin techo de proteína, un perfil de peso alto
    // en déficit daba 11 % de carbohidratos (50 g/día). Una dieta muy baja en
    // carbos en diabetes tipo 1 y sin supervisión clínica es riesgo de
    // hipoglucemia, y la app no puede proponerla sola.
    const rows: { pct: number; tag: string }[] = [];
    for (const sex of ['female', 'male'] as const)
      for (const ageYears of [18, 40, 110])
        for (const heightCm of [90, 150, 250])
          for (const weightKg of [25, 90, 200, 350])
            for (const activityLevel of ['sedentary', 'veryActive'] as const)
              for (const goal of ['lose', 'maintain', 'gain'] as const) {
                const t = calculateNutritionTargets({ sex, ageYears, heightCm, weightKg, activityLevel, goal });
                rows.push({
                  pct: (t.carbsG * 4) / t.caloriesKcal,
                  tag: `${sex} ${ageYears}y ${heightCm}cm ${weightKg}kg ${activityLevel} ${goal}`,
                });
              }
    const lowest = rows.reduce((a, b) => (a.pct < b.pct ? a : b));
    expect(lowest.pct, `peor caso: ${lowest.tag}`).toBeGreaterThanOrEqual(0.4);
  });

  it('la proteína nunca supera el 30 % de la energía', () => {
    const t = calculateNutritionTargets({
      sex: 'female', ageYears: 40, heightCm: 150, weightKg: 200,
      activityLevel: 'sedentary', goal: 'lose',
    });
    expect((t.proteinG * 4) / t.caloriesKcal).toBeLessThanOrEqual(0.31);
  });

  it('sigue subiendo la proteína en déficit cuando el techo no aplica', () => {
    // El techo no debe anular la regla de la ADA en perfiles normales.
    const maintain = calculateNutritionTargets({ ...baseProfile });
    const lose = calculateNutritionTargets({ ...baseProfile, goal: 'lose' });
    expect(lose.proteinG).toBeGreaterThan(maintain.proteinG);
  });
});

describe('meta de fibra', () => {
  it('escala 14 g por cada 1000 kcal de la meta entregada', () => {
    const t = calculateNutritionTargets(baseProfile);
    expect(FIBER_G_PER_1000_KCAL).toBe(14);
    expect(t.fiberG).toBe(Math.round((t.caloriesKcal / 1000) * 14));
  });

  it('se calcula sobre las calorías YA acotadas, no sobre el cálculo crudo', () => {
    // Un perfil que choca con un piso recibe más calorías de las que salían
    // del déficit; la fibra tiene que corresponder a la comida que la
    // pantalla propone, no a una que no va a existir.
    const clamped = calculateNutritionTargets({
      sex: 'female', ageYears: 70, heightCm: 145, weightKg: 40,
      activityLevel: 'sedentary', goal: 'lose',
    });
    expect(clamped.clampedBy).toBeDefined();
    expect(clamped.fiberG).toBe(Math.round((clamped.caloriesKcal / 1000) * FIBER_G_PER_1000_KCAL));
  });

  it('no descuadra el reparto de energía: la fibra ya está dentro de los carbohidratos', () => {
    // Si alguien sumara la fibra aparte en el 4/4/9, la energía repartida
    // dejaría de coincidir con la meta. Este test fija esa frontera.
    const t = calculateNutritionTargets(baseProfile);
    const repartida = t.carbsG * 4 + t.proteinG * 4 + t.fatG * 9;
    expect(Math.abs(repartida - t.caloriesKcal)).toBeLessThanOrEqual(6);
  });

  it('nunca pide más que el techo, ni siquiera con energías muy altas', () => {
    const grande = calculateNutritionTargets({
      sex: 'male', ageYears: 25, heightCm: 200, weightKg: 120,
      activityLevel: 'veryActive', goal: 'gain',
    });
    expect(grande.caloriesKcal).toBeGreaterThan(3600);
    expect(grande.fiberG).toBe(MAX_FIBER_TARGET_G);
  });

  it('siempre es un número positivo y usable', () => {
    for (const sex of ['female', 'male'] as const)
      for (const weightKg of [40, 70, 200])
        for (const goal of ['lose', 'maintain', 'gain', 'trackOnly'] as const) {
          const t = calculateNutritionTargets({
            ...baseProfile, sex, weightKg, goal,
          });
          expect(t.fiberG).toBeGreaterThan(0);
          expect(t.fiberG).toBeLessThanOrEqual(MAX_FIBER_TARGET_G);
          expect(Number.isInteger(t.fiberG)).toBe(true);
        }
  });
});
