import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import * as SQLite from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';

import { latestLiveReading } from '@type1a/domain';

import { fetchCGMReadings, fetchCGMStatus } from './api';
import { getSetting, initializeDatabase, upsertCGMReadings } from './db';
import { ACTION_REFRESH, postQuickEntryNotification, QUICK_ENTRY_ENABLED_KEY } from './notifications';

const PERIODIC_TASK_ID = 'type1a-background-cgm-sync';
const NOTIFICATION_TASK_ID = 'type1a-notification-response';
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

async function openDb(): Promise<SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DATABASE_NAME);
  // Idempotent: safe to call on every headless run, not just first launch.
  await initializeDatabase(db);
  return db;
}

/**
 * Fetches recent CGM data, caches it, and — if the quick-entry notification
 * is on — reposts it with the fresh reading. Shared by the periodic
 * background task below and the notification's own "Actualizar" button
 * (see `NOTIFICATION_TASK_ID`), since a manual tap should do exactly the
 * same sync a scheduled run does, not a separate, thinner version of it.
 */
async function runCgmSync(db: SQLiteDatabase): Promise<void> {
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
    // A run that found nothing new still refreshes the notification's own
    // "as of" stamp against `status`, so a silently failing sensor shows as
    // stale rather than freezing on old data.
    await postQuickEntryNotification(latest, showGlucose, status);
  }
}

/**
 * The task bodies must be defined at module scope, unconditionally, every
 * time the JS bundle loads — including the headless launch the OS uses to
 * run a background task with no UI on screen. This module must be imported
 * for that side effect before the app does anything else (see App.tsx).
 */
TaskManager.defineTask(PERIODIC_TASK_ID, async () => {
  try {
    await runCgmSync(await openDb());
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/**
 * Handles a tap on the quick-entry notification's own "Actualizar" button.
 * Registered separately from `PERIODIC_TASK_ID` via
 * `Notifications.registerTaskAsync` (an expo-notifications mechanism, not
 * expo-background-task) — per Expo's docs, on Android this runs in response
 * to a notification action tap even while the app is backgrounded or fully
 * terminated, without ever bringing the app to the foreground (the action
 * is declared with `opensAppToForeground: false`). Best-effort like every
 * background path here: the OS can still decide not to deliver it (Doze,
 * battery saver), which is why the notification body keeps saying "toca
 * Actualizar" rather than promising it always works instantly.
 */
TaskManager.defineTask<Notifications.NotificationTaskPayload>(NOTIFICATION_TASK_ID, async ({ data }) => {
  try {
    if (!('actionIdentifier' in data) || data.actionIdentifier !== ACTION_REFRESH) {
      return Notifications.BackgroundNotificationTaskResult.NoData;
    }
    await runCgmSync(await openDb());
    return Notifications.BackgroundNotificationTaskResult.NewData;
  } catch {
    return Notifications.BackgroundNotificationTaskResult.Failed;
  }
});

export async function registerBackgroundSync(): Promise<void> {
  if (!(await TaskManager.isTaskRegisteredAsync(PERIODIC_TASK_ID))) {
    await BackgroundTask.registerTaskAsync(PERIODIC_TASK_ID, { minimumInterval: MINIMUM_INTERVAL_MINUTES });
  }
  // The "Actualizar" button only exists on the quick-entry notification, so
  // this is harmless to register unconditionally alongside it — it's
  // already inert whenever that notification isn't showing.
  if (!(await TaskManager.isTaskRegisteredAsync(NOTIFICATION_TASK_ID))) {
    await Notifications.registerTaskAsync(NOTIFICATION_TASK_ID);
  }
}

export async function unregisterBackgroundSync(): Promise<void> {
  if (await TaskManager.isTaskRegisteredAsync(PERIODIC_TASK_ID)) {
    await BackgroundTask.unregisterTaskAsync(PERIODIC_TASK_ID);
  }
  if (await TaskManager.isTaskRegisteredAsync(NOTIFICATION_TASK_ID)) {
    await Notifications.unregisterTaskAsync(NOTIFICATION_TASK_ID);
  }
}
