import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import type { CGMProviderStatus, CGMReading, TherapyProfile } from '@type1a/schemas';

import { API_BASE_URL, connectFreestyleLibre } from '../api';
import { enableQuickEntryNotification } from '../notifications';
import { colors, radius, spacing } from '../theme';
import { ModalShell } from './ModalShell';

export function SettingsModal({
  visible,
  onClose,
  status,
  latest,
  profile,
  showGlucoseOnLockScreen,
  onPrivacyChange,
}: {
  visible: boolean;
  onClose: () => void;
  status: CGMProviderStatus | null;
  latest: CGMReading | null;
  profile: TherapyProfile;
  showGlucoseOnLockScreen: boolean;
  onPrivacyChange: (show: boolean) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (visible) setMessage(null);
  }, [visible]);

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

  async function notifications(): Promise<void> {
    setBusy(true);
    try {
      const enabled = await enableQuickEntryNotification(latest, showGlucoseOnLockScreen);
      setMessage(enabled
        ? 'Acceso rápido activado. Android muestra hasta tres acciones; basal queda al tocar la app.'
        : 'No se otorgó permiso de notificaciones.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell visible={visible} title="Conexiones y privacidad" onClose={onClose}>
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

      <Text style={styles.sectionTitle}>Parámetros de corrección</Text>
      <Text style={styles.copy}>Objetivo {profile.targetGlucose} mg/dL · Factor {profile.correctionFactor} mg/dL/U · Incremento {profile.doseIncrement} U. Se editan dentro de “Corrección”.</Text>

      <Text style={styles.sectionTitle}>Diagnóstico</Text>
      <Text style={styles.diagnostic}>Backend: {API_BASE_URL}</Text>
      <Text style={styles.diagnostic}>Type 1A 0.1.0 · almacenamiento local-first</Text>

      {message === null ? null : <Text style={styles.message}>{message}</Text>}
    </ModalShell>
  );
}

const styles = StyleSheet.create({
  sectionTitle: { color: colors.ink, fontSize: 18, fontWeight: '800', marginTop: spacing.xl },
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
});
