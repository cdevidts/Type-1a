import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { assessFreshness, convertGlucose } from '@type1a/domain';
import type { CGMProviderStatus, CGMReading } from '@type1a/schemas';

import { formatClock, trendArrow } from './format';
import { colors } from './theme';
import { normalizeQuickRoute } from './types';
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
/**
 * Los tres tipos de recordatorio, cada uno con su propia identidad (Fase 19).
 *
 * **Es seguridad, no estética.** Cuando las tres alarmas llegan con el mismo
 * símbolo, el mismo color y un título parecido, se vuelven indistinguibles y
 * la usuaria termina ignorándolas todas — incluidas las que importan. Fatiga
 * de alarma.
 *
 * El emoji va en el **título** y no como icono de la barra de estado porque
 * Android no permite lo segundo por notificación: el icono pequeño es uno
 * solo para toda la app, fijado en tiempo de compilación
 * (`NotificationContentAndroid` expone `badge`, `color`, `priority` y
 * `vibrationPattern`, y nada más — verificado contra expo-notifications@57).
 * Es la excepción consciente a la regla "nada de glifos Unicode como iconos"
 * de la skill `/iconography`: acá el glifo es texto de verdad, dentro de un
 * título, que es exactamente donde esa regla no aplica.
 */
export type ReminderKind = 'meal' | 'correction' | 'capillary';

interface ReminderPresentation {
  /** Se antepone al título. Lo que permite distinguir sin leer. */
  emoji: string;
  /** Android tiñe con esto el icono pequeño y el nombre de la app. */
  color: string;
  /** Nombre del canal en los ajustes de Android — lo que ella ve al silenciar. */
  channelName: string;
}

const REMINDER_PRESENTATION: Record<ReminderKind, ReminderPresentation> = {
  meal: { emoji: '🍽️', color: colors.orange, channelName: 'Recordatorios post-comida' },
  // 💧 y no 💉 a propósito: este recordatorio es "anda a mirar tu glucosa",
  // no "ponte algo". Una jeringa en la bandeja empuja justo hacia la segunda
  // dosis que esta notificación existe para que ella decida con calma.
  correction: { emoji: '💧', color: colors.teal, channelName: 'Recordatorios de corrección' },
  capillary: { emoji: '🩸', color: colors.red, channelName: 'Recordatorios de glicemia capilar' },
};

const REMINDER_KINDS = Object.keys(REMINDER_PRESENTATION) as ReminderKind[];
const ALERT_STYLES: ReminderAlertStyle[] = ['both', 'sound', 'vibrate', 'silent'];

/**
 * Un canal **por tipo y por estilo**, pero solo existen los del estilo activo.
 *
 * Android congela el sonido y la vibración de un canal al crearlo, así que un
 * estilo elegible por la usuaria obliga a tener un canal por estilo. Y el
 * pedido de la Fase 19 es un canal por *tipo*, para que ella pueda silenciar
 * "corrección" sin perder "capilar" desde los ajustes del sistema. Las dos
 * cosas juntas darían 12 canales listados a la vez, que es peor que el
 * problema que vinimos a resolver.
 *
 * Por eso `ensureReminderChannels` crea los tres del estilo vigente y
 * **borra los de los otros estilos**: en los ajustes de Android se ven
 * siempre tres entradas, una por tipo, con el nombre de su tipo.
 */
function reminderChannelId(kind: ReminderKind, style: ReminderAlertStyle): string {
  return `${kind}-${style}`;
}

/**
 * Estilo vigente, para que el handler de primer plano sepa si sonar.
 *
 * El handler se registra una vez a nivel de módulo y no puede leer estado de
 * React ni de SQLite, así que el estilo se le empuja desde `App.tsx` cuando
 * se carga o cambia. Antes esto no existía y el handler devolvía siempre
 * `shouldPlaySound: false`: con la app abierta las alarmas eran mudas aunque
 * la usuaria hubiera elegido "sonido" — probarlas con la app en pantalla daba
 * silencio y parecía que no funcionaban.
 */
let activeAlertStyle: ReminderAlertStyle = 'both';

export function setActiveAlertStyle(style: ReminderAlertStyle): void {
  activeAlertStyle = style;
}

/** Marca de la notificación fija de acceso rápido: nunca debe sonar. */
const SILENT_DATA_FLAG = 'quickEntrySticky';

Notifications.setNotificationHandler({
  handleNotification: async (notification) => {
    // La pegajosa de acceso rápido se repone cada ~15 min: si sonara, sería
    // una alarma cada cuarto de hora. Se detecta por su propia marca en
    // `data` y no por el canal, porque el handler de primer plano corre antes
    // de que el canal entre en juego.
    const isSticky = notification.request.content.data?.[SILENT_DATA_FLAG] === true;
    const audible = !isSticky && (activeAlertStyle === 'both' || activeAlertStyle === 'sound');
    return {
      shouldPlaySound: audible,
      shouldSetBadge: false,
      shouldShowBanner: !isSticky,
      shouldShowList: true,
    };
  },
});

/**
 * Último estilo para el que ya se crearon los canales. Evita repetir tres
 * creaciones y nueve borrados en cada notificación programada.
 */
let ensuredStyle: ReminderAlertStyle | null = null;

/**
 * Deja existiendo exactamente un canal por tipo, con el estilo pedido.
 *
 * Android solo hace sonar o vibrar con `importance >= DEFAULT`; en `LOW` la
 * notificación aparece en la bandeja en silencio. `sound: null` silencia un
 * canal que de otro modo sonaría, y lo que hace vibrar de verdad es un
 * `vibrationPattern` con algo más que el 0 inicial.
 */
export async function ensureReminderChannels(style: ReminderAlertStyle): Promise<void> {
  if (Platform.OS !== 'android') return;
  if (ensuredStyle === style) return;
  const buzz = [0, 250, 250, 250];
  const audible = style === 'both' || style === 'sound';
  const vibrates = style === 'both' || style === 'vibrate';
  const pending = await channelsWithPendingNotifications();

  for (const kind of REMINDER_KINDS) {
    await Notifications.setNotificationChannelAsync(reminderChannelId(kind, style), {
      name: REMINDER_PRESENTATION[kind].channelName,
      importance: style === 'silent'
        ? Notifications.AndroidImportance.LOW
        : Notifications.AndroidImportance.HIGH,
      sound: audible ? 'default' : null,
      enableVibrate: vibrates,
      vibrationPattern: vibrates ? buzz : [0],
      showBadge: false,
    });
    // Los del resto de los estilos se borran: si no, cambiar de estilo iría
    // dejando entradas muertas en los ajustes de Android hasta tener doce.
    //
    // ⚠️ **Pero nunca uno que todavía tenga algo programado encima**
    // (corregido 2026-08-22 tras la revisión de seguridad). Android no
    // entrega una notificación cuyo canal ya no existe, y la borra en
    // silencio: sin este resguardo, cambiar el estilo de alerta mataba los
    // check-ins +60/+120/+180 de un episodio en curso y el recordatorio
    // post-corrección — justo el que existe como punto de control antes de
    // una posible segunda dosis. Perder un recordatorio de salud sin aviso
    // es peor que dejar una entrada de más en los ajustes, así que el canal
    // viejo sobrevive hasta que lo suyo se haya disparado. La contrapartida,
    // asumida: un recordatorio programado ANTES del cambio se entrega con el
    // estilo viejo.
    for (const other of ALERT_STYLES) {
      if (other === style) continue;
      const orphan = reminderChannelId(kind, other);
      // `pending === null` ⇒ no se pudo saber ⇒ no se borra.
      if (pending === null || pending.has(orphan)) continue;
      await Notifications.deleteNotificationChannelAsync(orphan);
    }
  }
  ensuredStyle = style;
}

/**
 * Canales que todavía tienen al menos una notificación programada.
 *
 * Falla hacia el lado seguro: si no se puede leer la lista, o el trigger no
 * expone su canal, devuelve `null` y quien llama no borra nada. Preferimos
 * un canal huérfano en los ajustes antes que un recordatorio que desaparece.
 */
async function channelsWithPendingNotifications(): Promise<ReadonlySet<string> | null> {
  try {
    const scheduled = await Notifications.getAllScheduledNotificationsAsync();
    const busy = new Set<string>();
    for (const request of scheduled) {
      const channelId = (request.trigger as { channelId?: unknown } | null)?.channelId;
      if (typeof channelId === 'string') busy.add(channelId);
    }
    return busy;
  } catch {
    return null;
  }
}

export async function configureNotifications(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('quick-entry', {
      name: 'Accesos rápidos',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      showBadge: false,
    });
    // Los canales de recordatorio ya NO se crean acá: dependen del estilo
    // activo y se manejan en `ensureReminderChannels`. Ver su comentario.
    await Notifications.deleteNotificationChannelAsync('meal-episodes');
    await Notifications.deleteNotificationChannelAsync('correction-reminders');
    // Los cuatro canales por estilo de la Fase 6, reemplazados en la Fase 19
    // por uno por tipo. Sin borrarlos quedan huérfanos en los ajustes de
    // Android, con nombres que ya no corresponden a nada.
    for (const style of ALERT_STYLES) {
      await Notifications.deleteNotificationChannelAsync(`reminders-${style}`);
    }
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
    {
      // Un solo botón de comida desde la Fase 21. El id sigue siendo
      // ACTION_CARBS por compatibilidad con las notificaciones ya posteadas.
      identifier: ACTION_CARBS,
      buttonTitle: '+ Comida',
      options: { isAuthenticationRequired: true, opensAppToForeground: true },
    },
    {
      identifier: ACTION_CORRECTION,
      buttonTitle: 'Corrección',
      options: { isAuthenticationRequired: true, opensAppToForeground: true },
    },
  ]);
}

/**
 * Los ids de acción `ACTION_CARBS`/`ACTION_RAPID` **no se renombran** aunque
 * los dos botones se hayan fusionado en "Comida" (Fase 21): la notificación
 * pegajosa que ya está en la bandeja del teléfono fue creada por un build
 * anterior y sigue emitiendo esos identificadores. Renombrarlos habría dejado
 * muerto un botón que la usuaria ya tiene a mano.
 */
export function quickRouteFromNotificationAction(identifier: string): QuickRoute | null {
  if (identifier === ACTION_CARBS || identifier === ACTION_RAPID) return normalizeQuickRoute('carbs');
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
      ? `${convertGlucose(reading.glucose, reading.unit, 'mg/dL')} ${trendArrow[reading.trend]} mg/dL · ${formatClock(reading.sourceTimestamp)}${marks.length === 0 ? '' : ` (${marks.join(', ')})`}`
      : status?.state === 'offline'
        ? 'Backend sin conexión'
        : 'Sin lectura reciente';
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `Type 1A · ${glucoseText}`,
      body: `Actualizado ${formatClock(new Date().toISOString())}. Se refresca solo cada ~15 min si Android lo permite, o toca "Actualizar" para forzarlo ahora.`,
      categoryIdentifier: QUICK_CATEGORY,
      data: { url: 'type1a://quick/carbs', [SILENT_DATA_FLAG]: true },
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
  style: ReminderAlertStyle,
): Promise<void> {
  await ensureReminderChannels(style);
  const channelId = reminderChannelId('meal', style);
  const look = REMINDER_PRESENTATION.meal;
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
        title: isFinal
          ? `${look.emoji} Revisa tu glucosa post-comida`
          : `${look.emoji} Revisa tu glucosa post-comida · +${minutes} min`,
        body: isFinal
          ? 'Abre Type 1A para calcular el resumen con las lecturas disponibles.'
          : 'Type 1A seguirá reuniendo lecturas; no sustituye las alarmas del sensor.',
        data: { url: `type1a://episode/${episodeId}` },
        ...(Platform.OS === 'android' ? { color: look.color } : {}),
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
export async function scheduleCapillaryReminders(times: readonly ClockTime[], style: ReminderAlertStyle): Promise<void> {
  await cancelCapillaryReminders();
  if (times.length === 0) return;
  await ensureReminderChannels(style);
  const channelId = reminderChannelId('capillary', style);
  const look = REMINDER_PRESENTATION.capillary;
  let permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted && permissions.canAskAgain) {
    permissions = await Notifications.requestPermissionsAsync();
  }
  if (!permissions.granted) return;
  for (const time of times) {
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `${look.emoji} Toca medirte capilar`,
        body: 'Pínchate el dedo y registra el valor en Type 1A (usa el botón + y elige Capilar).',
        // No `url`: tapping just opens the app (the response listener falls
        // through to a refresh). There's no deep link straight to a capillary
        // entry, and routing to a quick-carbs modal would be misleading here.
        data: { kind: CAPILLARY_REMINDER_KIND },
        ...(Platform.OS === 'android' ? { color: look.color } : {}),
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
export async function scheduleCorrectionReminder(timestamp: string, offsetMinutes: number, style: ReminderAlertStyle): Promise<void> {
  await ensureReminderChannels(style);
  const channelId = reminderChannelId('correction', style);
  const look = REMINDER_PRESENTATION.correction;
  let permissions = await Notifications.getPermissionsAsync();
  if (!permissions.granted && permissions.canAskAgain) {
    permissions = await Notifications.requestPermissionsAsync();
  }
  if (!permissions.granted) return;
  const date = new Date(Date.parse(timestamp) + offsetMinutes * 60_000);
  if (date.getTime() <= Date.now()) return;
  await Notifications.scheduleNotificationAsync({
    content: {
      title: `${look.emoji} Revisa tu glucosa tras la corrección · +${offsetMinutes} min`,
      body: 'Revisa tu glucosa. Type 1A no calcula insulina activa: si hace poco te corregiste, tenlo en cuenta antes de una nueva dosis.',
      // Deliberately no `categoryIdentifier`/quick-action buttons here —
      // this is a checkpoint before a possible second dose, not a shortcut
      // to log one. Tapping opens the app to Corrección, which already
      // shows recent rapid-insulin context, but doesn't offer a one-tap
      // "+Rápida" action the way the quick-entry notification does.
      data: { url: 'type1a://quick/correction' },
      ...(Platform.OS === 'android' ? { color: look.color } : {}),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date,
      ...(Platform.OS === 'android' ? { channelId } : {}),
    },
  });
}
