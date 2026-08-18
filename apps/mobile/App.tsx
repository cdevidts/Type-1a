import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as Crypto from 'expo-crypto';
import * as Linking from 'expo-linking';
import * as Notifications from 'expo-notifications';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { StatusBar } from 'expo-status-bar';
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

import { latestLiveReading } from '@type1a/domain';
import type {
  CGMProviderStatus,
  CGMReading,
  InsulinEvent,
  MealEvent,
  TherapyProfile,
} from '@type1a/schemas';

import { fetchCGMReadings, fetchCGMStatus } from './src/api';
import { CorrectionModal } from './src/components/CorrectionModal';
import { EntryModal, type UnifiedEntryDraft } from './src/components/EntryModal';
import { GlucoseCard } from './src/components/GlucoseCard';
import { InsulinAssociationModal } from './src/components/InsulinAssociationModal';
import { MealModal, type ConfirmedMealDraft } from './src/components/MealModal';
import { NumericEntryModal } from './src/components/NumericEntryModal';
import { SettingsModal } from './src/components/SettingsModal';
import { Timeline } from './src/components/Timeline';
import {
  getCGMReadings,
  confirmEpisodeInsulinContext,
  getPendingInsulinAssociations,
  getRecentRapidInsulin,
  getSetting,
  getTherapyProfile,
  getTimeline,
  importMySugrCsv,
  initializeDatabase,
  isTherapyConfigured,
  saveCarbEvent,
  saveInsulinEvent,
  saveMealWithEpisode,
  saveTherapyProfile,
  saveUnifiedEntry,
  setSetting,
  upsertCGMReadings,
} from './src/db';
import { processReadyEpisodes } from './src/episodes';
import {
  configureNotifications,
  quickRouteFromNotificationAction,
  scheduleEpisodeNotifications,
} from './src/notifications';
import { colors, radius, spacing } from './src/theme';
import type { PendingInsulinAssociation, QuickRoute, TimelineItem } from './src/types';

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
  const [recentRapid, setRecentRapid] = useState<InsulinEvent[]>([]);
  const [pendingAssociations, setPendingAssociations] = useState<PendingInsulinAssociation[]>([]);
  const [quickRoute, setQuickRoute] = useState<QuickRoute | null>(null);
  const [mealOpen, setMealOpen] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showGlucoseOnLockScreen, setShowGlucoseOnLockScreen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const refreshingRef = useRef(false);

  const latest = latestLiveReading(readings);

  const loadLocalState = useCallback(async (): Promise<void> => {
    const to = new Date();
    // 30 days, not 3 hours: the chart is now a scrollable multi-day trend
    // (swipe back to see older/imported history), not just "right now".
    // The live/current badge and correction auto-fill are unaffected —
    // latestLiveReading() finds the true latest live point regardless of
    // how wide this window is.
    const from = new Date(to.getTime() - 30 * 24 * 60 * 60_000);
    const [cached, nextTimeline, nextProfile, configured, rapid, privacy, pending] = await Promise.all([
      getCGMReadings(db, from, to),
      getTimeline(db),
      getTherapyProfile(db),
      isTherapyConfigured(db),
      getRecentRapidInsulin(db),
      getSetting(db, 'showGlucoseOnLockScreen'),
      getPendingInsulinAssociations(db),
    ]);
    setReadings(cached);
    setTimeline(nextTimeline);
    setProfile(nextProfile);
    setTherapyConfigured(configured);
    setRecentRapid(rapid);
    setShowGlucoseOnLockScreen(privacy === 'true');
    setPendingAssociations(pending);
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
      try {
        const [nextStatus, remoteReadings] = await Promise.all([
          fetchCGMStatus(),
          fetchCGMReadings(from, to),
        ]);
        await upsertCGMReadings(db, remoteReadings);
        setStatus(nextStatus);
        setNotice(nextStatus.isSynthetic
          ? 'Modo de prueba: las lecturas CGM son sintéticas.'
          : null);
      } catch (error) {
        setStatus({
          state: 'offline',
          provider: 'backend',
          detail: error instanceof Error ? error.message : 'Sin conexión al backend.',
          checkedAt: new Date().toISOString(),
          isSynthetic: false,
        });
        setNotice('Backend sin conexión. El registro local sigue funcionando.');
      }
      await processReadyEpisodes(db);
      await loadLocalState();
    } finally {
      refreshingRef.current = false;
      setRefreshing(false);
    }
  }, [db, loadLocalState]);

  useEffect(() => {
    void configureNotifications();
    void refresh();
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') void refresh();
    });
    return () => { appStateSubscription.remove(); };
  }, [refresh]);

  useEffect(() => {
    function handleUrl(url: string): void {
      const nextRoute = routeFromUrl(url);
      if (nextRoute !== null) setQuickRoute(nextRoute);
    }
    void Linking.getInitialURL().then((url) => { if (url !== null) handleUrl(url); });
    const urlSubscription = Linking.addEventListener('url', ({ url }) => { handleUrl(url); });
    const notificationSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
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
    await registerNumeric('rapid', units);
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
      ...(draft.analysis === undefined
        ? {}
        : {
            aiEstimatedCarbsG: draft.analysis.totals.carbsG,
            proteinG: draft.analysis.totals.proteinG,
            fatG: draft.analysis.totals.fatG,
            fiberG: draft.analysis.totals.fiberG,
            caloriesKcal: draft.analysis.totals.caloriesKcal,
            aiAnalysisId: draft.analysis.analysisId,
          }),
    };
    const episodeId = await saveMealWithEpisode(db, meal);
    await scheduleEpisodeNotifications(episodeId, timestamp);
    setNotice('Comida guardada. El episodio se completará con CGM a +60, +120 y +180 minutos.');
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
            proteinG: draft.analysis.totals.proteinG,
            fatG: draft.analysis.totals.fatG,
            fiberG: draft.analysis.totals.fiberG,
            caloriesKcal: draft.analysis.totals.caloriesKcal,
            aiAnalysisId: draft.analysis.analysisId,
          }),
    });
    if (outcome.episodeId !== null) {
      await scheduleEpisodeNotifications(outcome.episodeId, draft.timestamp);
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

  async function updatePrivacy(show: boolean): Promise<void> {
    await setSetting(db, 'showGlucoseOnLockScreen', String(show));
    setShowGlucoseOnLockScreen(show);
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

  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <StatusBar style="dark" />
      <ScrollView
        contentContainerStyle={styles.screen}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void refresh(true); }} tintColor={colors.teal} />}
      >
        <View style={styles.topBar}>
          <View>
            <Text style={styles.brand}>Type 1A</Text>
            <Text style={styles.mode}>{sourceLabel}</Text>
          </View>
          <Pressable style={styles.settingsButton} onPress={() => { setSettingsOpen(true); }} accessibilityLabel="Conexiones y privacidad">
            <Text style={styles.settingsGlyph}>•••</Text>
          </Pressable>
        </View>

        {notice === null ? null : (
          <View style={[styles.notice, status?.isSynthetic === true ? styles.noticeWarning : styles.noticeInfo]}>
            <Text style={styles.noticeText}>{notice}</Text>
          </View>
        )}

        <GlucoseCard readings={readings} status={status} />

        <Pressable style={({ pressed }) => [styles.entryButton, pressed && styles.pressed]} onPress={() => { setEntryOpen(true); }} accessibilityRole="button">
          <Text style={styles.entryPlus}>+</Text>
          <View style={styles.entryCopy}>
            <Text style={styles.entryTitle}>Nueva entrada</Text>
            <Text style={styles.entrySubtitle}>Glucosa, comida, carbohidratos e insulina en un solo registro</Text>
          </View>
        </Pressable>

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
        </View>

        <Pressable style={styles.mealButton} onPress={() => { setMealOpen(true); }}>
          <View style={styles.mealIcon}><Text style={styles.mealIconText}>◎</Text></View>
          <View style={styles.mealButtonCopy}>
            <Text style={styles.mealTitle}>Foto o registro manual de comida</Text>
            <Text style={styles.mealSubtitle}>IA opcional · carbohidratos siempre confirmados por ti</Text>
          </View>
          <Text style={styles.chevron}>›</Text>
        </Pressable>

        <Timeline items={timeline} />

        <View style={styles.footerSafety}>
          <Text style={styles.footerTitle}>Software de desarrollo</Text>
          <Text style={styles.footerText}>No sustituye las alarmas de FreeStyle, una medición capilar cuando corresponda ni las indicaciones de tu equipo clínico.</Text>
        </View>
      </ScrollView>

      <NumericEntryModal
        route={numericRoute}
        onClose={() => { setQuickRoute(null); }}
        onSubmit={registerNumeric}
      />
      <CorrectionModal
        visible={quickRoute === 'correction'}
        latest={latest}
        profile={profile}
        recentRapid={recentRapid}
        onClose={() => { setQuickRoute(null); }}
        onSaveProfile={async (nextProfile) => {
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
      <MealModal visible={mealOpen} onClose={() => { setMealOpen(false); }} onConfirm={confirmMeal} />
      <SettingsModal
        visible={settingsOpen}
        onClose={() => { setSettingsOpen(false); }}
        status={status}
        latest={latest}
        profile={profile}
        showGlucoseOnLockScreen={showGlucoseOnLockScreen}
        onPrivacyChange={updatePrivacy}
        onImportMySugrCsv={async (csvText) => {
          const outcome = await importMySugrCsv(db, csvText);
          await loadLocalState();
          return outcome;
        }}
        onSaveProfile={async (nextProfile) => {
          await saveTherapyProfile(db, nextProfile);
          setProfile(nextProfile);
        }}
      />
      <InsulinAssociationModal
        pending={pendingAssociations[0] ?? null}
        onConfirm={confirmInsulinAssociation}
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
  screen: { padding: spacing.lg, paddingBottom: 60 },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: spacing.lg },
  brand: { color: colors.ink, fontSize: 30, fontWeight: '900', letterSpacing: -1 },
  mode: { color: colors.teal, fontSize: 10, fontWeight: '900', letterSpacing: 1.2, marginTop: 2 },
  settingsButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  settingsGlyph: { color: colors.navy, fontSize: 20, fontWeight: '900', letterSpacing: 2, marginTop: -8 },
  notice: { borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.md },
  noticeWarning: { backgroundColor: colors.warningSoft },
  noticeInfo: { backgroundColor: colors.tealSoft },
  noticeText: { color: colors.navy, fontSize: 12, lineHeight: 17, fontWeight: '600' },
  entryButton: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.teal, borderRadius: radius.md, padding: spacing.lg, marginTop: spacing.xl },
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
