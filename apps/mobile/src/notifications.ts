import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { assessFreshness } from '@type1a/domain';
import type { CGMProviderStatus, CGMReading } from '@type1a/schemas';

import { formatClock, trendArrow } from './format';
import type { QuickRoute } from './types';

export const QUICK_CATEGORY = 'type1a-quick-entry';
export const ACTION_CARBS = 'quick-carbs';
export const ACTION_RAPID = 'quick-rapid';
export const ACTION_CORRECTION = 'quick-correction';

/** app_settings key: whether the sticky quick-entry notification (and the
 * background sync that keeps it fresh) is turned on. Read by
 * `backgroundSync.ts`, which has no React context to read component state
 * from. */
export const QUICK_ENTRY_ENABLED_KEY = 'quickEntryNotificationEnabled';

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
    await Notifications.setNotificationChannelAsync('meal-episodes', {
      name: 'Episodios de comida',
      importance: Notifications.AndroidImportance.DEFAULT,
      showBadge: false,
    });
    await Notifications.setNotificationChannelAsync('correction-reminders', {
      name: 'Recordatorios de corrección',
      importance: Notifications.AndroidImportance.DEFAULT,
      showBadge: false,
    });
  }
  await Notifications.setNotificationCategoryAsync(QUICK_CATEGORY, [
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
      body: `Actualizado ${formatClock(new Date().toISOString())}. Se refresca solo cada ~15 min si Android lo permite. Toca para abrir.`,
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
        ...(Platform.OS === 'android' ? { channelId: 'meal-episodes' } : {}),
      },
    });
  }
}

/**
 * Fase 6: the same idea as `scheduleEpisodeNotifications`, for corrections.
 * This is a reminder to go measure/check in, not a recalculated dose — it
 * carries no glucose value and computes nothing. Opt-in (see
 * `getCorrectionReminderSettings` in db.ts), off by default.
 */
export async function scheduleCorrectionReminder(timestamp: string, offsetMinutes: number): Promise<void> {
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
      ...(Platform.OS === 'android' ? { priority: Notifications.AndroidNotificationPriority.DEFAULT } : {}),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date,
      ...(Platform.OS === 'android' ? { channelId: 'correction-reminders' } : {}),
    },
  });
}
