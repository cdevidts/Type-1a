/**
 * Metas de energía y macronutrientes (Fase 14).
 *
 * Puro y determinístico, como todo `packages/domain`. Traduce un perfil
 * antropométrico + una meta en un objetivo diario de calorías, carbohidratos,
 * proteína, grasa y fibra.
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
 *   diabetes tipo 1. Se **apunta** al 50 % y la grasa queda como resto
 *   acotado a [20 %, 35 %]. Ojo: cuando ese acotado muerde, la diferencia se
 *   compensa con carbohidratos, así que el valor entregado puede subir hasta
 *   ~55 % en perfiles de peso muy bajo. Cualquier texto de interfaz debe
 *   mostrar el porcentaje **calculado**, no repetir "50 %" como si fuera
 *   fijo — se prometía un número y se entregaba otro.
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
  /** Meta de agua escrita por la usuaria. Ausente = referencia poblacional. */
  waterMlTarget?: number | undefined;
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
/**
 * Techo de proteína como fracción de la energía, dentro del AMDR (10–35 %).
 *
 * Sin esto, la proteína por kilo aplasta a los carbohidratos en personas de
 * peso alto: un perfil de 200 kg en déficit daba 320 g de proteína —el 69 % de
 * la energía— y dejaba los carbohidratos en **11 %** (50 g al día). Eso es una
 * dieta muy baja en carbohidratos, que en diabetes tipo 1 y sin supervisión
 * clínica es riesgo de hipoglucemia: no algo que la app pueda proponer sola.
 *
 * El valor es 30 % y no menos a propósito: tiene que morder **solo** en los
 * perfiles extremos. A 25 % ya recortaba la proteína de un perfil corriente
 * (70 kg en déficit necesita 112 g, y el techo lo bajaba a 106 g), anulando
 * sin querer la regla de la ADA sobre cuidar la masa magra.
 */
const MAX_PROTEIN_ENERGY_FRACTION = 0.3;
const MIN_FAT_ENERGY_FRACTION = 0.2;
const MAX_FAT_ENERGY_FRACTION = 0.35;

const KCAL_PER_G_CARB = 4;
const KCAL_PER_G_PROTEIN = 4;
const KCAL_PER_G_FAT = 9;

/**
 * Fibra: 14 g por cada 1000 kcal.
 *
 * Es la Ingesta Adecuada del IOM (Dietary Reference Intakes, 2005), la misma
 * que la ADA recomienda explícitamente para personas con diabetes — el
 * estándar de referencia dice "al menos lo de la población general", no un
 * objetivo aparte. Se escala con la energía y no es un número fijo porque
 * quien come 1400 kcal y quien come 2800 no tienen la misma capacidad de
 * llegar a los mismos gramos.
 *
 * ## Es un piso, no un techo — y la interfaz tiene que tratarlo así
 *
 * A diferencia de las calorías o los carbohidratos, pasarse de fibra no es
 * un problema que haya que señalar: la referencia marca desde dónde está
 * bien, no hasta dónde se puede. Una barra que grite "te pasaste" acá estaría
 * desaconsejando algo deseable.
 *
 * ## Lo que este número NO es
 *
 * No es un parámetro de terapia y de acá no sale ninguna dosis. Que la fibra
 * module la absorción de los carbohidratos es cierto y es justo por eso que
 * hay que decirlo: descontar fibra de los carbohidratos para calcular un bolo
 * ("carbohidratos netos") es una decisión clínica que define el equipo
 * tratante, no una meta de nutrición, y `AGENTS.md` prohíbe que la app la
 * infiera. Esta constante alimenta una barra de progreso; nada más.
 */
export const FIBER_G_PER_1000_KCAL = 14;

/**
 * Techo de la meta de fibra.
 *
 * Solo muerde en energías muy altas (a 3600 kcal la fórmula ya pide 50 g).
 * Existe porque una meta muy por encima de lo habitual, perseguida rápido,
 * produce molestias digestivas reales; y porque un número que nadie alcanza
 * deja de funcionar como referencia. Que el tope casi nunca actúe es la
 * intención: es un tope de seguridad, no un reparto.
 */
export const MAX_FIBER_TARGET_G = 50;

/**
 * Ingesta adecuada de **agua total** del IOM (DRI 2004), en mL/día: todo lo
 * que entra, bebidas y alimentos juntos.
 *
 * No es la meta que se muestra. Lo que la usuaria registra es agua **bebida**,
 * y el propio informe dice que ~80 % del agua total viene de bebidas y el 20 %
 * restante de la comida. Mostrar 2.700 mL como meta de vaso sería pedirle
 * beber el agua de la fruta también.
 */
export const TOTAL_WATER_AI_ML: Readonly<Record<BiologicalSex, number>> = {
  female: 2700,
  male: 3700,
};

/** La fracción del agua total que el IOM atribuye a bebidas. */
export const WATER_FROM_BEVERAGES_FRACTION = 0.8;

/**
 * Techo y piso de la meta de agua.
 *
 * El piso existe porque la meta no depende del peso ni de la energía —es una
 * cifra por sexo— y no tiene sentido que baje. El techo es un freno a un
 * override disparatado, no una recomendación.
 */
/**
 * Piso de la **referencia calculada**, no del override.
 *
 * Ver `waterTargetMl`: lo que ella escribe no se sube nunca a este número.
 */
export const MIN_WATER_TARGET_ML = 1200;
export const MAX_WATER_TARGET_ML = 6000;

/**
 * Meta diaria de agua bebida, en mL.
 *
 * Sale de una referencia **poblacional**, no de esta persona: el IOM la fijó
 * para adultos sanos, sedentarios, en clima templado. Por eso `waterMlTarget`
 * la sobrescribe y por eso la pantalla que la muestra tiene que decir de dónde
 * viene — con ejercicio, calor o una restricción de líquidos indicada por su
 * equipo, el número correcto es otro.
 *
 * Se redondea a 50 mL: la precisión al mililitro sería falsa sobre una
 * referencia de este tipo.
 */
export function waterTargetMl(input: {
  sex: BiologicalSex;
  waterMlTarget?: number | undefined;
}): number {
  const override = input.waterMlTarget;
  if (override !== undefined && Number.isFinite(override) && override > 0) {
    // **Solo el techo.** El piso NO se aplica a lo que ella escribió: alguien
    // con una restricción de 1.000 mL/día (insuficiencia cardíaca, enfermedad
    // renal avanzada, diálisis) escribía 1000 y la app le seguía pidiendo
    // 1.200 — un 20 % por encima de una indicación clínica, en silencio, y
    // con "Te faltan 1200 mL" todos los días.
    //
    // Un tope que corta hacia ARRIBA es un freno a un dedo que se resbaló;
    // uno que corta hacia abajo contradice a su equipo. No son simétricos.
    return Math.min(MAX_WATER_TARGET_ML, Math.round(override));
  }
  const beverages = TOTAL_WATER_AI_ML[input.sex] * WATER_FROM_BEVERAGES_FRACTION;
  const rounded = Math.round(beverages / 50) * 50;
  return Math.min(MAX_WATER_TARGET_ML, Math.max(MIN_WATER_TARGET_ML, rounded));
}

/**
 * Cuánta agua se bebió en un día y cómo va contra la meta.
 *
 * Vive en el dominio y no en el `.tsx` por la Regla 1: es un agregado que se
 * lee como patrón. Se queda en 0-100 % **a propósito** — pasarse de agua no es
 * un logro que la barra deba premiar creciendo, y en una app de diabetes la
 * sed excesiva puede ser un síntoma de hiperglucemia, no una meta cumplida.
 */
export function summarizeWaterDay(input: {
  events: readonly { ml: number }[];
  targetMl: number;
}): { totalMl: number; targetMl: number; progress: number; remainingMl: number } {
  const totalMl = input.events.reduce(
    (sum, event) => sum + (Number.isFinite(event.ml) && event.ml > 0 ? event.ml : 0),
    0,
  );
  const targetMl = Math.max(1, input.targetMl);
  return {
    totalMl: Math.round(totalMl),
    targetMl,
    progress: Math.min(1, totalMl / targetMl),
    remainingMl: Math.max(0, Math.round(targetMl - totalMl)),
  };
}

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
   * Meta de fibra, en gramos. **Es un piso**: llegar o pasarse está bien, y
   * quedarse corto es lo único que la pantalla debería marcar.
   */
  fiberG: number;
  /**
   * Meta diaria de agua **bebida**, en mL. Ver `waterTargetMl`: sale de una
   * referencia poblacional o de lo que ella escribió, nunca de su peso ni de
   * su energía — el IOM la fija por sexo y no por talla.
   */
  waterMl: number;
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
  const proteinG = Math.round(
    Math.min(input.weightKg * proteinPerKg, (caloriesKcal * MAX_PROTEIN_ENERGY_FRACTION) / KCAL_PER_G_PROTEIN),
  );
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
    waterMl: waterTargetMl(input),
    proteinG,
    fatG: Math.max(0, Math.round(fatKcal / KCAL_PER_G_FAT)),
    // Se escala con la energía ya acotada por los pisos, no con el cálculo
    // crudo: la meta de fibra tiene que corresponder a la comida que la
    // pantalla efectivamente propone. Y no entra en el reparto 4/4/9 — la
    // fibra ya está contada dentro de los carbohidratos, así que sumarla
    // aparte descuadraría la energía.
    fiberG: Math.min(
      MAX_FIBER_TARGET_G,
      Math.round((caloriesKcal / 1000) * FIBER_G_PER_1000_KCAL),
    ),
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
