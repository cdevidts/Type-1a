/**
 * Qué calculadora abre el asistente, y cómo se decide.
 *
 * ## La arquitectura, en las palabras de Verónica
 *
 * > "mi texto → agente determina cuáles palabras del ruteo corresponden a lo
 * > que dije → ruteo de palabras → respuesta. Y con fallback a la IA para que
 * > nunca falte una respuesta coherente."
 *
 * Son tres capas, y este módulo es la del medio:
 *
 * 1. **El teléfono normaliza y reconoce raíces** (acá). Instantáneo, sin red.
 * 2. **El modelo decide** cuando lo de arriba no alcanza, con el campo `opens`
 *    del turno — un enum, sin lugar donde escribir una dosis.
 * 3. **Cualquier rechazo lleva botón**, pase lo que pase.
 *
 * ## Por qué raíces y no frases
 *
 * La primera versión listaba frases y se le escapó todo lo que ella escribe de
 * verdad: "Quiero corregirme", "Quiero hacerme una corregida". Una lista de
 * frases no cubre cómo habla una persona, y ella lo dijo con todas sus letras:
 * *"no puede ser que palabras clave determinen la respuesta, es el contenido
 * lo que importa"*.
 *
 * "corregirme", "corregida", "corrección", "corrijo" y "corregir" comparten la
 * raíz **correg/correcc/corrij**. Reconocer la raíz sobre el texto normalizado
 * —sin tildes, en minúsculas— cubre la familia entera, incluido cómo se escribe
 * con apuro y sin acentos desde el teléfono.
 */
export type CalculatorRoute = 'correction' | 'meal';

/** Minúsculas y sin tildes: así se escribe de verdad desde un teléfono. */
function normalize(text: string): string {
  return text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/gu, '');
}

/** Corregirse la glucosa. En esta app la palabra no significa otra cosa. */
const CORRECTION_STEM = /\b(?:correg|correc|corrij|corrid)/u;

/** Pincharse: la acción, en todas sus formas, en los dos idiomas. */
const INJECT_STEM =
  /\b(?:insulin|unidad|bolo|dosis|pinch|inyect|pongo|poner|puse|unit|bolus|dose|inject|shot)/u;

/** Pregunta por una cantidad. */
const AMOUNT_ASK = /\b(?:cuant|que cantidad|how much|how many)/u;

/**
 * Preguntas que mencionan insulina pero **no** piden una dosis ahora.
 *
 * Lo marcó la revisión de seguridad: navegar cuesta mucho más que responder,
 * así que "¿cuántas horas dura mi basal?" no puede terminar en una calculadora.
 */
const INFORMATIONAL = /\b(?:cuant\w*)\s+(?:horas?|minutos?|dias?|tiempo|dura|duran|demora|veces)/u;

/** Está contando algo que ya hizo, no preguntando. */
const IS_A_LOG = /\b(?:me\s+)?(?:puse|inyecte|pinche|tome|comi|bebi)\b/u;

const MEAL_CONTEXT =
  /\b(?:comida|comer|comi|almuerzo|desayuno|once|cena|colacion|carbohidrat|carbos|hidratos|plato|pan|arroz|fideos|tallarines|postre|racion|meal|carbs)/u;

/**
 * Qué calculadora corresponde, o `null` si la frase no pide una dosis.
 *
 * Lo importante de leer acá es **el orden**: primero se descarta lo que no es
 * una petición (informativas y registros), y recién después se busca la
 * intención. Al revés, "me puse 4 de rápida" abriría una calculadora encima de
 * un dato que ella acaba de dictar — y eso ya pasó una vez.
 */
export function insulinQuestionOpensCalculator(text: string): CalculatorRoute | null {
  const t = normalize(text);

  // "¿cuántas horas dura la basal?" pregunta por insulina y no pide dosis.
  if (INFORMATIONAL.test(t)) return null;

  const wantsCorrection = CORRECTION_STEM.test(t);
  // Pedir una cantidad, o preguntar si corresponde pincharse ahora.
  const asksAmount = AMOUNT_ASK.test(t) && INJECT_STEM.test(t);
  const shouldInjectNow = /\b(?:debo|tengo que|deberia|me conviene|me toca)\b/u.test(t)
    && (INJECT_STEM.test(t) || wantsCorrection);
  const asksToCalculate = /\b(?:calcul)/u.test(t) && (INJECT_STEM.test(t) || wantsCorrection);
  // "me pincho?" y "ayúdame con la dosis" no dicen una cantidad ni un verbo de
  // obligación, pero están pidiendo exactamente lo mismo. La forma de pregunta
  // —o de pedido de ayuda— sobre la acción de pincharse ya es la intención.
  const asksAboutInjecting = (t.includes('?') || /\b(?:ayud|help)/u.test(t)) && INJECT_STEM.test(t);

  const wantsADose = wantsCorrection || asksAmount || shouldInjectNow || asksToCalculate
    || asksAboutInjecting;
  if (!wantsADose) return null;

  // Un registro no abre nada… salvo que además pregunte de verdad por la dosis.
  if (IS_A_LOG.test(t) && !asksAmount && !asksToCalculate && !wantsCorrection) return null;

  return MEAL_CONTEXT.test(t) ? 'meal' : 'correction';
}
