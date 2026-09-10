/**
 * Lo que la app entiende **sin llamar al modelo**.
 *
 * ## Por qué existe
 *
 * La mitad de lo que se escribe en un chat de registro es una sola frase sin
 * ambigüedad: "250 ml de agua", "6 de rápida", "glucosa 168". Mandar eso a un
 * modelo cuesta créditos y tarda segundos, para un resultado que un `RegExp`
 * resuelve al instante y sin equivocarse.
 *
 * ## Entender a medias sirve, siempre que ella lo vea
 *
 * La primera versión tiraba lo entendido cuando sobraba texto, con el argumento
 * de que media frase registrada hace creer que la app entendió todo. El
 * argumento vale para **guardar sin preguntar**, y solo para eso. Verónica lo
 * corrigió el 2026-09-10: si de todos modos va a aparecer el formulario, que
 * llegue **pre-llenado con lo que sí se entendió**, y ella corrige lo que esté
 * mal y aprueba.
 *
 * Por eso `intents` **siempre** trae lo reconocido, incluso con `complete` en
 * `false`. Lo que `complete` decide es otra cosa: si hace falta el modelo. El
 * peligro de entender a medias desaparece cuando ella está mirando el
 * formulario antes de que se escriba nada.
 *
 * ## La regla que gobierna cada patrón
 *
 * **Ante la duda, no se interpreta.** Un número sin su palabra —"168"— podría
 * ser glucosa, carbohidratos o unidades. "Me puse 6" no dice si fue rápida o
 * basal. En los dos casos la respuesta correcta es devolver el texto sin tocar
 * y dejar que alguien pregunte, no elegir la lectura más probable.
 *
 * ## La trampa del `\b`
 *
 * `\b` en JavaScript se define sobre `[A-Za-z0-9_]`, así que **no hay frontera
 * de palabra después de una vocal acentuada**: `azúcar\b` no matchea "azúcar".
 * Ya rompió un guardrail de seguridad en este repo. Acá se usa
 * `(?![a-záéíóúñ])`, que es la forma documentada en `techContext.md`.
 */

import type { GlucoseUnit } from '@type1a/schemas';

/** Lo máximo que un esquema acepta por dosis (`InsulinEventSchema`). */
const MAX_UNITS = 100;
/** Tope de `WaterEventSchema`: un freno a un dedo que escribe 20000. */
const MAX_WATER_ML = 5000;
/** Tope de `CarbEventSchema`. */
const MAX_CARBS_G = 500;

export type LocalIntent =
  | {
      kind: 'water';
      /**
       * `null` cuando dijo "un vaso" sin decir cuánto.
       *
       * **No se traduce a 250 ml.** Es la misma regla que el prompt de la IA:
       * inventar un volumen redondo suma agua al total diario que nadie tomó.
       * La pantalla ofrece los presets y ella elige.
       */
      ml: number | null;
    }
  | { kind: 'glucose'; value: number; unit: GlucoseUnit }
  | { kind: 'carbs'; grams: number }
  | { kind: 'insulin'; units: number; insulinType: 'rapid' | 'basal' };

export interface LocalParseResult {
  /**
   * Lo reconocido. **Siempre se usa para pre-llenar**, valga o no `complete`.
   * Nunca se descarta: es trabajo ya hecho que le ahorra tecleo.
   */
  intents: LocalIntent[];
  /**
   * `true` si **todo** el texto se entendió acá, y por lo tanto **no hace falta
   * el modelo**. No significa "guardar sin preguntar": eso lo decide la
   * pantalla, que igual muestra qué va a escribir.
   */
  complete: boolean;
  /**
   * Lo que quedó sin interpretar, tal como ella lo escribió.
   *
   * Es lo que se le manda al modelo, y también lo que la pantalla puede mostrar
   * como "esto no lo entendí" en vez de tragárselo en silencio. Vacío cuando
   * `complete` es `true`.
   */
  leftover: string;
}

/** Un número con coma o punto: "6,5" y "6.5" son el mismo número. */
const NUMBER = String.raw`(\d+(?:[.,]\d+)?)`;
/** Frontera de palabra que sí funciona con acentos. Ver la cabecera. */
const END = String.raw`(?![a-záéíóúñ])`;

const parseNumber = (raw: string): number => Number(raw.replace(',', '.'));

/** Redondea a un decimal: la precisión del resto del dominio. */
const round1 = (value: number): number => Number(value.toFixed(1));

interface Pattern {
  re: RegExp;
  build: (match: RegExpMatchArray, unit: GlucoseUnit) => LocalIntent | null;
}

const PATTERNS: readonly Pattern[] = [
  // ── Agua con volumen explícito ────────────────────────────────────────────
  {
    re: new RegExp(String.raw`${NUMBER}\s*(ml|mililitros?|cc)${END}[^.]*?\bagua${END}`, 'iu'),
    build: (m) => {
      const ml = parseNumber(m[1]!);
      return ml > 0 && ml <= MAX_WATER_ML ? { kind: 'water', ml } : null;
    },
  },
  {
    re: new RegExp(String.raw`${NUMBER}\s*(l|litros?)${END}[^.]*?\bagua${END}`, 'iu'),
    build: (m) => {
      const ml = Math.round(parseNumber(m[1]!) * 1000);
      return ml > 0 && ml <= MAX_WATER_ML ? { kind: 'water', ml } : null;
    },
  },
  // ── Agua sin volumen: se reconoce la intención, NO se inventa el número ───
  {
    re: new RegExp(String.raw`\b(?:un|una|el|medio)?\s*(?:vaso|vasos|botella|sorbo)\s+de\s+agua${END}`, 'iu'),
    build: () => ({ kind: 'water', ml: null }),
  },
  {
    re: new RegExp(String.raw`\b(?:tom[eé]|beb[íi])\s+agua${END}`, 'iu'),
    build: () => ({ kind: 'water', ml: null }),
  },

  // ── Insulina: SIEMPRE con su tipo dicho ───────────────────────────────────
  {
    re: new RegExp(String.raw`${NUMBER}\s*(?:u|unidades?)?\s*de\s+(?:insulina\s+)?(r[aá]pida|ultrarr[aá]pida|bolo)${END}`, 'iu'),
    build: (m) => {
      const units = round1(parseNumber(m[1]!));
      return units > 0 && units <= MAX_UNITS ? { kind: 'insulin', units, insulinType: 'rapid' } : null;
    },
  },
  {
    re: new RegExp(String.raw`${NUMBER}\s*(?:u|unidades?)?\s*de\s+(?:insulina\s+)?(basal|lenta|prolongada)${END}`, 'iu'),
    build: (m) => {
      const units = round1(parseNumber(m[1]!));
      return units > 0 && units <= MAX_UNITS ? { kind: 'insulin', units, insulinType: 'basal' } : null;
    },
  },

  // ── Carbohidratos ─────────────────────────────────────────────────────────
  {
    re: new RegExp(String.raw`${NUMBER}\s*(?:g|gr|gramos?)?\s*de\s+(?:carbo?s?|carbohidratos?|hidratos)${END}`, 'iu'),
    build: (m) => {
      const grams = round1(parseNumber(m[1]!));
      return grams >= 0 && grams <= MAX_CARBS_G ? { kind: 'carbs', grams } : null;
    },
  },

  // ── Glucosa ───────────────────────────────────────────────────────────────
  {
    re: new RegExp(String.raw`\b(?:glucosa|glicemia|glucemia|az[uú]car)${END}\s*(?:en|de|:)?\s*${NUMBER}`, 'iu'),
    build: (m, unit) => {
      const value = parseNumber(m[1]!);
      return isPlausibleGlucose(value, unit) ? { kind: 'glucose', value, unit } : null;
    },
  },
  {
    re: new RegExp(String.raw`\b(?:estoy|ando|and[oa]ba|estaba)\s+(?:en|con)\s+${NUMBER}`, 'iu'),
    build: (m, unit) => {
      const value = parseNumber(m[1]!);
      return isPlausibleGlucose(value, unit) ? { kind: 'glucose', value, unit } : null;
    },
  },
];

/**
 * Si un número puede ser una glucosa **en la unidad que ella configuró**.
 *
 * No es cosmético. "6" es una glucemia normal en mmol/L y es incompatible con la
 * vida en mg/dL; "168" es lo contrario. Interpretar el número en la unidad
 * equivocada registraría una glucosa falsa, así que fuera de rango **no se
 * interpreta** y la frase va al modelo, que puede preguntar.
 */
export function isPlausibleGlucose(value: number, unit: GlucoseUnit): boolean {
  if (!Number.isFinite(value)) return false;
  return unit === 'mg/dL' ? value >= 20 && value <= 600 : value >= 1.1 && value <= 33.3;
}

/**
 * Lee una frase sin llamar al modelo.
 *
 * Con `complete: true` no hace falta llamar al modelo. Con `false`, se manda
 * `leftover` — **y las intenciones ya reconocidas se usan igual para
 * pre-llenar**, así el formulario abre lleno al instante en vez de en blanco
 * mientras llega la respuesta.
 */
export function parseLocalIntent(text: string, unit: GlucoseUnit): LocalParseResult {
  const intents: LocalIntent[] = [];
  let rest = text;

  for (const pattern of PATTERNS) {
    const match = rest.match(pattern.re);
    if (match === null) continue;
    const intent = pattern.build(match, unit);
    // Un patrón que matchea pero cuyo valor no es plausible NO consume el texto:
    // así "glucosa 900" cae al modelo en vez de desaparecer en silencio.
    if (intent === null) continue;
    // Dos valores para el MISMO campo son ambiguos y se descartan. Pero rápida
    // y basal son campos distintos, no un duplicado: deduplicar por `kind` se
    // comía la basal de "18 de basal y 5 de rápida".
    if (intents.some((existing) => slotOf(existing) === slotOf(intent))) continue;
    intents.push(intent);
    rest = rest.replace(pattern.re, ' ');
  }

  const leftover = hasSubstance(rest) ? tidy(rest) : '';
  return { intents, complete: intents.length > 0 && leftover === '', leftover };
}

/**
 * Qué campo del formulario ocupa una intención.
 *
 * Es lo que decide si dos lecturas se pisan. Una rápida y una basal conviven;
 * dos glucosas no.
 */
function slotOf(intent: LocalIntent): string {
  return intent.kind === 'insulin' ? `insulin:${intent.insulinType}` : intent.kind;
}

/** Deja el sobrante legible: sin espacios de más ni puntuación suelta. */
function tidy(rest: string): string {
  return rest.replace(/\s+/gu, ' ').replace(/^[\s,.;:]+|[\s,.;:]+$/gu, '').trim();
}

/**
 * Si lo que sobró dice algo.
 *
 * Conectores y puntuación no cuentan: "me puse 6 de rápida y tomé 250 ml de
 * agua" deja "me puse y tomé de", que no es una intención pendiente. **Un
 * número suelto sí cuenta**, porque es justo el caso peligroso.
 */
function hasSubstance(rest: string): boolean {
  if (/\d/u.test(rest)) return true;
  const RUIDO = new RegExp(
    String.raw`\b(y|e|o|de|del|la|el|los|las|un|una|unos|unas|me|mi|se|con|en|a|al|por|que|ya|tambi[eé]n|adem[aá]s|puse|inyect[eé]|tom[eé]|beb[íi]|com[íi]|registra|anota|apunta|agrega|pon|hoy|ahora|reci[eé]n|acabo|acabar|hace|rato|minutos?|hrs?|horas?|favor|porfa|gracias|please)${END}`,
    'giu',
  );
  return rest.replace(RUIDO, ' ').replace(/[^\p{L}]/gu, '').trim().length > 0;
}


// ---------------------------------------------------------------------------
// Pre-llenado
// ---------------------------------------------------------------------------

/**
 * Los campos del Modal Maestro que una frase alcanza a llenar.
 *
 * Cada campo ausente significa **"no se dijo"**, nunca cero: es la misma regla
 * que ya gobierna los parches de vitales y de comida. Un `waterMl` en `null`
 * dice "habló de agua pero no de cuánta", que no es lo mismo que no mencionarla.
 */
export interface EntryPrefill {
  glucose?: { value: number; unit: GlucoseUnit };
  carbsG?: number;
  rapidUnits?: number;
  basalUnits?: number;
  /** `null` = dijo agua sin decir cuánta; la pantalla ofrece los presets. */
  waterMl?: number | null;
}

/**
 * Convierte lo reconocido en campos listos para el formulario.
 *
 * **No inventa nada.** Lo que no se dijo no aparece, y la pantalla lo muestra
 * vacío para que ella lo llene o lo deje así.
 */
export function toPrefill(intents: readonly LocalIntent[]): EntryPrefill {
  const prefill: EntryPrefill = {};
  for (const intent of intents) {
    if (intent.kind === 'glucose') prefill.glucose = { value: intent.value, unit: intent.unit };
    else if (intent.kind === 'carbs') prefill.carbsG = intent.grams;
    else if (intent.kind === 'water') prefill.waterMl = intent.ml;
    else if (intent.insulinType === 'rapid') prefill.rapidUnits = intent.units;
    else prefill.basalUnits = intent.units;
  }
  return prefill;
}

/** Si el pre-llenado tiene algo que mostrar. */
export function hasPrefill(prefill: EntryPrefill): boolean {
  return Object.keys(prefill).length > 0;
}
