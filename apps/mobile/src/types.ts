import type {
  ActivityEvent,
  CarbEvent,
  CGMReading,
  GlucoseInsight,
  InsulinEvent,
  MealEpisodeMetrics,
  MealEvent,
  NoteEvent,
  VitalsEvent,
} from '@type1a/schemas';
import type { ReportRow } from '@type1a/domain';

/**
 * Lo que la pantalla "Resumen" necesita para un rango de fechas. Se pasan
 * los eventos crudos (no filas ya formateadas) porque los tres cálculos que
 * hace la pantalla — `summarizeGlucose`, `buildAmbulatoryProfile` y
 * `buildNutritionInsights` — necesitan valor, timestamp y `origin`, no
 * texto.
 */
export interface SummaryData {
  readings: CGMReading[];
  insulin: InsulinEvent[];
  carbs: CarbEvent[];
  meals: MealEvent[];
  /** Solo para descartar episodios confundidos (Fase 23). No se promedia. */
  activity: ActivityEvent[];
  /**
   * Filas del historial que no se pudieron decodificar en este rango y se
   * descartaron. Se muestra a la usuaria cuando es > 0: un agregado sobre una
   * muestra silenciosamente recortada es un número inventado, no un dato
   * omitido. Ver `DecodeTally` en `db.ts`.
   */
  unreadableCount: number;

  /**
   * Cuánto mirar hacia atrás por dosis que siguen actuando, en minutos
   * (2026-08-25). Sale de la insulina que la usuaria eligió en Ajustes
   * (`rapidInsulinLookbackMinutes` en `packages/domain`). `undefined`
   * mientras no haya elegido: sin dato no se excluye por una suposición.
   */
  rapidLookbackMinutes?: number | undefined;
  /** Ídem para la basal, que dura 24-42 h en vez de 5. Ver `insulin-catalog.ts`. */
  basalLookbackMinutes?: number | undefined;
}

/**
 * Fase 9/11: what `exportReport` hands to `SettingsModal`. `readings` stays
 * structured (not flattened into `rows`) so the report can build daily
 * glucose charts and the Fase 11 clinical summary (Time in Range, HbA1c
 * estimada) without re-fetching or re-parsing anything already loaded.
 */
export interface ReportExport {
  rows: ReportRow[];
  readings: CGMReading[];
  /**
   * Eventos crudos, además de las filas ya formateadas: el reporte incluye
   * los insights alimentarios por franja horaria
   * (`buildNutritionInsights`), que necesitan unidades y gramos como
   * números, no como el texto de `ReportRow.detail`.
   */
  insulin: InsulinEvent[];
  carbs: CarbEvent[];
  meals: MealEvent[];
  /** Solo para descartar episodios confundidos (Fase 23). No se promedia. */
  activity: ActivityEvent[];
  /**
   * Cuánto mirar hacia atrás por dosis que siguen actuando, en minutos
   * (2026-08-25). Sale de la insulina que la usuaria eligió en Ajustes
   * (`rapidInsulinLookbackMinutes` en `packages/domain`). `undefined`
   * mientras no haya elegido: sin dato no se excluye por una suposición.
   */
  rapidLookbackMinutes?: number | undefined;
  /** Ídem para la basal, que dura 24-42 h en vez de 5. Ver `insulin-catalog.ts`. */
  basalLookbackMinutes?: number | undefined;
  /**
   * Qué insulinas usa, para el encabezado del reporte (2026-08-25). El
   * equipo clínico necesita saberlo: la misma curva significa cosas
   * distintas con Fiasp que con regular humana.
   */
  rapidInsulinId?: string | undefined;
  basalInsulinId?: string | undefined;
  rapidInsulinDurationHours?: number | undefined;
  basalInsulinDurationHours?: number | undefined;
  /** Ver la nota homónima en `SummaryData`. El reporte lo declara al médico. */
  unreadableCount: number;
}

/**
 * Lo que la pantalla de Nutrición necesita para un día concreto, más la
 * ventana larga que alimenta los patrones de grasa/proteína vs. glucosa.
 * `readings` incluye las lecturas de la ventana larga porque la respuesta a
 * una comida puede caer al día siguiente (un almuerzo a las 21:00 mide hasta
 * las 02:00).
 */
export interface NutritionDayData {
  dayMeals: MealEvent[];
  dayCarbs: CarbEvent[];
  patternMeals: MealEvent[];
  /**
   * Insulina, carbohidratos y actividad de la MISMA ventana larga que
   * `patternMeals` (Fase 23). Existen solo para descartar episodios
   * confundidos: sin ellos, una colación a las 2 h entra al promedio de
   * grasa/proteína como si fuera efecto tardío de la comida.
   */
  patternInsulin: InsulinEvent[];
  patternCarbs: CarbEvent[];
  patternActivity: ActivityEvent[];
  readings: CGMReading[];
  /**
   * Cuánto mirar hacia atrás por dosis que siguen actuando, en minutos
   * (2026-08-25). Sale de la insulina que la usuaria eligió en Ajustes
   * (`rapidInsulinLookbackMinutes` en `packages/domain`). `undefined`
   * mientras no haya elegido: sin dato no se excluye por una suposición.
   */
  rapidLookbackMinutes?: number | undefined;
  /** Ídem para la basal, que dura 24-42 h en vez de 5. Ver `insulin-catalog.ts`. */
  basalLookbackMinutes?: number | undefined;
  unreadableCount: number;
}

/**
 * Destinos de los accesos rápidos.
 *
 * **`'meal'` reemplazó a `'carbs'` y `'rapid'` (Fase 21, 2026-08-25).** Los
 * dos botones sueltos escribían filas independientes con timestamps propios,
 * y por eso la app después no encontraba qué dosis correspondía a qué
 * carbohidratos. Ahora los dos casos entran por `MealModal`, que guarda todo
 * bajo un mismo timestamp.
 *
 * ⚠️ Los identificadores viejos **siguen existiendo** y no se pueden borrar:
 * la notificación pegajosa que ya está en la bandeja del teléfono fue creada
 * por un build anterior y sus botones siguen emitiendo `carbs`/`rapid`, igual
 * que cualquier deep link viejo. `normalizeQuickRoute` los traduce.
 */
export type QuickRoute = 'meal' | 'basal' | 'correction';

/**
 * Las tablas cuyo evento suelto se puede **promover** a entrada agrupada.
 *
 * Vive acá, en el módulo de tipos sin dependencias, porque la usan las dos
 * puntas: `masterModal.ts` para decidir la ruta de guardado (puro, con test) y
 * `db.ts` para ejecutarla. Duplicar la lista es cómo se abre la puerta a que
 * una tabla exista en una y no en la otra, y el síntoma sería un botón
 * "Editar" que no hace nada.
 */
export type PromotableTable = 'insulin_events' | 'carb_events' | 'note_events' | 'meal_events' | 'vitals_events';

/**
 * Con qué sección arranca abierto el Modal Maestro. Vive acá y no en el
 * componente para que la regla se pueda probar sin montar React.
 */
export type EntryFocus = 'all' | 'glucose' | 'meal' | 'insulin' | 'ketones' | 'note';

/** Lo que puede llegar desde una notificación vieja o un deep link viejo. */
export type LegacyQuickRoute = QuickRoute | 'carbs' | 'rapid';

/**
 * Traduce un destino heredado al actual. Explícito y con nombre propio en vez
 * de un `as`: si mañana se fusiona otro botón, el mapeo se agrega acá y no
 * hay que buscarlo en tres archivos.
 */
export function normalizeQuickRoute(route: LegacyQuickRoute): QuickRoute {
  if (route === 'carbs' || route === 'rapid') return 'meal';
  return route;
}

/**
 * How a reminder notification alerts. Android fixes sound/vibration per
 * channel (immutable after creation), so each style maps to its own
 * pre-created channel — see `reminderChannelId` in notifications.ts. Applies
 * to every reminder (post-comida, corrección, capilar); the sticky
 * quick-entry notification keeps its own silent channel, since it reposts
 * every ~15 min and must never buzz.
 */
export type ReminderAlertStyle = 'sound' | 'vibrate' | 'both' | 'silent';

export type TimelineItem =
  | {
      id: string;
      kind: 'insulin';
      timestamp: string;
      title: string;
      detail: string;
      tone: 'blue' | 'navy';
      raw: InsulinEvent;
    }
  | {
      id: string;
      kind: 'carbs';
      timestamp: string;
      title: string;
      detail: string;
      tone: 'orange';
      raw: { carbsG: number; source: 'manual' | 'meal_confirmed' | 'imported' };
    }
  | {
      id: string;
      kind: 'meal';
      timestamp: string;
      title: string;
      detail: string;
      tone: 'orange';
      raw: MealEvent;
    }
  | {
      id: string;
      kind: 'episode';
      timestamp: string;
      title: string;
      detail: string;
      tone: 'green' | 'navy';
      metrics?: MealEpisodeMetrics;
      insight?: GlucoseInsight;
    }
  | {
      id: string;
      kind: 'glucose';
      timestamp: string;
      title: string;
      detail: string;
      // 'warning' marks synthetic (sandbox) data, 'muted' marks imported
      // history (matches GlucoseChart's dashed/muted treatment) — neither
      // may look like a live reading anywhere in the app, Timeline included.
      tone: 'teal' | 'warning' | 'muted';
      raw: CGMReading;
    }
  | {
      id: string;
      kind: 'note';
      timestamp: string;
      title: string;
      detail: string;
      tone: 'navy';
      raw: NoteEvent;
    }
  | {
      /**
       * Un registro de vitales suelto — cetonas, peso o presión anotados desde
       * su propio acceso rápido, sin pertenecer a una entrada empaquetada.
       *
       * Las cetonas son el dato de triage de cetoacidosis: hasta el 2026-08-26
       * `getTimeline` no tenía rama para estas filas y desaparecían después de
       * guardarse. `tone: 'red'` marca la banda urgente, pero **la banda va
       * siempre escrita en `detail`** — un estado no se comunica solo con
       * color.
       */
      id: string;
      kind: 'vitals';
      timestamp: string;
      title: string;
      detail: string;
      tone: 'red' | 'navy';
      raw: VitalsEvent;
    }
  | {
      // A packaged "Nueva entrada" save — glucose, carbs/comida, rápida,
      // basal, nota, all written together and shown/edited as one thing.
      // `id` is the shared entry_group_id, not any single row's id.
      id: string;
      kind: 'entry';
      timestamp: string;
      title: string;
      detail: string;
      tone: 'teal';
      raw: TimelineEntryGroupRaw;
    };

export interface TimelineEntryGroupRaw {
  entryGroupId: string;
  glucose?: number;
  /**
   * Origin of the group's glucose reading, when it has one. A packaged entry
   * can now be anchored on an auto-saved sensor reading (Verónica attaches
   * carbs/insulin/nota to a past reading — "la hora en que comí y me pinché"),
   * not just a hand-typed 'manual' value. The edit form keeps a non-'manual'
   * value read-only and never relabels it, same rule as the standalone
   * 'glucose' item — real sensor data is a record, not a field to correct.
   */
  glucoseOrigin?: CGMReading['origin'];
  description?: string;
  carbsG?: number;
  /**
   * La comida completa del grupo, cuando la tiene.
   *
   * Los campos de arriba están aplanados para dibujar la fila; esto es el
   * `MealEvent` entero, y existe para que las **herramientas de edición con
   * IA aparezcan por contenido y no por qué botón abrió el modal**
   * (`projectbrief.md` § Modal Maestro). Antes solo un ítem `kind: 'meal'`
   * podía llegar a ellas, así que la misma comida guardada dentro de una
   * entrada empaquetada quedaba fuera de su propio editor.
   */
  meal?: MealEvent;
  aiEstimatedCarbsG?: number;
  /**
   * Macros (Fase 21). Editar dejó de ser más pobre que crear: `EntryModal`
   * ya los ofrecía al registrar, y el formulario de edición no. Un campo en
   * blanco significa "no lo anoté", nunca "0 g".
   */
  proteinG?: number;
  fatG?: number;
  fiberG?: number;
  /** Cetonas en sangre del grupo, si las tiene (mmol/L). */
  ketonesMmolL?: number;
  /**
   * Peso y presión del grupo, cuando los tiene. Se leen de vuelta por la
   * misma razón que las cetonas: el formulario que no ve un dato guardado es
   * el formulario que lo borra al guardar.
   */
  weightKg?: number;
  systolicBP?: number;
  diastolicBP?: number;
  /**
   * Foto de la comida del grupo, si la tiene.
   *
   * Se lee ya, pero **todavía no se muestra ni se puede cambiar**: editar con
   * foto es lo único que quedó pendiente de la Fase 21 (ver el roadmap). Está
   * acá para que la corrida que lo construya no tenga que tocar también la
   * capa de lectura.
   */
  imageUri?: string;
  rapidUnits?: number;
  basalUnits?: number;
  /**
   * Qué insulina se usó, tal como quedó estampada al crear el registro.
   *
   * Se lee de vuelta para poder **mostrarla** (es dato de solo lectura: se
   * cambia en Ajustes → Terapia, no por registro) y, sobre todo, para que el
   * editor no la pise. Que el formulario no la conociera es lo que permitía
   * que una actualización parcial la borrara en silencio.
   */
  rapidInsulinName?: string;
  /**
   * Propósito y desglose de la rápida del grupo (2026-09-02). La fila del
   * timeline mostraba solo el total: no decía cuánto cubría los
   * carbohidratos, cuánto corregía la glucosa, ni cuánta insulina activa se
   * descontó. Ausentes en toda dosis escrita a mano.
   */
  rapidPurpose?: 'meal' | 'correction' | 'combined';
  rapidMealUnits?: number;
  rapidCorrectionUnits?: number;
  rapidIobUnits?: number;
  basalInsulinName?: string;
  /** Calorías de la comida del grupo, si las tiene. */
  caloriesKcal?: number;
  note?: string;
}

export interface StoredMealEpisode {
  id: string;
  mealId: string;
  mealTimestamp: string;
  status: 'collecting' | 'complete' | 'incomplete';
  insulinContextConfirmed: boolean;
  rapidInsulinEventId?: string;
  metrics?: MealEpisodeMetrics;
  insight?: GlucoseInsight;
}

export interface MealWithEpisode {
  meal: MealEvent;
  episode: StoredMealEpisode;
}

/**
 * Lo que el Modal Maestro devuelve al guardar la edición de un registro.
 *
 * ## Por qué reemplazó a `TimelineEditPayload`
 *
 * Aquel tipo tenía **una variante por tipo de ítem** —insulina, carbos,
 * glucosa, nota, entrada— y cada variante llevaba su propio subconjunto de
 * campos. Esa forma era el problema, no un síntoma: codificaba en el tipo que
 * "una insulina solo puede editar unidades", que es exactamente la regla que
 * `projectbrief.md` prohíbe. El tipo con el que nació un evento no restringe
 * lo que se le puede sumar después, así que **hay un solo payload** y lo que
 * cambia es qué sección se abre primero.
 *
 * ## Semántica de cada campo
 *
 * Reemplazo completo para lo que el formulario muestra entero (un campo
 * vaciado se borra); **parche** para lo que no es un campo de texto: la foto,
 * el análisis y los vitales. Ver `UnifiedEntryInput` y `VitalsPatch` en
 * `db.ts`, que hablan el mismo idioma.
 */
export interface MasterEditPayload {
  /**
   * Fecha y hora corregidas. Ausente = el registro no se mueve.
   *
   * Mover es una transacción única que arrastra el episodio, la fila espejo
   * de carbohidratos y todas las filas del grupo. Lo que **nunca** se mueve
   * es `ingestedAt` ni la hora de una lectura de sensor.
   */
  timestamp?: string;
  /** Solo para una glucosa capilar tecleada por la usuaria. */
  manualGlucose?: number;
  carbsG?: number;
  description?: string;
  proteinG?: number;
  fatG?: number;
  fiberG?: number;
  caloriesKcal?: number;
  /** Parche: ausente no toca la foto guardada, `null` la quita. */
  imageUri?: string | null;
  /** Un análisis nuevo, cuando la edición pasó por la IA o por el carrito. */
  aiEstimatedCarbsG?: number;
  aiAnalysisId?: string;
  macrosSource?: MealEvent['macrosSource'] | null;
  rapidUnits?: number;
  basalUnits?: number;
  rapidIncludesCorrection?: boolean;
  /**
   * Cetonas, peso y presión. `undefined` = no se tocó · `null` = borrar.
   * Corregir una cetona no puede llevarse el peso de la misma fila.
   */
  vitals?: {
    ketonesMmolL?: number | null;
    weightKg?: number | null;
    systolicBP?: number | null;
    diastolicBP?: number | null;
  };
  note?: string;
}

export interface PendingInsulinAssociation {
  episodeId: string;
  mealTimestamp: string;
  confirmedCarbsG: number;
  candidates: InsulinEvent[];
}
