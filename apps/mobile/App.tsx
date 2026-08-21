import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import Settings from 'lucide-react-native/icons/settings';
import {
  AppState,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';

import { buildReportRows, catalogEntriesFrom, catalogEntryFromPortion, latestLiveReading, type CatalogFood } from '@type1a/domain';
import type {
  CGMProviderStatus,
  CGMReading,
  InsulinEvent,
  MealEvent,
  TherapyProfile,
} from '@type1a/schemas';


// Side-effect import: registers the background-task handler at module load,
// which is required even on the headless launch Android uses to run it with
// no UI on screen — see backgroundSync.ts.
import { registerBackgroundSync } from './src/backgroundSync';
import { CorrectionModal } from './src/components/CorrectionModal';
import { EntryModal, type UnifiedEntryDraft } from './src/components/EntryModal';
import { GlucoseCard } from './src/components/GlucoseCard';
import { InsulinAssociationModal } from './src/components/InsulinAssociationModal';
import type { MealEditResult } from './src/components/MealEditModal';
import { CatalogModal, type CatalogEdit } from './src/components/CatalogModal';
import { MealModal, type ConfirmedMealDraft } from './src/components/MealModal';
import { NumericEntryModal } from './src/components/NumericEntryModal';
import { SettingsModal } from './src/components/SettingsModal';
import { BottomNav, type NavDestination } from './src/components/BottomNav';
import { KetonesModal } from './src/components/KetonesModal';
import { NutritionModal } from './src/components/NutritionModal';
import { OnboardingModal } from './src/components/OnboardingModal';
import { SummaryModal } from './src/components/SummaryModal';
import { Timeline } from './src/components/Timeline';
import { useSwipeNavigation } from './src/useSwipeNavigation';
import { logSaveError } from './src/log';
import {
  fetchSensorReadings,
  fetchSensorStatus,
  LEGACY_BACKEND_SENSOR_KEY,
  resetSensorProviderCache,
  resolveSensorSource,
  type SensorSource,
} from './src/sensorConnection';
import {
  getCGMReadings,
  attachEntryToReading,
  confirmEpisodeInsulinContext,
  deleteCarbEvent,
  deleteCGMReading,
  deleteInsulinEvent,
  deleteMealEpisode,
  deleteMealEvent,
  deleteNoteEvent,
  deleteUnifiedEntryGroup,
  DEFAULT_CAPILLARY_REMINDER_SETTINGS,
  DEFAULT_CORRECTION_REMINDER_OFFSET_MINUTES,
  DEFAULT_MEAL_ALARM_OFFSETS_MINUTES,
  DEFAULT_REMINDER_ALERT_STYLE,
  getActivityEvents,
  getCapillaryReminderSettings,
  getCarbEvents,
  getCorrectionReminderSettings,
  getHbA1cResults,
  getInsulinEvents,
  getMealAlarmOffsets,
  createCatalogFoodVariant,
  deleteCatalogFood,
  getCatalogFoods,
  updateCatalogFood,
  getMealEvents,
  getNutritionProfile,
  recordCatalogFoods,
  saveNutritionProfile,
  getNoteEvents,
  getPendingInsulinAssociations,
  createDecodeTally,
  deleteSensorReadings,
  getRecentRapidInsulin,
  getReminderAlertStyle,
  getSetting,
  getTherapyProfile,
  PLACEHOLDER_THERAPY_PROFILE,
  getTimeline,
  getVitalsEvents,
  importMySugrCsv,
  initializeDatabase,
  isTherapyConfigured,
  saveCapillaryReminderSettings,
  saveCarbEvent,
  saveCorrectionReminderSettings,
  saveInsulinEvent,
  saveMealAlarmOffsets,
  saveMealWithEpisode,
  saveReminderAlertStyle,
  resolveLegacyBackendSensor,
  saveTherapyProfile,
  saveVitalsEvent,
  saveUnifiedEntry,
  setSetting,
  updateCarbEvent,
  updateInsulinEvent,
  updateManualCGMReading,
  updateMealFromEdit,
  updateNoteEvent,
  updateUnifiedEntryGroup,
  upsertCGMReadings,
  type CapillaryReminderSettings,
  type CorrectionReminderSettings,
} from './src/db';
import { processReadyEpisodes } from './src/episodes';
import {
  ACTION_REFRESH,
  configureNotifications,
  enableQuickEntryNotification,
  QUICK_ENTRY_ENABLED_KEY,
  quickRouteFromNotificationAction,
  reminderChannelId,
  scheduleCapillaryReminders,
  scheduleCorrectionReminder,
  scheduleEpisodeNotifications,
} from './src/notifications';
import { capillaryReminderTimes } from './src/format';
import { colors, radius, spacing } from './src/theme';
import type { NutritionProfile } from '@type1a/schemas';
import type { NutritionDayData, PendingInsulinAssociation, QuickRoute, ReminderAlertStyle, ReportExport, SummaryData, TimelineEditPayload, TimelineItem } from './src/types';

/** Flag de "ya vio la bienvenida"; vive en `settings`, no en el perfil de terapia. */
const ONBOARDING_SEEN_KEY = 'onboardingSeenAt';

const EMPTY_PROFILE: TherapyProfile = {
  glucoseUnit: 'mg/dL',
  targetGlucose: 110,
  correctionFactor: 45,
  doseIncrement: 0.5,
};

function routeFromUrl(url: string): QuickRoute | null {
  const match = /^type1a:\/\/quick\/(carbs|rapid|basal|correction)(?:[/?#]|$)/u.exec(url);
  return (match?.[1] as QuickRoute | undefined) ?? null;
}

function Type1AApp() {
  const db = useSQLiteContext();
  const [readings, setReadings] = useState<CGMReading[]>([]);
  const [status, setStatus] = useState<CGMProviderStatus | null>(null);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [profile, setProfile] = useState<TherapyProfile>(EMPTY_PROFILE);
  const [therapyConfigured, setTherapyConfigured] = useState(false);
  const [onboardingDone, setOnboardingDone] = useState<boolean | null>(null);
  const [recentRapid, setRecentRapid] = useState<InsulinEvent[]>([]);
  const [recentRapidUnreadable, setRecentRapidUnreadable] = useState(0);
  const [readingsUnreadable, setReadingsUnreadable] = useState(0);
  const [profileUnreadable, setProfileUnreadable] = useState(false);
  const [pendingAssociations, setPendingAssociations] = useState<PendingInsulinAssociation[]>([]);
  const [quickRoute, setQuickRoute] = useState<QuickRoute | null>(null);
  const [mealOpen, setMealOpen] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [ketonesOpen, setKetonesOpen] = useState(false);
  const [nutritionOpen, setNutritionOpen] = useState(false);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [nutritionProfile, setNutritionProfile] = useState<NutritionProfile | null>(null);
  const [catalogFoods, setCatalogFoods] = useState<CatalogFood[]>([]);
  const [showGlucoseOnLockScreen, setShowGlucoseOnLockScreen] = useState(false);
  const [mealAlarmOffsets, setMealAlarmOffsets] = useState<number[]>([...DEFAULT_MEAL_ALARM_OFFSETS_MINUTES]);
  const [correctionReminder, setCorrectionReminder] = useState<CorrectionReminderSettings>({
    enabled: false,
    offsetMinutes: DEFAULT_CORRECTION_REMINDER_OFFSET_MINUTES,
  });
  const [reminderAlertStyle, setReminderAlertStyle] = useState<ReminderAlertStyle>(DEFAULT_REMINDER_ALERT_STYLE);
  const [capillaryReminder, setCapillaryReminder] = useState<CapillaryReminderSettings>({
    ...DEFAULT_CAPILLARY_REMINDER_SETTINGS,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshingRef = useRef(false);
  /** Espejo de `sensorSource` legible dentro de `refresh()` sin re-crear el callback. */
  const sensorSourceRef = useRef<SensorSource>('none');

  const latest = latestLiveReading(readings);

  const loadLocalState = useCallback(async (): Promise<void> => {
    // Solo para la insulina reciente: ese panel afirma completitud ("No hay
    // eventos registrados") justo encima de una calculadora de dosis, así que
    // una fila ilegible no puede pasar por "no hay nada".
    const rapidTally = createDecodeTally();
    // Contador aparte para la serie de la pantalla principal: "Sin lecturas
    // CGM" también es una afirmación de completitud.
    const readTally = createDecodeTally();
    const to = new Date();
    // 30 days, not 3 hours: the chart is now a scrollable multi-day trend
    // (swipe back to see older/imported history), not just "right now".
    // The live/current badge and correction auto-fill are unaffected —
    // latestLiveReading() finds the true latest live point regardless of
    // how wide this window is.
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60_000);
    const [cached, nextTimeline, nextProfile, configured, rapid, privacy, pending, mealOffsets, correctionSettings, alertStyle, capillarySettings, onboardingSeen, isLegacyBackendInstall, nutrition, catalog] = await Promise.all([
      getCGMReadings(db, from, to, readTally),
      getTimeline(db),
      getTherapyProfile(db),
      isTherapyConfigured(db),
      getRecentRapidInsulin(db, undefined, undefined, rapidTally),
      getSetting(db, 'showGlucoseOnLockScreen'),
      getPendingInsulinAssociations(db),
      getMealAlarmOffsets(db),
      getCorrectionReminderSettings(db),
      getReminderAlertStyle(db),
      getCapillaryReminderSettings(db),
      getSetting(db, ONBOARDING_SEEN_KEY),
      resolveLegacyBackendSensor(db, LEGACY_BACKEND_SENSOR_KEY),
      getNutritionProfile(db),
      getCatalogFoods(db),
    ]);
    setReadings(cached);
    setReadingsUnreadable(readTally.unreadable);
    setTimeline(nextTimeline);
    // Un perfil ilegible NO puede caer a los placeholders ni tumbar la carga:
    // se muestran los placeholders pero se fuerza `therapyConfigured` a false
    // (las calculadoras quedan bloqueadas, que es lo seguro) y se levanta un
    // aviso persistente con la salida concreta. El resto de la app —registrar
    // glucosa, carbos, insulina— sigue funcionando, como exige la regla de
    // degradar a registro manual de AGENTS.md.
    setProfileUnreadable(nextProfile.kind === 'unreadable');
    setProfile(nextProfile.kind === 'ok' ? nextProfile.profile : PLACEHOLDER_THERAPY_PROFILE);
    setTherapyConfigured(nextProfile.kind === 'ok' && configured);
    setRecentRapid(rapid);
    setRecentRapidUnreadable(rapidTally.unreadable);
    setShowGlucoseOnLockScreen(privacy === 'true');
    setPendingAssociations(pending);
    setMealAlarmOffsets(mealOffsets);
    setCorrectionReminder(correctionSettings);
    setReminderAlertStyle(alertStyle);
    setCapillaryReminder(capillarySettings);
    setOnboardingDone(onboardingSeen === 'true');
    setNutritionProfile(nutrition);
    setCatalogFoods(catalog);
    sensorSourceRef.current = await resolveSensorSource(isLegacyBackendInstall);
  }, [db]);

  const refresh = useCallback(async (manual = false): Promise<void> => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    if (manual) setNotice(null);
    try {
      await loadLocalState();
      const to = new Date();
      const from = new Date(to.getTime() - 4 * 60 * 60_000);
      let nextStatus: CGMProviderStatus | null = null;
      let remoteReadings: CGMReading[] = [];
      try {
        // `fetchSensor*` usa la cuenta LibreLinkUp propia de la usuaria si la
        // conectó, y si no la ruta del backend de siempre — ver
        // `src/sensorConnection.ts`.
        // La fuente se resuelve acá y no dentro de `fetchSensor*` para que
        // ambas llamadas usen exactamente la misma, y para que "no hay
        // sensor" sea un estado explícito en vez de una caída al backend.
        const source = await resolveSensorSource(
          (await getSetting(db, LEGACY_BACKEND_SENSOR_KEY)) === 'true',
        );
        sensorSourceRef.current = source;
        [nextStatus, remoteReadings] = await Promise.all([
          fetchSensorStatus(source),
          fetchSensorReadings(source, from, to),
        ]);
      } catch (error) {
        // A genuine network/backend failure — the only case that should ever
        // be labelled "Backend sin conexión" (previously this catch also
        // wrapped the local upsertCGMReadings write below, so a SQLite
        // failure with nothing to do with the network — e.g. a stale
        // connection colliding with a background-sync run — got mislabeled
        // as a backend outage, which sent debugging in the wrong direction).
        // Qué falló depende de la fuente: con la cuenta propia no interviene
        // nuestro backend en absoluto, y decir "Backend sin conexión" mandaba
        // a depurar lo que no era.
        const ownAccount = sensorSourceRef.current === 'own';
        setStatus({
          state: 'offline',
          provider: ownAccount ? 'librelinkup-freestyle-libre' : 'backend',
          detail: error instanceof Error
            ? error.message
            : ownAccount ? 'Sin conexión con LibreLinkUp.' : 'Sin conexión al backend.',
          checkedAt: new Date().toISOString(),
          isSynthetic: false,
        });
        setNotice(ownAccount
          ? 'No se pudo contactar a LibreLinkUp. El registro local sigue funcionando.'
          : 'Backend sin conexión. El registro local sigue funcionando.');
      }
      if (nextStatus !== null) {
        try {
          await upsertCGMReadings(db, remoteReadings);
          setStatus(nextStatus);
          setNotice(nextStatus.isSynthetic
            ? 'Modo de prueba: las lecturas CGM son sintéticas.'
            : null);
        } catch {
          // Distinct from a backend outage: the fetch succeeded, but saving
          // it locally failed (e.g. a momentary SQLite conflict with a
          // background sync run). The read cache from loadLocalState() above
          // still has the last successfully-saved data.
          setNotice('No se pudo guardar la lectura localmente. Los datos ya guardados siguen disponibles.');
        }
      }
      await processReadyEpisodes(db);
      await loadLocalState();
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [db, loadLocalState]);

  useEffect(() => {
    void refresh();
    // Self-heal the notification channels, the background-task registration,
    // and the standing capillary reminders on every launch: all three are
    // persisted at the OS level, but re-establishing them covers a reinstall,
    // an OS update that cleared them, or a previous attempt that silently
    // failed. Sequenced so the channels exist before anything is scheduled
    // against them; each step is idempotent.
    void (async () => {
      await configureNotifications();
      const quickEntryEnabled = await getSetting(db, QUICK_ENTRY_ENABLED_KEY);
      if (quickEntryEnabled === 'true') await registerBackgroundSync();
      const capillary = await getCapillaryReminderSettings(db);
      if (capillary.enabled) {
        const style = await getReminderAlertStyle(db);
        const times = capillaryReminderTimes(capillary.wakeStart, capillary.wakeEnd, capillary.count);
        await scheduleCapillaryReminders(times ?? [], reminderChannelId(style));
      }
    })();
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void refresh();
    });
    return () => { appStateSubscription.remove(); };
  }, [db, refresh]);

  useEffect(() => {
    function handleUrl(url: string): void {
      const nextRoute = routeFromUrl(url);
      if (nextRoute !== null) setQuickRoute(nextRoute);
    }
    void Linking.getInitialURL().then((url) => { if (url !== null) handleUrl(url); });
    const urlSubscription = Linking.addEventListener('url', ({ url }) => { handleUrl(url); });
    const notificationSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
      // Handled headlessly by backgroundSync.ts even when the app never
      // opens; this only fires if the app happened to already be alive in
      // the background when the tap landed. Either way, opening a quick-
      // entry route (the fallback below, keyed off the notification's own
      // tap-to-open URL) would be the wrong reaction to "Actualizar".
      if (response.actionIdentifier === ACTION_REFRESH) {
        void refresh();
        return;
      }
      const actionRoute = quickRouteFromNotificationAction(response.actionIdentifier);
      if (actionRoute !== null) {
        setQuickRoute(actionRoute);
        return;
      }
      const url = response.notification.request.content.data?.url;
      if (typeof url === 'string') handleUrl(url);
      void refresh();
    });
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response === null) return;
      const actionRoute = quickRouteFromNotificationAction(response.actionIdentifier);
      if (actionRoute !== null) setQuickRoute(actionRoute);
    });
    return () => {
      urlSubscription.remove();
      notificationSubscription.remove();
    };
  }, [refresh]);

  async function registerNumeric(route: 'carbs' | 'rapid' | 'basal', value: number): Promise<void> {
    const timestamp = new Date().toISOString();
    if (route === 'carbs') {
      await saveCarbEvent(db, {
        id: Crypto.randomUUID(),
        timestamp,
        carbsG: value,
        source: 'manual',
        createdAt: timestamp,
      });
    } else {
      await saveInsulinEvent(db, {
        id: Crypto.randomUUID(),
        timestamp,
        type: route,
        units: value,
        source: 'manual',
        createdAt: timestamp,
      });
    }
    await loadLocalState();
  }

  async function registerCorrection(units: number): Promise<void> {
    const timestamp = new Date().toISOString();
    await registerNumeric('rapid', units);
    if (correctionReminder.enabled) {
      await scheduleCorrectionReminder(timestamp, correctionReminder.offsetMinutes, reminderChannelId(reminderAlertStyle));
    }
    setNotice(`Se registraron ${units} U de rápida tras confirmación.`);
  }

  async function confirmMeal(draft: ConfirmedMealDraft): Promise<void> {
    const timestamp = new Date().toISOString();
    const meal: MealEvent = {
      id: Crypto.randomUUID(),
      timestamp,
      confirmedCarbsG: draft.confirmedCarbsG,
      createdAt: timestamp,
      ...(draft.imageUri === undefined ? {} : { imageUri: draft.imageUri }),
      // El análisis va PRIMERO y los valores de la usuaria después, para que
      // los suyos ganen. Estaba al revés: el spread del análisis pisaba en
      // silencio la proteína o la grasa que ella hubiera corregido a mano,
      // que es justo lo contrario de lo que manda `AGENTS.md` sobre separar
      // lo estimado por IA de lo confirmado por la usuaria.
      ...(draft.analysis === undefined
        ? {}
        : {
            aiEstimatedCarbsG: draft.analysis.totals.carbsG,
            aiAnalysisId: draft.analysis.analysisId,
            // Los macros del análisis solo si ella NO vació ninguno. Si borró
            // un campo precargado está diciendo "no lo sé", y volver a
            // escribir el número de la IA convertiría ese blanco en un dato
            // que ella nunca anotó.
            ...(draft.clearedMacros === true
              ? {}
              : {
                  proteinG: draft.analysis.totals.proteinG,
                  fatG: draft.analysis.totals.fatG,
                  fiberG: draft.analysis.totals.fiberG,
                  caloriesKcal: draft.analysis.totals.caloriesKcal,
                }),
          }),
      ...(draft.proteinG === undefined ? {} : { proteinG: draft.proteinG }),
      ...(draft.fatG === undefined ? {} : { fatG: draft.fatG }),
      ...(draft.fiberG === undefined ? {} : { fiberG: draft.fiberG }),
      ...(draft.macrosSource === undefined ? {} : { macrosSource: draft.macrosSource }),
      // Un carbo venido del catálogo conserva su procedencia de IA. Solo si no
      // hubo análisis propio, que ya escribió el suyo más arriba.
      ...(draft.catalogSuggestedCarbsG === undefined || draft.analysis !== undefined
        ? {}
        : { aiEstimatedCarbsG: draft.catalogSuggestedCarbsG }),
    };
    const episodeId = await saveMealWithEpisode(db, meal);

    // Respuesta a la pregunta de tres salidas (Fase 18). Va **después** de
    // guardar la comida y en su propio try: el catálogo es una comodidad, y
    // un fallo suyo no puede impedir que quede registrado lo que se comió.
    if (draft.catalogWrite !== undefined) {
      try {
        const write = draft.catalogWrite;
        const entry = catalogEntryFromPortion(write.food, {
          grams: write.grams,
          carbsG: write.carbsG,
          proteinG: write.proteinG,
          fatG: write.fatG,
          fiberG: write.fiberG,
          caloriesKcal: write.caloriesKcal,
        }, timestamp);
        if (entry === null) {
          setNotice('La comida quedó guardada, pero esos valores no son posibles por 100 g y el catálogo no se tocó.');
        } else if (write.mode === 'update') {
          await updateCatalogFood(db, write.food.key, {
            carbsPer100g: entry.carbsPer100g,
            proteinPer100g: entry.proteinPer100g,
            fatPer100g: entry.fatPer100g,
            fiberPer100g: entry.fiberPer100g,
            kcalPer100g: entry.kcalPer100g,
          });
        } else {
          // `createCatalogFoodVariant` deriva su propia clave desde el nombre
          // nuevo; la del alimento original no debe viajar, o la variante
          // pisaría justamente al alimento que se quiso conservar.
          await createCatalogFoodVariant(db, {
            name: `${write.name} (variante)`,
            carbsPer100g: entry.carbsPer100g,
            proteinPer100g: entry.proteinPer100g,
            fatPer100g: entry.fatPer100g,
            fiberPer100g: entry.fiberPer100g,
            kcalPer100g: entry.kcalPer100g,
            lastSeenAt: entry.lastSeenAt,
            ...(entry.servingGrams === undefined ? {} : { servingGrams: entry.servingGrams }),
            ...(entry.servingLabel === undefined ? {} : { servingLabel: entry.servingLabel }),
          });
        }
      } catch (error) {
        logSaveError('App.catalogWrite', error);
        setNotice('La comida quedó guardada. No se pudo actualizar el catálogo.');
      }
    }
    // El catálogo se alimenta de cada análisis, y nunca puede impedir que la
    // comida se guarde: es una comodidad, no parte del registro.
    if (draft.analysis !== undefined) {
      try {
        await recordCatalogFoods(db, catalogEntriesFrom(draft.analysis.estimate.foods, timestamp));
      } catch (error) {
        logSaveError('App.recordCatalogFoods', error);
      }
    }
    await scheduleEpisodeNotifications(episodeId, timestamp, mealAlarmOffsets, reminderChannelId(reminderAlertStyle));
    setNotice(`Comida guardada. El episodio se completará con CGM a ${mealAlarmOffsets.map((minutes) => `+${minutes}`).join(', ')} minutos.`);
    await loadLocalState();
  }

  async function saveEntry(draft: UnifiedEntryDraft): Promise<void> {
    const outcome = await saveUnifiedEntry(db, {
      timestamp: draft.timestamp,
      rapidIncludesCorrection: draft.rapidIncludesCorrection,
      ...(draft.manualGlucose === undefined ? {} : { manualGlucose: draft.manualGlucose }),
      ...(draft.description === undefined ? {} : { description: draft.description }),
      ...(draft.carbsG === undefined ? {} : { carbsG: draft.carbsG }),
      ...(draft.imageUri === undefined ? {} : { imageUri: draft.imageUri }),
      ...(draft.rapidUnits === undefined ? {} : { rapidUnits: draft.rapidUnits }),
      ...(draft.basalUnits === undefined ? {} : { basalUnits: draft.basalUnits }),
      ...(draft.note === undefined ? {} : { note: draft.note }),
      ...(draft.analysis === undefined
        ? {}
        : {
            aiEstimatedCarbsG: draft.analysis.totals.carbsG,
            aiAnalysisId: draft.analysis.analysisId,
            proteinG: draft.analysis.totals.proteinG,
            fatG: draft.analysis.totals.fatG,
            fiberG: draft.analysis.totals.fiberG,
            caloriesKcal: draft.analysis.totals.caloriesKcal,
            // Esta hoja no tiene campos de macros que la usuaria pueda tocar:
            // vienen enteros del análisis. Marcarlo es obligatorio — si no,
            // "ausente" mezclaría comidas viejas con comidas 100 % IA
            // guardadas hoy, y la semántica del campo sería falsa.
            macrosSource: 'ai' as const,
          }),
    });
    if (outcome.episodeId !== null) {
      await scheduleEpisodeNotifications(outcome.episodeId, draft.timestamp, mealAlarmOffsets, reminderChannelId(reminderAlertStyle));
    }
    if (outcome.savedRapid && draft.rapidIncludesCorrection && correctionReminder.enabled) {
      await scheduleCorrectionReminder(draft.timestamp, correctionReminder.offsetMinutes, reminderChannelId(reminderAlertStyle));
    }
    const saved = [
      outcome.savedGlucose ? 'glucosa' : null,
      draft.carbsG === undefined ? null : 'carbohidratos',
      outcome.savedRapid ? 'rápida' : null,
      outcome.savedBasal ? 'basal' : null,
      outcome.savedNote ? 'nota' : null,
    ].filter((part): part is string => part !== null);
    setNotice(saved.length === 0
      ? 'Entrada guardada.'
      : `Entrada guardada: ${saved.join(', ')}.`);
    await loadLocalState();
  }

  const loadSummary = useCallback(
    async (range: { from: Date; to: Date }): Promise<SummaryData> => {
      // Un solo contador para las cuatro consultas: a la usuaria le importa
      // "faltan N registros de este rango", no cuál tabla los perdió.
      const tally = createDecodeTally();
      const [readings, insulin, carbs, meals] = await Promise.all([
        getCGMReadings(db, range.from, range.to, tally),
        getInsulinEvents(db, range.from, range.to, tally),
        getCarbEvents(db, range.from, range.to, tally),
        getMealEvents(db, range.from, range.to, tally),
      ]);
      return { readings, insulin, carbs, meals, unreadableCount: tally.unreadable };
    },
    [db],
  );

  /**
   * Dos ventanas distintas a propósito: el día de hoy para las metas, y 90
   * días para los patrones de grasa/proteína, que necesitan muchas comidas
   * con macros anotados para tener algo que comparar. Las lecturas cubren la
   * ventana larga más un margen, porque la respuesta a una comida tardía cae
   * al día siguiente.
   */
  const loadNutritionDay = useCallback(async (): Promise<NutritionDayData> => {
    const tally = createDecodeTally();
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const patternStart = new Date(now.getTime() - 90 * 24 * 60 * 60_000);
    const [patternMeals, dayCarbs, readings] = await Promise.all([
      getMealEvents(db, patternStart, now, tally),
      getCarbEvents(db, dayStart, now, tally),
      getCGMReadings(db, patternStart, now, tally),
    ]);
    return {
      dayMeals: patternMeals.filter((meal) => Date.parse(meal.timestamp) >= dayStart.getTime()),
      dayCarbs,
      patternMeals,
      readings,
      unreadableCount: tally.unreadable,
    };
  }, [db]);

  async function exportReport(range: { from: Date; to: Date }): Promise<ReportExport> {
    const tally = createDecodeTally();
    const [readings, insulin, carbs, meals, activities, notes, vitals, hba1c] = await Promise.all([
      getCGMReadings(db, range.from, range.to, tally),
      getInsulinEvents(db, range.from, range.to, tally),
      getCarbEvents(db, range.from, range.to, tally),
      getMealEvents(db, range.from, range.to, tally),
      getActivityEvents(db, range.from, range.to),
      getNoteEvents(db, range.from, range.to),
      getVitalsEvents(db, range.from, range.to),
      getHbA1cResults(db, range.from, range.to),
    ]);
    return {
      readings,
      insulin,
      carbs,
      meals,
      rows: buildReportRows({ readings, insulin, carbs, meals, activities, notes, vitals, hba1c }),
      unreadableCount: tally.unreadable,
    };
  }

  async function registerKetones(mmolL: number): Promise<void> {
    await saveVitalsEvent(db, {
      id: Crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ketonesMmolL: mmolL,
      source: 'manual',
      createdAt: new Date().toISOString(),
    });
    await loadLocalState();
  }

  async function updatePrivacy(show: boolean): Promise<void> {
    await setSetting(db, 'showGlucoseOnLockScreen', String(show));
    setShowGlucoseOnLockScreen(show);
  }

  async function updateMealAlarmOffsets(offsets: number[]): Promise<void> {
    await saveMealAlarmOffsets(db, offsets);
    setMealAlarmOffsets(offsets);
  }

  async function updateCorrectionReminder(settings: CorrectionReminderSettings): Promise<void> {
    await saveCorrectionReminderSettings(db, settings);
    setCorrectionReminder(settings);
  }

  async function updateReminderAlertStyle(style: ReminderAlertStyle): Promise<void> {
    await saveReminderAlertStyle(db, style);
    setReminderAlertStyle(style);
    // Reschedule the standing capillary reminders onto the newly-chosen alert
    // channel — they're the only reminders scheduled ahead of time; episode
    // and correction reminders are scheduled on demand and already read the
    // current style. If capillary reminders are off, this just clears them.
    if (capillaryReminder.enabled) {
      const times = capillaryReminderTimes(capillaryReminder.wakeStart, capillaryReminder.wakeEnd, capillaryReminder.count);
      await scheduleCapillaryReminders(times ?? [], reminderChannelId(style));
    }
  }

  async function updateCapillaryReminder(settings: CapillaryReminderSettings): Promise<void> {
    await saveCapillaryReminderSettings(db, settings);
    setCapillaryReminder(settings);
    const times = settings.enabled
      ? capillaryReminderTimes(settings.wakeStart, settings.wakeEnd, settings.count)
      : [];
    // A null result means the window/count didn't produce valid times; treat
    // it as "none" so a bad edit clears the schedule rather than leaving stale
    // reminders. SettingsModal validates before calling, so this is a backstop.
    await scheduleCapillaryReminders(times ?? [], reminderChannelId(reminderAlertStyle));
  }

  async function saveTimelineItem(item: TimelineItem, payload: TimelineEditPayload): Promise<void> {
    if (payload.kind === 'insulin') {
      await updateInsulinEvent(db, item.id, {
        type: payload.type,
        units: payload.units,
        ...(payload.insulinName === undefined ? {} : { insulinName: payload.insulinName }),
      });
    } else if (payload.kind === 'carbs') {
      await updateCarbEvent(db, item.id, payload.carbsG);
    } else if (payload.kind === 'glucose') {
      const hasAttachments = payload.carbsG !== undefined || payload.description !== undefined
        || payload.rapidUnits !== undefined || payload.basalUnits !== undefined || payload.note !== undefined;
      if (hasAttachments) {
        // Turn the standalone reading into a packaged entry anchored on it.
        const outcome = await attachEntryToReading(db, item.id, {
          rapidIncludesCorrection: payload.rapidIncludesCorrection === true,
          ...(payload.glucose === undefined ? {} : { manualGlucose: payload.glucose }),
          ...(payload.carbsG === undefined ? {} : { carbsG: payload.carbsG }),
          ...(payload.description === undefined ? {} : { description: payload.description }),
          ...(payload.rapidUnits === undefined ? {} : { rapidUnits: payload.rapidUnits }),
          ...(payload.basalUnits === undefined ? {} : { basalUnits: payload.basalUnits }),
          ...(payload.note === undefined ? {} : { note: payload.note }),
        });
        if (outcome.episodeId !== null) {
          // Offsets in the past self-skip; a reading measured minutes ago can
          // still have future check-ins worth scheduling.
          await scheduleEpisodeNotifications(outcome.episodeId, item.timestamp, mealAlarmOffsets, reminderChannelId(reminderAlertStyle));
        }
        if (outcome.savedRapid && payload.rapidIncludesCorrection === true && correctionReminder.enabled) {
          await scheduleCorrectionReminder(item.timestamp, correctionReminder.offsetMinutes, reminderChannelId(reminderAlertStyle));
        }
        // Compute the retroactive episode right away from the CGM around that
        // time, rather than waiting for the next refresh.
        await processReadyEpisodes(db);
      } else if (payload.glucose !== undefined) {
        await updateManualCGMReading(db, item.id, payload.glucose);
      }
    } else if (payload.kind === 'note') {
      await updateNoteEvent(db, item.id, payload.text);
    } else {
      await updateUnifiedEntryGroup(db, item.id, {
        timestamp: item.timestamp,
        rapidIncludesCorrection: payload.rapidIncludesCorrection === true,
        ...(payload.manualGlucose === undefined ? {} : { manualGlucose: payload.manualGlucose }),
        ...(payload.carbsG === undefined ? {} : { carbsG: payload.carbsG }),
        ...(payload.description === undefined ? {} : { description: payload.description }),
        ...(payload.rapidUnits === undefined ? {} : { rapidUnits: payload.rapidUnits }),
        ...(payload.basalUnits === undefined ? {} : { basalUnits: payload.basalUnits }),
        ...(payload.note === undefined ? {} : { note: payload.note }),
      });
    }
    await loadLocalState();
  }

  /**
   * Guarda la edición completa de una comida (Fase 17).
   *
   * La IA ya propuso y la usuaria ya confirmó en `MealEditModal`; acá solo se
   * escribe. `loadLocalState()` al final para que el Timeline, el resumen y
   * la pantalla de nutrición vean el mismo número — los carbos confirmados
   * viven duplicados en `carb_events` y `updateMealFromEdit` los sincroniza.
   */
  async function saveMealEdit(mealId: string, result: MealEditResult): Promise<void> {
    await updateMealFromEdit(db, mealId, result);
    // Si la edición cambió carbos o macros, `updateMealFromEdit` devolvió el
    // episodio a 'collecting' para que se recalcule. Se recalcula acá mismo y
    // no en el próximo refresh: el resumen post-comida quedaría en blanco
    // mientras tanto, y ella acaba de mirar justo esa comida.
    await processReadyEpisodes(db);
    await loadLocalState();
  }

  async function deleteTimelineItem(item: TimelineItem): Promise<void> {
    if (item.kind === 'insulin') {
      await deleteInsulinEvent(db, item.id);
    } else if (item.kind === 'carbs') {
      await deleteCarbEvent(db, item.id);
    } else if (item.kind === 'meal') {
      await deleteMealEvent(db, item.id);
    } else if (item.kind === 'glucose') {
      await deleteCGMReading(db, item.id);
    } else if (item.kind === 'episode') {
      await deleteMealEpisode(db, item.id);
    } else if (item.kind === 'note') {
      await deleteNoteEvent(db, item.id);
    } else {
      await deleteUnifiedEntryGroup(db, item.id);
    }
    await loadLocalState();
  }

  async function activateQuickEntry(): Promise<boolean> {
    const enabled = await enableQuickEntryNotification(latest, showGlucoseOnLockScreen);
    if (enabled) {
      // Persisted so backgroundSync.ts (no React context) knows whether to
      // repost the notification, and so app relaunches can self-heal the
      // task registration in the effect above.
      await setSetting(db, QUICK_ENTRY_ENABLED_KEY, 'true');
      await registerBackgroundSync();
    }
    return enabled;
  }

  async function confirmInsulinAssociation(episodeId: string, insulinEventId: string | null): Promise<void> {
    await confirmEpisodeInsulinContext(db, episodeId, insulinEventId);
    await processReadyEpisodes(db);
    await loadLocalState();
    setNotice('Contexto de insulina confirmado; el episodio fue recalculado.');
  }

  const numericRoute = quickRoute === 'correction' ? null : quickRoute;
  const sourceLabel = useMemo(() => {
    if (status?.isSynthetic === true) return 'PRUEBA · DATOS SINTÉTICOS';
    if (status?.state === 'connected') return 'CGM CONECTADO';
    return 'LOCAL-FIRST';
  }, [status]);

  /**
   * Un solo punto de entrada para la navegación: lo usan tanto los botones de
   * la barra como el gesto de swipe, así que no pueden divergir.
   */
  const activeDestination: NavDestination | null =
    nutritionOpen ? 'nutrition'
      : catalogOpen ? 'catalog'
        : summaryOpen ? 'summary'
          : null;

  function navigateTo(destination: NavDestination | null): void {
    // Se cierra todo antes de abrir: dos modales encimados dejan uno
    // inalcanzable detrás del otro. `null` = volver a la pantalla principal,
    // que es lo que hace el swipe cuando vuelve al centro del recorrido.
    setNutritionOpen(false);
    setCatalogOpen(false);
    setSummaryOpen(false);
    setEntryOpen(false);
    if (destination === null) return;
    if (destination === 'nutrition') setNutritionOpen(true);
    else if (destination === 'summary') setSummaryOpen(true);
    else if (destination === 'entry') setEntryOpen(true);
    else if (destination === 'catalog') setCatalogOpen(true);
    else if (destination === 'chat') {
      setNotice('El chat de IA todavía no está disponible.');
    }
  }

  const swipe = useSwipeNavigation({ active: activeDestination, onNavigate: navigateTo });

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar style="dark" />
      {/*
        El PanResponder va en un View que ENVUELVE al ScrollView, no en el
        ScrollView mismo: un ScrollView es nativo y nunca le entrega la
        decisión al sistema de responders de JS, así que puesto encima el
        gesto no se disparaba nunca. Ver `useSwipeNavigation`, que documenta
        los dos bugs de la primera versión.
      */}
      <View style={styles.flex} {...swipe.panHandlers}>
      <ScrollView
        contentContainerStyle={styles.screen}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh(true); }} tintColor={colors.teal} />}
      >
        <View style={styles.topBar}>
          <View>
            <Text style={styles.brand}>Type 1A</Text>
            <Text style={styles.mode}>{sourceLabel}</Text>
          </View>
          {/*
            Resumen y Nutrición se MOVIERON a la barra inferior (Fase 16):
            arriba a la derecha va la configuración, no la navegación. Ajustes
            se queda porque es exactamente eso.
          */}
          <View style={styles.topBarActions}>
            <Pressable style={styles.settingsButton} onPress={() => { setSettingsOpen(true); }} accessibilityRole="button" accessibilityLabel="Ajustes">
              <Settings size={22} color={colors.navy} />
            </Pressable>
          </View>
        </View>

        {notice === null ? null : (
          <View style={[styles.notice, status?.isSynthetic === true ? styles.noticeWarning : styles.noticeInfo]}>
            <Text style={styles.noticeText}>{notice}</Text>
          </View>
        )}

        {/*
          Persistente, no descartable: mientras la fila del perfil siga
          ilegible las calculadoras están bloqueadas, y la única salida
          (volver a cargar los parámetros) no se descubre sola.
        */}
        {profileUnreadable ? (
          <View style={[styles.notice, styles.noticeWarning]}>
            <Text style={styles.noticeText}>
              No pudimos leer tus parámetros de terapia guardados, así que las calculadoras de dosis quedan
              bloqueadas. Vuelve a cargarlos en Ajustes → Terapia con lo que te indicó tu equipo clínico. Todo lo
              demás —registrar glucosa, carbohidratos e insulina— sigue funcionando.
            </Text>
          </View>
        ) : null}

        {readingsUnreadable > 0 ? (
          <View style={[styles.notice, styles.noticeWarning]}>
            <Text style={styles.noticeText}>
              {readingsUnreadable} lectura(s) guardada(s) no se pudieron leer y no aparecen abajo.
            </Text>
          </View>
        ) : null}

        <GlucoseCard readings={readings} status={status} />


        <View style={styles.quickHeader}>
          <View>
            <Text style={styles.sectionTitle}>Registro rápido</Text>
            <Text style={styles.sectionSubtitle}>Atajos de un solo dato</Text>
          </View>
          {refreshing ? <Text style={styles.syncing}>Sincronizando…</Text> : null}
        </View>

        <View style={styles.quickGrid}>
          <QuickButton label="Carbos" value="+ g" color={colors.orange} soft={colors.orangeSoft} onPress={() => { setQuickRoute('carbs'); }} />
          <QuickButton label="Rápida" value="+ U" color={colors.blue} soft="#E5F1FA" onPress={() => { setQuickRoute('rapid'); }} />
          <QuickButton label="Basal" value="+ U" color={colors.navy} soft="#E7EDF2" onPress={() => { setQuickRoute('basal'); }} />
          <QuickButton label="Corrección" value="ƒ(x)" color={colors.teal} soft={colors.tealSoft} onPress={() => { setQuickRoute('correction'); }} />
          {/*
            Cetonas va acá y no dentro de "Nueva entrada" porque el momento en
            que se mide —enfermedad, glucosa alta sostenida— es justo cuando
            no se quiere navegar. Cae en su propia fila por el `flexWrap`, lo
            que además la separa visualmente de las cuatro rutinarias.
          */}
          <QuickButton label="Cetonas" value="mmol/L" color={colors.red} soft={colors.redSoft} onPress={() => { setKetonesOpen(true); }} />
        </View>

        <Pressable style={styles.mealButton} onPress={() => { setMealOpen(true); }}>
          <View style={styles.mealIcon}><Text style={styles.mealIconText}>◎</Text></View>
          <View style={styles.mealButtonCopy}>
            <Text style={styles.mealTitle}>Foto o registro manual de comida</Text>
            <Text style={styles.mealSubtitle}>IA opcional · carbohidratos siempre confirmados por ti</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        <Timeline items={timeline} onSaveItem={saveTimelineItem} onDeleteItem={deleteTimelineItem} onSaveMealEdit={saveMealEdit} />

        <View style={styles.footerSafety}>
          <Text style={styles.footerTitle}>Software de desarrollo</Text>
          <Text style={styles.footerText}>No sustituye las alarmas de FreeStyle, una medición capilar cuando corresponda ni las indicaciones de tu equipo clínico.</Text>
        </View>
      </ScrollView>
      </View>

      <NumericEntryModal
        route={numericRoute}
        onClose={() => { setQuickRoute(null); }}
        onSubmit={registerNumeric}
      />
      <CorrectionModal
        visible={quickRoute === 'correction'}
        latest={latest}
        profile={profile}
        therapyConfigured={therapyConfigured}
        recentRapid={recentRapid}
        recentRapidUnreadable={recentRapidUnreadable}
        onClose={() => { setQuickRoute(null); }}
        onSaveProfile={async (nextProfile) => {
          // Deliberately not `markConfigured` — see saveTherapyProfile.
          await saveTherapyProfile(db, nextProfile);
          setProfile(nextProfile);
        }}
        onRegister={registerCorrection}
      />
      <EntryModal
        visible={entryOpen}
        latest={latest}
        profile={profile}
        therapyConfigured={therapyConfigured}
        onClose={() => { setEntryOpen(false); }}
        onSave={saveEntry}
      />
      <MealModal visible={mealOpen} onClose={() => { setMealOpen(false); }} onConfirm={confirmMeal} catalogFoods={catalogFoods} />
      <SettingsModal
        visible={settingsOpen}
        onClose={() => { setSettingsOpen(false); }}
        status={status}
        profile={profile}
        therapyConfigured={therapyConfigured}
        showGlucoseOnLockScreen={showGlucoseOnLockScreen}
        onPrivacyChange={updatePrivacy}
        onImportMySugrCsv={async (csvText) => {
          const outcome = await importMySugrCsv(db, csvText);
          await loadLocalState();
          return outcome;
        }}
        onSaveProfile={async (nextProfile) => {
          // The therapy section is the one place where saving *is* the act
          // of configuring, so this is the only call that marks the profile
          // as user-entered and unlocks the dose calculators.
          await saveTherapyProfile(db, nextProfile, { markConfigured: true });
          setProfile(nextProfile);
          setTherapyConfigured(true);
        }}
        onEnableQuickEntry={activateQuickEntry}
        mealAlarmOffsets={mealAlarmOffsets}
        onSaveMealAlarmOffsets={updateMealAlarmOffsets}
        correctionReminder={correctionReminder}
        onSaveCorrectionReminder={updateCorrectionReminder}
        reminderAlertStyle={reminderAlertStyle}
        onSaveReminderAlertStyle={updateReminderAlertStyle}
        capillaryReminder={capillaryReminder}
        onSaveCapillaryReminder={updateCapillaryReminder}
        onExportReport={exportReport}
        onSensorConnectionChange={async () => {
          // Limpiar el estado en memoria NO alcanza: las lecturas de la cuenta
          // anterior están en SQLite, y `refresh()` arranca con
          // `loadLocalState()`, que las vuelve a leer antes de que llegue la
          // primera respuesta de red. Sin borrarlas, el timeline, el gráfico,
          // las métricas y el reporte mezclarían la glucosa de dos personas, y
          // `latestLiveReading` podría devolver la de la cuenta anterior como
          // "actual". Se borran solo las de sensor (`origin:'real'`); lo
          // manual y lo importado lo cargó la usuaria y se conserva.
          resetSensorProviderCache();
          const removed = await deleteSensorReadings(db);
          setReadings([]);
          setStatus(null);
          await refresh(true);
          if (removed > 0) {
            setNotice(`Se borraron ${removed} lectura(s) del sensor anterior para no mezclarlas con las nuevas. Tus registros manuales e importados siguen ahí.`);
          }
        }}
      />
      <SummaryModal
        visible={summaryOpen}
        onClose={() => { setSummaryOpen(false); }}
        onLoadSummary={loadSummary}
        swipeHandlers={swipe.panHandlers}
      />
      <CatalogModal
        visible={catalogOpen}
        swipeHandlers={swipe.panHandlers}
        onClose={() => { setCatalogOpen(false); }}
        onLoad={(search) => getCatalogFoods(db, 60, search)}
        onSaveFood={async (key, edit: CatalogEdit) => {
          await updateCatalogFood(db, key, edit);
          // El picker de `MealModal` lee de este estado, así que sin refrescar
          // seguiría sugiriendo el valor que ella acaba de corregir.
          setCatalogFoods(await getCatalogFoods(db));
        }}
        onDeleteFood={async (food) => {
          await deleteCatalogFood(db, food.key);
          setCatalogFoods(await getCatalogFoods(db));
        }}
      />
      <NutritionModal
        visible={nutritionOpen}
        swipeHandlers={swipe.panHandlers}
        onClose={() => { setNutritionOpen(false); }}
        profile={nutritionProfile}
        onSaveProfile={async (next) => {
          await saveNutritionProfile(db, next);
          setNutritionProfile(next);
        }}
        onLoadDay={loadNutritionDay}
      />
      <KetonesModal
        visible={ketonesOpen}
        onClose={() => { setKetonesOpen(false); }}
        onSubmit={registerKetones}
      />
      <InsulinAssociationModal
        pending={pendingAssociations[0] ?? null}
        onConfirm={confirmInsulinAssociation}
      />
      {/*
        Se monta al final para quedar por encima del resto, y solo una vez
        que `loadLocalState` resolvió el flag (`null` = todavía no sabemos):
        sin esa espera, la bienvenida parpadearía en cada arranque antes de
        que la base de datos conteste que ya se vio.
      */}
      <BottomNav active={activeDestination} onSelect={navigateTo} />
      <OnboardingModal
        visible={onboardingDone === false}
        onFinish={() => {
          setOnboardingDone(true);
          void setSetting(db, ONBOARDING_SEEN_KEY, 'true').catch((error: unknown) => {
            // Que no se pueda persistir no debe bloquear el arranque: lo peor
            // que pasa es que la bienvenida vuelva a aparecer la próxima vez.
            logSaveError('App.onboardingSeen', error);
          });
        }}
      />
    </SafeAreaView>
  );
}

function QuickButton({
  label,
  value,
  color,
  soft,
  onPress,
}: {
  label: string;
  value: string;
  color: string;
  soft: string;
  onPress: () => void;
}) {
  return (
    <Pressable style={({ pressed }) => [styles.quickButton, { backgroundColor: soft }, pressed && styles.pressed]} onPress={onPress} accessibilityRole="button">
      <Text style={[styles.quickValue, { color }]}>{value}</Text>
      <Text style={[styles.quickLabel, { color }]}>{label}</Text>
    </Pressable>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <SQLiteProvider databaseName="type1a.db" onInit={initializeDatabase}>
        <Type1AApp />
      </SQLiteProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  /** Contenedor del gesto lateral; envuelve al ScrollView de la pantalla. */
  flex: { flex: 1 },
  // paddingBottom generoso: la barra inferior es `position: absolute` y sin
  // esto tapa la última tarjeta. 96 = alto de la barra + holgura; el inset
  // del sistema lo suma la barra por dentro.
  screen: { padding: spacing.lg, paddingBottom: 96 },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg },
  brand: { color: colors.ink, fontSize: 30, fontWeight: '900', letterSpacing: -1 },
  mode: { color: colors.teal, fontSize: 10, fontWeight: '900', letterSpacing: 1.2, marginTop: 2 },
  topBarActions: { flexDirection: 'row', gap: spacing.sm },
  settingsButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  notice: { borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.md },
  noticeWarning: { backgroundColor: colors.warningSoft },
  noticeInfo: { backgroundColor: colors.tealSoft },
  noticeText: { color: colors.navy, fontSize: 12, lineHeight: 17, fontWeight: '600' },
  entryPlus: { color: '#FFFFFF', fontSize: 38, fontWeight: '300', lineHeight: 42, marginRight: spacing.md },
  entryCopy: { flex: 1 },
  entryTitle: { color: '#FFFFFF', fontSize: 19, fontWeight: '800' },
  entrySubtitle: { color: '#FFFFFF', fontSize: 12, lineHeight: 17, marginTop: 2, opacity: 0.9 },
  quickHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: spacing.xl, marginBottom: spacing.md },
  sectionTitle: { color: colors.ink, fontSize: 24, fontWeight: '800' },
  sectionSubtitle: { color: colors.muted, fontSize: 13, marginTop: 2 },
  syncing: { color: colors.teal, fontSize: 11, fontWeight: '700' },
  quickGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  quickButton: { width: '48%', minHeight: 108, borderRadius: radius.md, padding: spacing.lg, justifyContent: 'space-between' },
  quickValue: { fontSize: 29, fontWeight: '900' },
  quickLabel: { fontSize: 15, fontWeight: '800' },
  pressed: { opacity: 0.68, transform: [{ scale: 0.98 }] },
  mealButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md, borderColor: colors.line, borderWidth: 1 },
  mealIcon: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.orangeSoft, alignItems: 'center', justifyContent: 'center' },
  mealIconText: { color: colors.orange, fontSize: 24 },
  mealButtonCopy: { flex: 1, paddingHorizontal: spacing.md },
  mealTitle: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  mealSubtitle: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 2 },
  chevron: { color: colors.muted, fontSize: 30 },
  footerSafety: { backgroundColor: colors.redSoft, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.xl },
  footerTitle: { color: colors.red, fontSize: 13, fontWeight: '900' },
  footerText: { color: colors.red, fontSize: 11, lineHeight: 17, marginTop: 3 },
});
