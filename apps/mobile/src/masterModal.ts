import type { CGMReading, MealEvent } from '@type1a/schemas';

import type { EntryFocus, PromotableTable, TimelineItem } from './types';

/**
 * Las reglas del Modal Maestro, puras y con test.
 *
 * `projectbrief.md` las fija como arquitectura inquebrantable, así que no
 * pueden vivir dentro de un `.tsx` donde solo se verifican a ojo. Las dos
 * primeras ya tuvieron su versión equivocada: una repartida en tres modales
 * distintos, la otra como un `item.kind === 'meal'` que dejaba fuera a la
 * misma comida guardada de otra forma.
 *
 * Las que se sumaron después (`masterSectionsFor`, `masterSeedFrom`,
 * `masterTargetOf`) existen porque la edición dejó de ser un formulario
 * inline por tipo: **el foco decide qué se abre primero y nunca qué se puede
 * guardar**, así que decidir qué secciones arrancan abiertas es ahora una
 * regla de datos, no una condición suelta dentro de un `render`.
 */

/**
 * Qué sección arranca abierta.
 *
 * **El foco decide qué se ve primero, nunca qué se puede guardar.** Desde
 * cualquiera se llega a todo lo demás: es la diferencia entre un acceso rápido
 * —pocos toques para lo de siempre— y cuatro formularios que sabían hacer
 * cosas distintas.
 */
export function sectionStartsOpen(focus: EntryFocus, section: EntryFocus): boolean {
  return focus === 'all' || focus === section;
}

/**
 * La comida de un ítem del timeline, venga suelta o dentro de una entrada
 * empaquetada.
 *
 * Es lo que hace que las herramientas potentes aparezcan **por contenido y no
 * por qué botón abrió el modal**. Con la condición vieja (`kind === 'meal'`),
 * una comida registrada desde "Nueva entrada" quedaba fuera de su propio
 * editor: tenía foto y macros, y no había forma de re-analizarla.
 */
export function mealOf(item: TimelineItem): MealEvent | null {
  if (item.kind === 'meal') return item.raw;
  if (item.kind === 'entry') return item.raw.meal ?? null;
  return null;
}

/** Las seis secciones del maestro. La calculadora es una más, no un anexo. */
export type MasterSection = 'glucose' | 'meal' | 'calculator' | 'insulin' | 'ketones' | 'water' | 'note';

export const MASTER_SECTIONS: readonly MasterSection[] = [
  'glucose', 'meal', 'calculator', 'insulin', 'ketones', 'water', 'note',
];

/**
 * Qué operación de escritura corresponde a este ítem.
 *
 * Es el corazón del cambio "la edición es retroactiva y sin límite de tipo":
 * un evento suelto no tiene grupo, así que guardarle una comida encima exige
 * **promoverlo** primero. La decisión es de datos y no de pantalla, así que
 * vive acá con su test en vez de dentro de un `if` del componente.
 */
export type MasterTarget =
  /** Ya es un grupo: se edita en su sitio. */
  | { kind: 'group'; entryGroupId: string }
  /** Una lectura suelta: se le adjunta y queda anclada, sin tocar su valor. */
  | { kind: 'reading'; readingId: string }
  /** Un evento suelto de esta tabla: hay que promoverlo a grupo. */
  | { kind: 'promote'; table: PromotableTable; rowId: string }
  /** Nada que editar: episodios calculados. */
  | { kind: 'readonly' };

export function masterTargetOf(item: TimelineItem): MasterTarget {
  switch (item.kind) {
    case 'entry': return { kind: 'group', entryGroupId: item.raw.entryGroupId };
    case 'glucose': return { kind: 'reading', readingId: item.raw.id };
    case 'insulin': return { kind: 'promote', table: 'insulin_events', rowId: item.raw.id };
    case 'carbs': return { kind: 'promote', table: 'carb_events', rowId: item.id };
    case 'note': return { kind: 'promote', table: 'note_events', rowId: item.raw.id };
    case 'water': return { kind: 'promote', table: 'water_events', rowId: item.raw.id };
    case 'meal': return { kind: 'promote', table: 'meal_events', rowId: item.raw.id };
    case 'vitals': return { kind: 'promote', table: 'vitals_events', rowId: item.raw.id };
    // Un episodio es un agregado calculado: sus métricas salen del CGM, nadie
    // las tecleó. Se lee y se borra; no se edita.
    case 'episode': return { kind: 'readonly' };
  }
}

export function isMasterEditable(item: TimelineItem): boolean {
  return masterTargetOf(item).kind !== 'readonly';
}

/**
 * Lo que el maestro carga en sus campos al abrirse sobre un registro
 * existente.
 *
 * Un campo ausente significa "no lo anotó", nunca "cero": la misma regla que
 * rige en todos los formularios de esta app. Y lo que viene de un sensor
 * viaja con su bandera de solo lectura, no con una convención implícita que
 * cada pantalla tenga que recordar.
 */
export interface MasterSeed {
  timestamp: string;
  /** Valor en mg/dL, ya convertido por quien construyó el ítem del timeline. */
  glucose?: number;
  glucoseOrigin?: CGMReading['origin'];
  /**
   * `true` cuando la glucosa es un registro de lo que reportó una fuente
   * externa (sensor, importación, sintético). Su **valor** no se edita jamás;
   * lo que se le cuelgue encima, sí.
   */
  glucoseReadOnly: boolean;
  meal: MealEvent | null;
  carbsG?: number;
  description?: string;
  proteinG?: number;
  fatG?: number;
  fiberG?: number;
  caloriesKcal?: number;
  imageUri?: string;
  aiEstimatedCarbsG?: number;
  rapidUnits?: number;
  basalUnits?: number;
  rapidInsulinName?: string;
  basalInsulinName?: string;
  ketonesMmolL?: number;
  weightKg?: number;
  systolicBP?: number;
  diastolicBP?: number;
  /** Agua bebida en este registro, en mL. */
  waterMl?: number;
  note?: string;
  /**
   * `false` solo cuando el momento lo fija una fuente externa: la hora de un
   * sensor es parte de lo que reportó, y moverla sería falsificar la lectura.
   * Todo lo que introdujo la usuaria sí se puede corregir.
   */
  timestampEditable: boolean;
}

const EMPTY_SEED: Omit<MasterSeed, 'timestamp'> = {
  glucoseReadOnly: false,
  meal: null,
  timestampEditable: true,
};

export function masterSeedFrom(item: TimelineItem): MasterSeed {
  switch (item.kind) {
    case 'glucose': {
      const readOnly = item.raw.origin !== 'manual';
      return {
        ...EMPTY_SEED,
        timestamp: item.raw.sourceTimestamp,
        glucose: item.raw.glucose,
        glucoseOrigin: item.raw.origin,
        glucoseReadOnly: readOnly,
        // Una lectura de sensor conserva la verdad de su fuente. Una capilar
        // que ella tecleó es suya y se puede corregir de hora.
        timestampEditable: !readOnly,
      };
    }
    case 'water':
      return { ...EMPTY_SEED, timestamp: item.raw.timestamp, waterMl: item.raw.ml };
    case 'entry': {
      const raw = item.raw;
      const readOnly = raw.glucoseOrigin !== undefined && raw.glucoseOrigin !== 'manual';
      return {
        ...EMPTY_SEED,
        timestamp: item.timestamp,
        ...(raw.glucose === undefined ? {} : { glucose: raw.glucose }),
        ...(raw.glucoseOrigin === undefined ? {} : { glucoseOrigin: raw.glucoseOrigin }),
        glucoseReadOnly: readOnly,
        meal: raw.meal ?? null,
        ...(raw.carbsG === undefined ? {} : { carbsG: raw.carbsG }),
        ...(raw.description === undefined ? {} : { description: raw.description }),
        ...(raw.proteinG === undefined ? {} : { proteinG: raw.proteinG }),
        ...(raw.fatG === undefined ? {} : { fatG: raw.fatG }),
        ...(raw.fiberG === undefined ? {} : { fiberG: raw.fiberG }),
        ...(raw.meal?.caloriesKcal === undefined ? {} : { caloriesKcal: raw.meal.caloriesKcal }),
        ...(raw.imageUri === undefined ? {} : { imageUri: raw.imageUri }),
        ...(raw.aiEstimatedCarbsG === undefined ? {} : { aiEstimatedCarbsG: raw.aiEstimatedCarbsG }),
        ...(raw.rapidUnits === undefined ? {} : { rapidUnits: raw.rapidUnits }),
        ...(raw.basalUnits === undefined ? {} : { basalUnits: raw.basalUnits }),
        ...(raw.rapidInsulinName === undefined ? {} : { rapidInsulinName: raw.rapidInsulinName }),
        ...(raw.basalInsulinName === undefined ? {} : { basalInsulinName: raw.basalInsulinName }),
        ...(raw.ketonesMmolL === undefined ? {} : { ketonesMmolL: raw.ketonesMmolL }),
        ...(raw.waterMl === undefined ? {} : { waterMl: raw.waterMl }),
        ...(raw.note === undefined ? {} : { note: raw.note }),
        // El grupo entero se mueve junto, salvo que lo ancle un sensor.
        timestampEditable: !readOnly,
      };
    }
    case 'meal': {
      const meal = item.raw;
      return {
        ...EMPTY_SEED,
        timestamp: meal.timestamp,
        meal,
        ...(meal.confirmedCarbsG === undefined ? {} : { carbsG: meal.confirmedCarbsG }),
        ...(meal.note === undefined ? {} : { description: meal.note }),
        ...(meal.proteinG === undefined ? {} : { proteinG: meal.proteinG }),
        ...(meal.fatG === undefined ? {} : { fatG: meal.fatG }),
        ...(meal.fiberG === undefined ? {} : { fiberG: meal.fiberG }),
        ...(meal.caloriesKcal === undefined ? {} : { caloriesKcal: meal.caloriesKcal }),
        ...(meal.imageUri === undefined ? {} : { imageUri: meal.imageUri }),
        ...(meal.aiEstimatedCarbsG === undefined ? {} : { aiEstimatedCarbsG: meal.aiEstimatedCarbsG }),
      };
    }
    case 'insulin': {
      const event = item.raw;
      return {
        ...EMPTY_SEED,
        timestamp: event.timestamp,
        ...(event.type === 'rapid'
          ? { rapidUnits: event.units, ...(event.insulinName === undefined ? {} : { rapidInsulinName: event.insulinName }) }
          : { basalUnits: event.units, ...(event.insulinName === undefined ? {} : { basalInsulinName: event.insulinName }) }),
        // Una dosis importada conserva la hora de su fuente, como cualquier
        // otro dato que la app no presenció.
        timestampEditable: event.source !== 'imported',
      };
    }
    case 'carbs':
      return {
        ...EMPTY_SEED,
        timestamp: item.timestamp,
        carbsG: item.raw.carbsG,
        timestampEditable: item.raw.source !== 'imported',
      };
    case 'note':
      return {
        ...EMPTY_SEED,
        timestamp: item.raw.timestamp,
        note: item.raw.text,
        timestampEditable: item.raw.source !== 'imported',
      };
    case 'vitals': {
      const vitals = item.raw;
      return {
        ...EMPTY_SEED,
        timestamp: vitals.timestamp,
        ...(vitals.ketonesMmolL === undefined ? {} : { ketonesMmolL: vitals.ketonesMmolL }),
        ...(vitals.weightKg === undefined ? {} : { weightKg: vitals.weightKg }),
        ...(vitals.systolicBP === undefined ? {} : { systolicBP: vitals.systolicBP }),
        ...(vitals.diastolicBP === undefined ? {} : { diastolicBP: vitals.diastolicBP }),
        timestampEditable: vitals.source !== 'imported',
      };
    }
    case 'episode':
      return { ...EMPTY_SEED, timestamp: item.timestamp, timestampEditable: false };
  }
}

/**
 * Qué secciones arrancan abiertas al editar.
 *
 * **Depende del contenido, no del botón.** Es la regla que ya estaba escrita
 * para las herramientas de IA (`mealOf`) llevada al resto del formulario: una
 * sección que tiene datos se abre, porque un dato clínico plegado detrás de un
 * acordeón es un dato que se olvida; una vacía queda plegada pero disponible,
 * porque el tipo con el que nació un registro no puede limitar lo que se le
 * suma después.
 *
 * La calculadora nunca arranca abierta: no es un dato del registro, es una
 * herramienta, y desplegarla sola al abrir cualquier corrección sugiere que
 * hay algo que calcular.
 */
export function masterSectionsFor(seed: MasterSeed): Set<MasterSection> {
  const open = new Set<MasterSection>();
  if (seed.glucose !== undefined) open.add('glucose');
  if (seed.meal !== null || seed.carbsG !== undefined || seed.description !== undefined
    || seed.proteinG !== undefined || seed.fatG !== undefined || seed.fiberG !== undefined
    || seed.caloriesKcal !== undefined || seed.imageUri !== undefined) {
    open.add('meal');
  }
  if (seed.rapidUnits !== undefined || seed.basalUnits !== undefined) open.add('insulin');
  if (seed.ketonesMmolL !== undefined || seed.weightKg !== undefined
    || seed.systolicBP !== undefined || seed.diastolicBP !== undefined) {
    open.add('ketones');
  }
  if (seed.waterMl !== undefined) open.add('water');
  if (seed.note !== undefined) open.add('note');
  return open;
}

/**
 * El título del maestro en edición.
 *
 * Nombra el registro que se está corrigiendo, no el componente: abrir una
 * insulina y leer "Nueva entrada" es perder el hilo de lo que se venía a
 * hacer (`contracts/ux-checklist.md`).
 */
export function masterTitleFor(item: TimelineItem): string {
  switch (item.kind) {
    case 'glucose': return 'Editar glucosa';
    case 'entry': return 'Editar entrada';
    case 'meal': return 'Editar comida';
    case 'insulin': return 'Editar insulina';
    case 'carbs': return 'Editar carbohidratos';
    case 'note': return 'Editar nota';
    case 'water': return 'Editar agua';
    case 'vitals': return 'Editar cetonas y vitales';
    case 'episode': return 'Episodio de comida';
  }
}

/**
 * Si la calculadora está reconstruyendo un momento pasado en vez de calcular
 * para ahora.
 *
 * ## Por qué es una función y no un `editing !== null` suelto
 *
 * Porque hay **dos** caminos hasta esa superficie y la primera versión solo
 * cubrió uno. La advertencia histórica estaba condicionada a modo edición,
 * pero registrar en el pasado —el "+" contextual de Nutrición— llega al mismo
 * bloque en modo creación, con una glucosa de hace cinco días: la sección
 * decía "Calculadora de dosis", el botón "Calcular dosis sugerida" y el
 * resultado "6 U", sin nada que dijera de cuándo era el número.
 *
 * Un cálculo reconstruido que no se declara como tal se lee como una
 * indicación de pincharse ahora. La condición vive acá, con test, para que
 * agregar un tercer camino a la calculadora obligue a pasar por esta regla.
 */
export function isHistoricCalculation(input: {
  /** Se está corrigiendo un registro que ya existe. */
  editing: boolean;
  /** Se está creando con una fecha heredada del calendario. */
  hasPresetDay: boolean;
}): boolean {
  return input.editing || input.hasPresetDay;
}

/**
 * El título exacto de la calculadora cuando se abre sobre un registro
 * histórico.
 *
 * Es literal y no una plantilla: la frase la eligió Verónica, y decir "dosis
 * sugerida" al lado de una glucosa de anteayer se lee como una indicación de
 * pincharse ahora. Ver `HISTORIC_CALCULATOR_WARNING`.
 */
export const HISTORIC_CALCULATOR_TITLE = '¿Se te olvidó cuánto te pinchaste?';

/**
 * La advertencia que acompaña a ese título.
 *
 * Lleva la fecha y la hora de la glucosa **dentro del texto**, no solo
 * arriba: el número grande de la calculadora es lo que se mira, y sin la
 * fecha pegada a él un resultado reconstruido es indistinguible de uno
 * calculado con la glucosa de ahora.
 */
export function historicCalculatorWarning(glucoseTimestamp: string | null): string {
  const when = glucoseTimestamp === null ? 'de ese momento' : `del ${glucoseTimestamp}`;
  return `Este cálculo reconstruye lo que la fórmula habría dado con la glucosa ${when}. `
    + 'NO es una sugerencia para inyectarte ahora: sirve para anotar la dosis que te pusiste y no recordabas. '
    + 'La insulina activa que descuenta es la de AHORA, no la de ese momento, así que el desglose es orientativo.';
}
