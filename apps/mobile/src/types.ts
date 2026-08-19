import type {
  CGMReading,
  GlucoseInsight,
  InsulinEvent,
  MealEpisodeMetrics,
  MealEvent,
  NoteEvent,
} from '@type1a/schemas';
import type { ReportRow } from '@type1a/domain';

/**
 * Fase 9/11: what `exportReport` hands to `SettingsModal`. `readings` stays
 * structured (not flattened into `rows`) so the report can build daily
 * glucose charts and the Fase 11 clinical summary (Time in Range, HbA1c
 * estimada) without re-fetching or re-parsing anything already loaded.
 */
export interface ReportExport {
  rows: ReportRow[];
  readings: CGMReading[];
}

export type QuickRoute = 'carbs' | 'rapid' | 'basal' | 'correction';

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
  | { kind: 'meal'; note: string }
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
