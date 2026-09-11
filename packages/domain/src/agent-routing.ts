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
 * `null` cuando la frase no está pidiendo una dosis.
 *
 * Se apoya en `requestsInsulinAdvice` a propósito, en vez de escribir un
 * detector paralelo: ese es el mismo predicado con el que el backend decide
 * rechazar, así que **lo que el servidor considera "está pidiendo insulina" y
 * lo que el teléfono considera "abro la calculadora" no pueden divergir**. Un
 * segundo juego de patrones habría abierto justo esa grieta — es la Regla 1 de
 * `systemPatterns.md`, y `macrosSource` ya costó tres bugs por ignorarla.
 */
export function insulinQuestionOpensCalculator(text: string): CalculatorRoute | null {
  if (!requestsInsulinAdvice(text)) return null;
  return MEAL_QUESTION_PATTERN.test(text) ? 'meal' : 'correction';
}
