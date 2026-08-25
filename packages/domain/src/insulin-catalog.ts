/**
 * Catálogo de insulinas y su **duración de acción declarada en ficha
 * técnica**.
 *
 * ── Por qué existe, y qué NO es ────────────────────────────────────────────
 *
 * Existe por una sola razón: **higiene de datos**. Para saber si la glucosa
 * medida 3 h después de una comida todavía describe a esa comida, hay que
 * saber si había otra dosis actuando en el medio — y "en el medio" depende de
 * cuánto dura la insulina que la persona realmente usa. Con Fiasp (~5 h) y
 * con insulina regular (~8 h) la ventana no es la misma.
 *
 * **Esto NO es insulina activa (IOB) y no puede convertirse en eso.**
 * `AGENTS.md` prohíbe IOB y dosificación automática en el MVP. La diferencia
 * no es de matiz:
 *
 * - IOB estima **cuántas unidades siguen actuando** y se usa para decidir una
 *   dosis. Prohibido.
 * - Esto responde **sí/no: ¿había una dosis dentro de su ventana?**, y se usa
 *   solo para decidir si un episodio entra o no a un promedio descriptivo.
 *   Nunca se muestra, nunca se resta de nada, nunca toca una calculadora.
 *
 * Si alguna vez alguien necesita multiplicar una duración por unas unidades,
 * eso ya es IOB y no va acá.
 *
 * ── Por qué la elige la usuaria y no la adivina la app ─────────────────────
 *
 * `AGENTS.md`: "Never infer therapy parameters." La app no deduce qué
 * insulina usa alguien a partir de sus datos, ni preselecciona una. La
 * usuaria elige su marca de una lista, y puede sobrescribir la duración si su
 * equipo clínico le dio otra. Los valores de acá son **el dato de la ficha
 * técnica del fabricante**, no una estimación de la app sobre esa persona.
 *
 * Fuentes de las duraciones (consultadas 2026-08-25) — ver
 * `docs/RESEARCH_SOURCES.md`.
 */

export type InsulinCategory = 'rapid' | 'basal';

export interface CatalogInsulin {
  /** Id estable: se guarda en la base, así que no se renombra nunca. */
  id: string;
  /** Marca comercial, como aparece en la caja. */
  brand: string;
  /** Principio activo. */
  generic: string;
  category: InsulinCategory;
  /**
   * Duración de acción declarada, en horas. Es el extremo del rango de la
   * ficha técnica, no el promedio: para excluir un episodio confundido
   * conviene errar por exceso (excluir de más pierde muestra; excluir de
   * menos publica un promedio contaminado como si fuera un patrón).
   */
  durationHours: number;
  /** Qué se le muestra a la usuaria bajo el nombre, en Ajustes. */
  note: string;
}

/**
 * Rápidas y ultrarrápidas. La duración de todas las análogas rápidas cae en
 * 3–5 h; se toma 5. La regular humana es la excepción real (5–8 h).
 */
const RAPID: CatalogInsulin[] = [
  { id: 'novorapid', brand: 'NovoRapid / NovoLog', generic: 'insulina aspart', category: 'rapid', durationHours: 5, note: 'Análoga rápida. Inicio ~10-15 min, pico 1-3 h, dura 3-5 h.' },
  { id: 'fiasp', brand: 'Fiasp', generic: 'aspart de acción más rápida', category: 'rapid', durationHours: 5, note: 'Aspart acelerada: entra antes que NovoRapid y termina un poco antes, pero la duración total sigue en el mismo rango de 3-5 h.' },
  { id: 'humalog', brand: 'Humalog', generic: 'insulina lispro', category: 'rapid', durationHours: 5, note: 'Análoga rápida. Inicio ~10-15 min, pico 1-3 h, dura 3-5 h.' },
  { id: 'lyumjev', brand: 'Lyumjev', generic: 'lispro de acción más rápida', category: 'rapid', durationHours: 5, note: 'Lispro acelerada, equivalente a Fiasp dentro de la familia de lispro.' },
  { id: 'apidra', brand: 'Apidra', generic: 'insulina glulisina', category: 'rapid', durationHours: 5, note: 'Análoga rápida. Inicio ~5-15 min, pico 1-3 h, dura 3-5 h.' },
  { id: 'regular', brand: 'Humulin R / Novolin R', generic: 'insulina humana regular', category: 'rapid', durationHours: 8, note: 'Humana regular, no análoga: entra más lento (30-60 min) y dura bastante más, 5-8 h.' },
];

/**
 * Basales. El rango es enorme (24 h a 42 h) y por eso importa que sea la
 * usuaria la que elija: usar 24 h para alguien con Tresiba sería mirar la
 * mitad de la ventana.
 */
const BASAL: CatalogInsulin[] = [
  { id: 'lantus', brand: 'Lantus / Basaglar / Semglee', generic: 'glargina U-100', category: 'basal', durationHours: 24, note: 'Sin pico marcado. Dura hasta 24 h.' },
  { id: 'toujeo', brand: 'Toujeo', generic: 'glargina U-300', category: 'basal', durationHours: 36, note: 'Glargina concentrada: más plana y más larga que Lantus, hasta 36 h.' },
  { id: 'tresiba', brand: 'Tresiba', generic: 'insulina degludec', category: 'basal', durationHours: 42, note: 'La más larga y plana: hasta 42 h.' },
  { id: 'levemir', brand: 'Levemir', generic: 'insulina detemir', category: 'basal', durationHours: 24, note: 'Sin pico marcado. Hasta 24 h; con dosis bajas puede durar menos.' },
  { id: 'nph', brand: 'Humulin N / Novolin N', generic: 'insulina NPH', category: 'basal', durationHours: 24, note: 'Intermedia, con pico entre 4 y 12 h. Dura 14-24 h.' },
];

export const INSULIN_CATALOG: readonly CatalogInsulin[] = [...RAPID, ...BASAL];

export function insulinsByCategory(category: InsulinCategory): readonly CatalogInsulin[] {
  return INSULIN_CATALOG.filter((insulin) => insulin.category === category);
}

export function findCatalogInsulin(id: string | undefined): CatalogInsulin | undefined {
  if (id === undefined) return undefined;
  return INSULIN_CATALOG.find((insulin) => insulin.id === id);
}

/**
 * Límites de una duración escrita a mano.
 *
 * No son "lo razonable clínicamente" —eso no lo define la app—: son un cerco
 * contra un dedo equivocado. 0,5 h haría que ningún episodio se excluyera
 * nunca; 72 h haría que ninguno quedara limpio y la pantalla de patrones se
 * vaciaría sin explicación.
 */
export const MIN_INSULIN_DURATION_HOURS = 1;
export const MAX_INSULIN_DURATION_HOURS = 72;

export function isPlausibleInsulinDuration(hours: number): boolean {
  return (
    Number.isFinite(hours)
    && hours >= MIN_INSULIN_DURATION_HOURS
    && hours <= MAX_INSULIN_DURATION_HOURS
  );
}

/**
 * Cuánto hacia atrás mirar para decidir si un episodio está confundido.
 *
 * Devuelve `undefined` cuando la usuaria todavía no eligió su insulina. Eso
 * es deliberado y es la parte que más importa de este módulo: **sin dato no
 * se inventa un default**. Un 5 supuesto silenciosamente excluiría episodios
 * por una suposición que nadie confirmó, y el resultado se lee como patrón.
 * Sin dato, la ventana se queda como estaba (solo hacia adelante) y la
 * pantalla lo dice.
 */
export function basalInsulinLookbackMinutes(profile: {
  basalInsulinDurationHours?: number | undefined;
}): number | undefined {
  const hours = profile.basalInsulinDurationHours;
  if (hours === undefined || !isPlausibleInsulinDuration(hours)) return undefined;
  return Math.round(hours * 60);
}

export function rapidInsulinLookbackMinutes(profile: {
  rapidInsulinDurationHours?: number | undefined;
}): number | undefined {
  const hours = profile.rapidInsulinDurationHours;
  if (hours === undefined || !isPlausibleInsulinDuration(hours)) return undefined;
  return Math.round(hours * 60);
}
