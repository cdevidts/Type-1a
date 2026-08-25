/**
 * Cuidado al editar: **`\b` en JavaScript es ASCII**. Después de una vocal
 * acentuada no hay frontera de palabra, así que `solapó\b` no matchea nunca.
 * Donde una alternativa puede terminar en acento va `(?![a-záéíóúñ])`, que es
 * el mismo arreglo que ya se aplicó en `INSULIN_REQUEST_PATTERNS`.
 */
const THERAPY_PATTERNS = [
  /\b(?:ponte|iny[eé]ctate|admin[ií]strate|usa|aumenta|reduce|ajusta)\b.{0,45}\b(?:u|unidad(?:es)?|insulina|basal|bolo)\b/iu,
  /\b(?:cambia|modifica|ajusta)\b.{0,35}\b(?:ratio|factor|dosis|terapia)\b/iu,
  /\b(?:deber[ií]as?|te recomiendo)\b.{0,45}\b(?:insulina|dosis|bolo|basal)\b/iu,
  /\b\d+(?:[.,]\d+)?\s*(?:u|unidad(?:es)?)\s+(?:m[aá]s|menos)\b/iu,

  // ── Insulina activa (IOB) ────────────────────────────────────────────────
  // Agregados 2026-08-22 tras la revisión de seguridad de la Fase 23. El
  // prompt v3 le pasa al modelo la lista de dosis de la ventana con sus
  // unidades y minutos, así que por primera vez tiene material para afirmar
  // superposición: "la segunda dosis se solapó con la primera, que todavía
  // estaba activa". Eso NO es una recomendación —los cuatro patrones de
  // arriba no lo tocan— pero sí es una estimación de insulina activa
  // presentada a la usuaria, y `AGENTS.md` prohíbe IOB en el MVP tanto como
  // prohíbe recomendar dosis. Al crecer lo que el modelo puede decir, tiene
  // que crecer el filtro.
  /\binsulina\s+activa(?![a-záéíóúñ])/iu,
  /\b(?:dosis|bolo|insulina|correcci[oó]n|unidades?)\b.{0,60}\b(?:todav[ií]a|a[uú]n|segu[ií]a|sigue|seguía)\b.{0,25}\b(?:activ[ao]s?|actuando|haciendo efecto)/iu,
  /\bse\s+solap(?:o|ó|aba|aban|aron|an)(?![a-záéíóúñ]).{0,50}\b(?:dosis|bolo|insulina|correcci[oó]n)/iu,
  /\b(?:dosis|bolo|insulina|correcci[oó]n)\b.{0,50}\bse\s+solap(?:o|ó|aba|aban|aron|an)(?![a-záéíóúñ])/iu,

  // ── Juicio de suficiencia sobre una dosis ────────────────────────────────
  // "fue insuficiente" / "se quedó corta" / "hizo falta más insulina" son
  // evaluaciones de una dosis, que es lo que el prompt prohíbe en palabras y
  // esto respalda en estructura.
  /\b(?:dosis|bolo|insulina|correcci[oó]n)\b.{0,50}\b(?:insuficiente|excesiv[ao]s?|de m[aá]s|de menos|se qued[oó] cort[ao]|no alcanz(?:o|ó)(?![a-záéíóúñ]))/iu,
  /\b(?:hizo falta|habr[ií]a hecho falta|falt(?:o|ó)(?![a-záéíóúñ])).{0,45}\b(?:insulina|dosis|bolo|basal|correcci[oó]n|unidades?)\b/iu,

  // ── Sugerencia para la próxima vez ───────────────────────────────────────
  // Solo cuando va pegada a vocabulario de dosis: "la próxima vez que haya
  // más lecturas" es una limitación legítima y no debe suprimir el insight.
  /\b(?:la pr[oó]xima vez|para la pr[oó]xima)\b.{0,60}\b(?:insulina|dosis|bolo|basal|correcci[oó]n|unidades?|pre-?bolo|bolear)\b/iu,
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
