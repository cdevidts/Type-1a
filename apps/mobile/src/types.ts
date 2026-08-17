import type {
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
    }
  | {
      id: string;
      kind: 'carbs';
      timestamp: string;
      title: string;
      detail: string;
      tone: 'orange';
    }
  | {
      id: string;
      kind: 'meal';
      timestamp: string;
      title: string;
      detail: string;
      tone: 'orange';
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
      tone: 'teal';
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
