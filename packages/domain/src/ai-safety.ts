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
