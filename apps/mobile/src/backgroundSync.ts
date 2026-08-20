import * as BackgroundTask from 'expo-background-task';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import * as SQLite from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';

import { latestLiveReading } from '@type1a/domain';

import { getSetting, initializeDatabase, upsertCGMReadings } from './db';
import {
  fetchSensorReadings,
  fetchSensorStatus,
  LEGACY_BACKEND_SENSOR_KEY,
  resolveSensorSource,
} from './sensorConnection';
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
 * Serializes every call into this module (both task bodies) through one
 * promise chain, and always closes the connection it opened before the next
 * call gets to run.
 *
 * Bug this fixes: a burst of taps on the notification's "Actualizar" button
 * — each one a separate `NOTIFICATION_TASK_ID` invocation — used to call
 * `openDb()` and never close it, so N rapid taps left N native SQLite
 * connections open concurrently against the same SQLCipher/WAL file (on top
 * of the app's own long-lived `SQLiteProvider` connection, if the app
 * process was still alive with the notification shade pulled down). That's
 * what crashed with "NativeDatabase.execAsync has been rejected —
 * NullPointerException" on-device. This queue plus the `finally`-closed
 * connection below means at most one connection this module owns is ever
 * open at a time, and a burst of taps collapses into sequential runs instead
 * of concurrent ones.
 */
let syncChain: Promise<void> = Promise.resolve();

async function runSyncSerialized(): Promise<void> {
  const run = syncChain.then(async () => {
    const db = await openDb();
    try {
      await runCgmSync(db);
    } finally {
      await db.closeAsync();
    }
  });
  // Swallow so one failed run doesn't permanently wedge the chain for
  // whichever call comes after it — but this call still awaits `run` below
  // and sees its own rejection.
  syncChain = run.catch(() => {});
  return run;
}

/**
 * Fetches recent CGM data, caches it, and — if the quick-entry notification
 * is on — reposts it with the fresh reading. Shared by the periodic
 * background task below and the notification's own "Actualizar" button
 * (see `NOTIFICATION_TASK_ID`), since a manual tap should do exactly the
 * same sync a scheduled run does, not a separate, thinner version of it.
 */
async function runCgmSync(db: SQLiteDatabase): Promise<void> {
  // Tiene que resolver la fuente igual que `App.tsx`. Cuando esto llamaba
  // directo a `fetchCGMStatus`/`fetchCGMReadings`, seguía leyendo la cuenta
  // global del backend cada ~15 minutos —y en cada toque de "Actualizar" de
  // la notificación, incluso con la app cerrada— aunque la usuaria hubiera
  // conectado la suya. Escribía esas lecturas en el mismo SQLite y ponía la
  // glucosa de otra persona en la pantalla bloqueada rotulada como sensor en
  // vivo. Una vez mezcladas son indistinguibles: quedan con `origin:'real'` y
  // el mismo `source`.
  const source = await resolveSensorSource(
    (await getSetting(db, LEGACY_BACKEND_SENSOR_KEY)) === 'true',
  );
  if (source === 'none') return;

  const to = new Date();
  const from = new Date(to.getTime() - SYNC_WINDOW_MS);
  const [status, readings] = await Promise.all([
    fetchSensorStatus(source),
    fetchSensorReadings(source, from, to),
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
    await runSyncSerialized();
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
    await runSyncSerialized();
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
