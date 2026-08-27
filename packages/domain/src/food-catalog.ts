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
  /**
   * Tamaño de la porción de referencia, en gramos (Fase 18).
   *
   * **Opcional a propósito.** Todo el catálogo se guarda por 100 g y así se
   * seguirá guardando; esto solo dice en cuánto se piensa una porción de este
   * alimento ("una taza son 150 g"). Ausente = 100 g, que es lo que había
   * antes de la Fase 18 y lo que tienen todas las filas ya guardadas en el
   * teléfono. Una migración que las invalidara sería inaceptable: son datos
   * reales de Verónica.
   */
  servingGrams?: number;
  /** Cómo se llama esa porción para la usuaria: "taza", "rebanada", "plato". */
  servingLabel?: string;
  /**
   * Foto del alimento, si alguna comida real dejó una.
   *
   * **Nunca se genera ni se inventa.** Sale exactamente de la foto que la
   * usuaria sacó al registrar una comida donde ese alimento se identificó, y
   * si esa comida no tuvo foto, el alimento no tiene foto. Un alimento
   * anterior a este campo —o sea, todo lo que ya está en el teléfono de
   * Verónica— simplemente no la trae, y su tarjeta muestra el fallback.
   *
   * Es **representación**, no evidencia de macros: nada la vuelve a analizar
   * al leer el catálogo. Ver `catalogFoodMissingMacros` y `blendCatalogEntry`.
   */
  imageUri?: string;
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
    .replace(/[\u0300-\u036f]/gu, '')
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
  /**
   * La foto de la comida en la que se identificó, si la hubo. Se propaga tal
   * cual: no se genera, no se recorta y no se deriva nada de ella.
   */
  imageUri?: string,
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
    ...(imageUri === undefined ? {} : { imageUri }),
  };
}

/** Todas las entradas normalizables de un análisis, ya deduplicadas por clave. */
export function catalogEntriesFrom(
  foods: readonly FoodEstimate[],
  seenAt: string,
  /** Foto de la comida analizada, si la hubo. Ver `toCatalogEntry`. */
  imageUri?: string,
): Omit<CatalogFood, 'timesSeen'>[] {
  const byKey = new Map<string, Omit<CatalogFood, 'timesSeen'>>();
  for (const food of foods) {
    const entry = toCatalogEntry(food, seenAt, imageUri);
    // El último gana: si un análisis nombra el mismo alimento dos veces, es
    // más probable que sea una corrección que dos platos distintos.
    if (entry !== null && isPlausibleCatalogEntry(entry)) byKey.set(entry.key, entry);
  }
  return [...byKey.values()];
}

/**
 * Máximos físicamente posibles por 100 g. 100 g de un alimento no pueden
 * contener más de 100 g de un macro, y ~900 kcal es el techo (grasa pura).
 * Un valor por encima solo puede venir de una estimación con la porción muy
 * equivocada — y sin este filtro quedaba fosilizado en el catálogo para
 * siempre, sugiriendo cientos de gramos de carbohidratos.
 */
const MAX_MACRO_PER_100G = 100;
const MAX_KCAL_PER_100G = 900;

export function isPlausibleCatalogEntry(entry: Omit<CatalogFood, 'timesSeen'>): boolean {
  // La porción también: es el multiplicador de todos los macros, así que una
  // porción imposible produce sugerencias imposibles aunque los valores por
  // 100 g sean perfectamente razonables.
  if (entry.servingGrams !== undefined && !isValidServingGrams(entry.servingGrams)) return false;
  const macros = [entry.carbsPer100g, entry.proteinPer100g, entry.fatPer100g, entry.fiberPer100g];
  if (macros.some((value) => !Number.isFinite(value) || value < 0 || value > MAX_MACRO_PER_100G)) return false;
  if (!Number.isFinite(entry.kcalPer100g) || entry.kcalPer100g < 0 || entry.kcalPer100g > MAX_KCAL_PER_100G) return false;
  // La fibra es un subconjunto de los carbohidratos: más fibra que carbos es
  // una estimación incoherente, no un alimento raro.
  if (entry.fiberPer100g > entry.carbsPer100g + 1) return false;
  return true;
}

/**
 * Fusiona una estimación nueva con lo que ya había, ponderando por las veces
 * vistas: dos estimaciones del mismo alimento convergen en vez de que la
 * última pise a la anterior.
 *
 * Vive acá y no en `db.ts` porque es un cálculo que termina sugiriendo
 * carbohidratos, y `AGENTS.md` pide que los cálculos sensibles sean puros,
 * determinísticos y estén en `packages/domain`.
 *
 * **El peso está acotado** (`MAX_BLEND_WEIGHT`): sin tope, un alimento visto
 * 50 veces vuelve casi inmutable, así que un error grande temprano no se
 * puede corregir nunca — la inercia crece justo al revés de lo deseable. Con
 * el tope, una estimación nueva siempre conserva algo de influencia.
 */
export const MAX_BLEND_WEIGHT = 10;

export function blendCatalogEntry(
  existing: CatalogFood,
  next: Omit<CatalogFood, 'timesSeen'>,
): CatalogFood {
  const weight = Math.min(existing.timesSeen, MAX_BLEND_WEIGHT);
  // La porción de referencia la define la usuaria, no la IA. Sin conservarla,
  // la próxima vez que la IA identifique este alimento borraría el "una taza
  // son 150 g" que ella escribió: un análisis nuevo nunca trae este campo.
  const servingGrams = next.servingGrams ?? existing.servingGrams;
  const servingLabel = next.servingLabel ?? existing.servingLabel;
  // La foto se conserva si la nueva no trae una. Un análisis por texto no
  // tiene imagen, y sin esto reconocer el mismo alimento sin foto borraría la
  // que ya había — un dato que solo se recupera volviendo a fotografiar.
  const imageUri = next.imageUri ?? existing.imageUri;
  const mix = (old: number, incoming: number): number =>
    Number(((old * weight + incoming) / (weight + 1)).toFixed(2));
  return {
    key: existing.key,
    name: next.name,
    carbsPer100g: mix(existing.carbsPer100g, next.carbsPer100g),
    proteinPer100g: mix(existing.proteinPer100g, next.proteinPer100g),
    fatPer100g: mix(existing.fatPer100g, next.fatPer100g),
    fiberPer100g: mix(existing.fiberPer100g, next.fiberPer100g),
    kcalPer100g: mix(existing.kcalPer100g, next.kcalPer100g),
    timesSeen: existing.timesSeen + 1,
    lastSeenAt: next.lastSeenAt,
    ...(servingGrams === undefined ? {} : { servingGrams }),
    ...(servingLabel === undefined ? {} : { servingLabel }),
    ...(imageUri === undefined ? {} : { imageUri }),
  };
}

/**
 * Porción de referencia de un alimento, en gramos.
 *
 * El default de 100 g no es arbitrario: es la base en la que está guardado
 * todo el catálogo, así que un alimento sin porción definida se comporta
 * exactamente como antes de la Fase 18.
 */
export const DEFAULT_SERVING_GRAMS = 100;

/**
 * Cota de la porción de referencia.
 *
 * No es cosmética. `isPlausibleCatalogEntry` solo mira los macros por 100 g,
 * así que una porción absurda pasa entera: escribir 1500 donde iban 150 hace
 * que la app anuncie "una porción son 1500 g" y sugiera ≈420 g de
 * carbohidratos para un plato de arroz normal — un número plausible por 100 g
 * multiplicado por una porción imposible. Y si los macros escalados se pasan
 * de los topes de `MealEventSchema`, la comida directamente no se guarda y la
 * usuaria solo ve "no se pudo guardar".
 */
export const MAX_SERVING_GRAMS = 2000;
export const MIN_SERVING_GRAMS = 1;

export function isValidServingGrams(grams: number): boolean {
  return Number.isFinite(grams) && grams >= MIN_SERVING_GRAMS && grams <= MAX_SERVING_GRAMS;
}

export function servingGramsOf(food: CatalogFood): number {
  const grams = food.servingGrams;
  return grams !== undefined && isValidServingGrams(grams) ? grams : DEFAULT_SERVING_GRAMS;
}

/**
 * Cuántas porciones puede pedir la usuaria al reusar un alimento.
 *
 * El piso de 0,1 permite "un poquito" sin abrir la puerta a un 0 que después
 * se guardaría como "comí 0 g de esto" — que no es un registro, es ruido. El
 * techo de 10 es el límite que pidió Verónica.
 */
export const MIN_SERVINGS = 0.1;
export const MAX_SERVINGS = 10;

export function isValidServings(servings: number): boolean {
  return Number.isFinite(servings) && servings >= MIN_SERVINGS && servings <= MAX_SERVINGS;
}

/**
 * Escala un alimento del catálogo a un número de porciones.
 *
 * Es azúcar sobre `scaleCatalogFood`, pero es la que usa la interfaz: pensar
 * en "dos tazas" es más fácil que en "300 gramos", y quien sí pesa en balanza
 * sigue teniendo la otra puerta abierta.
 */
export function scaleCatalogFoodByServings(food: CatalogFood, servings: number): ReturnType<typeof scaleCatalogFood> {
  if (!isValidServings(servings)) {
    throw new Error(`Servings must be between ${MIN_SERVINGS} and ${MAX_SERVINGS}.`);
  }
  return scaleCatalogFood(food, servings * servingGramsOf(food));
}

/**
 * Lo que la pantalla de catálogo puede corregir de un alimento (Fase 18).
 *
 * `timesSeen` no está: es el peso que `blendCatalogEntry` le da a lo ya
 * sabido, o sea un parámetro del algoritmo, no un dato de la comida.
 */
export interface CatalogFoodEdit {
  name?: string;
  carbsPer100g?: number;
  proteinPer100g?: number;
  fatPer100g?: number;
  fiberPer100g?: number;
  kcalPer100g?: number;
  /** `null` borra la porción de referencia y vuelve al default de 100 g. */
  servingGrams?: number | null;
  servingLabel?: string | null;
  /**
   * `null` quita la foto guardada; ausente la deja como está.
   *
   * Quitar es una acción explícita, igual que en el resto de la app: un campo
   * que no viaja nunca borra nada.
   */
  imageUri?: string | null;
}

/**
 * Aplica una corrección a un alimento del catálogo, o devuelve `null` si el
 * resultado no sería físicamente posible.
 *
 * Vive acá y no en `db.ts` porque es la puerta por la que pasa **toda**
 * escritura manual al catálogo, y lo que se guarde ahí termina sugiriendo
 * carbohidratos en cada comida futura que reuse el alimento. `AGENTS.md` pide
 * que ese tipo de cálculo sea puro, determinístico y con test; en `db.ts` no
 * se puede probar, porque ese módulo importa nativos de Expo.
 *
 * La clave **no** cambia aunque cambie el nombre: si cambiara, el alimento
 * corregido sería uno nuevo y el viejo —con la estimación mala— seguiría ahí,
 * que es justo lo que la pantalla de catálogo viene a resolver.
 */
export function applyCatalogEdit(existing: CatalogFood, edit: CatalogFoodEdit): CatalogFood | null {
  // Los campos de porción se construyen desde cero y no con un spread: con
  // `exactOptionalPropertyTypes`, "la borré" tiene que dejar la propiedad
  // fuera del objeto, no puesta en `undefined`.
  const servingGrams = edit.servingGrams === undefined
    ? existing.servingGrams
    : (edit.servingGrams ?? undefined);
  const servingLabel = edit.servingLabel === undefined
    ? existing.servingLabel
    : (edit.servingLabel ?? undefined);
  const imageUri = edit.imageUri === undefined
    ? existing.imageUri
    : (edit.imageUri ?? undefined);

  const next: CatalogFood = {
    key: existing.key,
    timesSeen: existing.timesSeen,
    lastSeenAt: existing.lastSeenAt,
    name: edit.name === undefined || edit.name.trim() === '' ? existing.name : edit.name.trim(),
    carbsPer100g: edit.carbsPer100g ?? existing.carbsPer100g,
    proteinPer100g: edit.proteinPer100g ?? existing.proteinPer100g,
    fatPer100g: edit.fatPer100g ?? existing.fatPer100g,
    fiberPer100g: edit.fiberPer100g ?? existing.fiberPer100g,
    kcalPer100g: edit.kcalPer100g ?? existing.kcalPer100g,
    ...(servingGrams === undefined ? {} : { servingGrams }),
    ...(servingLabel === undefined ? {} : { servingLabel }),
    ...(imageUri === undefined ? {} : { imageUri }),
  };
  return isPlausibleCatalogEntry(next) ? next : null;
}

/**
 * Convierte los macros de **una porción** editados a mano a la base por 100 g
 * del catálogo.
 *
 * Es el camino de vuelta de `scaleCatalogFoodByServings`, y el que se necesita
 * cuando la usuaria corrige una comida que vino del catálogo y elige "editar
 * el alimento del catálogo". Sin esto habría que hacer la regla de tres en un
 * componente, que es exactamente donde `AGENTS.md` no quiere cálculos que
 * terminan sugiriendo carbohidratos.
 */
export function catalogEntryFromPortion(
  base: CatalogFood,
  portion: { grams: number; carbsG: number; proteinG: number; fatG: number; fiberG: number; caloriesKcal: number },
  seenAt: string,
): Omit<CatalogFood, 'timesSeen'> | null {
  if (!Number.isFinite(portion.grams) || portion.grams < MIN_CATALOG_GRAMS) return null;
  const per100 = (value: number): number => Number(((value / portion.grams) * 100).toFixed(2));
  const entry: Omit<CatalogFood, 'timesSeen'> = {
    key: base.key,
    name: base.name,
    carbsPer100g: per100(portion.carbsG),
    proteinPer100g: per100(portion.proteinG),
    fatPer100g: per100(portion.fatG),
    fiberPer100g: per100(portion.fiberG),
    kcalPer100g: per100(portion.caloriesKcal),
    lastSeenAt: seenAt,
    ...(base.servingGrams === undefined ? {} : { servingGrams: base.servingGrams }),
    ...(base.servingLabel === undefined ? {} : { servingLabel: base.servingLabel }),
    ...(base.imageUri === undefined ? {} : { imageUri: base.imageUri }),
  };
  return isPlausibleCatalogEntry(entry) ? entry : null;
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
