import {
  foodKey,
  isPlausibleCatalogEntry,
  isValidServingGrams,
  normalizationBasis,
  toCatalogEntry,
  type CatalogFood,
} from './food-catalog';
import { findSimilarFood, type SimilarFood } from './catalog-similarity';
import type { FoodEstimate } from '@type1a/schemas';

/**
 * Lo que la IA **propone** guardar en el catálogo, antes de que la usuaria lo
 * confirme.
 *
 * ## Por qué existe este paso
 *
 * Hasta ahora un análisis escribía directo al catálogo, y eso producía dos
 * fallas opuestas que Verónica encontró el mismo día:
 *
 * 1. **Lo que no se podía normalizar desaparecía sin decir nada.** Una Monster
 *    Zero descrita por texto vuelve con `estimatedGrams: null` —el prompt se
 *    lo pide así cuando no puede estimar la porción— y `toCatalogEntry` la
 *    descartaba. La pantalla decía "guardado" y el catálogo quedaba igual.
 * 2. **Todo quedaba con porción de 100 g**, porque la IA no podía proponer
 *    porción y `servingGramsOf` caía a su default. Reusar un alimento obligaba
 *    a averiguar por fuera qué fracción de 100 g es una porción de verdad.
 *
 * Las dos son el mismo hueco: faltaba saber **cuánto pesa una porción**. Con
 * eso hay denominador para normalizar y hay porción que mostrar.
 *
 * ## Por qué se confirma en vez de aplicarse solo
 *
 * La porción multiplica los cuatro macros, así que termina alimentando los
 * carbohidratos que se sugieren al reusar el alimento. Un número que la IA
 * inventó y nadie miró no puede entrar por esa puerta. Confirmar lo convierte
 * en un dato de la usuaria (`servingSource: 'user'`), y desde ahí ningún
 * análisis posterior lo pisa — ver `blendCatalogEntry`.
 *
 * Nada de esto calcula ni sugiere insulina: son gramos de alimento.
 */

/** De dónde salió el denominador con el que se normalizó a 100 g. */
export type NormalizationBasis = 'plate' | 'serving';

export interface CatalogProposal {
  /** La entrada ya normalizada por 100 g, lista para guardar. */
  entry: Omit<CatalogFood, 'timesSeen'>;
  basis: NormalizationBasis;
  /** Gramos con los que se normalizó. Se muestra para que sea auditable. */
  basisGrams: number;
  /** La porción que propuso la IA, cruda. `null` si no propuso ninguna. */
  proposedServingGrams: number | null;
  proposedServingLabel: string | null;
  /**
   * Ya existe en el catálogo. Confirmar es **fusionar**, no dar de alta, y la
   * pantalla tiene que decirlo: son dos consecuencias distintas.
   */
  existing: boolean;
  /**
   * La porción que ya tenía la usuaria para este alimento, si la había.
   * Cuando existe, es la que manda: se ofrece conservarla, no reemplazarla.
   */
  existingServingGrams: number | null;
  /**
   * Un alimento del catálogo que **probablemente ya es este**, cuando el
   * nombre no coincide exacto ("manzanas" vs "manzana", "pollo con arroz" vs
   * "arroz con pollo"). Se muestra para que ella decida; nunca se fusiona sola.
   */
  similarTo: SimilarFood | null;
}

/** Por qué un alimento del análisis no se puede ofrecer siquiera. */
export type CatalogRejectionReason =
  /** Ni gramos del plato ni porción típica: no hay denominador. */
  | 'sin-base'
  /** Nombre vacío o que se normaliza a nada. */
  | 'sin-nombre'
  /** Valores por 100 g fuera de lo físicamente posible. */
  | 'inverosimil';

export interface CatalogRejection {
  name: string;
  reason: CatalogRejectionReason;
}

export interface CatalogProposalSet {
  proposals: CatalogProposal[];
  /** Lo que no se puede guardar, **con su razón**, para poder decirlo. */
  rejected: CatalogRejection[];
  /** La foto del plato, para que la receta la conserve. */
  imageUri?: string | undefined;
  /**
   * Nombre propuesto para la receta: los alimentos unidos por "con".
   *
   * Es un punto de partida editable, no una afirmación. `undefined` con un
   * solo alimento, donde una receta no significa nada.
   */
  suggestedRecipeName?: string | undefined;
}

/** Texto para la usuaria. Vive acá porque la razón es una regla, no una vista. */
export function rejectionMessage(rejection: CatalogRejection): string {
  switch (rejection.reason) {
    case 'sin-base':
      return `${rejection.name}: no se sabe cuánto pesa una porción, así que no se puede guardar por 100 g. Escribe los gramos y se guarda.`;
    case 'sin-nombre':
      return 'Un alimento llegó sin nombre y no se puede guardar.';
    case 'inverosimil':
      return `${rejection.name}: la estimación da valores imposibles por 100 g. Revísala antes de guardarla.`;
  }
}

/**
 * Arma las propuestas de catálogo de un análisis.
 *
 * `existingByKey` es el catálogo actual: sirve para decir si confirmar es un
 * alta o una fusión, y para no ofrecer reemplazar una porción que la usuaria
 * ya fijó a mano.
 */
export function buildCatalogProposals(
  foods: readonly FoodEstimate[],
  input: {
    seenAt: string;
    imageUri?: string | undefined;
    existingByKey?: ReadonlyMap<string, CatalogFood> | undefined;
  },
): CatalogProposalSet {
  const existingByKey = input.existingByKey ?? new Map<string, CatalogFood>();
  const proposals = new Map<string, CatalogProposal>();
  const rejected: CatalogRejection[] = [];

  for (const food of foods) {
    const name = food.name.trim();
    if (foodKey(name) === '') {
      rejected.push({ name, reason: 'sin-nombre' });
      continue;
    }
    const basisGrams = normalizationBasis(food);
    if (basisGrams === null) {
      rejected.push({ name, reason: 'sin-base' });
      continue;
    }
    const entry = toCatalogEntry(food, input.seenAt, input.imageUri);
    if (entry === null || !isPlausibleCatalogEntry(entry)) {
      rejected.push({ name, reason: 'inverosimil' });
      continue;
    }
    const plate = food.estimatedGrams;
    const usedPlate = plate !== null && Number.isFinite(plate) && plate === basisGrams;
    const existing = existingByKey.get(entry.key);
    const existingServing = existing?.servingGrams;
    // El último gana, igual que en `catalogEntriesFrom`: un análisis que nombra
    // dos veces el mismo alimento es más probable que se esté corrigiendo.
    proposals.set(entry.key, {
      entry,
      basis: usedPlate ? 'plate' : 'serving',
      basisGrams,
      proposedServingGrams: food.servingGrams !== null && isValidServingGrams(food.servingGrams)
        ? food.servingGrams
        : null,
      proposedServingLabel: food.servingLabel !== null && food.servingLabel.trim() !== ''
        ? food.servingLabel.trim()
        : null,
      existing: existing !== undefined,
      existingServingGrams: existingServing !== undefined && isValidServingGrams(existingServing)
        ? existingServing
        : null,
      // Solo tiene sentido si NO es el mismo por clave: cuando ya existe, la
      // fusión es un hecho y `existing` ya lo dice.
      similarTo: existing !== undefined
        ? null
        : findSimilarFood(name, [...existingByKey.values()]),
    });
  }

  const list = [...proposals.values()];
  return {
    proposals: list,
    rejected,
    ...(input.imageUri === undefined ? {} : { imageUri: input.imageUri }),
    ...(list.length > 1
      ? { suggestedRecipeName: list.map((proposal) => proposal.entry.name).join(' con ') }
      : {}),
  };
}

/**
 * Qué porción mostrar precargada en la pantalla de confirmación.
 *
 * **La de la usuaria manda sobre la de la IA.** Si ya fijó "una taza son
 * 150 g", la pantalla no puede llegar con los 200 g que propuso esta foto:
 * confirmarla sin mirar reemplazaría su dato por uno automático, que es
 * exactamente lo que este paso viene a evitar.
 */
export function initialServingGrams(proposal: CatalogProposal): number | null {
  return proposal.existingServingGrams ?? proposal.proposedServingGrams;
}

/**
 * Aplica lo que la usuaria confirmó y devuelve la entrada lista para guardar.
 *
 * `servingGrams` en `null` = decidió no fijar porción; el alimento se guarda
 * igual y `servingGramsOf` seguirá cayendo a 100 g. Un `null` no es un error:
 * hay alimentos sin porción convencional.
 *
 * Todo lo que sale de acá va marcado `'user'`, incluso cuando aceptó el número
 * de la IA sin cambiarlo: **lo miró y dijo que sí**, y eso es justo lo que
 * protege `blendCatalogEntry` de un análisis futuro.
 */
export function confirmProposal(
  proposal: CatalogProposal,
  confirmed: { servingGrams: number | null; servingLabel: string | null },
): Omit<CatalogFood, 'timesSeen'> | null {
  // Los tres campos de porción se reconstruyen desde cero en vez de spreadear
  // y pisar: con `exactOptionalPropertyTypes`, "sin porción" tiene que dejar
  // la propiedad **fuera** del objeto, no puesta en `undefined`.
  const base: Omit<CatalogFood, 'timesSeen' | 'servingGrams' | 'servingLabel' | 'servingSource'> = {
    key: proposal.entry.key,
    name: proposal.entry.name,
    carbsPer100g: proposal.entry.carbsPer100g,
    proteinPer100g: proposal.entry.proteinPer100g,
    fatPer100g: proposal.entry.fatPer100g,
    fiberPer100g: proposal.entry.fiberPer100g,
    kcalPer100g: proposal.entry.kcalPer100g,
    lastSeenAt: proposal.entry.lastSeenAt,
    ...(proposal.entry.imageUri === undefined ? {} : { imageUri: proposal.entry.imageUri }),
  };
  const grams = confirmed.servingGrams;
  if (grams !== null && !isValidServingGrams(grams)) return null;
  const label = confirmed.servingLabel !== null && confirmed.servingLabel.trim() !== ''
    ? confirmed.servingLabel.trim()
    : undefined;
  const next: Omit<CatalogFood, 'timesSeen'> = {
    ...base,
    ...(grams === null ? {} : { servingGrams: grams, servingSource: 'user' as const }),
    ...(label === undefined ? {} : { servingLabel: label }),
  };
  return isPlausibleCatalogEntry(next) ? next : null;
}
