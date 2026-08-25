import type { SQLiteDatabase } from 'expo-sqlite';

import { calculateMealEpisodeMetrics, collectEpisodeContext, findRapidInsulinCandidates } from '@type1a/domain';

import { fetchGlucoseInsight } from './api';
import {
  confirmEpisodeInsulinContext,
  getCGMReadings,
  getCollectingEpisodes,
  getEventsDuringEpisode,
  getInsulinEventsForMeal,
  updateEpisode,
} from './db';

/**
 * Cuánto dura la ventana de la que el episodio junta contexto (Fase 23).
 *
 * 240 min, el mismo horizonte del que ya se traen lecturas de CGM más abajo:
 * si la curva se mide hasta las 4 h, lo que pudo moverla también tiene que
 * mirarse hasta las 4 h. Un número más corto dejaría fuera justo las
 * correcciones tardías, que son las que más ensucian la lectura.
 */
const EPISODE_CONTEXT_WINDOW_MINUTES = 240;

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

    // Qué más pasó mientras se medía este episodio. Se ignoran la comida misma
    // y su propio bolo: son el episodio, no algo que le ocurrió encima.
    const during = await getEventsDuringEpisode(db, meal.timestamp, EPISODE_CONTEXT_WINDOW_MINUTES);
    const contextEvents = collectEpisodeContext({
      anchorTimestamp: meal.timestamp,
      windowMinutes: EPISODE_CONTEXT_WINDOW_MINUTES,
      ignoreIds: [meal.id, ...(rapidInsulinEventId === undefined ? [] : [rapidInsulinEventId])],
      insulin: during.insulin,
      carbs: during.carbs,
      meals: during.meals,
      activity: during.activity,
      notes: during.notes,
    });

    const metrics = calculateMealEpisodeMetrics({
      mealTimestamp: meal.timestamp,
      readings,
      ...(meal.confirmedCarbsG === undefined ? {} : { confirmedCarbsG: meal.confirmedCarbsG }),
      ...(meal.proteinG === undefined ? {} : { proteinG: meal.proteinG }),
      ...(meal.fatG === undefined ? {} : { fatG: meal.fatG }),
      ...(rapidInsulin === undefined ? {} : { rapidInsulin }),
      ...(contextEvents.length === 0 ? {} : { contextEvents }),
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
