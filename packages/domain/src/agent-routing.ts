import { requestsInsulinAdvice } from './ai-safety';

/**
 * Qué calculadora abre el asistente cuando ella pregunta por una dosis.
 *
 * ## Por qué existe
 *
 * Verónica lo reportó con el teléfono en la mano: *"si le digo 'me quiero
 * corregir, cuánto me pincho', me dice 'no puedo decirte eso, pero puedo abrir
 * el modal'. Obviamente que no quiero que me diga él, pero quiero que
 * automáticamente abra el modal y cargue mi glucosa del sensor."*
 *
 * Tenía razón, y el rechazo solo con palabras era el error. **La prohibición
 * sigue intacta:** ningún modelo calcula, infiere ni recomienda insulina
 * (`AGENTS.md`). Lo que cambia es qué pasa después de negarse: en vez de
 * dejarla en un callejón, se abre la calculadora de la app, que hace la
 * aritmética con los parámetros que **ella** cargó y muestra el desglose
 * entero. Eso siempre estuvo permitido; simplemente no se alcanzaba desde el
 * chat.
 *
 * ## Por qué corre en el teléfono
 *
 * Sin red, sin esperar, y sin gastar una llamada. Preguntar "cuánto me pincho"
 * y quedarse mirando un "Pensando…" es justo el momento en que la app tiene
 * que ser instantánea.
 */
export type CalculatorRoute = 'correction' | 'meal';

/**
 * Señales de que la pregunta es por una comida y no por una corrección suelta.
 *
 * Ante la duda **gana `correction`**, y no es arbitrario: la calculadora de
 * corrección parte de la glucosa actual, que es el dato que ella ya tiene en
 * pantalla, y desde el Modal Maestro se puede agregar la comida después. Al
 * revés —abrir el formulario de comida cuando solo quería corregirse— la
 * obliga a cerrar y volver a empezar.
 */
const MEAL_QUESTION_PATTERN =
  /\b(?:comida|comer|com[ií]|almuerzo|desayuno|once|cena|colaci[oó]n|carbohidratos?|carbos?|hidratos|plato|pan|arroz|fideos|tallarines|postre|raci[oó]n|bolo de comida|meal|carbs?)\b/iu;

/**
 * Preguntas por una **cantidad, ahora**: "cuánto me pongo", "cuántas unidades".
 *
 * `requestsInsulinAdvice` es más ancho a propósito, y su comentario lo declara:
 * acepta falsos positivos porque *"el costo es un mensaje explicando por qué"*.
 * Eso valía cuando la respuesta era un mensaje. **Navegar tiene un costo mucho
 * mayor**, así que para mover la pantalla hace falta esta segunda condición,
 * más estrecha. Lo cazó la revisión de seguridad con tres casos reales:
 * "¿qué pasa si me salto la basal?", "no sé qué pasó con la dosis de ayer" y
 * "cuántas horas dura mi insulina basal" caían todas en la calculadora.
 *
 * Lo que NO cambia es el rechazo: una frase que `requestsInsulinAdvice`
 * detecta y esta no, sigue yendo al backend y sigue siendo rechazada con
 * palabras. Ancho para negarse, estrecho para navegar.
 */
const DOSE_AMOUNT_QUESTION_PATTERN =
  /\b(?:cu[aá]nt[ao]s?)(?![a-záéíóúñ])(?!\s+(?:horas?|minutos?|d[ií]as?|tiempo|dura|duran|demora))[^.?!]{0,40}\b(?:insulina|unidad(?:es)?|bolo|me pongo|me inyecto|me administro|me pincho)\b/iu;

const EXPLICIT_CALCULATE_PATTERN =
  /\b(?:cal[cq]ula(?:me)?|calcular|corr[ií]geme|me quiero corregir|quiero corregirme|necesito corregir(?:me)?)\b/iu;

/**
 * "¿debo ponerme insulina?" no pregunta una cantidad, pero sí pregunta por
 * pincharse **ahora**: abrirle la calculadora es justo lo útil, porque ahí ve
 * los números y decide ella. Es distinto de "¿qué pasa si me salto la basal?",
 * que no es sobre este momento.
 */
const SHOULD_INJECT_NOW_PATTERN =
  /\b(?:debo|tengo que|deber[ií]a|me conviene)\s+(?:ponerme|inyectarme|administrarme|pincharme|corregirme)\b/iu;

const ENGLISH_AMOUNT_PATTERN =
  /\b(?:how much|how many)\b[^.?!]{0,30}\b(?:insulin|units?|bolus)\b/iu;

/**
 * `null` cuando la frase no está pidiendo **cuánta** insulina ponerse ahora.
 *
 * Se apoya en `requestsInsulinAdvice` como primera condición a propósito, en
 * vez de escribir un detector paralelo: ese es el mismo predicado con el que el
 * backend decide rechazar, así que **lo que el servidor considera "está
 * pidiendo insulina" y lo que el teléfono considera "abro la calculadora" no
 * pueden divergir** (Regla 1 de `systemPatterns.md`; `macrosSource` ya costó
 * tres bugs por ignorarla). La segunda condición solo **estrecha**: nunca
 * navega por algo que el servidor no habría rechazado.
 */
export function insulinQuestionOpensCalculator(text: string): CalculatorRoute | null {
  if (!requestsInsulinAdvice(text)) return null;
  const asksForAnAmount = DOSE_AMOUNT_QUESTION_PATTERN.test(text)
    || EXPLICIT_CALCULATE_PATTERN.test(text)
    || SHOULD_INJECT_NOW_PATTERN.test(text)
    || ENGLISH_AMOUNT_PATTERN.test(text);
  if (!asksForAnAmount) return null;
  return MEAL_QUESTION_PATTERN.test(text) ? 'meal' : 'correction';
}
