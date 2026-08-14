import type { SQLiteDatabase } from 'expo-sqlite';

import { calculateMealEpisodeMetrics, findRapidInsulinCandidates } from '@type1a/domain';

import { fetchGlucoseInsight } from './api';
import {
  confirmEpisodeInsulinContext,
  getCGMReadings,
  getCollectingEpisodes,
  getInsulinEventsForMeal,
  updateEpisode,
} from './db';

export interface EpisodeProcessingResult {
  completed: number;
  incomplete: number;
  awaitingInsulinConfirmation: number;
}

export async function processReadyEpisodes(
  db: SQLiteDatabase,
  now = new Date(),
): Promise<EpisodeProcessingResult> {
  const collecting = await getCollectingEpisodes(db);
  const result: EpisodeProcessingResult = {
    completed: 0,
    incomplete: 0,
    awaitingInsulinConfirmation: 0,
  };

  for (const { episode, meal } of collecting) {
    const ageMinutes = (now.getTime() - Date.parse(meal.timestamp)) / 60_000;
    if (ageMinutes < 180) continue;

    const [readings, insulinEvents] = await Promise.all([
      getCGMReadings(
        db,
        new Date(Date.parse(meal.timestamp) - 15 * 60_000),
        new Date(Date.parse(meal.timestamp) + 240 * 60_000),
      ),
      getInsulinEventsForMeal(db, meal.timestamp),
    ]);
    const association = findRapidInsulinCandidates(meal.timestamp, insulinEvents);
    let insulinContextConfirmed = episode.insulinContextConfirmed;
    let rapidInsulinEventId = episode.rapidInsulinEventId;
    if (!insulinContextConfirmed && association.candidateIds.length === 1) {
      rapidInsulinEventId = association.candidateIds[0]!;
      await confirmEpisodeInsulinContext(db, episode.id, rapidInsulinEventId);
      insulinContextConfirmed = true;
    }
    if (!insulinContextConfirmed) {
      result.awaitingInsulinConfirmation += 1;
      continue;
    }
    const rapidInsulin = rapidInsulinEventId === undefined
      ? undefined
      : insulinEvents.find((event) => event.id === rapidInsulinEventId);

    const metrics = calculateMealEpisodeMetrics({
      mealTimestamp: meal.timestamp,
      readings,
      ...(meal.confirmedCarbsG === undefined ? {} : { confirmedCarbsG: meal.confirmedCarbsG }),
      ...(meal.proteinG === undefined ? {} : { proteinG: meal.proteinG }),
      ...(meal.fatG === undefined ? {} : { fatG: meal.fatG }),
      ...(rapidInsulin === undefined ? {} : { rapidInsulin }),
    });
    const complete = meal.confirmedCarbsG !== undefined
      && metrics.startingGlucose !== undefined
      && metrics.glucose60 !== undefined
      && metrics.glucose120 !== undefined
      && metrics.glucose180 !== undefined;

    if (!complete && ageMinutes < 240) continue;
    if (!complete) {
      await updateEpisode(db, episode.id, 'incomplete', metrics);
      result.incomplete += 1;
      continue;
    }

    let insight;
    try {
      insight = await fetchGlucoseInsight(metrics);
    } catch {
      // The deterministic episode remains complete when the optional AI service is offline.
    }
    await updateEpisode(db, episode.id, 'complete', metrics, insight);
    result.completed += 1;
  }
  return result;
}
