import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as ImageManipulator from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  hasPrefill,
  insulinQuestionOpensCalculator,
  parseLocalIntent,
  toPrefill,
  type CalculatorRoute,
  type EntryPrefill,
} from '@type1a/domain';
import type { AgentTurn, GlucoseUnit } from '@type1a/schemas';
import Camera from 'lucide-react-native/icons/camera';
import CircleStop from 'lucide-react-native/icons/circle-stop';
import Mic from 'lucide-react-native/icons/mic';
import SendHorizontal from 'lucide-react-native/icons/send-horizontal';
import Sparkles from 'lucide-react-native/icons/sparkles';

import { persistPhoto } from '../photos';
import { useDictation } from '../useDictation';
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
 *
 * **El micrófono es un teclado, no un botón de enviar.** Lo dictado cae en el
 * cuadro de texto y se queda ahí hasta que ella lo lea y lo mande: un
 * "doscientos sesenta" entendido como "sesenta" tiene que ser un error visible
 * y corregible, nunca una glucosa falsa registrada sola. Mientras escucha, la
 * pantalla dice **dónde** se está transcribiendo, porque "en el teléfono" y
 * "por el servicio de Android" no son lo mismo para un dato de salud.
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
  /**
   * La calculadora que este turno ofrece abrir.
   *
   * Existe como botón, y no como navegación automática, cuando el mismo
   * mensaje traía algo que registrar: navegar de inmediato le borraba la
   * dosis que acababa de declarar, y la calculadora se abría afirmando que no
   * había insulina activa.
   */
  opensCalculator?: CalculatorRoute;
}

export function AgentChatModal({
  visible,
  onClose,
  glucoseUnit,
  onAsk,
  onConfirmDraft,
  onOpenMaster,
  onOpenCalculator,
  insulinNames = [],
  foodNames = [],
  cloudDictationAllowed = false,
  onAllowCloudDictation = () => {},
}: {
  visible: boolean;
  onClose: () => void;
  /** La unidad que ella configuró. Decide cómo se lee un número suelto. */
  glucoseUnit: GlucoseUnit;
  /** Manda la pregunta al backend. Devuelve el turno ya validado. */
  onAsk: (
    message: string,
    imageBase64?: string,
    history?: readonly { role: 'user' | 'assistant'; content: string }[],
  ) => Promise<AgentTurn>;
  /** Escribe lo confirmado. La pantalla nunca escribe por su cuenta. */
  onConfirmDraft: (prefill: EntryPrefill) => Promise<void>;
  /** Abre el Modal Maestro con lo entendido, para completar a mano. */
  onOpenMaster: (prefill: EntryPrefill) => void;
  /**
   * Abre la calculadora de la app cuando ella pregunta por una dosis.
   *
   * El modelo nunca da un número; la calculadora sí, con los parámetros que
   * ella cargó y el desglose a la vista. Eso siempre estuvo permitido — lo que
   * faltaba era llegar hasta ahí desde el chat.
   */
  onOpenCalculator: (route: CalculatorRoute) => void;
  /**
   * Nombres de sus insulinas y de su catálogo, como pistas para el
   * reconocedor de voz. **Solo se usan si transcribe en el teléfono**
   * (`dictationHints`): son datos de salud y no viajan a un servicio ajeno.
   */
  insulinNames?: readonly string[];
  foodNames?: readonly string[];
  /**
   * Si ella ya aceptó alguna vez que el audio salga del teléfono. Se pregunta
   * **antes** de abrir el micrófono, no mientras graba.
   */
  cloudDictationAllowed?: boolean;
  onAllowCloudDictation?: () => void;
}): React.JSX.Element {
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  /**
   * Espejo de `messages` para leerlo dentro de `send` sin volverlo dependencia
   * del `useCallback`: si lo fuera, la función se recrearía en cada mensaje.
   */
  const messagesRef = useRef<AgentChatMessage[]>([]);
  messagesRef.current = messages;
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const nextId = useRef(0);
  const dictation = useDictation({
    insulinNames,
    foodNames,
    onText: setInput,
    cloudAllowed: cloudDictationAllowed,
    onAllowCloud: onAllowCloudDictation,
  });
  const listening = dictation.state === 'listening' || dictation.state === 'finishing';

  // Cerrar el chat mientras dicta tiene que apagar el micrófono. El modal no
  // se desmonta al ocultarse (`visible` es una prop), así que sin esto el
  // reconocedor seguiría escuchando con la pantalla cerrada.
  useEffect(() => {
    if (!visible && dictation.state !== 'idle') dictation.cancel();
  }, [visible, dictation]);

  const newId = useCallback((): string => {
    nextId.current += 1;
    return `m${nextId.current}`;
  }, []);

  /**
   * Los últimos turnos de la conversación, para que una pregunta de
   * seguimiento tenga a qué referirse.
   *
   * Se mandan **los textos que ya se vieron en pantalla**, nada más: ni
   * borradores, ni citas, ni el contexto clínico, que viaja aparte y filtrado
   * por `agent-context.ts`.
   */
  const recentHistory = useCallback(
    (): readonly { role: 'user' | 'assistant'; content: string }[] =>
      messagesRef.current
        .slice(-6)
        .map((message) => ({ role: message.role, content: message.text.slice(0, 2000) })),
    [],
  );

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
    const hasSomethingToLog = hasPrefill(localPrefill);
    if (hasSomethingToLog) {
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

    // 2. ¿Está pidiendo una dosis? Se abre la calculadora en vez de contestarle
    //    con palabras. La prohibición no se toca —ningún modelo calcula
    //    insulina— pero negarse y no hacer nada la dejaba en un callejón.
    //
    //    **Se navega solo si no hay nada que perder.** Este fue el hallazgo
    //    grave de la revisión: "me puse 4 de rápida, ¿cuánto me pincho ahora?"
    //    llevaba a la calculadora tirando las 4 U, y la calculadora afirmaba
    //    "no hay eventos registrados" sobre una dosis que seguía activa — o sea
    //    proponía MÁS corrección de la que corresponde. Con algo registrado o
    //    con foto, primero se guarda: el botón queda ahí y lo aprieta ella.
    const calculator = insulinQuestionOpensCalculator(trimmed);
    if (calculator !== null) {
      const blocked = hasSomethingToLog || imageBase64 !== undefined;
      push({
        id: newId(),
        role: 'assistant',
        text: blocked
          ? 'La dosis no te la digo yo, la calcula la app con tus parámetros. Guarda primero lo de arriba para que entre en el cálculo, y después abre la calculadora.'
          // No se nombra la fuente de la glucosa: `latestLiveReading` incluye
          // lecturas manuales y sintéticas, y decir "del sensor" sería
          // presentarlas como lo que no son. La calculadora ya rotula la
          // procedencia de lo que precarga, que es donde corresponde.
          : 'La dosis no te la digo yo, la calcula la app con tus parámetros y te muestra de dónde sale cada unidad.',
        opensCalculator: calculator,
      });
      if (!blocked) { onOpenCalculator(calculator); return; }
      // Con foto pendiente se sigue al análisis; sin foto no hay nada más que
      // preguntar, porque la dosis no la contesta el modelo.
      if (imageBase64 === undefined) return;
    }

    // 3. Si todo se entendió y no hay foto, no hace falta el modelo.
    if (local.complete && imageBase64 === undefined) return;

    setBusy(true);
    try {
      // Sin historial, "¿y la semana pasada?" llegaba al modelo sin nada a qué
      // referirse y la respuesta salía genérica. Se mandan los últimos turnos,
      // que es el tope que acepta el contrato.
      const turn = await onAsk(
        local.leftover.length > 0 ? local.leftover : trimmed,
        imageBase64,
        recentHistory(),
      );
      const remotePrefill = turn.draft === null
        ? undefined
        : {
            ...localPrefill,
            ...(turn.draft.waterMl === null ? {} : { waterMl: turn.draft.waterMl }),
            ...(turn.draft.foods === null ? {} : { carbsG: sumCarbs(turn.draft.foods) }),
          };
      // Red de seguridad: si el turno vuelve como RECHAZO, lleva el botón de la
      // calculadora aunque el detector local no haya visto la frase.
      //
      // Existe porque falló exactamente así: "Quiero corregirme, dime cuánto."
      // no caía en ningún patrón, llegaba al modelo, y el modelo contestaba
      // "puedo abrirla" — algo que no podía hacer — y a la insistencia
      // respondía "no puedo abrir pantallas". Un rechazo sin salida es el
      // problema que esta fase vino a resolver, así que **todo** rechazo tiene
      // que terminar en una acción, venga de donde venga.
      // **El modelo decide, no mis palabras clave.** Verónica lo pidió así:
      // "no puede ser que palabras clave determinen la respuesta, es el
      // contenido lo que importa". `turn.opens` es un enum de tres valores —
      // no hay dónde escribir una dosis— así que entender la intención se le
      // puede dejar a él sin ceder nada.
      //
      // El `??` es la red por si un turno viejo o un rechazo por otro motivo
      // llega sin `opens`: un rechazo sin salida es justo lo que sobra.
      const refusalRoute = turn.opens ?? (turn.kind === 'refusal'
        ? insulinQuestionOpensCalculator(trimmed) ?? 'correction'
        : undefined);
      // Una respuesta vacía o en blanco es lo mismo que ninguna: ella pidió que
      // NUNCA falte una respuesta coherente.
      const say = turn.say.trim().length > 0
        ? turn.say
        : 'No entendí eso. Puedes contármelo de otra forma, o registrarlo a mano desde el botón de nueva entrada.';
      push({
        id: newId(),
        role: 'assistant',
        text: say,
        ...(remotePrefill === undefined ? {} : { prefill: remotePrefill, pending: true }),
        ...(turn.cites.length === 0 ? {} : { cites: turn.cites }),
        ...(refusalRoute === undefined ? {} : { opensCalculator: refusalRoute }),
      });
    } catch {
      // Degradar a manual, nunca a un callejón sin salida (`AGENTS.md`).
      //
      // El texto se devuelve al cuadro. El mensaje decía "lo que escribiste
      // sigue acá" cuando `setInput('')` ya lo había borrado: era falso, y la
      // dejaba retecleando la frase entera para reintentar.
      if (trimmed.length > 0) setInput(trimmed);
      // **Nunca el mensaje crudo del error.** `caught.message` fue a parar a la
      // pantalla como un volcado de Zod con corchetes y `invalid_value`: ella
      // vio eso donde esperaba una respuesta. Un error técnico no es una
      // respuesta, y esta pantalla siempre tiene que dar una.
      setError('No pude consultar al asistente. Te devolví el texto al cuadro: reinténtalo, o regístralo a mano desde el botón de nueva entrada.');

      // Y si lo que pedía era una dosis, el fallo de red no puede quitarle la
      // salida: la calculadora funciona sin internet.
      const offline = insulinQuestionOpensCalculator(trimmed);
      if (offline !== null) {
        push({
          id: newId(),
          role: 'assistant',
          text: 'Me quedé sin conexión con el asistente, pero esto no la necesita: la calculadora usa tus parámetros y funciona sin internet.',
          opensCalculator: offline,
        });
      }
    } finally {
      setBusy(false);
    }
  }, [glucoseUnit, newId, onAsk, onOpenCalculator, push, recentHistory]);

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
              onOpenCalculator={onOpenCalculator}
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

        {dictation.state === 'asking' ? (
          /* Con el micrófono TODAVÍA CERRADO. Avisarle mientras graba sería
             decirle dónde fue su voz después de que fue. */
          <View style={styles.consent}>
            <Text style={styles.consentTitle}>
              Este teléfono no puede pasar tu voz a texto por su cuenta
            </Text>
            <Text style={styles.consentBody}>
              Si sigues, lo hace el servicio de dictado de Android: tu voz —diciendo
              en cuánto estás y qué te pusiste— sale del teléfono. Escribir a mano
              no manda nada.
            </Text>
            <View style={styles.consentButtons}>
              <Pressable
                style={styles.consentSecondary}
                accessibilityRole="button"
                onPress={dictation.cancel}
              >
                <Text style={styles.consentSecondaryText}>Mejor escribo</Text>
              </Pressable>
              <Pressable
                style={styles.consentPrimary}
                accessibilityRole="button"
                onPress={dictation.allowCloud}
              >
                <Text style={styles.consentPrimaryText}>Dictar igual</Text>
              </Pressable>
            </View>
          </View>
        ) : null}
        {listening ? (
          <View style={styles.listening}>
            {/* El estado no se comunica solo con color: dice que escucha, y
                dice dónde se convierte la voz en texto. */}
            <Text style={styles.listeningText}>
              {dictation.state === 'finishing' ? 'Terminando…' : 'Escuchando…'}{' '}
              {dictation.onDevice
                ? 'se transcribe en el teléfono'
                : 'lo transcribe el servicio de Android'}
            </Text>
            <Pressable
              style={styles.listeningCancel}
              accessibilityRole="button"
              accessibilityLabel="Descartar lo dictado"
              hitSlop={8}
              onPress={dictation.cancel}
            >
              <Text style={styles.listeningCancelText}>Descartar</Text>
            </Pressable>
          </View>
        ) : null}
        {dictation.error === null ? null : (
          <Text style={styles.dictationError}>{dictation.error}</Text>
        )}

        <View style={styles.composer}>
          <Pressable
            style={styles.iconButton}
            accessibilityRole="button"
            accessibilityLabel="Tomar una foto de la comida"
            disabled={busy || listening}
            onPress={() => { void attachPhoto(); }}
          >
            <Camera size={22} color={busy || listening ? colors.muted : colors.teal} />
          </Pressable>
          <Pressable
            style={[styles.iconButton, listening && styles.iconButtonActive]}
            accessibilityRole="button"
            accessibilityLabel={listening ? 'Terminar de dictar' : 'Dictar en vez de escribir'}
            accessibilityState={{ busy: listening }}
            disabled={busy || dictation.state === 'asking' || dictation.state === 'finishing'}
            // Se toca para empezar y se toca para terminar, en vez de mantener
            // apretado: un dedo que resbala no puede costarle lo dictado, y
            // sostener un botón es justo lo que peor sale con las manos
            // temblando por una hipoglucemia.
            onPress={() => {
              if (dictation.state === 'listening') dictation.stop();
              else if (dictation.state === 'idle') void dictation.start(input);
            }}
          >
            {listening
              ? <CircleStop size={22} color={colors.red} />
              : <Mic size={22} color={busy ? colors.muted : colors.teal} />}
          </Pressable>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder={listening ? 'Habla y aparece acá…' : 'Cuéntame o pregúntame…'}
            placeholderTextColor={colors.muted}
            multiline
            editable={!busy}
          />
          <Pressable
            style={[
              styles.sendButton,
              (busy || listening || input.trim().length === 0) && styles.disabled,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Enviar"
            // Deshabilitado mientras dicta: mandar a mitad de una frase
            // enviaría media glucosa.
            disabled={busy || listening || input.trim().length === 0}
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

function CalculatorButton({
  route,
  onPress,
}: {
  route: CalculatorRoute;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      style={styles.calcButton}
      accessibilityRole="button"
      onPress={onPress}
    >
      <Text style={styles.calcButtonText}>
        {route === 'meal' ? 'Abrir la calculadora de comida' : 'Abrir la calculadora de corrección'}
      </Text>
    </Pressable>
  );
}

function Bubble({
  message,
  onConfirm,
  onEdit,
  onOpenCalculator,
}: {
  message: AgentChatMessage;
  onConfirm: () => Promise<void>;
  onEdit: () => void;
  onOpenCalculator: (route: CalculatorRoute) => void;
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

      {message.opensCalculator === undefined ? null : (
        <CalculatorButton
          route={message.opensCalculator}
          onPress={() => { onOpenCalculator(message.opensCalculator!); }}
        />
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
  iconButtonActive: { borderColor: colors.red, backgroundColor: colors.redSoft },
  listening: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    backgroundColor: colors.redSoft,
  },
  calcButton: {
    marginTop: spacing.sm, minHeight: 44, justifyContent: 'center', alignItems: 'center',
    borderRadius: radius.sm, backgroundColor: colors.teal, paddingHorizontal: spacing.md,
  },
  calcButtonText: { fontSize: 14, fontWeight: '600', color: '#FFFFFF' },
  consent: {
    gap: spacing.sm, padding: spacing.md,
    backgroundColor: colors.warningSoft, borderTopColor: colors.line, borderTopWidth: 1,
  },
  consentTitle: { fontSize: 15, fontWeight: '600', color: colors.ink },
  consentBody: { fontSize: 13, lineHeight: 19, color: colors.ink },
  consentButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  consentSecondary: {
    minHeight: 44, paddingHorizontal: spacing.md, justifyContent: 'center',
    borderRadius: radius.sm, borderColor: colors.line, borderWidth: 1,
    backgroundColor: colors.surface,
  },
  consentSecondaryText: { fontSize: 14, fontWeight: '600', color: colors.ink },
  consentPrimary: {
    minHeight: 44, paddingHorizontal: spacing.md, justifyContent: 'center',
    borderRadius: radius.sm, backgroundColor: colors.teal,
  },
  consentPrimaryText: { fontSize: 14, fontWeight: '600', color: '#FFFFFF' },
  listeningText: { flex: 1, fontSize: 13, color: colors.red },
  listeningCancel: { minHeight: 44, justifyContent: 'center' },
  listeningCancelText: { fontSize: 13, fontWeight: '600', color: colors.red },
  dictationError: {
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    fontSize: 13, color: colors.red, backgroundColor: colors.redSoft,
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
