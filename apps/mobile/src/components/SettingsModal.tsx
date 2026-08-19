import { useEffect, useRef, useState } from 'react';
import { File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import type { CGMProviderStatus, TherapyProfile } from '@type1a/schemas';

import { API_BASE_URL, connectFreestyleLibre } from '../api';
import type { CapillaryReminderSettings, CorrectionReminderSettings, MySugrImportOutcome } from '../db';
import { capillaryReminderTimes, formatMinutesAsClock, parseMinuteOffsets, parsePositiveNumber } from '../format';
import { logSaveError } from '../log';
import { reportHtml, reportWorkbookBytes } from '../reportExport';
import { colors, radius, spacing } from '../theme';
import type { ReminderAlertStyle, ReportExport } from '../types';
import { ModalShell } from './ModalShell';

/**
 * Fase 9: preset windows for the exported report, rather than a free-form
 * date picker — the app has no date-picker dependency anywhere yet, and
 * these cover the actual use case (a recent stretch to bring to an
 * appointment) without adding one just for this.
 */
const REPORT_RANGES: { label: string; days: number | null }[] = [
  { label: '7 días', days: 7 },
  { label: '30 días', days: 30 },
  { label: '90 días', days: 90 },
  { label: 'Todo', days: null },
];

async function shareGeneratedFile(uri: string, mimeType: string): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(uri, { mimeType, dialogTitle: 'Reporte Type 1A' });
  return true;
}

const ALERT_STYLE_OPTIONS: { value: ReminderAlertStyle; label: string }[] = [
  { value: 'both', label: 'Sonido y vibración' },
  { value: 'sound', label: 'Solo sonido' },
  { value: 'vibrate', label: 'Solo vibración' },
  { value: 'silent', label: 'Silencioso' },
];

function TherapyField({
  label,
  value,
  unit,
  onChange,
}: {
  label: string;
  value: string;
  unit: string;
  onChange: (value: string) => void;
}) {
  return (
    <View style={styles.therapyField}>
      <Text style={styles.therapyFieldLabel}>{label}</Text>
      <View style={styles.therapyFieldInputWrap}>
        <TextInput
          value={value}
          onChangeText={onChange}
          keyboardType="decimal-pad"
          style={styles.therapyFieldInput}
          placeholder="—"
          placeholderTextColor={colors.muted}
          selectTextOnFocus
        />
        <Text style={styles.therapyFieldUnit}>{unit}</Text>
      </View>
    </View>
  );
}

function importSummaryText(outcome: MySugrImportOutcome): string {
  const parts = [
    outcome.cgmReadings > 0 ? `${outcome.cgmReadings} glucosas` : null,
    outcome.insulinEvents > 0 ? `${outcome.insulinEvents} insulinas` : null,
    outcome.carbEvents > 0 ? `${outcome.carbEvents} carbohidratos` : null,
    outcome.mealEvents > 0 ? `${outcome.mealEvents} comidas` : null,
    outcome.activityEvents > 0 ? `${outcome.activityEvents} actividades` : null,
    outcome.noteEvents > 0 ? `${outcome.noteEvents} notas` : null,
    outcome.vitalsEvents > 0 ? `${outcome.vitalsEvents} vitales` : null,
    outcome.hba1cResults > 0 ? `${outcome.hba1cResults} HbA1c` : null,
  ].filter((part): part is string => part !== null);
  const skipped = outcome.rowsSkipped > 0 ? ` (${outcome.rowsSkipped} filas no se pudieron leer)` : '';
  return parts.length === 0
    ? `Se leyeron ${outcome.rowsTotal} filas, pero no había nada nuevo para importar${skipped}.`
    : `Importado: ${parts.join(', ')}, de ${outcome.rowsTotal} filas${skipped}. Repetir con el mismo archivo no duplica datos.`;
}

type SettingsGroup = 'devices' | 'alarms' | 'therapy' | 'reports';

/**
 * El orden importa: "Dispositivos" primero porque es donde se llega cuando
 * algo no está sincronizando (el motivo más frecuente para abrir Ajustes), y
 * "Terapia" separado en su propia pestaña porque es la única cuyos valores
 * alimentan un cálculo de dosis — mezclarla con recordatorios y exportaciones
 * la volvía fácil de tocar de paso.
 */
const SETTINGS_GROUPS: { key: SettingsGroup; label: string }[] = [
  { key: 'devices', label: 'Dispositivos' },
  { key: 'alarms', label: 'Alarmas' },
  { key: 'therapy', label: 'Terapia' },
  { key: 'reports', label: 'Reportes' },
];

export function SettingsModal({
  visible,
  onClose,
  status,
  profile,
  therapyConfigured,
  showGlucoseOnLockScreen,
  onPrivacyChange,
  onImportMySugrCsv,
  onSaveProfile,
  onEnableQuickEntry,
  mealAlarmOffsets,
  onSaveMealAlarmOffsets,
  correctionReminder,
  onSaveCorrectionReminder,
  reminderAlertStyle,
  onSaveReminderAlertStyle,
  capillaryReminder,
  onSaveCapillaryReminder,
  onExportReport,
}: {
  visible: boolean;
  onClose: () => void;
  status: CGMProviderStatus | null;
  profile: TherapyProfile;
  /** False while `profile` still holds the placeholders shipped with the app. */
  therapyConfigured: boolean;
  showGlucoseOnLockScreen: boolean;
  onPrivacyChange: (show: boolean) => Promise<void>;
  onImportMySugrCsv: (csvText: string) => Promise<MySugrImportOutcome>;
  onSaveProfile: (profile: TherapyProfile) => Promise<void>;
  /** Requests notification permission, posts the sticky notification, and — on success — persists it as enabled and starts the background refresh. */
  onEnableQuickEntry: () => Promise<boolean>;
  mealAlarmOffsets: number[];
  onSaveMealAlarmOffsets: (offsets: number[]) => Promise<void>;
  correctionReminder: CorrectionReminderSettings;
  onSaveCorrectionReminder: (settings: CorrectionReminderSettings) => Promise<void>;
  reminderAlertStyle: ReminderAlertStyle;
  onSaveReminderAlertStyle: (style: ReminderAlertStyle) => Promise<void>;
  capillaryReminder: CapillaryReminderSettings;
  onSaveCapillaryReminder: (settings: CapillaryReminderSettings) => Promise<void>;
  /** Fase 9: reads the local history for a range and normalizes it to report rows — never generates the file itself, that stays here (UI-only concern). */
  onExportReport: (range: { from: Date; to: Date }) => Promise<ReportExport>;
}) {
  const [group, setGroup] = useState<SettingsGroup>('devices');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Until the profile has actually been configured, these fields start
  // EMPTY rather than pre-filled with the app's placeholder numbers.
  // Pre-filling them would let someone come here to set only the carb ratio
  // (which is what the entry sheet sends them here to do), tap Guardar, and
  // unknowingly record 110/45 as their clinical parameters — the app would
  // then print them back as "Objetivo 110 · factor 45" as if they'd chosen
  // them. A wrong correction factor doubles or halves every correction.
  const [targetInput, setTargetInput] = useState(therapyConfigured ? String(profile.targetGlucose) : '');
  const [factorInput, setFactorInput] = useState(therapyConfigured ? String(profile.correctionFactor) : '');
  const [incrementInput, setIncrementInput] = useState(therapyConfigured ? String(profile.doseIncrement) : '');
  const [carbRatioInput, setCarbRatioInput] = useState(profile.carbRatio === undefined ? '' : String(profile.carbRatio));
  const [therapyBusy, setTherapyBusy] = useState(false);
  const [therapyMessage, setTherapyMessage] = useState<string | null>(null);

  const [mealOffsetsInput, setMealOffsetsInput] = useState(mealAlarmOffsets.join(', '));
  const [correctionReminderEnabled, setCorrectionReminderEnabled] = useState(correctionReminder.enabled);
  const [correctionOffsetInput, setCorrectionOffsetInput] = useState(String(correctionReminder.offsetMinutes));
  const [alertStyle, setAlertStyle] = useState<ReminderAlertStyle>(reminderAlertStyle);
  const [capEnabled, setCapEnabled] = useState(capillaryReminder.enabled);
  const [capCountInput, setCapCountInput] = useState(String(capillaryReminder.count));
  const [capStartInput, setCapStartInput] = useState(capillaryReminder.wakeStart);
  const [capEndInput, setCapEndInput] = useState(capillaryReminder.wakeEnd);
  const [alarmBusy, setAlarmBusy] = useState(false);
  const [alarmMessage, setAlarmMessage] = useState<string | null>(null);

  const [reportRangeDays, setReportRangeDays] = useState<number | null>(30);
  const [reportBusy, setReportBusy] = useState(false);
  const [reportMessage, setReportMessage] = useState<string | null>(null);

  // Live preview of the reminder times for the values currently in the form,
  // so Verónica sees exactly what she'll get before saving. null while the
  // window/count is invalid — the hint below explains what to fix.
  const capillaryPreview = capillaryReminderTimes(capStartInput, capEndInput, Number(capCountInput));

  useEffect(() => {
    if (visible) setMessage(null);
  }, [visible]);

  // Same fix as CorrectionModal's earlier bug: only re-initialize these
  // fields on the true "modal just opened" transition, not on every
  // background refresh that hands us a new (but possibly unchanged)
  // `profile` object — otherwise in-progress edits or a just-saved value
  // could get silently wiped by an unrelated refresh while the modal sits
  // open.
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      setTargetInput(therapyConfigured ? String(profile.targetGlucose) : '');
      setFactorInput(therapyConfigured ? String(profile.correctionFactor) : '');
      setIncrementInput(therapyConfigured ? String(profile.doseIncrement) : '');
      setCarbRatioInput(profile.carbRatio === undefined ? '' : String(profile.carbRatio));
      setTherapyMessage(null);
      setMealOffsetsInput(mealAlarmOffsets.join(', '));
      setCorrectionReminderEnabled(correctionReminder.enabled);
      setCorrectionOffsetInput(String(correctionReminder.offsetMinutes));
      setAlertStyle(reminderAlertStyle);
      setCapEnabled(capillaryReminder.enabled);
      setCapCountInput(String(capillaryReminder.count));
      setCapStartInput(capillaryReminder.wakeStart);
      setCapEndInput(capillaryReminder.wakeEnd);
      setAlarmMessage(null);
      setReportMessage(null);
    }
    wasVisibleRef.current = visible;
  }, [visible, profile, therapyConfigured, mealAlarmOffsets, correctionReminder, reminderAlertStyle, capillaryReminder]);

  async function saveAlarms(): Promise<void> {
    const offsets = parseMinuteOffsets(mealOffsetsInput);
    if (offsets === null) {
      setAlarmMessage('Los controles post-comida deben ser minutos enteros entre 1 y 720, separados por coma.');
      return;
    }
    // While disabled, keep whatever offset was last saved rather than
    // requiring/validating a value nobody is currently using.
    let correctionOffset = correctionReminder.offsetMinutes;
    if (correctionReminderEnabled) {
      const parsed = parsePositiveNumber(correctionOffsetInput);
      if (parsed === null || !Number.isInteger(parsed) || parsed > 720) {
        setAlarmMessage('El recordatorio de corrección debe ser un número entero de minutos entre 1 y 720.');
        return;
      }
      correctionOffset = parsed;
    }
    // Only validate the capillary window when the reminder is on. Keep the
    // last-saved values otherwise, same reasoning as the correction offset.
    let capillary = capillaryReminder;
    if (capEnabled) {
      const count = Number(capCountInput);
      if (capillaryReminderTimes(capStartInput, capEndInput, count) === null) {
        setAlarmMessage('Revisa el recordatorio capilar: cantidad entre 1 y 12, y horas válidas "HH:MM" con fin después del inicio.');
        return;
      }
      capillary = { enabled: true, count, wakeStart: capStartInput, wakeEnd: capEndInput };
    } else {
      capillary = { ...capillaryReminder, enabled: false };
    }
    setAlarmBusy(true);
    setAlarmMessage(null);
    try {
      await onSaveMealAlarmOffsets(offsets);
      await onSaveCorrectionReminder({ enabled: correctionReminderEnabled, offsetMinutes: correctionOffset });
      await onSaveReminderAlertStyle(alertStyle);
      await onSaveCapillaryReminder(capillary);
      setAlarmMessage('Alarmas guardadas.');
    } catch (error) {
      logSaveError('SettingsModal.saveAlarms', error);
      setAlarmMessage('No se pudieron guardar las alarmas.');
    } finally {
      setAlarmBusy(false);
    }
  }

  async function saveTherapy(): Promise<void> {
    const targetGlucose = parsePositiveNumber(targetInput);
    const correctionFactor = parsePositiveNumber(factorInput);
    const doseIncrement = parsePositiveNumber(incrementInput);
    const carbRatio = carbRatioInput.trim() === '' ? undefined : parsePositiveNumber(carbRatioInput);
    if (
      targetGlucose === null || correctionFactor === null || doseIncrement === null
      || doseIncrement > 1 || (carbRatioInput.trim() !== '' && carbRatio === null)
    ) {
      setTherapyMessage('Revisa objetivo, factor e incremento (máximo 1 U). Carbs por unidad es opcional, pero si lo llenas debe ser un número positivo.');
      return;
    }
    setTherapyBusy(true);
    setTherapyMessage(null);
    try {
      // carbRatio is explicitly `number | undefined` here (never `null` —
      // that case already returned above), so this correctly clears a
      // previously-set value when the field is emptied, not just "leaves
      // the old value alone".
      await onSaveProfile({ ...profile, targetGlucose, correctionFactor, doseIncrement, carbRatio: carbRatio ?? undefined });
      setTherapyMessage('Parámetros guardados.');
    } catch (error) {
      logSaveError('SettingsModal.saveTherapy', error);
      setTherapyMessage('No se pudieron guardar los parámetros.');
    } finally {
      setTherapyBusy(false);
    }
  }

  async function link(): Promise<void> {
    if (!/^\S+@\S+\.\S+$/u.test(email.trim())) {
      setMessage('Escribe el email asociado a LibreView.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const state = await connectFreestyleLibre(email.trim());
      setMessage(`Junction respondió: ${state}. Revisa LibreView → Aplicaciones conectadas → LibreView para compartir con la práctica indicada.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo iniciar la conexión.');
    } finally {
      setBusy(false);
    }
  }

  async function importCsv(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const picked = await File.pickFileAsync({ mimeTypes: ['text/csv', 'text/comma-separated-values', 'text/plain', '*/*'] });
      if (picked.canceled) return;
      const csvText = await picked.result.text();
      const outcome = await onImportMySugrCsv(csvText);
      setMessage(importSummaryText(outcome));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo importar el archivo.');
    } finally {
      setBusy(false);
    }
  }

  async function notifications(): Promise<void> {
    setBusy(true);
    try {
      const enabled = await onEnableQuickEntry();
      setMessage(enabled
        ? 'Acceso rápido activado. Se refresca solo cada ~15 min si Android lo permite, o toca "Actualizar" en la notificación para forzarlo; basal queda al tocar la app.'
        : 'No se otorgó permiso de notificaciones.');
    } finally {
      setBusy(false);
    }
  }

  function reportRangeWindow(): { from: Date; to: Date; label: string } {
    const to = new Date();
    const option = REPORT_RANGES.find((candidate) => candidate.days === reportRangeDays) ?? REPORT_RANGES[1]!;
    // "Todo": no floor date exists anywhere in the app's data model, so this
    // just needs to predate anything a real user could have logged or
    // imported — not a semantic epoch.
    const from = option.days === null ? new Date('2015-01-01T00:00:00.000Z') : new Date(to.getTime() - option.days * 24 * 60 * 60_000);
    return { from, to, label: option.label === 'Todo' ? 'Todo el historial' : `Últimos ${option.label}` };
  }

  async function exportReportPdf(): Promise<void> {
    setReportBusy(true);
    setReportMessage(null);
    try {
      const { from, to, label } = reportRangeWindow();
      const data = await onExportReport({ from, to });
      if (data.rows.length === 0) {
        setReportMessage('No hay datos guardados en ese rango.');
        return;
      }
      const { uri } = await Print.printToFileAsync({ html: reportHtml(data, label) });
      const shared = await shareGeneratedFile(uri, 'application/pdf');
      setReportMessage(shared ? null : 'PDF generado, pero este dispositivo no puede compartir archivos.');
    } catch (error) {
      logSaveError('SettingsModal.exportReportPdf', error);
      setReportMessage('No se pudo generar el PDF. Inténtalo otra vez.');
    } finally {
      setReportBusy(false);
    }
  }

  async function exportReportXlsx(): Promise<void> {
    setReportBusy(true);
    setReportMessage(null);
    try {
      const { from, to } = reportRangeWindow();
      const data = await onExportReport({ from, to });
      if (data.rows.length === 0) {
        setReportMessage('No hay datos guardados en ese rango.');
        return;
      }
      const file = new File(Paths.cache, `type1a-reporte-${Date.now()}.xlsx`);
      if (file.exists) file.delete();
      file.create();
      file.write(reportWorkbookBytes(data));
      const shared = await shareGeneratedFile(
        file.uri,
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      setReportMessage(shared ? null : 'Excel generado, pero este dispositivo no puede compartir archivos.');
    } catch (error) {
      logSaveError('SettingsModal.exportReportXlsx', error);
      setReportMessage('No se pudo generar el Excel. Inténtalo otra vez.');
    } finally {
      setReportBusy(false);
    }
  }

  return (
    <ModalShell visible={visible} title="Ajustes" onClose={onClose} scroll={false}>
      {/*
        Antes era una sola lista plana de ocho secciones en un modal de ~660
        líneas, con un título ("Conexiones y privacidad") que ya no describía
        la mitad de lo que contenía. Agrupado en cuatro pestañas por pedido
        de Verónica (Fase 13, ítem 12) usando el mismo patrón de `SummaryModal`
        — la app no tiene librería de navegación y no se agrega una para esto.
      */}
      <View style={styles.tabBar}>
        {SETTINGS_GROUPS.map((entry) => {
          const active = entry.key === group;
          return (
            <Pressable
              key={entry.key}
              style={[styles.tab, active && styles.tabActive]}
              onPress={() => { setGroup(entry.key); }}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{entry.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <ScrollView contentContainerStyle={styles.groupBody} keyboardShouldPersistTaps="handled">
        {group === 'devices' ? (
          <>
          <Text style={styles.sectionTitle}>Estado CGM</Text>
          <View style={styles.statusCard}>
            <View style={styles.statusRow}>
              <View style={[styles.statusDot, { backgroundColor: status?.state === 'connected' ? colors.green : colors.warning }]} />
              <Text style={styles.statusName}>{status?.provider ?? 'Sin proveedor'}</Text>
            </View>
            <Text style={styles.statusDetail}>{status?.detail ?? 'Abre el backend para sincronizar o usa el modo local.'}</Text>
            {status?.isSynthetic === true ? <Text style={styles.synthetic}>Los datos actuales son sintéticos y están marcados en toda la app.</Text> : null}
          </View>

          <Text style={styles.sectionTitle}>Conectar FreeStyle</Text>
          <Text style={styles.copy}>Ruta elegida para el MVP: LibreView mediante una práctica autorizada en Junction EU. Chile usa la región EU.</Text>
          <TextInput
            style={styles.input}
            value={email}
            onChangeText={setEmail}
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Email de LibreView"
            placeholderTextColor={colors.muted}
          />
          <Pressable style={[styles.connectButton, busy && styles.disabled]} disabled={busy} onPress={() => { void link(); }}>
            <Text style={styles.connectText}>Iniciar conexión LibreView</Text>
          </Pressable>
          <View style={styles.optionsBox}>
            <Text style={styles.option}><Text style={styles.optionStrong}>LibreView:</Text> ruta principal; permite compartir con la práctica.</Text>
            <Text style={styles.option}><Text style={styles.optionStrong}>LibreLinkUp:</Text> útil para familiares, pero sin API pública general; no se usa ocultamente.</Text>
            <Text style={styles.option}><Text style={styles.optionStrong}>Libre Data Share:</Text> acceso temporal clínico; no sirve como sincronización continua.</Text>
          </View>

          <Text style={styles.sectionTitle}>Importar historial</Text>
          <Text style={styles.copy}>Carga un CSV exportado desde MySugr (glucosa, insulina, carbohidratos, comidas, actividad, vitales, HbA1c). Se guarda como historial local; importar el mismo archivo dos veces no duplica datos.</Text>
          <Pressable style={[styles.connectButton, busy && styles.disabled]} disabled={busy} onPress={() => { void importCsv(); }}>
            <Text style={styles.connectText}>Elegir archivo CSV de MySugr</Text>
          </Pressable>

          </>
        ) : null}

        {group === 'alarms' ? (
          <>
          <Text style={styles.sectionTitle}>Alarmas</Text>
          <Text style={styles.copy}>Controles post-comida, en minutos separados por coma. El último se usa para avisar que el episodio está listo para revisar.</Text>
          <TextInput
            style={styles.input}
            value={mealOffsetsInput}
            onChangeText={setMealOffsetsInput}
            keyboardType="numbers-and-punctuation"
            placeholder="60, 120, 180"
            placeholderTextColor={colors.muted}
          />
          <View style={styles.switchRow}>
            <View style={styles.switchCopy}>
              <Text style={styles.switchTitle}>Recordatorio tras una corrección</Text>
              <Text style={styles.switchFoot}>Solo te avisa que revises tu glucosa — no calcula ni sugiere una nueva dosis.</Text>
            </View>
            <Switch
              value={correctionReminderEnabled}
              onValueChange={setCorrectionReminderEnabled}
              trackColor={{ false: colors.line, true: colors.teal }}
            />
          </View>
          {correctionReminderEnabled ? (
            <TextInput
              style={styles.input}
              value={correctionOffsetInput}
              onChangeText={setCorrectionOffsetInput}
              keyboardType="number-pad"
              placeholder="60"
              placeholderTextColor={colors.muted}
            />
          ) : null}

          <Text style={styles.subheading}>Sonido y vibración</Text>
          <Text style={styles.copy}>Cómo te avisan los recordatorios (post-comida, corrección y capilar). La notificación de glucosa fija sigue siendo silenciosa.</Text>
          <View style={styles.styleGrid}>
            {ALERT_STYLE_OPTIONS.map((option) => (
              <Pressable
                key={option.value}
                style={[styles.styleChip, alertStyle === option.value && styles.styleChipActive]}
                onPress={() => { setAlertStyle(option.value); }}
              >
                <Text style={[styles.styleChipText, alertStyle === option.value && styles.styleChipTextActive]}>{option.label}</Text>
              </Pressable>
            ))}
          </View>

          <View style={styles.switchRow}>
            <View style={styles.switchCopy}>
              <Text style={styles.switchTitle}>Recordar mediciones capilares</Text>
              <Text style={styles.switchFoot}>Reparte X avisos por día dentro de tu horario despierto para que te pinches el dedo.</Text>
            </View>
            <Switch
              value={capEnabled}
              onValueChange={setCapEnabled}
              trackColor={{ false: colors.line, true: colors.teal }}
            />
          </View>
          {capEnabled ? (
            <>
              <View style={styles.row}>
                <View style={styles.therapyField}>
                  <Text style={styles.therapyFieldLabel}>Veces al día</Text>
                  <View style={styles.therapyFieldInputWrap}>
                    <TextInput
                      value={capCountInput}
                      onChangeText={setCapCountInput}
                      keyboardType="number-pad"
                      style={styles.therapyFieldInput}
                      placeholder="4"
                      placeholderTextColor={colors.muted}
                      selectTextOnFocus
                    />
                  </View>
                </View>
                <View style={styles.therapyField}>
                  <Text style={styles.therapyFieldLabel}>Despierto desde</Text>
                  <View style={styles.therapyFieldInputWrap}>
                    <TextInput
                      value={capStartInput}
                      onChangeText={setCapStartInput}
                      keyboardType="numbers-and-punctuation"
                      style={styles.therapyFieldInput}
                      placeholder="08:00"
                      placeholderTextColor={colors.muted}
                    />
                  </View>
                </View>
                <View style={styles.therapyField}>
                  <Text style={styles.therapyFieldLabel}>Hasta</Text>
                  <View style={styles.therapyFieldInputWrap}>
                    <TextInput
                      value={capEndInput}
                      onChangeText={setCapEndInput}
                      keyboardType="numbers-and-punctuation"
                      style={styles.therapyFieldInput}
                      placeholder="22:00"
                      placeholderTextColor={colors.muted}
                    />
                  </View>
                </View>
              </View>
              <Text style={styles.hint}>
                {capillaryPreview === null
                  ? 'Ingresa una cantidad entre 1 y 12 y horas válidas "HH:MM", con el fin después del inicio.'
                  : `Te avisará a las ${capillaryPreview.map((time) => formatMinutesAsClock(time.hour * 60 + time.minute)).join(', ')}.`}
              </Text>
            </>
          ) : null}

          <Pressable style={[styles.connectButton, alarmBusy && styles.disabled]} disabled={alarmBusy} onPress={() => { void saveAlarms(); }}>
            <Text style={styles.connectText}>Guardar alarmas</Text>
          </Pressable>
          {alarmMessage === null ? null : <Text style={styles.message}>{alarmMessage}</Text>}

          <Text style={styles.sectionTitle}>Pantalla bloqueada</Text>
          <View style={styles.switchRow}>
            <View style={styles.switchCopy}>
              <Text style={styles.switchTitle}>Mostrar glucosa en la notificación</Text>
              <Text style={styles.switchFoot}>Desactivado oculta el valor, pero mantiene los accesos rápidos.</Text>
            </View>
            <Switch
              value={showGlucoseOnLockScreen}
              onValueChange={(value) => { void onPrivacyChange(value); }}
              trackColor={{ false: colors.line, true: colors.teal }}
            />
          </View>
          <Pressable style={[styles.notificationButton, busy && styles.disabled]} disabled={busy} onPress={() => { void notifications(); }}>
            <Text style={styles.notificationText}>Activar notificación de acceso rápido</Text>
          </Pressable>

          </>
        ) : null}

        {group === 'therapy' ? (
          <>
          <Text style={styles.sectionTitle}>Parámetros de terapia</Text>
          <Text style={styles.copy}>Estos valores los define tu equipo clínico — Type 1A nunca los calcula ni los sugiere. También puedes editar objetivo/factor/incremento dentro de “Corrección”; es el mismo valor guardado en ambos lados.</Text>
          {therapyConfigured ? null : (
            <View style={styles.unconfiguredBox}>
              <Text style={styles.unconfiguredText}>
                Todavía no has confirmado tus parámetros. Los campos están vacíos a propósito: la app no propone valores de terapia.
                Las calculadoras de dosis quedan bloqueadas hasta que completes objetivo, factor e incremento con lo que te indicó tu equipo clínico.
              </Text>
            </View>
          )}
          <View style={styles.row}>
            <TherapyField label="Objetivo" unit="mg/dL" value={targetInput} onChange={setTargetInput} />
            <TherapyField label="Factor corrección" unit="mg/dL/U" value={factorInput} onChange={setFactorInput} />
          </View>
          <View style={styles.row}>
            <TherapyField label="Incremento pluma" unit="U" value={incrementInput} onChange={setIncrementInput} />
            <TherapyField label="Carbs por unidad" unit="g/U" value={carbRatioInput} onChange={setCarbRatioInput} />
          </View>
          <Text style={styles.hint}>"Carbs por unidad" es opcional — déjalo vacío si aún no lo tienes definido con tu equipo clínico. Se usa para el registro combinado de comida + corrección.</Text>
          <Pressable style={[styles.connectButton, therapyBusy && styles.disabled]} disabled={therapyBusy} onPress={() => { void saveTherapy(); }}>
            <Text style={styles.connectText}>Guardar parámetros de terapia</Text>
          </Pressable>
          {therapyMessage === null ? null : <Text style={styles.message}>{therapyMessage}</Text>}

          </>
        ) : null}

        {group === 'reports' ? (
          <>
          <Text style={styles.sectionTitle}>Reportes</Text>
          <Text style={styles.copy}>Exporta el historial guardado (glucosa, insulina, carbohidratos, comidas, actividad, notas, vitales, HbA1c) a un archivo para llevar a un control médico. Se genera en el dispositivo — nada se sube a ningún servidor.</Text>
          <View style={styles.styleGrid}>
            {REPORT_RANGES.map((range) => (
              <Pressable
                key={range.label}
                style={[styles.styleChip, reportRangeDays === range.days && styles.styleChipActive]}
                onPress={() => { setReportRangeDays(range.days); }}
              >
                <Text style={[styles.styleChipText, reportRangeDays === range.days && styles.styleChipTextActive]}>{range.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.reportButtonRow}>
            <Pressable
              style={[styles.reportButton, reportBusy && styles.disabled]}
              disabled={reportBusy}
              onPress={() => { void exportReportPdf(); }}
            >
              <Text style={styles.connectText}>{reportBusy ? 'Generando…' : 'Exportar PDF'}</Text>
            </Pressable>
            <Pressable
              style={[styles.reportButton, styles.reportButtonOutline, reportBusy && styles.disabled]}
              disabled={reportBusy}
              onPress={() => { void exportReportXlsx(); }}
            >
              <Text style={styles.reportButtonOutlineText}>{reportBusy ? 'Generando…' : 'Exportar Excel'}</Text>
            </Pressable>
          </View>
          {reportMessage === null ? null : <Text style={styles.message}>{reportMessage}</Text>}

          <Text style={styles.sectionTitle}>Diagnóstico</Text>
          <Text style={styles.diagnostic}>Backend: {API_BASE_URL}</Text>
          <Text style={styles.diagnostic}>Type 1A 0.1.0 · almacenamiento local-first</Text>

          </>
        ) : null}

        {/*
          `message` es el resultado de conectar LibreView o de importar el CSV
          — ambas acciones viven en "Dispositivos". Sin acotarlo, un resumen de
          importación aparecía al pie de la pestaña de Reportes.
        */}
        {group === 'devices' && message !== null ? <Text style={styles.message}>{message}</Text> : null}
      </ScrollView>
    </ModalShell>
  );
}

const styles = StyleSheet.create({
  // Mismos tokens y medidas que la barra de pestañas de `SummaryModal`: las
  // dos pantallas con sub-páginas de la app tienen que leerse igual.
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.line,
    borderRadius: radius.sm,
    padding: 3,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.sm, minHeight: 44, borderRadius: radius.sm - 3 },
  tabActive: { backgroundColor: colors.surface },
  tabLabel: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  tabLabelActive: { color: colors.ink },
  groupBody: { padding: spacing.lg, paddingBottom: 44 },
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: '800', marginTop: spacing.xl },
  subheading: { color: colors.ink, fontSize: 14, fontWeight: '800', marginTop: spacing.lg },
  styleGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  styleChip: { borderColor: colors.line, borderWidth: 1, borderRadius: radius.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, minHeight: 40, justifyContent: 'center' },
  styleChipActive: { backgroundColor: colors.teal, borderColor: colors.teal },
  styleChipText: { color: colors.navy, fontSize: 13, fontWeight: '700' },
  styleChipTextActive: { color: '#FFFFFF' },
  statusCard: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm },
  statusRow: { flexDirection: 'row', alignItems: 'center' },
  statusDot: { width: 10, height: 10, borderRadius: 5, marginRight: spacing.sm },
  statusName: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  statusDetail: { color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: spacing.sm },
  synthetic: { color: colors.warning, fontSize: 12, fontWeight: '700', marginTop: spacing.sm },
  copy: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: spacing.sm },
  input: { backgroundColor: colors.surface, borderRadius: radius.sm, borderColor: colors.line, borderWidth: 1, color: colors.ink, fontSize: 15, padding: spacing.md, marginTop: spacing.md },
  connectButton: { backgroundColor: colors.teal, borderRadius: radius.sm, padding: spacing.md, alignItems: 'center', marginTop: spacing.sm },
  connectText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  optionsBox: { backgroundColor: colors.tealSoft, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md },
  option: { color: colors.navy, fontSize: 12, lineHeight: 18, marginBottom: 5 },
  optionStrong: { fontWeight: '900' },
  switchRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm },
  switchCopy: { flex: 1, paddingRight: spacing.md },
  switchTitle: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  switchFoot: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 3 },
  notificationButton: { borderColor: colors.teal, borderWidth: 1, borderRadius: radius.sm, padding: spacing.md, alignItems: 'center', marginTop: spacing.sm },
  notificationText: { color: colors.teal, fontSize: 14, fontWeight: '800' },
  diagnostic: { color: colors.muted, fontSize: 12, marginTop: 5 },
  message: { color: colors.warning, backgroundColor: colors.warningSoft, borderRadius: radius.sm, padding: spacing.md, fontSize: 13, lineHeight: 19, marginTop: spacing.xl },
  disabled: { opacity: 0.55 },
  row: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  therapyField: { flex: 1 },
  therapyFieldLabel: { color: colors.muted, fontSize: 12, fontWeight: '700', marginBottom: 4 },
  therapyFieldInputWrap: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderRadius: radius.sm, borderColor: colors.line, borderWidth: 1, paddingHorizontal: spacing.md },
  therapyFieldInput: { flex: 1, color: colors.ink, fontSize: 15, paddingVertical: spacing.md },
  therapyFieldUnit: { color: colors.muted, fontSize: 12 },
  hint: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: spacing.sm },
  unconfiguredBox: { backgroundColor: colors.warningSoft, borderRadius: radius.sm, padding: spacing.md, marginTop: spacing.sm },
  unconfiguredText: { color: colors.warning, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  reportButtonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  reportButton: { flex: 1, backgroundColor: colors.teal, borderRadius: radius.sm, padding: spacing.md, alignItems: 'center', minHeight: 44, justifyContent: 'center' },
  reportButtonOutline: { backgroundColor: 'transparent', borderColor: colors.teal, borderWidth: 1 },
  reportButtonOutlineText: { color: colors.teal, fontSize: 14, fontWeight: '800' },
});
