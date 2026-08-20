import type { FoodEstimate } from '@type1a/schemas';

/**
 * Catálogo de alimentos propio, construido con lo que la IA va identificando
 * (Fase 15).
 *
 * ## Por qué existe
 *
 * La IA ya estima **todos** los macros de cada alimento que reconoce en una
 * foto o en una descripción — no solo carbohidratos. Hasta ahora ese desglose
 * por alimento se usaba una vez y se tiraba: se guardaban los totales de la
 * comida y nada más. Pero la gente come casi siempre lo mismo: guardar cada
 * alimento identificado convierte esas llamadas en un catálogo que crece solo.
 *
 * Lo que habilita, en orden de valor:
 *
 * 1. **Volver a registrar un alimento conocido sin llamar a la IA**: instantáneo,
 *    sin esperar, sin conexión, y sin mandar otra foto afuera. Para el uso real
 *    —el mismo desayuno cinco días a la semana— esto es la diferencia entre
 *    una app que se usa y una que cansa.
 * 2. **Consistencia**: el mismo alimento da los mismos números, en vez de
 *    variar en cada estimación.
 * 3. Menos costo de IA por comida registrada.
 *
 * ## Normalización a 100 g
 *
 * Todo se guarda **por 100 g** para que una porción distinta se escale sola.
 * Eso exige que la estimación traiga los gramos: `FoodEstimate.estimatedGrams`
 * es `nullable` a propósito (la IA declara cuando no puede estimar la porción),
 * y **un alimento sin gramos no entra al catálogo**. Escalar desde una porción
 * desconocida sería inventar el dato.
 *
 * ## Frontera de seguridad
 *
 * Estos valores son **estimaciones de IA**, y siguen siéndolo cuando salen del
 * catálogo: `AGENTS.md` exige que los carbohidratos estimados por IA nunca se
 * confundan con los confirmados por la usuaria. El catálogo guarda la
 * procedencia y quien lo consuma tiene que arrastrarla — un alimento reusado
 * del catálogo precarga un campo, nunca lo confirma solo.
 */

export interface CatalogFood {
  /** Clave normalizada; dos escrituras del mismo alimento colapsan en una. */
  key: string;
  /** Nombre para mostrar: el más reciente que usó la IA. */
  name: string;
  carbsPer100g: number;
  proteinPer100g: number;
  fatPer100g: number;
  fiberPer100g: number;
  kcalPer100g: number;
  /** Cuántas veces se ha identificado. Más veces = estimación más asentada. */
  timesSeen: number;
  lastSeenAt: string;
}

/**
 * Clave de agrupación de un nombre de alimento.
 *
 * Minúsculas, sin acentos, sin puntuación y con los espacios colapsados, para
 * que "Pan Integral", "pan integral" y "pan  integral." sean el mismo alimento.
 * A propósito **no** intenta lematizar ni quitar plurales: "manzana" y
 * "manzanas" quedan separados. Colapsarlos exigiría un diccionario de español
 * y equivocarse ahí mezcla macros de alimentos distintos, que es peor que
 * tener dos entradas parecidas.
 */
export function foodKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Gramos mínimos para normalizar sin que el redondeo domine el resultado. */
export const MIN_CATALOG_GRAMS = 5;

/**
 * Convierte un alimento estimado a una entrada de catálogo por 100 g, o
 * `null` si no es normalizable (sin gramos, gramos absurdos, nombre vacío).
 */
export function toCatalogEntry(
  food: FoodEstimate,
  seenAt: string,
): Omit<CatalogFood, 'timesSeen'> | null {
  const grams = food.estimatedGrams;
  if (grams === null || !Number.isFinite(grams) || grams < MIN_CATALOG_GRAMS) return null;
  const key = foodKey(food.name);
  if (key === '') return null;

  const per100 = (value: number): number => Number(((value / grams) * 100).toFixed(2));
  return {
    key,
    name: food.name.trim(),
    carbsPer100g: per100(food.carbsG),
    proteinPer100g: per100(food.proteinG),
    fatPer100g: per100(food.fatG),
    fiberPer100g: per100(food.fiberG),
    kcalPer100g: per100(food.caloriesKcal),
    lastSeenAt: seenAt,
  };
}

/** Todas las entradas normalizables de un análisis, ya deduplicadas por clave. */
export function catalogEntriesFrom(
  foods: readonly FoodEstimate[],
  seenAt: string,
): Omit<CatalogFood, 'timesSeen'>[] {
  const byKey = new Map<string, Omit<CatalogFood, 'timesSeen'>>();
  for (const food of foods) {
    const entry = toCatalogEntry(food, seenAt);
    // El último gana: si un análisis nombra el mismo alimento dos veces, es
    // más probable que sea una corrección que dos platos distintos.
    if (entry !== null) byKey.set(entry.key, entry);
  }
  return [...byKey.values()];
}

/** Escala una entrada del catálogo a una porción concreta. */
export function scaleCatalogFood(food: CatalogFood, grams: number): {
  carbsG: number;
  proteinG: number;
  fatG: number;
  fiberG: number;
  caloriesKcal: number;
} {
  if (!Number.isFinite(grams) || grams <= 0) {
    throw new Error('Portion grams must be a positive finite number.');
  }
  const factor = grams / 100;
  const round = (value: number): number => Number((value * factor).toFixed(1));
  return {
    carbsG: round(food.carbsPer100g),
    proteinG: round(food.proteinPer100g),
    fatG: round(food.fatPer100g),
    fiberG: round(food.fiberPer100g),
    caloriesKcal: Math.round(food.kcalPer100g * factor),
  };
}
