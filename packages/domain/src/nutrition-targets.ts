/**
 * Metas de energía y macronutrientes (Fase 14).
 *
 * Puro y determinístico, como todo `packages/domain`. Traduce un perfil
 * antropométrico + una meta en un objetivo diario de calorías, carbohidratos,
 * proteína y grasa.
 *
 * ## Frontera de seguridad — leer antes de tocar nada acá
 *
 * Esto es una app de **diabetes tipo 1**, y una meta de carbohidratos no es
 * un número inocente: los carbohidratos determinan el bolo de comida. Reglas
 * que este módulo respeta y que no se pueden relajar:
 *
 * - **No es una prescripción, es una referencia.** La meta se calcula con
 *   ecuaciones poblacionales; el objetivo real de cada persona lo define su
 *   equipo clínico. Toda pantalla que muestre esto tiene que decirlo.
 * - **Nunca se deriva insulina de acá.** Ni un ratio, ni un factor, ni una
 *   dosis. `AGENTS.md` lo prohíbe y este es justo el módulo desde donde sería
 *   tentador hacerlo.
 * - **El déficit está acotado a 500 kcal/día** (≈0,5 kg/semana), no a los
 *   1000 kcal que usan las calculadoras genéricas. En T1D un déficit agresivo
 *   sobre una pauta de insulina que no cambió al mismo tiempo es riesgo de
 *   hipoglucemia, no solo de perder músculo.
 * - **Pisos duros**: nunca por debajo del metabolismo basal, y nunca por
 *   debajo de 1200 kcal (mujeres) / 1500 kcal (hombres). Si el cálculo choca
 *   con un piso, se devuelve `clampedBy` para que la interfaz lo diga en vez
 *   de mostrar un número silenciosamente corregido.
 * - **La proteína sube cuando hay déficit** (1,6 g/kg vs 1,2 g/kg): la ADA
 *   pide cuidar específicamente la insuficiencia proteica en pérdida de peso
 *   intencional.
 *
 * ## Fuentes
 *
 * - BMR: ecuación de Mifflin-St Jeor (1990), la más precisa para adultos no
 *   atletas frente a calorimetría indirecta.
 * - Reparto de carbohidratos: ISPAD recomienda 45–50 % de la energía total en
 *   diabetes tipo 1. Se usa el 50 % y la grasa queda como resto acotado.
 * - Déficit y pisos: guía general de pérdida de peso segura (0,5–1 kg/semana),
 *   recortada al extremo conservador por lo dicho arriba.
 */

export type BiologicalSex = 'female' | 'male';

export type NutritionGoal = 'lose' | 'maintain' | 'gain' | 'trackOnly';

/**
 * Multiplicadores PAL estándar que acompañan a Mifflin-St Jeor. Las etiquetas
 * describen la semana completa, no el día de hoy: es el error más común al
 * elegir, y por eso se explicitan los días de ejercicio.
 */
export const ACTIVITY_LEVELS = [
  { key: 'sedentary', multiplier: 1.2, label: 'Sedentaria', detail: 'Trabajo de escritorio, poco o nada de ejercicio' },
  { key: 'light', multiplier: 1.375, label: 'Ligera', detail: 'Ejercicio suave 1–3 días por semana' },
  { key: 'moderate', multiplier: 1.55, label: 'Moderada', detail: 'Ejercicio moderado 3–5 días por semana' },
  { key: 'active', multiplier: 1.725, label: 'Alta', detail: 'Ejercicio intenso 6–7 días por semana' },
  { key: 'veryActive', multiplier: 1.9, label: 'Muy alta', detail: 'Trabajo físico o entrenamiento doble' },
] as const;

export type ActivityLevel = (typeof ACTIVITY_LEVELS)[number]['key'];

export interface NutritionProfileInput {
  sex: BiologicalSex;
  ageYears: number;
  heightCm: number;
  weightKg: number;
  activityLevel: ActivityLevel;
  goal: NutritionGoal;
}

/** Límite deliberadamente conservador — ver la nota de seguridad de arriba. */
export const MAX_DAILY_DEFICIT_KCAL = 500;
export const DAILY_SURPLUS_KCAL = 300;
export const CALORIE_FLOOR_FEMALE = 1200;
export const CALORIE_FLOOR_MALE = 1500;

/** ISPAD: 45–50 % de la energía en diabetes tipo 1. Se usa el techo del rango. */
export const CARB_ENERGY_FRACTION = 0.5;
const PROTEIN_G_PER_KG_MAINTAIN = 1.2;
const PROTEIN_G_PER_KG_DEFICIT = 1.6;
const MIN_FAT_ENERGY_FRACTION = 0.2;
const MAX_FAT_ENERGY_FRACTION = 0.35;

const KCAL_PER_G_CARB = 4;
const KCAL_PER_G_PROTEIN = 4;
const KCAL_PER_G_FAT = 9;

/** Por qué la meta no es la que salía del cálculo puro. */
export type TargetClamp = 'bmr' | 'absoluteFloor';

export interface NutritionTargets {
  bmrKcal: number;
  tdeeKcal: number;
  caloriesKcal: number;
  carbsG: number;
  proteinG: number;
  fatG: number;
  /**
   * Presente si un piso de seguridad modificó el resultado. La interfaz debe
   * decirlo: una meta corregida en silencio es una meta que la usuaria no
   * puede evaluar.
   */
  clampedBy?: TargetClamp;
}

export function calculateBMR(input: Pick<NutritionProfileInput, 'sex' | 'ageYears' | 'heightCm' | 'weightKg'>): number {
  const { sex, ageYears, heightCm, weightKg } = input;
  if (![ageYears, heightCm, weightKg].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('Age, height and weight must be positive finite numbers.');
  }
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  return sex === 'male' ? base + 5 : base - 161;
}

export function activityMultiplier(level: ActivityLevel): number {
  const found = ACTIVITY_LEVELS.find((entry) => entry.key === level);
  if (found === undefined) throw new Error(`Unknown activity level: ${level}`);
  return found.multiplier;
}

export function calculateTDEE(input: NutritionProfileInput): number {
  return calculateBMR(input) * activityMultiplier(input.activityLevel);
}

/**
 * Meta diaria completa. `trackOnly` devuelve el mantenimiento: quien solo
 * quiere registrar igual necesita una referencia contra la cual leer el día,
 * pero sin déficit ni superávit.
 */
export function calculateNutritionTargets(input: NutritionProfileInput): NutritionTargets {
  const bmrKcal = calculateBMR(input);
  const tdeeKcal = bmrKcal * activityMultiplier(input.activityLevel);

  const rawCalories =
    input.goal === 'lose' ? tdeeKcal - MAX_DAILY_DEFICIT_KCAL
      : input.goal === 'gain' ? tdeeKcal + DAILY_SURPLUS_KCAL
        : tdeeKcal;

  // Los pisos se aplican en orden de severidad y se reporta cuál mordió.
  const absoluteFloor = input.sex === 'male' ? CALORIE_FLOOR_MALE : CALORIE_FLOOR_FEMALE;
  let caloriesKcal = rawCalories;
  let clampedBy: TargetClamp | undefined;
  if (caloriesKcal < bmrKcal) {
    caloriesKcal = bmrKcal;
    clampedBy = 'bmr';
  }
  if (caloriesKcal < absoluteFloor) {
    caloriesKcal = absoluteFloor;
    clampedBy = 'absoluteFloor';
  }

  // La proteína se calcula por peso corporal, no como porcentaje: es lo que
  // protege la masa magra, y un porcentaje de una dieta baja en calorías da
  // muy poca proteína justo cuando más hace falta.
  const proteinPerKg = input.goal === 'lose' ? PROTEIN_G_PER_KG_DEFICIT : PROTEIN_G_PER_KG_MAINTAIN;
  const proteinG = Math.round(input.weightKg * proteinPerKg);
  const proteinKcal = proteinG * KCAL_PER_G_PROTEIN;

  let carbKcal = caloriesKcal * CARB_ENERGY_FRACTION;
  let fatKcal = caloriesKcal - proteinKcal - carbKcal;

  // La grasa queda como resto, pero acotada: demasiado poca compromete
  // ácidos grasos esenciales y saciedad; demasiada desplaza a los otros dos.
  // Lo que sobra o falta se compensa con carbohidratos, no con proteína.
  const minFatKcal = caloriesKcal * MIN_FAT_ENERGY_FRACTION;
  const maxFatKcal = caloriesKcal * MAX_FAT_ENERGY_FRACTION;
  if (fatKcal < minFatKcal) {
    carbKcal -= minFatKcal - fatKcal;
    fatKcal = minFatKcal;
  } else if (fatKcal > maxFatKcal) {
    carbKcal += fatKcal - maxFatKcal;
    fatKcal = maxFatKcal;
  }

  return {
    bmrKcal: Math.round(bmrKcal),
    tdeeKcal: Math.round(tdeeKcal),
    caloriesKcal: Math.round(caloriesKcal),
    carbsG: Math.max(0, Math.round(carbKcal / KCAL_PER_G_CARB)),
    proteinG,
    fatG: Math.max(0, Math.round(fatKcal / KCAL_PER_G_FAT)),
    ...(clampedBy === undefined ? {} : { clampedBy }),
  };
}

/**
 * Energía de una comida a partir de sus macros (Atwater: 4/4/9 kcal/g).
 *
 * Devuelve también `partial`: si falta algún macro, el total es un piso, no
 * el valor real. Mostrar "480 kcal" cuando en realidad falta contar la grasa
 * es peor que no mostrar nada, porque invita a "gastar" el resto del día.
 */
export function energyFromMacros(macros: {
  carbsG?: number | undefined;
  proteinG?: number | undefined;
  fatG?: number | undefined;
}): { kcal: number; partial: boolean } {
  const carbs = macros.carbsG ?? 0;
  const protein = macros.proteinG ?? 0;
  const fat = macros.fatG ?? 0;
  return {
    kcal: Math.round(carbs * KCAL_PER_G_CARB + protein * KCAL_PER_G_PROTEIN + fat * KCAL_PER_G_FAT),
    partial: macros.carbsG === undefined || macros.proteinG === undefined || macros.fatG === undefined,
  };
}
