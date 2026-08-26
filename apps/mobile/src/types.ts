import type {
  ActivityEvent,
  CarbEvent,
  CGMReading,
  GlucoseInsight,
  InsulinEvent,
  MealEpisodeMetrics,
  MealEvent,
  NoteEvent,
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
 * What a Timeline edit form can submit, one variant per editable kind.
 * `episode` has none — its metrics/insight are computed, not user-entered,
 * so it's delete-only (see TimelineDetailModal / deleteMealEpisode).
 */
export type TimelineEditPayload =
  | { kind: 'insulin'; type: 'rapid' | 'basal'; units: number; insulinName?: string }
  | { kind: 'carbs'; carbsG: number }
  // La comida NO tiene variante acá: desde la Fase 17 se edita en
  // `MealEditModal`, que además de la nota toca macros, carbohidratos
  // confirmados y foto, y ofrece los tres modos de IA. Un segundo camino de
  // edición inline para lo mismo garantizaba que los dos se fueran
  // separando.
  // A standalone glucose reading. `glucose` (the value) is only present when
  // editing a hand-typed 'manual' reading — a sensor/imported/synthetic value
  // is read-only. The optional attachment fields turn a bare reading into a
  // packaged entry anchored on it (Verónica adding carbs/insulina to an
  // auto-saved sensor reading she measured a meal against after the fact).
  | {
      kind: 'glucose';
      glucose?: number;
      carbsG?: number;
      description?: string;
      proteinG?: number;
      fatG?: number;
      fiberG?: number;
      /** Ver la nota homónima en la variante `'entry'`. */
      ketonesMmolL?: number;
      rapidUnits?: number;
      basalUnits?: number;
      note?: string;
      rapidIncludesCorrection?: boolean;
    }
  | { kind: 'note'; text: string }
  // Whatever a field omits gets deleted from the group, not left alone —
  // this is a full replace of the packaged entry's contents, matching what
  // the edit form shows (every field, blank ones included).
  | {
      kind: 'entry';
      manualGlucose?: number;
      carbsG?: number;
      description?: string;
      proteinG?: number;
      fatG?: number;
      fiberG?: number;
      /**
       * Cetonas en sangre, mmol/L (2026-08-25). El editor tiene que poder
       * guardar lo mismo que "Nueva entrada" — pedido repetido de Verónica.
       */
      ketonesMmolL?: number;
      rapidUnits?: number;
      basalUnits?: number;
      note?: string;
      rapidIncludesCorrection?: boolean;
    };

export interface PendingInsulinAssociation {
  episodeId: string;
  mealTimestamp: string;
  confirmedCarbsG: number;
  candidates: InsulinEvent[];
}
