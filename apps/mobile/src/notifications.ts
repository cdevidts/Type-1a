import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { assessFreshness } from '@type1a/domain';
import type { CGMProviderStatus, CGMReading } from '@type1a/schemas';

import { formatClock, trendArrow } from './format';
import type { QuickRoute, ReminderAlertStyle } from './types';

export const QUICK_CATEGORY = 'type1a-quick-entry';
export const ACTION_CARBS = 'quick-carbs';
export const ACTION_RAPID = 'quick-rapid';
export const ACTION_CORRECTION = 'quick-correction';
/** Handled entirely in the background by backgroundSync.ts's notification-response task — never routed to a QuickRoute. */
export const ACTION_REFRESH = 'quick-refresh';

/** app_settings key: whether the sticky quick-entry notification (and the
 * background sync that keeps it fresh) is turned on. Read by
 * `backgroundSync.ts`, which has no React context to read component state
 * from. */
export const QUICK_ENTRY_ENABLED_KEY = 'quickEntryNotificationEnabled';

/** data.kind stamped on capillary-measurement reminders, so they can be
 * found and cancelled as a group when the schedule changes. */
export const CAPILLARY_REMINDER_KIND = 'capillary-reminder';

/**
 * Android fixes a channel's sound/vibration at creation and ignores later
 * changes, so a user-selectable alert style can't mutate one channel — it
 * has to pick between channels created up front, one per style. All reminders
 * (post-comida, corrección, capilar) share this set; the sticky quick-entry
 * notification deliberately does NOT (it stays on its own silent channel).
 */
const REMINDER_CHANNEL_IDS: Record<ReminderAlertStyle, string> = {
  both: 'reminders-both',
  sound: 'reminders-sound',
  vibrate: 'reminders-vibrate',
  silent: 'reminders-silent',
};

export function reminderChannelId(style: ReminderAlertStyle): string {
  return REMINDER_CHANNEL_IDS[style];
}

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function configureNotifications(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('quick-entry', {
      name: 'Accesos rápidos',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      showBadge: false,
    });
    // Four reminder channels, one per alert style. Android only makes sound
    // and vibrates at importance >= DEFAULT; LOW shows silently in the tray.
    // `sound: null` mutes an otherwise-audible channel; a vibrationPattern
    // with more than the leading 0 is what actually buzzes.
    const buzz = [0, 250, 250, 250];
    await Notifications.setNotificationChannelAsync('reminders-both', {
      name: 'Recordatorios (sonido y vibración)',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      enableVibrate: true,
      vibrationPattern: buzz,
      showBadge: false,
    });
    await Notifications.setNotificationChannelAsync('reminders-sound', {
      name: 'Recordatorios (solo sonido)',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      enableVibrate: false,
      vibrationPattern: [0],
      showBadge: false,
    });
    await Notifications.setNotificationChannelAsync('reminders-vibrate', {
      name: 'Recordatorios (solo vibración)',
      importance: Notifications.AndroidImportance.HIGH,
      sound: null,
      enableVibrate: true,
      vibrationPattern: buzz,
      showBadge: false,
    });
    await Notifications.setNotificationChannelAsync('reminders-silent', {
      name: 'Recordatorios (silencioso)',
      importance: Notifications.AndroidImportance.LOW,
      sound: null,
      enableVibrate: false,
      vibrationPattern: [0],
      showBadge: false,
    });
    // Older builds created these two; they're replaced by the style channels
    // above. Deleting keeps the system notification settings tidy (Android
    // migrates any still-pending notification to a fallback channel).
    await Notifications.deleteNotificationChannelAsync('meal-episodes');
    await Notifications.deleteNotificationChannelAsync('correction-reminders');
  }
  await Notifications.setNotificationCategoryAsync(QUICK_CATEGORY, [
    // Order matters: Android renders only the FIRST 3 action buttons in a
    // notification's row (iOS stacks all of them). "Actualizar" is the whole
    // reason this notification is useful without opening the app — seeing a
    // fresh glucose value — so it goes first and is always visible. When a
    // device only shows three, the one that drops off is "Corrección" (last),
    // the most redundant here: it's reachable in-app AND has its own
    // dedicated correction-reminder notification, unlike the others.
    {
      identifier: ACTION_REFRESH,
      buttonTitle: 'Actualizar',
      // The whole point: pull fresh CGM data and repost this notification
      // without opening the app. Handled headlessly in backgroundSync.ts.
      options: { opensAppToForeground: false },
    },
    { identifier: ACTION_CARBS, buttonTitle: '+ Carbos' },
    {
      identifier: ACTION_RAPID,
      buttonTitle: '+ Rápida',
      options: { isAuthenticationRequired: true, opensAppToForeground: true },
    },
    {
      identifier: ACTION_CORRECTION,
      buttonTitle: 'Corrección',
      options: { isAuthenticationRequired: true, opensAppToForeground: true },
    },
  ]);
}

export function quickRouteFromNotificationAction(identifier: string): QuickRoute | null {
  if (identifier === ACTION_CARBS) return 'carbs';
  if (identifier === ACTION_RAPID) return 'rapid';
  if (identifier === ACTION_CORRECTION) return 'correction';
  return null;
}

/**
 * Reposts the sticky quick-entry notification with fresh content. Called
 * both from the UI (first activation) and headlessly from
 * `backgroundSync.ts` (periodic refresh) — that's why it never assumes a
 * live component tree and takes everything it needs as arguments.
 *
 * The value is still a snapshot the instant this runs, not a live feed —
 * background runs are best-effort and can land anywhere from ~15 minutes to
 * hours apart (see backgroundSync.ts). Stamping the reading's own clock
 * time, and marking anything that isn't real sensor data or has gone stale,
 * keeps a snapshot from reading as "current" between refreshes.
 */
export async function postQuickEntryNotification(
  reading: CGMReading | null,
  showGlucose: boolean,
  status?: CGMProviderStatus,
): Promise<void> {
  await configureNotifications();
  const marks = reading === null ? [] : [
    reading.origin === 'synthetic' ? 'sintético'
      : reading.origin === 'manual' ? 'manual'
        : reading.origin === 'imported' ? 'importado'
          : null,
    assessFreshness(reading.sourceTimestamp).state !== 'connected' ? 'desactualizado' : null,
  ].filter((mark): mark is string => mark !== null);
  const glucoseText = !showGlucose
    ? 'Glucosa oculta'
    : reading !== null
      ? `${reading.glucose} ${trendArrow[reading.trend]} mg/dL · ${formatClock(reading.sourceTimestamp)}${marks.length === 0 ? '' : ` (${marks.join(', ')})`}`
      : status?.state === 'offline'
        ? 'Backend sin conexión'
        : 'Sin lectura reciente';
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `Type 1A · ${glucoseText}`,
      body: `Actualizado ${formatClock(new Date().toISOString())}. Se refresca solo cada ~15 min si Android lo permite, o toca "Actualizar" para forzarlo ahora.`,
      categoryIdentifier: QUICK_CATEGORY,
      data: { url: 'type1a://quick/carbs' },
      sticky: true,
      autoDismiss: false,
      ...(Platform.OS === 'android' ? { priority: Notifications.AndroidNotificationPriority.DEFAULT } : {}),
    },
    trigger: Platform.OS === 'android' ? { channelId: 'quick-entry' } : null,
  });
}

export async function enableQuickEntryNotification(
  reading: CGMReading | null,
  showGlucose: boolean,
): Promise<boolean> {
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return false;
  await postQuickEntryNotification(reading, showGlucose);
  return true;
}

/**
 * `offsetsMinutes` — Fase 6: these used to be hardcoded to [60, 120, 180].
 * Now they're whatever Ajustes has saved (see `getMealAlarmOffsets` in
 * db.ts, default unchanged: 60/120/180). The largest offset is treated as
 * "episode ready to review"; the rest are just interim check-ins.
 */
export async function scheduleEpisodeNotifications(
  episodeId: string,
  mealTimestamp: string,
  offsetsMinutes: readonly number[],
  channelId: string,
): Promise<void> {
  let permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted && permissions.canAskAgain) {
    permissions = await Notifications.requestPermissionsAsync();
  }
  if (!permissions.granted) return;
  const mealMs = Date.parse(mealTimestamp);
  const sorted = [...offsetsMinutes].sort((a, b) => a - b);
  const last = sorted.at(-1);
  for (const minutes of sorted) {
    const date = new Date(mealMs + minutes * 60_000);
    if (date.getTime() <= Date.now()) continue;
    const isFinal = minutes === last;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: isFinal ? 'Episodio de comida listo para revisar' : `Control postcomida +${minutes}`,
        body: isFinal
          ? 'Abre Type 1A para calcular el resumen con las lecturas disponibles.'
          : 'Type 1A seguirá reuniendo lecturas; no sustituye las alarmas del sensor.',
        data: { url: `type1a://episode/${episodeId}` },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        date,
        ...(Platform.OS === 'android' ? { channelId } : {}),
      },
    });
  }
}

/**
 * Computed reminder clock times, evenly spaced across the awake window.
 * `count` reminders anchored at `wakeStart`, one interval (window/count)
 * apart. Pure and deterministic so it can be previewed in Ajustes and unit
 * tested; the actual scheduling is `scheduleCapillaryReminders`.
 */
export interface ClockTime {
  hour: number;
  minute: number;
}

/**
 * Reschedules the daily capillary-measurement reminders. Cancels the previous
 * set first (found by `data.kind`), then schedules one repeating DAILY
 * notification per computed time. A reminder to go measure — it carries no
 * glucose value and computes nothing, same discipline as the correction
 * reminder.
 */
export async function scheduleCapillaryReminders(times: readonly ClockTime[], channelId: string): Promise<void> {
  await cancelCapillaryReminders();
  if (times.length === 0) return;
  let permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted && permissions.canAskAgain) {
    permissions = await Notifications.requestPermissionsAsync();
  }
  if (!permissions.granted) return;
  for (const time of times) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Hora de medir tu glicemia capilar',
        body: 'Pínchate el dedo y registra el valor en Type 1A (usa el botón + y elige Capilar).',
        // No `url`: tapping just opens the app (the response listener falls
        // through to a refresh). There's no deep link straight to a capillary
        // entry, and routing to a quick-carbs modal would be misleading here.
        data: { kind: CAPILLARY_REMINDER_KIND },
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: time.hour,
        minute: time.minute,
        ...(Platform.OS === 'android' ? { channelId } : {}),
      },
    });
  }
}

export async function cancelCapillaryReminders(): Promise<void> {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    scheduled
      .filter((notification) => notification.content.data?.kind === CAPILLARY_REMINDER_KIND)
      .map((notification) => Notifications.cancelScheduledNotificationAsync(notification.identifier)),
  );
}

/**
 * Fase 6: the same idea as `scheduleEpisodeNotifications`, for corrections.
 * This is a reminder to go measure/check in, not a recalculated dose — it
 * carries no glucose value and computes nothing. Opt-in (see
 * `getCorrectionReminderSettings` in db.ts), off by default.
 */
export async function scheduleCorrectionReminder(timestamp: string, offsetMinutes: number, channelId: string): Promise<void> {
  let permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted && permissions.canAskAgain) {
    permissions = await Notifications.requestPermissionsAsync();
  }
  if (!permissions.granted) return;
  const date = new Date(Date.parse(timestamp) + offsetMinutes * 60_000);
  if (date.getTime() <= Date.now()) return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `Control tras corrección +${offsetMinutes} min`,
      body: 'Revisa tu glucosa. Type 1A no calcula insulina activa: si hace poco te corregiste, tenlo en cuenta antes de una nueva dosis.',
      // Deliberately no `categoryIdentifier`/quick-action buttons here —
      // this is a checkpoint before a possible second dose, not a shortcut
      // to log one. Tapping opens the app to Corrección, which already
      // shows recent rapid-insulin context, but doesn't offer a one-tap
      // "+Rápida" action the way the quick-entry notification does.
      data: { url: 'type1a://quick/correction' },
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date,
      ...(Platform.OS === 'android' ? { channelId } : {}),
    },
  });
}
