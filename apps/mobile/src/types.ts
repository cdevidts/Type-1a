import type {
  CGMReading,
  GlucoseInsight,
  InsulinEvent,
  MealEpisodeMetrics,
  MealEvent,
} from '@type1a/schemas';

export type QuickRoute = 'carbs' | 'rapid' | 'basal' | 'correction';

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
    };

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

export interface PendingInsulinAssociation {
  episodeId: string;
  mealTimestamp: string;
  confirmedCarbsG: number;
  candidates: InsulinEvent[];
}
