const THERAPY_PATTERNS = [
  /\b(?:ponte|iny[eé]ctate|admin[ií]strate|usa|aumenta|reduce|ajusta)\b.{0,45}\b(?:u|unidad(?:es)?|insulina|basal|bolo)\b/iu,
  /\b(?:cambia|modifica|ajusta)\b.{0,35}\b(?:ratio|factor|dosis|terapia)\b/iu,
  /\b(?:deber[ií]as?|te recomiendo)\b.{0,45}\b(?:insulina|dosis|bolo|basal)\b/iu,
  /\b\d+(?:[.,]\d+)?\s*(?:u|unidad(?:es)?)\s+(?:m[aá]s|menos)\b/iu,
];

export function containsTherapyRecommendation(value: unknown): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return THERAPY_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Patrones de una instrucción que **pide** consejo de insulina, no de una
 * respuesta que lo da.
 *
 * Son distintos de `THERAPY_PATTERNS` a propósito: aquellos buscan
 * imperativos y recomendaciones ("ponte 4 U", "deberías subir la basal"),
 * que es la forma que toma una *salida* insegura. Una *entrada* insegura es
 * una pregunta ("¿cuánta insulina me pongo?", "calcula el bolo") y no
 * dispara ninguno de esos patrones.
 */
const INSULIN_REQUEST_PATTERNS = [
  /\b(?:cu[aá]nt[ao]s?|qu[eé])(?![a-záéíóúñ]).{0,40}\b(?:insulina|unidad(?:es)?|bolo|basal|dosis)\b/iu,
  /\b(?:calcula|calcular|c[aá]lcula(?:me)?|dime|dime cu[aá]nto|sugiere|sugi[eé]reme|recomienda|recomi[eé]ndame|corr[ií]geme|ind[ií]came)\b.{0,40}\b(?:insulina|unidad(?:es)?|bolo|basal|dosis|correcci[oó]n|ratio|factor)\b/iu,
  // "¿cuánta me pongo?" no nombra la insulina, así que no cae en el patrón de
  // arriba. Se exige la forma de pregunta o de obligación: "me pongo" suelto
  // aparecería en notas legítimas ("me pongo nervioso antes de comer").
  /\b(?:cu[aá]nt[ao]s?|qu[eé])(?![a-záéíóúñ]).{0,20}\b(?:me pongo|me inyecto|me administro|me pincho)\b/iu,
  /\b(?:debo|tengo que|deber[ií]a)\s+(?:ponerme|inyectarme|administrarme|pincharme)\b/iu,
  /\b(?:how much|how many)\b.{0,30}\b(?:insulin|units?|bolus|basal|dose)\b/iu,
];

/**
 * ¿La instrucción de edición está pidiendo que la IA calcule o recomiende
 * insulina?
 *
 * Se filtra **antes** de llamar al modelo, no después. `AGENTS.md` prohíbe
 * que un LLM calcule, infiera o recomiende insulina; el filtro de salida
 * (`containsTherapyRecommendation`) es la última línea, no la primera. Una
 * pregunta así no debería llegar nunca al proveedor: manda a un servicio
 * externo el dato de que alguien está por dosificarse, gasta la llamada, y
 * deja al usuario esperando un rechazo que ya se podía dar de inmediato.
 *
 * Falso positivo aceptado a conciencia: "sácale la insulina de la nota" se
 * rechaza. El costo es un mensaje explicando por qué; el costo del falso
 * negativo es una recomendación de dosis.
 */
export function requestsInsulinAdvice(instruction: string): boolean {
  return INSULIN_REQUEST_PATTERNS.some((pattern) => pattern.test(instruction));
}
