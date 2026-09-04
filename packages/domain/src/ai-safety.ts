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
  // presentada a la usuaria por un modelo de lenguaje.
  //
  // El 2026-09-02 la app SÍ empezó a estimar insulina activa (ADR 0005), y
  // esto **no se relaja por eso**: al contrario. La estimación válida es la
  // de `iob.ts` —determinista, con un modelo citado, sobre la duración que
  // ella configuró, y mostrada con su desglose—. Una frase generada que diga
  // lo mismo con otras palabras no tiene ninguna de esas propiedades y sería
  // indistinguible para quien la lee. Al crecer lo que el modelo puede decir,
  // tiene que crecer el filtro.
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

  // ── Juicio o consejo sobre la HORA de comer ──────────────────────────────
  // Agregados 2026-09-01, junto con `episode-local-time.ts`. Hasta ahora el
  // modelo recibía la hora en UTC: un dato sin significado para la vida de
  // quien registró la comida —ese era justo el bug—. Ahora recibe la hora de
  // pared local y el prompt le dice explícitamente que es la hora real de esa
  // persona, así que por primera vez tiene material para juzgarla: "cenar tan
  // tarde no ayuda", "la próxima vez intenta cenar más temprano". Eso no toca
  // ninguno de los patrones de dosis y sin embargo es exactamente lo que
  // `AGENTS.md` y el prompt prohíben — evaluar si algo estuvo bien hecho y
  // decir qué hacer distinto. Al crecer lo que el modelo puede decir, crece
  // el filtro; es la misma regla que trajo los patrones de IOB de la Fase 23.
  //
  // Lo DESCRIPTIVO sigue pasando a propósito: "la comida fue a las 21:30" y
  // "las cenas más tardías mostraron picos más altos" describen lo que pasó,
  // que es justamente el trabajo de este resumen. Lo que se bloquea es el
  // marcador de consejo o de juicio pegado a la hora de una comida.
  ...timingAdvicePatterns(),
];

/**
 * Consejo o juicio sobre CUÁNDO comer, en sus dos órdenes de palabras.
 *
 * Se arma en una función porque son las mismas tres listas combinadas
 * —marcador de consejo, palabra de comida, palabra de hora— y escribir las
 * cuatro variantes a mano fue cómo se colaron huecos en los patrones de dosis.
 *
 * `TIMING` no incluye "antes"/"después" sueltos ni "hora" a secas: aparecen en
 * limitaciones legítimas ("registra la comida antes de guardarla") y un falso
 * positivo acá no cuesta un mensaje, cuesta el insight entero.
 */
function timingAdvicePatterns(): RegExp[] {
  const ADVICE = 'la pr[oó]xima vez|para la pr[oó]xima|intenta|prueba|procura|convien(?:e|en)|convendr[ií]a|ser[ií]a (?:mejor|bueno|ideal)|lo ideal ser[ií]a|te recomiendo|recomendable|deber[ií]as?|evita|adelanta(?:r)?|atrasa(?:r)?|retrasa(?:r)?';
  const MEAL = 'cen(?:a|ar|as)(?![a-záéíóúñ])|com(?:e|er|ida|idas)(?![a-záéíóúñ])|desayun(?:o|os|a|ar)(?![a-záéíóúñ])|almuerzos?(?![a-záéíóúñ])|almorzar|colaci[oó]n|merienda';
  const TIMING = 'm[aá]s temprano|m[aá]s tarde|m[aá]s pronto|tan tarde|tan temprano|demasiado tarde|demasiado temprano|a otra hora|antes de (?:las|comer|dormir|acostarte)|adelantar|atrasar|retrasar';
  return [
    new RegExp(`\\b(?:${ADVICE})\\b.{0,40}\\b(?:${MEAL})\\b.{0,30}\\b(?:${TIMING})`, 'iu'),
    new RegExp(`\\b(?:${ADVICE})\\b.{0,40}\\b(?:${TIMING})\\b.{0,30}\\b(?:${MEAL})`, 'iu'),
    // Juicio sin verbo de consejo: "cenar tan tarde", "la cena fue demasiado
    // tarde". El adjetivo de exceso es lo que lo vuelve una evaluación.
    new RegExp(`\\b(?:${MEAL})\\b.{0,30}\\b(?:tan tarde|tan temprano|demasiado tarde|demasiado temprano)`, 'iu'),
  ];
}

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

/**
 * Bebidas que **no** son agua, en los idiomas en que la app recibe texto.
 *
 * Existe porque el prompt no puede ser la única defensa. `contracts/safety-acceptance.md`
 * es explícito: al agregar un campo al payload que va al modelo, en el mismo
 * cambio crecen la prohibición del prompt **y el filtro**. `waterMl` se agregó
 * el 2026-09-03 y el filtro no había crecido.
 *
 * El daño concreto: una foto con un vaso de jugo al lado del plato. Si el
 * modelo devuelve `waterMl: 250` y omite el jugo de `foods`, esos ~25 g de
 * carbohidratos desaparecen del registro, del catálogo **y del campo que
 * alimenta el bolo**. La pantalla, además, le dice "solo agua, un jugo va
 * arriba con sus carbohidratos", que se lee como que la app lo verificó.
 */
const NON_WATER_BEVERAGE_PATTERN =
  /\b(jugo|zumo|bebida|gaseosa|refresco|soda|cola|nectar|limonada|leche|lactea|yogur|batido|licuado|smoothie|cafe|te|mate|chocolate|cacao|cerveza|vino|alcohol|trago|sopa|caldo|consome|isotonic[ao]|gatorade|powerade|energetica|kombucha|juice|soft ?drink|milk|yogh?urt|shake|coffee|tea|beer|wine|broth|soup|sports ?drink)\b/i;

/**
 * Quita los acentos antes de buscar.
 *
 * `\b` en JavaScript se define sobre `[A-Za-z0-9_]`, así que en "té con
 * azúcar" **no hay límite de palabra después de la `é`** y el patrón no
 * matcheaba. Lo encontró un test parametrizado; con un solo ejemplo por
 * bebida habría pasado desapercibido. Normalizar arregla eso y de paso
 * atrapa a quien escribe "cafe" sin tilde.
 */
function withoutAccents(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/gu, '');
}

/**
 * ¿Puede confiarse en el `waterMl` que devolvió el modelo?
 *
 * `false` cuando el texto que rodea al análisis menciona una bebida que **no**
 * es agua y ninguna entrada de `foods` la recoge. En ese caso quien llama
 * descarta el volumen: perder un vaso de agua es una molestia, perder 25 g de
 * carbohidratos es una dosis corta.
 *
 * Deliberadamente grueso. Un falso positivo cuesta que ella escriba el agua a
 * mano —el campo está ahí, visible—; un falso negativo cuesta carbohidratos
 * que nadie ve. Esa asimetría decide el diseño.
 */
export function waterEstimateIsTrustworthy(input: {
  waterMl: number | null | undefined;
  /** Nombres de los alimentos que el propio análisis devolvió. */
  foodNames: readonly string[];
  /** Lo que ella escribió: la pista de la foto o la descripción sin foto. */
  description?: string | undefined;
}): boolean {
  if (input.waterMl === null || input.waterMl === undefined) return true;

  const mentioned = withoutAccents(`${input.description ?? ''} ${input.foodNames.join(' ')}`);
  if (!NON_WATER_BEVERAGE_PATTERN.test(mentioned)) return true;

  // Se nombró una bebida. Solo se confía si **algún alimento** la recoge: ahí
  // sus carbohidratos están contados y el agua puede convivir con ella.
  return input.foodNames.some((name) => NON_WATER_BEVERAGE_PATTERN.test(withoutAccents(name)));
}

/**
 * Un alimento que en realidad es **agua sola**, no comida.
 *
 * ## Por qué existe (2026-09-03)
 *
 * Probando el backend real tras el redeploy: pedirle "arroz con pollo y un
 * vaso de agua al lado" devuelve `foods: [{ name: "Arroz con pollo", … },
 * { name: "Agua", estimatedGrams: 250, carbsG: 0, proteinG: 0, fatG: 0,
 * caloriesKcal: 0 }]`. El prompt v4 —el que manda el agua a `waterMl`— todavía
 * no está desplegado, y el v3 la trata como un alimento más.
 *
 * Eso tiene dos costos, y **ninguno depende del redeploy para arreglarse**:
 * "Agua" entra al catálogo de alimentos como si fuera comida, y el vaso que
 * ella bebió no llega a su meta de hidratación.
 *
 * Así que el cliente lo resuelve él. Cuando el v4 esté arriba, esta función
 * simplemente no encontrará nada que rescatar — y sigue valiendo como red: un
 * modelo puede volver a meter agua en `foods` en cualquier momento.
 *
 * ## El criterio, y por qué es tan estrecho
 *
 * Se exige **nombre de agua Y todos los macros en cero**. Un "agua de coco"
 * tiene carbohidratos y no pasa; una "sopa" tampoco. Clasificar mal en esta
 * dirección sacaría carbohidratos del plato y de la dosis, así que el filtro
 * prefiere dejar pasar un alimento raro antes que perder un gramo.
 */
const PLAIN_WATER_NAME = /^(?:un |una |el |la |vaso de |vasos de |botella de )*(agua|agua (?:pura|potable|natural|sin gas|mineral)|water|plain water)$/i;

export interface WaterLikeFood {
  name: string;
  estimatedGrams?: number | null | undefined;
  servingGrams?: number | null | undefined;
  carbsG: number;
  proteinG: number;
  fatG: number;
  caloriesKcal: number;
}

export function isPlainWaterFood(food: WaterLikeFood): boolean {
  const name = withoutAccents(food.name).trim().toLowerCase();
  if (!PLAIN_WATER_NAME.test(name)) return false;
  // Todos los macros en cero. Un solo gramo de carbohidrato lo descalifica:
  // eso ya no es agua y sus carbohidratos tienen que quedar en el plato.
  return food.carbsG === 0 && food.proteinG === 0 && food.fatG === 0 && food.caloriesKcal === 0;
}

/**
 * Separa el agua de la lista de alimentos de un análisis.
 *
 * Devuelve los alimentos **sin** el agua y los mililitros rescatados (1 g de
 * agua = 1 mL, que es exacto para lo que hace falta acá). `waterMl` es `null`
 * cuando no había agua o cuando no se pudo estimar el volumen: nunca un número
 * inventado, porque se suma a la meta del día.
 */
export function separatePlainWater<T extends WaterLikeFood>(
  foods: readonly T[],
): { foods: T[]; waterMl: number | null } {
  const kept: T[] = [];
  let ml = 0;
  for (const food of foods) {
    if (!isPlainWaterFood(food)) {
      kept.push(food);
      continue;
    }
    const grams = food.estimatedGrams ?? food.servingGrams;
    if (typeof grams === 'number' && Number.isFinite(grams) && grams > 0) ml += grams;
  }
  // Si TODO era agua, no se devuelve una lista vacía: `MealAnalysisSchema`
  // exige al menos un alimento, y una foto de solo un vaso es un caso legítimo
  // que quien llama resuelve mirando `foods.length === 0`.
  return { foods: kept, waterMl: ml > 0 ? Math.round(ml) : null };
}
