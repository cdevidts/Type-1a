/**
 * Las reglas del dictado por voz, sin teléfono de por medio.
 *
 * Dos decisiones de producto viven acá, y las dos tienen test:
 *
 * 1. **El micrófono es un teclado, no un botón de enviar.** Lo dictado se
 *    fusiona con lo que ya estaba escrito y se queda en el cuadro de texto
 *    hasta que ella lo lea y lo mande. Nada se registra por lo que el teléfono
 *    creyó escuchar: un "doscientos sesenta" entendido como "sesenta" sería un
 *    dato clínico falso en su historial.
 * 2. **Las pistas de vocabulario solo salen si la transcripción es local.**
 *    Ver `dictationHints`.
 */

/**
 * Tope de caracteres del cuadro de texto, igual al del contrato del chat
 * (`AgentChatRequestSchema.message`). Se recorta acá y no en el servidor para
 * que un dictado largo no vuelva como un 400 sin explicación.
 */
export const DICTATION_MAX_CHARS = 2000;

/**
 * Cuántas pistas de vocabulario se le pasan al reconocedor. Android no
 * documenta un tope duro, y una lista larga empeora el reconocimiento en vez
 * de mejorarlo: son *pistas*, no un diccionario.
 */
export const DICTATION_HINT_LIMIT = 40;

/**
 * Une lo que ya estaba escrito con la transcripción en curso.
 *
 * `base` es el texto **congelado al empezar a dictar**, no el del cuadro en
 * este instante: el reconocedor manda la transcripción entera cada vez (crece
 * "doscientos" → "doscientos sesenta"), así que un resultado parcial
 * **reemplaza** al anterior. Concatenar cada evento repetiría todo.
 */
export function mergeDictation(base: string, transcript: string): string {
  const dictated = transcript.trim();
  if (dictated.length === 0) return base.slice(0, DICTATION_MAX_CHARS);
  // Sin `trim()` sobre `base`: si ella dejó un espacio a propósito, se respeta;
  // lo que no se hace es agregar uno cuando ya hay.
  const needsSpace = base.length > 0 && !/\s$/u.test(base);
  const joined = `${base}${needsSpace ? ' ' : ''}${dictated}`;
  return joined.slice(0, DICTATION_MAX_CHARS);
}

export interface DictationHintInput {
  /** `true` solo si el reconocedor transcribe **sin** mandar audio a la red. */
  readonly onDevice: boolean;
  /** Nombres de las insulinas que ella cargó. */
  readonly insulinNames: readonly string[];
  /** Nombres de su catálogo de comidas. */
  readonly foodNames: readonly string[];
}

/**
 * Las palabras que el reconocedor debe esperar: "Fiasp", "Tresiba", "porotos
 * granados". Sin ellas, un nombre de marca sale fonético y el parser local no
 * lo encuentra.
 *
 * **Devuelve una lista vacía si la transcripción no es local, y eso no es una
 * limitación técnica sino la regla.** Estas pistas son datos de salud: el
 * nombre de una insulina dice que quien habla es diabético y con qué se trata.
 * Mandárselas a un servicio de dictado ajeno para mejorar el reconocimiento
 * sería exactamente la fuga que el ADR 0007 prohíbe. Cuando el reconocedor es
 * de red se dicta igual, solo que sin ayuda.
 */
export function dictationHints(input: DictationHintInput): readonly string[] {
  if (!input.onDevice) return [];
  const seen = new Set<string>();
  const hints: string[] = [];
  // Las insulinas van primero: son pocas, y errarle a un nombre de marca es lo
  // que más cuesta corregir a mano.
  for (const raw of [...input.insulinNames, ...input.foodNames]) {
    const name = raw.trim();
    // Menos de tres letras no es una pista, es ruido que sesga el reconocedor.
    if (name.length < 3) continue;
    const key = name.toLocaleLowerCase('es');
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push(name);
    if (hints.length >= DICTATION_HINT_LIMIT) break;
  }
  return hints;
}

/** Español de Chile primero; es donde ella vive y cómo dice los números. */
export const DICTATION_PREFERRED_LOCALE = 'es-CL';

/**
 * Con qué idioma arrancar el reconocedor, entre los que el teléfono tiene.
 *
 * No alcanza con pedir `es-CL`: si ese modelo no está en el dispositivo,
 * Android no elige otro, **falla** con `language-not-supported`. Y para
 * transcribir sin red hay que mirar los idiomas *instalados*, que son un
 * subconjunto de los soportados.
 *
 * Devuelve `undefined` cuando no hay ningún español: ahí es mejor dejar que el
 * sistema use el suyo que forzar uno que no existe.
 */
export function pickDictationLocale(available: readonly string[]): string | undefined {
  const normalized = available.map((l) => l.replace('_', '-'));
  const exact = normalized.find((l) => l.toLowerCase() === DICTATION_PREFERRED_LOCALE.toLowerCase());
  if (exact !== undefined) return exact;
  // Cualquier español sirve para dictar: las diferencias son de acento, no de
  // números ni de nombres de comida.
  return normalized.find((l) => l.toLowerCase().startsWith('es-') || l.toLowerCase() === 'es');
}

/**
 * Si el dictado va a ocurrir **dentro** del teléfono.
 *
 * Las dos condiciones son necesarias y el bug clásico es olvidar la segunda:
 * un teléfono puede soportar reconocimiento local y no tener descargado el
 * modelo de español, y entonces exigirlo lo deja mudo.
 */
export function dictationRunsOnDevice(
  supportsOnDevice: boolean,
  installedLocales: readonly string[],
): boolean {
  return supportsOnDevice && pickDictationLocale(installedLocales) !== undefined;
}

export interface DictationStartOptions {
  readonly lang?: string;
  readonly requiresOnDeviceRecognition: boolean;
  readonly addsPunctuation: boolean;
  readonly contextualStrings: readonly string[];
}

/**
 * Todo lo que decide el `start()` del reconocedor, en una sola función.
 *
 * Está junto a propósito, y es la **Regla 2** de `systemPatterns.md` aplicada:
 * si un dato no debe salir, que no haya dónde ponerlo. Exigir transcripción
 * local y no mandar el vocabulario son la misma decisión, y separarlas en dos
 * campos que alguien pone a mano es cómo se llega a `requiresOnDeviceRecognition:
 * false` con las pistas todavía adentro — o sea, los nombres de sus insulinas
 * viajando a un servicio ajeno con la suite de tests en verde.
 *
 * Acá salen de la misma variable, así que no pueden discrepar.
 */
export function dictationStartOptions(input: DictationHintInput & {
  readonly locale?: string | undefined;
}): DictationStartOptions {
  return {
    ...(input.locale === undefined ? {} : { lang: input.locale }),
    requiresOnDeviceRecognition: input.onDevice,
    // Los signos de puntuación solo existen con reconocimiento local.
    addsPunctuation: input.onDevice,
    contextualStrings: dictationHints(input),
  };
}
