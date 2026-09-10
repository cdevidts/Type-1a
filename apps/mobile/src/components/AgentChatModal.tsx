import { useCallback, useMemo, useRef, useState } from 'react';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { hasPrefill, parseLocalIntent, toPrefill, type EntryPrefill } from '@type1a/domain';
import type { AgentTurn, GlucoseUnit } from '@type1a/schemas';
import Camera from 'lucide-react-native/icons/camera';
import SendHorizontal from 'lucide-react-native/icons/send-horizontal';
import Sparkles from 'lucide-react-native/icons/sparkles';

import { persistPhoto } from '../photos';
import { colors, radius, spacing } from '../theme';
import { ModalShell } from './ModalShell';

/**
 * El chat del asistente.
 *
 * ## Lo que esta pantalla promete, y por qué
 *
 * **Nada se guarda sin que ella lo vea.** Un turno que propone registrar algo
 * llega como una tarjeta con los campos a la vista y dos botones; hasta que
 * toque "Guardar", la app no escribió nada. Un "¿lo aplico?" sin mostrar qué
 * cambia no es una confirmación informada.
 *
 * **El pre-llenado es instantáneo y no espera al modelo.** `local-intent.ts`
 * lee la frase en el teléfono, así que "me puse 6 de rápida" ya deja las 6 U
 * puestas antes de que salga una sola petición. Si además hay algo que el
 * parser no entendió, ESO va al modelo — y la tarjeta ya estaba en pantalla.
 *
 * **La insulina nunca la propone el modelo.** El borrador que vuelve del
 * servidor no tiene dónde poner unidades (ADR 0008); las que se ven acá o las
 * dictó ella, o las calculó el dominio con sus parámetros.
 */

export interface AgentChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  /** El borrador que acompaña a un turno, cuando lo hay. */
  prefill?: EntryPrefill;
  /** Lo que el turno citó, para que ella pueda comprobarlo. */
  cites?: readonly string[];
  /** `true` mientras la tarjeta sigue sin resolverse. */
  pending?: boolean;
}

export function AgentChatModal({
  visible,
  onClose,
  glucoseUnit,
  onAsk,
  onConfirmDraft,
  onOpenMaster,
}: {
  visible: boolean;
  onClose: () => void;
  /** La unidad que ella configuró. Decide cómo se lee un número suelto. */
  glucoseUnit: GlucoseUnit;
  /** Manda la pregunta al backend. Devuelve el turno ya validado. */
  onAsk: (message: string, imageBase64?: string) => Promise<AgentTurn>;
  /** Escribe lo confirmado. La pantalla nunca escribe por su cuenta. */
  onConfirmDraft: (prefill: EntryPrefill) => Promise<void>;
  /** Abre el Modal Maestro con lo entendido, para completar a mano. */
  onOpenMaster: (prefill: EntryPrefill) => void;
}): React.JSX.Element {
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const nextId = useRef(0);

  const newId = useCallback((): string => {
    nextId.current += 1;
    return `m${nextId.current}`;
  }, []);

  const push = useCallback((message: AgentChatMessage): void => {
    setMessages((current) => [...current, message]);
    // El scroll va después del render, o cae en la altura vieja.
    setTimeout(() => { scrollRef.current?.scrollToEnd({ animated: true }); }, 50);
  }, []);

  const send = useCallback(async (text: string, imageBase64?: string): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length === 0 && imageBase64 === undefined) return;

    push({ id: newId(), role: 'user', text: trimmed.length > 0 ? trimmed : 'Foto de mi comida' });
    setInput('');
    setError(null);

    // 1. Lo que se entiende acá se muestra YA, sin esperar al servidor.
    const local = parseLocalIntent(trimmed, glucoseUnit);
    const localPrefill = toPrefill(local.intents);
    if (hasPrefill(localPrefill)) {
      push({
        id: newId(),
        role: 'assistant',
        text: local.complete
          ? 'Entendí esto. Revísalo y guarda.'
          : 'Entendí esto mientras pregunto por el resto.',
        prefill: localPrefill,
        pending: true,
      });
    }

    // 2. Si todo se entendió y no hay foto, no hace falta el modelo.
    if (local.complete && imageBase64 === undefined) return;

    setBusy(true);
    try {
      const turn = await onAsk(local.leftover.length > 0 ? local.leftover : trimmed, imageBase64);
      const remotePrefill = turn.draft === null
        ? undefined
        : {
            ...localPrefill,
            ...(turn.draft.waterMl === null ? {} : { waterMl: turn.draft.waterMl }),
            ...(turn.draft.foods === null ? {} : { carbsG: sumCarbs(turn.draft.foods) }),
          };
      push({
        id: newId(),
        role: 'assistant',
        text: turn.say,
        ...(remotePrefill === undefined ? {} : { prefill: remotePrefill, pending: true }),
        ...(turn.cites.length === 0 ? {} : { cites: turn.cites }),
      });
    } catch (caught) {
      // Degradar a manual, nunca a un callejón sin salida (`AGENTS.md`).
      setError(caught instanceof Error
        ? `${caught.message} Lo que escribiste sigue acá, y puedes registrarlo a mano.`
        : 'No se pudo consultar al asistente. Lo que escribiste sigue acá, y puedes registrarlo a mano.');
    } finally {
      setBusy(false);
    }
  }, [glucoseUnit, newId, onAsk, push]);

  const attachPhoto = useCallback(async (): Promise<void> => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      setError('Sin permiso de cámara no puedo ver la foto. Puedes describir la comida escribiendo.');
      return;
    }
    const picked = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], exif: false, quality: 1 });
    if (picked.canceled) return;
    const asset = picked.assets[0];
    if (asset === undefined) return;
    const context = ImageManipulator.ImageManipulator.manipulate(asset.uri);
    const rendered = await context.renderAsync();
    const compressed = await rendered.saveAsync({ compress: 0.72, format: ImageManipulator.SaveFormat.JPEG });
    await persistPhoto(compressed.uri);
    await send(input, compressed.uri);
  }, [input, send]);

  const resolve = useCallback((id: string): void => {
    setMessages((current) => current.map((m) => (m.id === id ? { ...m, pending: false } : m)));
  }, []);

  const empty = messages.length === 0;

  return (
    <ModalShell visible={visible} title="Asistente" onClose={onClose} scroll={false}>
      <View style={styles.root}>
        <ScrollView ref={scrollRef} style={styles.feed} contentContainerStyle={styles.feedContent}>
          {empty ? <EmptyState /> : null}
          {messages.map((message) => (
            <Bubble
              key={message.id}
              message={message}
              onConfirm={async () => {
                if (message.prefill === undefined) return;
                await onConfirmDraft(message.prefill);
                resolve(message.id);
              }}
              onEdit={() => {
                if (message.prefill === undefined) return;
                onOpenMaster(message.prefill);
                resolve(message.id);
              }}
            />
          ))}
          {busy ? (
            <View style={styles.thinking}>
              <ActivityIndicator color={colors.teal} />
              <Text style={styles.thinkingText}>Pensando…</Text>
            </View>
          ) : null}
          {error === null ? null : <Text style={styles.error}>{error}</Text>}
        </ScrollView>

        <View style={styles.composer}>
          <Pressable
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel="Tomar una foto de la comida"
            disabled={busy}
            onPress={() => { void attachPhoto(); }}
          >
            <Camera size={22} color={colors.teal} />
          </Pressable>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder="Cuéntame o pregúntame…"
            placeholderTextColor={colors.muted}
            multiline
            editable={!busy}
          />
          <Pressable
            style={[styles.sendButton, (busy || input.trim().length === 0) && styles.disabled]}
            accessibilityRole="button"
            accessibilityLabel="Enviar"
            disabled={busy || input.trim().length === 0}
            onPress={() => { void send(input); }}
          >
            <SendHorizontal size={20} color="#FFFFFF" />
          </Pressable>
        </View>
      </View>
    </ModalShell>
  );
}

/** Suma los carbohidratos de lo que la IA estimó. Siguen siendo estimación. */
function sumCarbs(foods: readonly { carbsG: number }[]): number {
  return Number(foods.reduce((total, food) => total + food.carbsG, 0).toFixed(1));
}

function EmptyState(): React.JSX.Element {
  return (
    <View style={styles.empty}>
      <Sparkles size={28} color={colors.teal} />
      <Text style={styles.emptyTitle}>Cuéntame qué pasó, o pregúntame por tus datos</Text>
      <Text style={styles.emptyBody}>
        “Me puse 6 de rápida y tomé 250 ml de agua” · “¿Cómo estuve estos 14 días?” · “¿Cómo me fue el 14 de agosto?”
      </Text>
      <Text style={styles.emptyFoot}>
        Nada se guarda hasta que tú lo confirmes. Las unidades de insulina las escribes tú o las calcula la
        app con los parámetros que cargaste — el asistente nunca propone una dosis.
      </Text>
    </View>
  );
}

function Bubble({
  message,
  onConfirm,
  onEdit,
}: {
  message: AgentChatMessage;
  onConfirm: () => Promise<void>;
  onEdit: () => void;
}): React.JSX.Element {
  const [saving, setSaving] = useState(false);
  const mine = message.role === 'user';
  const rows = useMemo(() => (message.prefill === undefined ? [] : describePrefill(message.prefill)), [message.prefill]);

  return (
    <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
      <Text style={mine ? styles.mineText : styles.theirsText}>{message.text}</Text>

      {message.cites === undefined ? null : (
        <Text style={styles.cites}>Cifras citadas: {message.cites.join(' · ')}</Text>
      )}

      {rows.length === 0 ? null : (
        <View style={styles.card}>
          {rows.map((row) => (
            <View key={row.label} style={styles.cardRow}>
              <Text style={styles.cardLabel}>{row.label}</Text>
              <Text style={styles.cardValue}>{row.value}</Text>
            </View>
          ))}
          {message.pending === true ? (
            <View style={styles.cardActions}>
              <Pressable
                style={[styles.primary, saving && styles.disabled]}
                accessibilityRole="button"
                accessibilityLabel="Guardar este registro"
                disabled={saving}
                onPress={() => {
                  setSaving(true);
                  void onConfirm().finally(() => { setSaving(false); });
                }}
              >
                <Text style={styles.primaryText}>{saving ? 'Guardando…' : 'Guardar'}</Text>
              </Pressable>
              <Pressable
                style={styles.secondary}
                accessibilityRole="button"
                accessibilityLabel="Abrir el formulario para corregir o completar"
                onPress={onEdit}
              >
                <Text style={styles.secondaryText}>Corregir</Text>
              </Pressable>
            </View>
          ) : (
            <Text style={styles.saved}>✓ Guardado</Text>
          )}
        </View>
      )}
    </View>
  );
}

/** Los campos del borrador, en palabras y con su unidad al lado. */
export function describePrefill(prefill: EntryPrefill): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (prefill.glucose !== undefined) {
    rows.push({ label: 'Glucosa', value: `${prefill.glucose.value} ${prefill.glucose.unit}` });
  }
  if (prefill.carbsG !== undefined) {
    // Se dice que es estimación: `AGENTS.md` separa lo estimado por IA de lo
    // que ella confirmó, y confirmarlo es justamente lo que hace el botón.
    rows.push({ label: 'Carbohidratos', value: `${prefill.carbsG} g (estimados)` });
  }
  if (prefill.rapidUnits !== undefined) rows.push({ label: 'Insulina rápida', value: `${prefill.rapidUnits} U` });
  if (prefill.basalUnits !== undefined) rows.push({ label: 'Insulina basal', value: `${prefill.basalUnits} U` });
  if (prefill.waterMl !== undefined) {
    rows.push({ label: 'Agua', value: prefill.waterMl === null ? 'falta cuánta' : `${prefill.waterMl} ml` });
  }
  return rows;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  feed: { flex: 1 },
  feedContent: { padding: spacing.lg, gap: spacing.md },

  empty: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xxl },
  emptyTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', textAlign: 'center' },
  emptyBody: { color: colors.muted, fontSize: 13, lineHeight: 20, textAlign: 'center' },
  emptyFoot: {
    color: colors.muted, fontSize: 12, lineHeight: 18, textAlign: 'center',
    marginTop: spacing.md, paddingHorizontal: spacing.md,
  },

  bubble: { borderRadius: radius.md, padding: spacing.md, maxWidth: '92%' },
  mine: { backgroundColor: colors.teal, alignSelf: 'flex-end' },
  theirs: { backgroundColor: colors.surface, alignSelf: 'flex-start', borderColor: colors.line, borderWidth: 1 },
  mineText: { color: '#FFFFFF', fontSize: 14, lineHeight: 20 },
  theirsText: { color: colors.ink, fontSize: 14, lineHeight: 20 },
  cites: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: spacing.sm },

  card: {
    marginTop: spacing.md, borderTopColor: colors.line, borderTopWidth: 1,
    paddingTop: spacing.md, gap: spacing.xs,
  },
  cardRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 24 },
  cardLabel: { color: colors.muted, fontSize: 13 },
  cardValue: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  cardActions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  primary: {
    flex: 1, backgroundColor: colors.teal, borderRadius: radius.sm,
    minHeight: 44, alignItems: 'center', justifyContent: 'center',
  },
  primaryText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  secondary: {
    flex: 1, borderColor: colors.teal, borderWidth: 1, borderRadius: radius.sm,
    minHeight: 44, alignItems: 'center', justifyContent: 'center',
  },
  secondaryText: { color: colors.teal, fontSize: 14, fontWeight: '800' },
  saved: { color: colors.green, fontSize: 13, fontWeight: '700', marginTop: spacing.sm },

  thinking: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.sm },
  thinkingText: { color: colors.muted, fontSize: 13 },
  error: {
    color: colors.warning, backgroundColor: colors.warningSoft, borderRadius: radius.sm,
    padding: spacing.md, fontSize: 13, lineHeight: 19,
  },

  composer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm,
    padding: spacing.md, borderTopColor: colors.line, borderTopWidth: 1, backgroundColor: colors.surface,
  },
  iconButton: {
    width: 44, height: 44, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center',
    borderColor: colors.line, borderWidth: 1,
  },
  input: {
    flex: 1, minHeight: 44, maxHeight: 120, borderColor: colors.line, borderWidth: 1,
    borderRadius: radius.sm, paddingHorizontal: spacing.md, paddingTop: spacing.sm,
    paddingBottom: spacing.sm, color: colors.ink, fontSize: 14,
  },
  sendButton: {
    width: 44, height: 44, borderRadius: radius.sm, backgroundColor: colors.teal,
    alignItems: 'center', justifyContent: 'center',
  },
  disabled: { opacity: 0.55 },
});
