import { foodKey, type CatalogFood } from './food-catalog';

/**
 * Encontrar el alimento del catálogo que la usuaria **probablemente ya tiene**,
 * para ofrecérselo en vez de crear un duplicado.
 *
 * ## La regla que gobierna el módulo: solo propone, nunca fusiona
 *
 * Emparejar mal mezcla los macros de dos alimentos distintos, y esa mezcla
 * después sugiere carbohidratos en cada comida que reuse el alimento, sin que
 * nada delate el error. Un duplicado, en cambio, es feo y **reversible**.
 *
 * Por eso todo lo de acá devuelve *candidatos con su razón* y la decisión la
 * toma la usuaria en la pantalla de confirmación. Y por eso las heurísticas
 * son deliberadamente pocas: cada una que se agregue amplía la superficie de
 * un error silencioso.
 *
 * ## Qué NO hace, a propósito
 *
 * - **No empareja por subconjunto.** "arroz" y "arroz integral" son alimentos
 *   distintos con macros distintos; tratarlos como el mismo es exactamente el
 *   error caro.
 * - **No usa distancia de edición.** "pera" y "peras" sí; "pera" y "pena" no,
 *   y una distancia de 1 no sabe distinguirlas.
 * - **No lematiza con diccionario.** `foodKey` ya decidió no hacerlo.
 */

/** Palabras de unión que no distinguen un plato de otro. */
const STOPWORDS = new Set(['con', 'de', 'del', 'la', 'el', 'los', 'las', 'y', 'a', 'al', 'en']);

/**
 * Quita el plural español más común. Conservador a propósito: solo `-es` tras
 * consonante y `-s` tras vocal, que es donde el riesgo de confundir dos
 * palabras distintas es bajo.
 */
export function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (/[^aeiou]es$/u.test(word)) return word.slice(0, -2);
  if (/[aeiou]s$/u.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * El conjunto de palabras significativas de un nombre, en singular y sin
 * palabras de unión. "Arroz con pollo" y "pollo y arroz" dan el mismo.
 */
export function significantTokens(name: string): Set<string> {
  const tokens = foodKey(name)
    .split(' ')
    .filter((token) => token !== '' && !STOPWORDS.has(token))
    .map(singularize);
  return new Set(tokens);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size || a.size === 0) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** Por qué se propone este candidato. Se muestra: la usuaria decide con esto. */
export type SimilarityReason =
  /** Misma clave normalizada. Es el mismo nombre. */
  | 'exacto'
  /** Mismas palabras significativas, en cualquier orden y número. */
  | 'mismas-palabras';

export interface SimilarFood {
  food: CatalogFood;
  reason: SimilarityReason;
}

export function similarityLabel(reason: SimilarityReason): string {
  switch (reason) {
    case 'exacto':
      return 'Ya tienes este alimento';
    case 'mismas-palabras':
      return 'Se parece a uno que ya tienes';
  }
}

/**
 * El alimento del catálogo que más se parece a `name`, o `null`.
 *
 * Devuelve **uno solo**: ofrecer una lista de parecidos convierte una
 * confirmación en una tarea de desambiguación, y el objetivo es que reusar sea
 * más fácil que duplicar, no al revés. La coincidencia exacta siempre gana.
 */
export function findSimilarFood(
  name: string,
  catalog: readonly CatalogFood[],
): SimilarFood | null {
  const key = foodKey(name);
  if (key === '') return null;

  const exact = catalog.find((food) => food.key === key);
  if (exact !== undefined) return { food: exact, reason: 'exacto' };

  const tokens = significantTokens(name);
  if (tokens.size === 0) return null;
  // El más usado gana el desempate: es el que ella ya viene reutilizando.
  const byTimesSeen = [...catalog].sort((a, b) => b.timesSeen - a.timesSeen);
  const loose = byTimesSeen.find((food) => sameSet(tokens, significantTokens(food.name)));
  return loose === undefined ? null : { food: loose, reason: 'mismas-palabras' };
}

/**
 * Qué alimentos **ya existentes** cubren un análisis de varios alimentos.
 *
 * Es lo que permite ofrecer "arma la receta con el arroz y el pollo que ya
 * tienes" en vez de crear copias nuevas de los dos.
 */
export interface RecipeReuseCandidates {
  /** Nombre del análisis → alimento del catálogo que lo cubre. */
  matched: { analysedName: string; similar: SimilarFood }[];
  /** Nombres que no tienen equivalente y habría que dar de alta. */
  unmatched: string[];
}

export function matchAnalysedFoods(
  names: readonly string[],
  catalog: readonly CatalogFood[],
): RecipeReuseCandidates {
  const matched: RecipeReuseCandidates['matched'] = [];
  const unmatched: string[] = [];
  const used = new Set<string>();
  for (const name of names) {
    const similar = findSimilarFood(name, catalog);
    // Un alimento del catálogo no puede cubrir dos líneas del análisis: si la
    // foto trae "arroz" y "arroz integral", emparejar los dos con el mismo
    // `arroz` colapsaría dos cosas distintas en una.
    if (similar === null || used.has(similar.food.key)) {
      unmatched.push(name);
      continue;
    }
    used.add(similar.food.key);
    matched.push({ analysedName: name, similar });
  }
  return { matched, unmatched };
}
