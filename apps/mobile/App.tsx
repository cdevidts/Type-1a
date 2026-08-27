import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
import Calculator from 'lucide-react-native/icons/calculator';
import FlaskConical from 'lucide-react-native/icons/flask-conical';
import Settings from 'lucide-react-native/icons/settings';
import Syringe from 'lucide-react-native/icons/syringe';
import UtensilsCrossed from 'lucide-react-native/icons/utensils-crossed';
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

import {
  basalInsulinLookbackMinutes,
  buildReportRows,
  catalogEntriesFrom,
  catalogEntryFromPortion,
  insulinNameForType,
  isPlausibleInsulinDuration,
  latestLiveReading,
  MAX_INSULIN_DURATION_HOURS,
  MIN_INSULIN_DURATION_HOURS,
  rapidInsulinLookbackMinutes,
  type CatalogFood,
} from '@type1a/domain';
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
import { UnifiedEntryModal, type MasterMode, type UnifiedEntryDraft } from './src/components/UnifiedEntryModal';
import { MealEditModal } from './src/components/MealEditModal';
import { QuickNumericModal, type QuickNumericKind } from './src/components/QuickNumericModal';
import { insulinProfileFields } from './src/components/InsulinPicker';
import { GlucoseCard } from './src/components/GlucoseCard';
import { InsulinAssociationModal } from './src/components/InsulinAssociationModal';
import { CatalogModal, type CatalogEdit } from './src/components/CatalogModal';
import type { MealEditResult } from './src/components/MealEditModal';
import { MealModal, type ConfirmedMealDraft } from './src/components/MealModal';
import { SettingsModal } from './src/components/SettingsModal';
import { BottomNav, type NavDestination } from './src/components/BottomNav';
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
  deleteVitalsEvent,
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
  saveCorrectionReminderSettings,
  saveInsulinEvent,
  saveMealAlarmOffsets,
  saveMealWithEpisode,
  saveReminderAlertStyle,
  resolveLegacyBackendSensor,
  saveTherapyProfile,
  saveUnifiedEntry,
  saveVitalsEvent,
  setSetting,
  promoteEventToEntryGroup,
  updateMealFromEdit,
  updateUnifiedEntryGroup,
  upsertCGMReadings,
  type UnifiedEntryInput,
  type UnifiedEntryOutcome,
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
  ensureReminderChannels,
  setActiveAlertStyle,
  cancelEpisodeNotifications,
  scheduleCapillaryReminders,
  scheduleCorrectionReminder,
  scheduleEpisodeNotifications,
} from './src/notifications';
import { capillaryReminderTimes } from './src/format';
import { colors, radius, spacing } from './src/theme';
import type { NutritionProfile } from '@type1a/schemas';
import { normalizeQuickRoute } from './src/types';
import { masterSeedFrom, masterTargetOf, masterTitleFor } from './src/masterModal';
import { dayRange, isSameDay, MONTH_NAMES, startOfDay } from './src/entryTime';
import type { EntryFocus, LegacyQuickRoute, MasterEditPayload, NutritionDayData, PendingInsulinAssociation, QuickRoute, ReminderAlertStyle, ReportExport, SummaryData, TimelineItem } from './src/types';

/** Flag de "ya vio la bienvenida"; vive en `settings`, no en el perfil de terapia. */
const ONBOARDING_SEEN_KEY = 'onboardingSeenAt';

const EMPTY_PROFILE: TherapyProfile = {
  glucoseUnit: 'mg/dL',
  targetGlucose: 110,
  correctionFactor: 45,
  doseIncrement: 0.5,
};

function routeFromUrl(url: string): QuickRoute | null {
  // `carbs` y `rapid` siguen aceptándose a propósito: un deep link viejo, o
  // un acceso directo que la usuaria ya tenga, no puede dejar de funcionar
  // porque adentro se hayan fusionado los botones (Fase 21).
  const match = /^type1a:\/\/quick\/(meal|carbs|rapid|basal|correction)(?:[/?#]|$)/u.exec(url);
  const route = match?.[1] as LegacyQuickRoute | undefined;
  return route === undefined ? null : normalizeQuickRoute(route);
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
  /**
   * El Modal Maestro: `null` = cerrado.
   *
   * Un solo estado para **crear y editar**, porque es un solo componente
   * (`projectbrief.md`: "Nueva entrada y TODOS los modales de edición
   * consumen un mismo componente maestro"). Antes esto era un `EntryFocus`
   * suelto y la edición vivía en formularios inline dentro del detalle del
   * timeline, que sabían menos que el de creación.
   */
  const [masterMode, setMasterMode] = useState<MasterMode | null>(null);
  /** Con qué sección arranca abierto al **crear**. Al editar manda el contenido. */
  const [entryFocus, setEntryFocus] = useState<EntryFocus>('all');
  /** Los accesos rápidos dedicados de Basal y Cetonas. `null` = cerrados. */
  const [quickNumeric, setQuickNumeric] = useState<QuickNumericKind | null>(null);
  /** La comida abierta en su editor con IA, hospedado desde el maestro. */
  const [editingMeal, setEditingMeal] = useState<MealEvent | null>(null);
  /**
   * El día que muestra Nutrición. Manda sobre las consultas del día y sobre el
   * estado del botón "+", que cambia cuando no es hoy.
   */
  const [nutritionDay, setNutritionDay] = useState<Date>(() => startOfDay(new Date()));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
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
    // El handler de primer plano vive a nivel de módulo y no puede leer este
    // estado: hay que empujárselo. Sin esto, con la app abierta las alarmas
    // suenan según el default y no según lo que ella eligió (Fase 19).
    setActiveAlertStyle(alertStyle);
    void ensureReminderChannels(alertStyle);
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
        await scheduleCapillaryReminders(times ?? [], style);
      }
    })();
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void refresh();
    });
    return () => { appStateSubscription.remove(); };
  }, [db, refresh]);

  /**
   * Un solo punto de entrada para los destinos rápidos, vengan del botón, de
   * un deep link o de la notificación. `'meal'` abre `MealModal` en vez de un
   * modal numérico, así que no alcanza con `setQuickRoute` (Fase 21).
   */
  const openQuickRoute = useCallback((route: QuickRoute): void => {
    if (route === 'meal') { setMealOpen(true); return; }
    // Basal vuelve a tener su modal dedicado y breve. No es volver atrás: el
    // fallo que produjo la fusión no fue tener modales pequeños, fue que cada
    // uno traía su copia del parseo y la escritura. `QuickNumericModal` es uno
    // solo, parametrizado, sin lógica clínica propia — y ofrece la salida al
    // maestro para quien además quiera anotar la glucosa.
    if (route === 'basal') { setQuickNumeric('basal'); return; }
    setQuickRoute(route);
  }, []);

  useEffect(() => {
    function handleUrl(url: string): void {
      const nextRoute = routeFromUrl(url);
      if (nextRoute !== null) openQuickRoute(nextRoute);
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
        openQuickRoute(actionRoute);
        return;
      }
      const url = response.notification.request.content.data?.url;
      if (typeof url === 'string') handleUrl(url);
      void refresh();
    });
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response === null) return;
      const actionRoute = quickRouteFromNotificationAction(response.actionIdentifier);
      if (actionRoute !== null) openQuickRoute(actionRoute);
    });
    return () => {
      urlSubscription.remove();
      notificationSubscription.remove();
    };
  }, [refresh, openQuickRoute]);


  async function registerCorrection(units: number): Promise<void> {
    const timestamp = new Date().toISOString();
    // Una corrección SÍ es una fila suelta legítima: no pertenece a ninguna
    // comida, y marcarla con `purpose: 'correction'` es justamente lo que
    // permite después distinguirla del bolo de un plato.
    await saveInsulinEvent(db, {
      id: Crypto.randomUUID(),
      timestamp,
      type: 'rapid',
      units,
      source: 'manual',
      createdAt: timestamp,
      purpose: 'correction',
      ...(insulinNameForType(profile, 'rapid') === undefined
        ? {}
        : { insulinName: insulinNameForType(profile, 'rapid')! }),
    });
    await loadLocalState();
    if (correctionReminder.enabled) {
      await scheduleCorrectionReminder(timestamp, correctionReminder.offsetMinutes, reminderAlertStyle);
    }
    setNotice(`Se registraron ${units} U de rápida tras confirmación.`);
  }

  /**
   * El acceso rápido de basal.
   *
   * Escribe por la misma función que el maestro (`saveInsulinEvent`) y estampa
   * el nombre con la misma función de dominio (`insulinNameForType`): lo único
   * propio del acceso rápido es cuántos toques cuesta llegar, no qué se
   * guarda.
   */
  async function registerBasal(units: number): Promise<void> {
    const timestamp = new Date().toISOString();
    const name = insulinNameForType(profile, 'basal');
    await saveInsulinEvent(db, {
      id: Crypto.randomUUID(),
      timestamp,
      type: 'basal',
      units,
      source: 'manual',
      createdAt: timestamp,
      ...(name === undefined ? {} : { insulinName: name }),
    });
    await loadLocalState();
    setNotice(`Se registraron ${units} U de basal.`);
  }

  /**
   * El acceso rápido de cetonas.
   *
   * La banda la decide `assessKetones` en `packages/domain` y la muestra el
   * propio modal; acá solo se escribe la fila. Es el dato de triage de
   * cetoacidosis, así que va a `vitals_events` como cualquier otra medición y
   * el timeline la lee por el mismo camino.
   */
  async function registerKetones(ketonesMmolL: number): Promise<void> {
    const timestamp = new Date().toISOString();
    await saveVitalsEvent(db, {
      id: Crypto.randomUUID(),
      timestamp,
      ketonesMmolL,
      source: 'manual',
      createdAt: timestamp,
    });
    await loadLocalState();
    setNotice(`Se registraron ${ketonesMmolL} mmol/L de cetonas.`);
  }

  /**
   * Aplica la respuesta a la pregunta de tres salidas del catálogo (Fase 18).
   *
   * Extraído a función propia el 2026-08-25 porque ahora tiene **dos**
   * llamadores: el guardado normal de una comida y el modo "solo al
   * catálogo". Cuando vivía embebido en el primero, elegir "actualizar el
   * alimento" en modo solo-catálogo se perdía en silencio — justo el modo
   * donde esa corrección es lo único que se pidió.
   *
   * Nunca lanza: el catálogo es una comodidad y su fallo no puede tumbar el
   * registro de lo que se comió.
   */
  async function applyCatalogWrite(
    write: NonNullable<ConfirmedMealDraft['catalogWrite']>,
    timestamp: string,
  ): Promise<void> {
    try {
      const entry = catalogEntryFromPortion(write.food, {
        grams: write.grams,
        carbsG: write.carbsG,
        proteinG: write.proteinG,
        fatG: write.fatG,
        fiberG: write.fiberG,
        caloriesKcal: write.caloriesKcal,
      }, timestamp);
      if (entry === null) {
        setNotice('Esos valores no son posibles por 100 g, así que el catálogo no se tocó.');
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
      setNotice('No se pudo actualizar el catálogo.');
    }
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
      // Un carbo que salió del catálogo conserva su procedencia. El catálogo
      // es una media de estimaciones de IA, así que transcribir su sugerencia
      // al campo de confirmación sin este rastro la vuelve indistinguible de
      // un valor pesado en balanza — para ella y para el reporte al médico.
      // Un análisis propio manda sobre la sugerencia del catálogo.
      ...(draft.catalogSuggestedCarbsG === undefined || draft.analysis !== undefined
        ? {}
        : { aiEstimatedCarbsG: draft.catalogSuggestedCarbsG }),
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
    // Fase 21: "solo al catálogo" corta acá. No se escribe `meal_events`, no
    // se crea episodio y no se programan alarmas — es cargar un alimento sin
    // haberlo comido. El catálogo se alimenta más abajo con el mismo camino
    // de siempre.
    if (draft.registerToTimeline === false) {
      // Ojo: `catalogWrite` (la respuesta a la pregunta de tres salidas de la
      // Fase 18) también tiene que atenderse acá. Si solo se mirara
      // `draft.analysis`, corregir los macros de un alimento del catálogo y
      // elegir "actualizar el alimento" se perdería en silencio en este modo,
      // que es justo el modo donde esa corrección es lo único que se pidió.
      const wroteCatalog = draft.catalogWrite !== undefined
        || (draft.analysis !== undefined && draft.saveToCatalog !== false);
      if (draft.catalogWrite !== undefined) await applyCatalogWrite(draft.catalogWrite, timestamp);
      if (draft.analysis !== undefined && draft.saveToCatalog !== false) {
        try {
          await recordCatalogFoods(db, catalogEntriesFrom(draft.analysis.estimate.foods, timestamp, draft.imageUri));
        } catch (error) {
          logSaveError('App.recordCatalogFoods', error);
          setNotice('No se pudo guardar en el catálogo.');
          await loadLocalState();
          return;
        }
      }
      setNotice(wroteCatalog
        ? 'Guardado en tu catálogo. No se registró ninguna comida de hoy.'
        : 'No había nada que guardar en el catálogo: analiza la comida con foto o texto primero.');
      await loadLocalState();
      return;
    }

    const episodeId = await saveMealWithEpisode(db, meal);

    // La insulina de esta comida va con el MISMO timestamp que la comida.
    // Es el arreglo estructural de la Fase 21: el botón "Rápida" suelto
    // escribía una fila con su propia hora, y por eso el emparejamiento
    // insulina↔comida fallaba. Va después de guardar la comida y en su propio
    // try: si falla la dosis, lo comido ya quedó registrado.
    if (draft.rapidUnits !== undefined) {
      try {
        await saveInsulinEvent(db, {
          id: Crypto.randomUUID(),
          timestamp,
          type: 'rapid',
          units: draft.rapidUnits,
          source: 'manual',
          createdAt: timestamp,
          purpose: 'meal',
          ...(insulinNameForType(profile, 'rapid') === undefined
            ? {}
            : { insulinName: insulinNameForType(profile, 'rapid')! }),
        });
      } catch (error) {
        logSaveError('App.confirmMealInsulin', error);
        setNotice('La comida quedó guardada, pero no se pudo registrar la insulina.');
      }
    }

    // Respuesta a la pregunta de tres salidas (Fase 18). Va **después** de
    // guardar la comida y en su propio try: el catálogo es una comodidad, y
    // un fallo suyo no puede impedir que quede registrado lo que se comió.
    if (draft.catalogWrite !== undefined) await applyCatalogWrite(draft.catalogWrite, timestamp);
    // El catálogo se alimenta de cada análisis, y nunca puede impedir que la
    // comida se guarde: es una comodidad, no parte del registro.
    if (draft.analysis !== undefined && draft.saveToCatalog !== false) {
      try {
        // Ver `saveEntry`: la foto es representación del alimento, no
        // evidencia de sus macros.
        await recordCatalogFoods(db, catalogEntriesFrom(draft.analysis.estimate.foods, timestamp, draft.imageUri));
      } catch (error) {
        logSaveError('App.recordCatalogFoods', error);
      }
    }
    await scheduleEpisodeNotifications(episodeId, timestamp, mealAlarmOffsets, reminderAlertStyle);
    setNotice(`Comida guardada. El episodio se completará con CGM a ${mealAlarmOffsets.map((minutes) => `+${minutes}`).join(', ')} minutos.`);
    await loadLocalState();
  }

  /** Abre el maestro en modo creación, con la sección `focus` desplegada. */
  function openMasterCreate(focus: EntryFocus, presetDay: Date | null = null): void {
    setEntryFocus(focus);
    setMasterMode({
      kind: 'create',
      ...(presetDay === null ? {} : { presetDay }),
      onSave: saveEntry,
    });
  }

  /**
   * Abre el maestro sobre un registro existente.
   *
   * La semilla y el título los calcula `masterModal.ts`, puro y con test: qué
   * secciones arrancan abiertas depende del **contenido**, no de qué botón lo
   * abrió, y qué se puede mover en el tiempo depende de si el dato lo escribió
   * ella o lo reportó una fuente externa.
   */
  function openMasterEdit(item: TimelineItem): void {
    setMasterMode({
      kind: 'edit',
      seed: masterSeedFrom(item),
      title: masterTitleFor(item),
      onSave: (payload) => saveMasterEdit(item, payload),
      onEditMeal: (meal) => {
        // Se cierra el maestro ANTES de abrir el editor de comida: dos `Modal`
        // de React Native encimados en Android dejan el de abajo capturando
        // los toques, y el de arriba se ve pero no responde.
        setMasterMode(null);
        setEditingMeal(meal);
      },
    });
  }

  async function saveEntry(draft: UnifiedEntryDraft): Promise<void> {
    // La procedencia la decide `packages/domain`, y quien la calcula es el
    // **maestro**: es el único que sabe qué precargó una estimación —la foto,
    // el texto o el carrito—. Acá se recalculaba comparando solo contra
    // `draft.analysis`, así que unos macros venidos del catálogo, que no
    // traen análisis, se guardaban marcados `'user'` y el reporte del control
    // médico los imprimía como anotados a mano.
    const macrosSource = draft.macrosSource ?? undefined;
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
      // El análisis va PRIMERO y lo que ella escribió después, para que lo
      // suyo gane. Desde el 2026-08-25 esta hoja SÍ tiene campos de macros
      // editables, así que el bloque anterior —que los tomaba enteros del
      // análisis y los marcaba `macrosSource: 'ai'`— habría pisado en
      // silencio la proteína que ella corrigiera y encima la habría
      // etiquetado como estimación de IA. Es el mismo error que ya se había
      // corregido en `confirmMeal`.
      ...(draft.analysis === undefined
        ? {}
        : {
            aiEstimatedCarbsG: draft.analysis.totals.carbsG,
            aiAnalysisId: draft.analysis.analysisId,
            proteinG: draft.analysis.totals.proteinG,
            fatG: draft.analysis.totals.fatG,
            fiberG: draft.analysis.totals.fiberG,
            caloriesKcal: draft.analysis.totals.caloriesKcal,
          }),
      ...(draft.proteinG === undefined ? {} : { proteinG: draft.proteinG }),
      ...(draft.fatG === undefined ? {} : { fatG: draft.fatG }),
      ...(draft.fiberG === undefined ? {} : { fiberG: draft.fiberG }),
      ...(draft.caloriesKcal === undefined ? {} : { caloriesKcal: draft.caloriesKcal }),
      // `UnifiedEntryInput` declara `macrosSource` desde el 2026-08-26. Antes
      // no, y como esto es un spread, TypeScript lo dejaba pasar y `db.ts` lo
      // descartaba: los macros de la IA llegaban al reporte médico sin
      // procedencia. No agregues un campo acá sin verlo en esa interfaz.
      ...(macrosSource === undefined ? {} : { macrosSource }),
      // **El carbo del catálogo conserva su procedencia de estimación.**
      // `confirmMeal` ya lo hacía y este camino no: los gramos del carrito
      // pasaban a "confirmados" sin `aiEstimatedCarbsG`, y quedaban
      // indistinguibles de un valor pesado en balanza para ella y para el
      // reporte. Un análisis propio manda sobre la sugerencia del catálogo.
      ...(draft.catalogSuggestedCarbsG === undefined || draft.analysis !== undefined
        ? {}
        : { aiEstimatedCarbsG: draft.catalogSuggestedCarbsG }),
      // Cetonas, peso y presión en el mismo idioma de parche que usa la
      // edición: un número es un valor, la ausencia no borra nada.
      vitals: {
        ...(draft.ketonesMmolL === undefined ? {} : { ketonesMmolL: draft.ketonesMmolL }),
        ...(draft.weightKg === undefined ? {} : { weightKg: draft.weightKg }),
        ...(draft.systolicBP === undefined ? {} : { systolicBP: draft.systolicBP }),
        ...(draft.diastolicBP === undefined ? {} : { diastolicBP: draft.diastolicBP }),
      },
      // El nombre se estampa al crear y queda congelado. La app no inventa uno
      // si no hay configuración.
      profileInsulinNames: profileInsulinNames(),
    });
    // Mismo trato que `confirmMeal`: una comida analizada por IA alimenta el
    // catálogo, venga del formulario que venga. Esta hoja no lo hacía, así que
    // registrar una comida con foto desde "Nueva entrada" no dejaba nada en el
    // catálogo y la misma comida desde `MealModal` sí — dos caminos para lo
    // mismo con memorias distintas. Va después de guardar y en su propio
    // try/catch por la misma razón que allá: el catálogo es una comodidad, y
    // un fallo suyo nunca puede impedir que quede registrado lo que se comió.
    // `saveToCatalog !== false` es la misma condición que aplica `confirmMeal`.
    // Antes esta hoja alimentaba el catálogo **siempre** que hubiera análisis,
    // sin ofrecer la decisión: dos caminos para lo mismo con reglas distintas.
    if (draft.analysis !== undefined && draft.saveToCatalog !== false) {
      try {
        // La foto de la comida viaja al catálogo como **representación** del
        // alimento. Sale de la imagen real que ella sacó, nunca se genera, y
        // no se usa para inferir macros: los macros vienen del análisis.
        await recordCatalogFoods(db, catalogEntriesFrom(draft.analysis.estimate.foods, draft.timestamp, draft.imageUri));
      } catch (error) {
        logSaveError('App.recordCatalogFoods', error);
      }
    }
    if (outcome.episodeId !== null) {
      await scheduleEpisodeNotifications(outcome.episodeId, draft.timestamp, mealAlarmOffsets, reminderAlertStyle);
    }
    if (outcome.savedRapid && draft.rapidIncludesCorrection && correctionReminder.enabled) {
      await scheduleCorrectionReminder(draft.timestamp, correctionReminder.offsetMinutes, reminderAlertStyle);
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
      const [readings, insulin, carbs, meals, activity] = await Promise.all([
        getCGMReadings(db, range.from, range.to, tally),
        getInsulinEvents(db, range.from, range.to, tally),
        getCarbEvents(db, range.from, range.to, tally),
        getMealEvents(db, range.from, range.to, tally),
        // Solo para descartar episodios confundidos (Fase 23): una caminata
        // entre la dosis y el horizonte hace que ese "% en rango" ya no
        // describa a la dosis. No entra en ningún promedio.
        getActivityEvents(db, range.from, range.to),
      ]);
      return {
        readings,
        insulin,
        carbs,
        meals,
        activity,
        // La insulina que eligió la usuaria decide cuánto se mira hacia atrás
        // por dosis que siguen actuando. Sin elegir, `undefined`: no se
        // excluye nada por una suposición de la app (AGENTS.md).
        rapidLookbackMinutes: rapidInsulinLookbackMinutes(profile),
        basalLookbackMinutes: basalInsulinLookbackMinutes(profile),
        unreadableCount: tally.unreadable,
      };
    },
    [db, profile],
  );

  /**
   * Dos ventanas distintas a propósito: el **día seleccionado** para las metas,
   * y 90 días para los patrones de grasa/proteína, que necesitan muchas
   * comidas con macros anotados para tener algo que comparar. Las lecturas
   * cubren la ventana larga más un margen, porque la respuesta a una comida
   * tardía cae al día siguiente.
   *
   * ## Por qué recibe el día
   *
   * Antes no lo recibía: filtraba contra `new Date()` y la pantalla estaba
   * clavada en "hoy". Revisar lo que se comió ayer —que es *la* razón por la
   * que existe una pantalla de nutrición— no se podía. El rango llega
   * explícito desde el Strip Calendar (`dayRange`, puro y con test), así que
   * "el día" es siempre un rango local semiabierto y no una comparación
   * contra el reloj.
   *
   * **La ventana de patrones no se mueve con el día seleccionado.** Son dos
   * preguntas distintas: "qué comí el martes" y "qué patrón se ve en 90 días".
   * Anclar la segunda al día elegido rompería la ventana analítica cada vez
   * que ella navega el calendario.
   */
  const loadNutritionDay = useCallback(async (day: Date): Promise<NutritionDayData> => {
    const tally = createDecodeTally();
    const now = new Date();
    const { from: dayStart, to: dayEnd } = dayRange(day);
    const patternStart = new Date(now.getTime() - 90 * 24 * 60 * 60_000);
    // La insulina, los carbohidratos y la actividad de la ventana LARGA son
    // los que permiten descartar episodios confundidos (Fase 23) — sin ellos,
    // una colación a las 2 h entra al promedio de grasa/proteína como si
    // fuera efecto tardío de la comida. `dayCarbs` y `dayMeals` son la ventana
    // del día seleccionado, que es otra pregunta.
    const [dayMeals, dayCarbs, patternMeals, readings, patternInsulin, patternCarbs, patternActivity] = await Promise.all([
      getMealEvents(db, dayStart, dayEnd, tally),
      getCarbEvents(db, dayStart, dayEnd, tally),
      getMealEvents(db, patternStart, now, tally),
      getCGMReadings(db, patternStart, now, tally),
      getInsulinEvents(db, patternStart, now, tally),
      getCarbEvents(db, patternStart, now, tally),
      getActivityEvents(db, patternStart, now),
    ]);
    return {
      dayMeals,
      dayCarbs,
      patternMeals,
      patternInsulin,
      patternCarbs,
      patternActivity,
      readings,
      rapidLookbackMinutes: rapidInsulinLookbackMinutes(profile),
      basalLookbackMinutes: basalInsulinLookbackMinutes(profile),
      unreadableCount: tally.unreadable,
    };
  }, [db, profile]);

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
      // Ver la nota de `loadSummary`: solo para descartar confundidos.
      activity: activities,
      rows: buildReportRows({ readings, insulin, carbs, meals, activities, notes, vitals, hba1c }),
      // El reporte va al control médico: los promedios que imprime tienen que
      // excluir lo confundido con el mismo criterio que la app en pantalla.
      rapidLookbackMinutes: rapidInsulinLookbackMinutes(profile),
      basalLookbackMinutes: basalInsulinLookbackMinutes(profile),
      unreadableCount: tally.unreadable,
    };
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
    setActiveAlertStyle(style);
    // Crea los tres canales del estilo nuevo y borra los del anterior: Android
    // congela sonido y vibración al crear el canal, así que cambiar de estilo
    // es cambiar de canal, no editar el que ya existe.
    await ensureReminderChannels(style);
    // Reschedule the standing capillary reminders onto the newly-chosen alert
    // channel — they're the only reminders scheduled ahead of time; episode
    // and correction reminders are scheduled on demand and already read the
    // current style. If capillary reminders are off, this just clears them.
    if (capillaryReminder.enabled) {
      const times = capillaryReminderTimes(capillaryReminder.wakeStart, capillaryReminder.wakeEnd, capillaryReminder.count);
      await scheduleCapillaryReminders(times ?? [], style);
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
    await scheduleCapillaryReminders(times ?? [], reminderAlertStyle);
  }

  /**
   * Los nombres de insulina configurados, para estampar y reestampar.
   *
   * Viajan como dato hasta `db.ts`, que se los pasa a
   * `resolveInsulinNameForEdit` en `packages/domain`. La app no infiere
   * ninguno: si no hay configuración, el registro se guarda sin nombre.
   */
  function profileInsulinNames(): { rapidInsulinName?: string; basalInsulinName?: string } {
    return {
      ...(profile.rapidInsulinName === undefined ? {} : { rapidInsulinName: profile.rapidInsulinName }),
      ...(profile.basalInsulinName === undefined ? {} : { basalInsulinName: profile.basalInsulinName }),
    };
  }

  /**
   * Cancela y reprograma las alarmas de los episodios que se movieron de hora.
   *
   * **Cancelar va primero, siempre.** Al revés, la cancelación por episodio se
   * llevaría por delante las que se acaban de crear. Sin esto, corregir la
   * hora de una comida no reemplazaba sus tres alarmas: las sumaba, y el
   * teléfono avisaba seis veces por un solo plato.
   */
  async function rescheduleMovedEpisodes(outcome: UnifiedEntryOutcome, timestamp: string): Promise<void> {
    for (const episodeId of outcome.movedEpisodeIds) {
      await cancelEpisodeNotifications(episodeId);
    }
    for (const episodeId of outcome.movedEpisodeIds) {
      // Los offsets que ya quedaron en el pasado se saltan solos; los que no,
      // se reprograman sobre la hora nueva.
      await scheduleEpisodeNotifications(episodeId, timestamp, mealAlarmOffsets, reminderAlertStyle);
    }
  }

  /**
   * Guarda la edición de **cualquier** registro histórico, desde el Modal
   * Maestro.
   *
   * ## La regla que reemplaza a las cinco ramas anteriores
   *
   * Antes había una rama por tipo de ítem, y cada una sabía guardar un
   * subconjunto distinto: la de insulina solo unidades, la de carbos solo
   * gramos, la de nota solo texto. Eso codificaba "el tipo con el que nació un
   * evento restringe lo que se le puede sumar", que es exactamente lo que
   * `projectbrief.md` prohíbe.
   *
   * Ahora hay **una** ruta de escritura, y lo único que decide el tipo del
   * ítem es *dónde* aterriza (`masterTargetOf`, puro y con test):
   *
   * - ya es un grupo → se edita en su sitio;
   * - es una lectura suelta → se le adjunta sin tocar su valor ni su hora;
   * - es un evento suelto → se **promueve** a grupo, conservando id,
   *   timestamp, `created_at`, `source` y procedencia, y después se edita por
   *   el mismo camino que todos.
   */
  async function saveMasterEdit(item: TimelineItem, payload: MasterEditPayload): Promise<void> {
    const target = masterTargetOf(item);
    // Un episodio es un agregado calculado: se lee y se borra, no se edita.
    if (target.kind === 'readonly') return;

    const timestamp = payload.timestamp ?? item.timestamp;
    const input: UnifiedEntryInput = {
      timestamp,
      rapidIncludesCorrection: payload.rapidIncludesCorrection === true,
      profileInsulinNames: profileInsulinNames(),
      ...(payload.manualGlucose === undefined ? {} : { manualGlucose: payload.manualGlucose }),
      ...(payload.carbsG === undefined ? {} : { carbsG: payload.carbsG }),
      ...(payload.description === undefined ? {} : { description: payload.description }),
      ...(payload.proteinG === undefined ? {} : { proteinG: payload.proteinG }),
      ...(payload.fatG === undefined ? {} : { fatG: payload.fatG }),
      ...(payload.fiberG === undefined ? {} : { fiberG: payload.fiberG }),
      ...(payload.caloriesKcal === undefined ? {} : { caloriesKcal: payload.caloriesKcal }),
      ...(payload.imageUri === undefined ? {} : { imageUri: payload.imageUri }),
      ...(payload.aiEstimatedCarbsG === undefined ? {} : { aiEstimatedCarbsG: payload.aiEstimatedCarbsG }),
      ...(payload.aiAnalysisId === undefined ? {} : { aiAnalysisId: payload.aiAnalysisId }),
      ...(payload.macrosSource === undefined ? {} : { macrosSource: payload.macrosSource }),
      ...(payload.rapidUnits === undefined ? {} : { rapidUnits: payload.rapidUnits }),
      ...(payload.basalUnits === undefined ? {} : { basalUnits: payload.basalUnits }),
      ...(payload.vitals === undefined ? {} : { vitals: payload.vitals }),
      ...(payload.note === undefined ? {} : { note: payload.note }),
    };

    let outcome: UnifiedEntryOutcome;
    if (target.kind === 'group') {
      outcome = await updateUnifiedEntryGroup(db, target.entryGroupId, input);
    } else if (target.kind === 'reading') {
      // La lectura conserva valor, origen y hora de su fuente. Solo una
      // capilar que ella tecleó admite corregir el valor, y eso lo decide
      // `attachEntryToReading`, no esta capa.
      outcome = await attachEntryToReading(db, target.readingId, input);
    } else {
      // Promoción: idempotente, así que un doble toque no acuña dos grupos.
      const entryGroupId = await promoteEventToEntryGroup(db, target.table, target.rowId);
      outcome = await updateUnifiedEntryGroup(db, entryGroupId, input);
    }

    // Primero cancelar lo que dejó de describir la realidad, después
    // recalcular, y solo entonces programar lo nuevo.
    await rescheduleMovedEpisodes(outcome, timestamp);
    if (outcome.episodeId !== null) {
      await cancelEpisodeNotifications(outcome.episodeId);
      await scheduleEpisodeNotifications(outcome.episodeId, timestamp, mealAlarmOffsets, reminderAlertStyle);
    }
    if (outcome.savedRapid && payload.rapidIncludesCorrection === true && correctionReminder.enabled) {
      await scheduleCorrectionReminder(timestamp, correctionReminder.offsetMinutes, reminderAlertStyle);
    }
    // El episodio se recalcula acá y no en el próximo refresh: el resumen
    // post-comida quedaría en blanco mientras tanto, y ella acaba de mirar
    // justo ese registro.
    await processReadyEpisodes(db);
    await loadLocalState();
    setNotice('Cambios guardados.');
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
    } else if (item.kind === 'vitals') {
      await deleteVitalsEvent(db, item.id);
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

  /**
   * `true` cuando el "+" registraría en una fecha pasada.
   *
   * Es exactamente "Nutrición abierta en un día que no es hoy". Se calcula acá
   * y no dentro de la barra porque la barra dibuja, no decide: el estado del
   * botón tiene que apagarse solo al volver a hoy, al cerrar Nutrición y al
   * navegar a cualquier otro destino, y esas tres condiciones viven en este
   * estado.
   */
  const pastEntryDay: Date | null = nutritionOpen && !isSameDay(nutritionDay, new Date())
    ? nutritionDay
    : null;

  function navigateTo(destination: NavDestination | null): void {
    // Se cierra todo antes de abrir: dos modales encimados dejan uno
    // inalcanzable detrás del otro. `null` = volver a la pantalla principal,
    // que es lo que hace el swipe cuando vuelve al centro del recorrido.
    //
    // ⚠️ El "+" se lee **antes** de cerrar Nutrición: cerrarla apaga
    // `pastEntryDay`, así que leerlo después perdería la fecha heredada y la
    // entrada se guardaría con la hora de ahora, en silencio.
    const inheritedDay = destination === 'entry' ? pastEntryDay : null;
    setNutritionOpen(false);
    setCatalogOpen(false);
    setSummaryOpen(false);
    setMasterMode(null);
    if (destination === null) return;
    if (destination === 'nutrition') setNutritionOpen(true);
    else if (destination === 'summary') setSummaryOpen(true);
    else if (destination === 'entry') openMasterCreate('all', inheritedDay);
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
          <View style={styles.flex}>
            <Text style={styles.sectionTitle}>Registro rápido</Text>
            {/*
              Ya no dice "atajos de un solo dato": desde la Fase 21 "Comida"
              no es un dato suelto, es el registro completo con foto, IA,
              catálogo e insulina. La bajada describe lo que hay.
            */}
            <Text style={styles.sectionSubtitle}>Lo que registras a diario, a un toque</Text>
          </View>
          {refreshing ? <Text style={styles.syncing}>Sincronizando…</Text> : null}
        </View>

        {/*
          Cuatro destinos, uno por acción real. Rediseñado el 2026-08-25 con
          dos correcciones que Verónica pidió:

          1. **Se fue la tarjeta "Foto o registro manual de comida"**, que
             abría exactamente lo mismo que el botón "Comida". Dos entradas al
             mismo lugar es ruido, y la que sobra es la que no es par de las
             demás. Su explicación ("IA opcional · carbohidratos siempre
             confirmados por ti") se mudó al pie del propio botón, donde
             sigue diciendo lo mismo sin ocupar una fila entera.
          2. **Se fueron los glifos Unicode** (`ƒ(x)`, `mmol/L`, `◎`), que la
             skill `/iconography` prohíbe desde hace tiempo: se renderizan
             distinto en cada Android, no tienen grosor controlable y no
             comunican nada a quien no los reconozca. Ahora son iconos de
             Lucide, la familia que ya usa la barra inferior.

          Cada botón lleva icono + etiqueta + una línea de qué hace: un icono
          nunca comunica solo.
        */}
        <View style={styles.quickGrid}>
          <QuickButton
            label="Comida"
            hint="Foto o texto · IA opcional"
            Icon={UtensilsCrossed}
            color={colors.orange}
            soft={colors.orangeSoft}
            onPress={() => { setMealOpen(true); }}
          />
          <QuickButton
            label="Corrección"
            hint="Calcular con tus parámetros"
            Icon={Calculator}
            color={colors.teal}
            soft={colors.tealSoft}
            onPress={() => { setQuickRoute('correction'); }}
          />
          <QuickButton
            label="Basal"
            hint="Tu dosis de base del día"
            Icon={Syringe}
            color={colors.navy}
            soft="#E7EDF2"
            onPress={() => { setQuickNumeric('basal'); }}
          />
          {/*
            Cetonas tiene modal propio y no una sección del maestro: el momento
            en que se mide —enfermedad, glucosa alta sostenida— es justo cuando
            no se quiere navegar, y un formulario de seis secciones se lee como
            un formulario largo aunque cinco vengan plegadas. Desde adentro hay
            una salida al maestro para quien además quiera anotar la glucosa.
          */}
          <QuickButton
            label="Cetonas"
            hint="Medición en sangre"
            Icon={FlaskConical}
            color={colors.red}
            soft={colors.redSoft}
            onPress={() => { setQuickNumeric('ketones'); }}
          />
        </View>

        <Timeline items={timeline} onEditItem={openMasterEdit} onDeleteItem={deleteTimelineItem} />

        <View style={styles.footerSafety}>
          <Text style={styles.footerTitle}>Software de desarrollo</Text>
          <Text style={styles.footerText}>No sustituye las alarmas de FreeStyle, una medición capilar cuando corresponda ni las indicaciones de tu equipo clínico.</Text>
        </View>
      </ScrollView>
      </View>

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
      {/*
        **Un solo Modal Maestro montado**, para crear y para editar. Montar dos
        instancias —una en el timeline, otra acá— es cómo se termina con dos
        formularios que divergen, que es la historia que este archivo ya vivió.
      */}
      <UnifiedEntryModal
        mode={masterMode}
        focus={entryFocus}
        latest={latest}
        profile={profile}
        therapyConfigured={therapyConfigured}
        catalogFoods={catalogFoods}
        onClose={() => { setMasterMode(null); }}
        onOpenTherapySettings={() => { setMasterMode(null); setSettingsOpen(true); }}
      />
      {/*
        Los accesos rápidos dedicados. Un solo componente parametrizado, sin
        lógica clínica propia: la banda de cetonas la decide `assessKetones` en
        `packages/domain` y se muestra escrita, no solo en el tono.
      */}
      <QuickNumericModal
        kind={quickNumeric ?? 'basal'}
        visible={quickNumeric !== null}
        {...(quickNumeric === 'basal' && profile.basalInsulinName !== undefined
          ? { insulinName: profile.basalInsulinName }
          : {})}
        onClose={() => { setQuickNumeric(null); }}
        onSave={quickNumeric === 'basal' ? registerBasal : registerKetones}
        onOpenFullEntry={() => {
          const focus: EntryFocus = quickNumeric === 'basal' ? 'insulin' : 'ketones';
          setQuickNumeric(null);
          openMasterCreate(focus);
        }}
      />
      {/*
        El editor de comida con IA, hospedado desde el maestro. Se conserva
        entero —foto nueva, re-análisis, instrucción libre, propuesta antes →
        después— porque es la herramienta madura: reconstruirlo como campos
        básicos sería justo la degradación que este trabajo evita.
      */}
      <MealEditModal
        meal={editingMeal}
        catalogFoods={catalogFoods}
        onClose={() => { setEditingMeal(null); }}
        onSave={saveMealEdit}
      />
      <MealModal
        visible={mealOpen}
        onClose={() => { setMealOpen(false); }}
        onConfirm={confirmMeal}
        catalogFoods={catalogFoods}
        carbRatio={profile.carbRatio}
        therapyConfigured={therapyConfigured}
        targetGlucose={profile.targetGlucose}
        correctionFactor={profile.correctionFactor}
        doseIncrement={profile.doseIncrement}
      />
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
        onSaveInsulins={async (nextProfile) => {
          // Sin `markConfigured`: elegir tu insulina NO desbloquea las
          // calculadoras de dosis. Ver la nota del prop en SettingsModal.
          await saveTherapyProfile(db, nextProfile);
          setProfile(nextProfile);
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
        selectedDay={nutritionDay}
        onSelectDay={setNutritionDay}
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
      <BottomNav
        active={activeDestination}
        onSelect={navigateTo}
        pastEntryLabel={pastEntryDay === null
          ? null
          : `${pastEntryDay.getDate()} de ${MONTH_NAMES[pastEntryDay.getMonth()] ?? ''}`}
      />
      <OnboardingModal
        visible={onboardingDone === false}
        onSaveInsulins={async (rapid, basal) => {
          // Guarda SOLO los campos de insulina sobre el perfil actual. No
          // toca objetivo/factor/incremento ni marca el perfil como
          // configurado: elegir tu insulina no es haber cargado tus
          // parámetros de terapia, y las calculadoras siguen bloqueadas.
          if (rapid.id === undefined && basal.id === undefined) return;
          // Se valida ACÁ y no solo en Ajustes. Sin esto, una duración fuera
          // de rango hacía que `TherapyProfileSchema.parse` lanzara, el error
          // se tragara en `logSaveError`, y ella siguiera adelante creyendo
          // que su insulina había quedado configurada cuando no se escribió
          // nada. Un guardado que falla en silencio es peor que uno que se
          // niega en voz alta.
          const invalid = [rapid, basal].some(
            (selection) => selection.durationHours !== undefined
              && !isPlausibleInsulinDuration(selection.durationHours),
          );
          if (invalid) {
            setNotice(`La duración de la insulina debe estar entre ${MIN_INSULIN_DURATION_HOURS} y ${MAX_INSULIN_DURATION_HOURS} horas. Puedes elegirlas después en Ajustes → Terapia.`);
            return;
          }
          try {
            const next = { ...profile, ...insulinProfileFields(rapid, basal) };
            // `saveTherapyProfile` sin `markConfigured`: guarda el dato pero
            // NO desbloquea las calculadoras de dosis.
            await saveTherapyProfile(db, next);
            setProfile(next);
          } catch (error) {
            logSaveError('App.onboardingInsulins', error);
          }
        }}
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
  hint,
  Icon,
  color,
  soft,
  onPress,
}: {
  label: string;
  /** Qué hace, en una línea. Un icono nunca comunica solo (`/iconography`). */
  hint: string;
  /**
   * Icono de Lucide, importado por subpath. Nunca un glifo Unicode.
   *
   * `ComponentType` y no una firma de función: los iconos de Lucide son
   * `ForwardRefExoticComponent`, que no encaja en un tipo de función simple.
   */
  Icon: ComponentType<{ size?: number; color?: string; strokeWidth?: number }>;
  color: string;
  soft: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.quickButton, { backgroundColor: soft }, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}. ${hint}`}
    >
      {/*
        El icono va en su propio disco blanco: sobre el fondo suave del botón
        el trazo de 2 px de Lucide pierde contraste, y el disco lo devuelve
        sin tener que engrosarlo (lo que rompería la consistencia con la barra
        inferior, que usa el mismo grosor).
      */}
      <View style={styles.quickIcon}>
        <Icon size={22} color={color} strokeWidth={2} />
      </View>
      <View>
        <Text style={[styles.quickLabel, { color }]}>{label}</Text>
        <Text style={styles.quickHint}>{hint}</Text>
      </View>
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
  quickButton: {
    width: '48%',
    minHeight: 112,
    borderRadius: radius.md,
    padding: spacing.md,
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  quickIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  quickLabel: { fontSize: 16, fontWeight: '800' },
  quickHint: { color: colors.muted, fontSize: 11, lineHeight: 15, marginTop: 2 },
  pressed: { opacity: 0.68, transform: [{ scale: 0.98 }] },
  footerSafety: { backgroundColor: colors.redSoft, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.xl },
  footerTitle: { color: colors.red, fontSize: 13, fontWeight: '900' },
  footerText: { color: colors.red, fontSize: 11, lineHeight: 17, marginTop: 3 },
});
