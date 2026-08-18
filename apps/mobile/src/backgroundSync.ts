import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import * as SQLite from 'expo-sqlite';

import { latestLiveReading } from '@type1a/domain';

import { fetchCGMReadings, fetchCGMStatus } from './api';
import { getSetting, initializeDatabase, upsertCGMReadings } from './db';
import { postQuickEntryNotification, QUICK_ENTRY_ENABLED_KEY } from './notifications';

const TASK_ID = 'type1a-background-cgm-sync';
const DATABASE_NAME = 'type1a.db';

/**
 * Android's WorkManager treats this as a floor, not a schedule: the OS
 * decides the actual timing based on battery, network, and Doze state, and
 * may wait well past 15 minutes. This is why AGENTS.md's "never present
 * delayed CGM data as live" rule still applies — a background-synced
 * reading is exactly the kind of value that needs its own timestamp shown,
 * never silently assumed current.
 */
const MINIMUM_INTERVAL_MINUTES = 15;

const SYNC_WINDOW_MS = 4 * 60 * 60_000;

/**
 * The task body must be defined at module scope, unconditionally, every
 * time the JS bundle loads — including the headless launch the OS uses to
 * run a background task with no UI on screen. This module must be imported
 * for that side effect before the app does anything else (see App.tsx).
 */
TaskManager.defineTask(TASK_ID, async () => {
  try {
    const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
    // Idempotent: safe to call on every headless run, not just first launch.
    await initializeDatabase(db);

    const to = new Date();
    const from = new Date(to.getTime() - SYNC_WINDOW_MS);
    const [status, readings] = await Promise.all([
      fetchCGMStatus(),
      fetchCGMReadings(from, to),
    ]);
    await upsertCGMReadings(db, readings);

    const notificationEnabled = (await getSetting(db, QUICK_ENTRY_ENABLED_KEY)) === 'true';
    if (notificationEnabled) {
      const showGlucose = (await getSetting(db, 'showGlucoseOnLockScreen')) === 'true';
      const latest = latestLiveReading(readings);
      // A background run that found nothing new still refreshes the
      // notification's own "as of" stamp against `status`, so a silently
      // failing sensor shows as stale rather than freezing on old data.
      await postQuickEntryNotification(latest, showGlucose, status);
    }

    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundSync(): Promise<void> {
  const already = await TaskManager.isTaskRegisteredAsync(TASK_ID);
  if (already) return;
  await BackgroundTask.registerTaskAsync(TASK_ID, { minimumInterval: MINIMUM_INTERVAL_MINUTES });
}

export async function unregisterBackgroundSync(): Promise<void> {
  const registered = await TaskManager.isTaskRegisteredAsync(TASK_ID);
  if (!registered) return;
  await BackgroundTask.unregisterTaskAsync(TASK_ID);
}
