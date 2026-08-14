import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { CGMReading } from '@type1a/schemas';

import { trendArrow } from './format';
import type { QuickRoute } from './types';

export const QUICK_CATEGORY = 'type1a-quick-entry';
export const ACTION_CARBS = 'quick-carbs';
export const ACTION_RAPID = 'quick-rapid';
export const ACTION_CORRECTION = 'quick-correction';

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

export async function enableQuickEntryNotification(
  reading: CGMReading | null,
  showGlucose: boolean,
): Promise<boolean> {
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return false;
  await configureNotifications();
  const glucoseText = showGlucose && reading !== null
    ? `${reading.glucose} ${trendArrow[reading.trend]} mg/dL`
    : 'Glucosa oculta';
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `Type 1A · ${glucoseText}`,
      body: 'Registro rápido. Toca para abrir; basal está dentro de la app.',
      categoryIdentifier: QUICK_CATEGORY,
      data: { url: 'type1a://quick/carbs' },
      sticky: true,
      autoDismiss: false,
      ...(Platform.OS === 'android' ? { priority: Notifications.AndroidNotificationPriority.DEFAULT } : {}),
    },
    trigger: Platform.OS === 'android' ? { channelId: 'quick-entry' } : null,
  });
  return true;
}

export async function scheduleEpisodeNotifications(episodeId: string, mealTimestamp: string): Promise<void> {
  let permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted && permissions.canAskAgain) {
    permissions = await Notifications.requestPermissionsAsync();
  }
  if (!permissions.granted) return;
  const mealMs = Date.parse(mealTimestamp);
  const moments = [60, 120, 180] as const;
  for (const minutes of moments) {
    const date = new Date(mealMs + minutes * 60_000);
    if (date.getTime() <= Date.now()) continue;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: minutes === 180 ? 'Episodio de comida listo para revisar' : `Control postcomida +${minutes}`,
        body: minutes === 180
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
