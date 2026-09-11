import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  ExpoSpeechRecognitionModule,
  useSpeechRecognitionEvent,
} from 'expo-speech-recognition';

import {
  dictationRunsOnDevice,
  dictationStartOptions,
  mergeDictation,
  pickDictationLocale,
} from '@type1a/domain';

/**
 * El micrófono del chat.
 *
 * **Dicta al cuadro de texto y nunca envía.** Un "doscientos sesenta"
 * entendido como "sesenta" tiene que ser un error que ella ve y corrige, no
 * una glucosa falsa en su historial. Por eso el hook no conoce `send`: solo
 * escribe.
 *
 * **Si el teléfono no puede transcribir solo, se pregunta ANTES de abrir el
 * micrófono.** El reconocedor de red manda el audio —su voz diciendo en cuánto
 * está y qué se puso— al servicio de Android. Decirlo mientras ya está
 * grabando es avisarle dónde fue su voz después de que fue: la revisión de
 * seguridad lo marcó como el hallazgo más grave de la fase. Ahora es un
 * permiso explícito, se pide una sola vez y se recuerda.
 */
export type DictationState =
  | 'idle'
  /** Esperando que ella acepte que el audio salga del teléfono. */
  | 'asking'
  | 'listening'
  /** Se pidió parar; el resultado final todavía puede llegar. */
  | 'finishing';

export interface DictationHandle {
  readonly state: DictationState;
  /** Válido mientras escucha: `false` significa que el audio sale del teléfono. */
  readonly onDevice: boolean;
  readonly error: string | null;
  /** `base` es el texto que ya estaba escrito; lo dictado se le suma. */
  readonly start: (base: string) => Promise<void>;
  /** Acepta que el audio salga del teléfono y arranca. */
  readonly allowCloud: () => void;
  /** Cierra el dictado conservando lo transcrito. */
  readonly stop: () => void;
  /** Descarta el dictado y deja el cuadro como estaba. */
  readonly cancel: () => void;
}

export interface DictationSources {
  readonly insulinNames: readonly string[];
  readonly foodNames: readonly string[];
  readonly onText: (text: string) => void;
  /** `true` si ella ya aceptó alguna vez que el audio salga del teléfono. */
  readonly cloudAllowed: boolean;
  /** Recuerda esa respuesta. */
  readonly onAllowCloud: () => void;
}

/** Los códigos del reconocedor, en algo que se pueda leer en pantalla. */
function describeError(code: string): string | null {
  switch (code) {
    // Soltar el botón sin haber hablado no es un error que valga mostrar.
    case 'aborted':
    case 'no-speech':
      return null;
    case 'not-allowed':
      return 'Type 1A no tiene permiso para usar el micrófono. Puedes dárselo en los ajustes del teléfono.';
    case 'language-not-supported':
      return 'Este teléfono no tiene el dictado en español. Se puede instalar desde los ajustes de Google.';
    case 'network':
      return 'El dictado necesitó internet y no lo tuvo. Puedes escribirlo.';
    case 'service-not-allowed':
      return 'Este teléfono no tiene un servicio de dictado disponible.';
    case 'busy':
      return 'El dictado está ocupado. Intenta de nuevo en un momento.';
    case 'audio-capture':
      return 'No se pudo usar el micrófono.';
    default:
      return 'No se pudo dictar. Puedes escribirlo.';
  }
}

export function useDictation(sources: DictationSources): DictationHandle {
  const [state, setState] = useState<DictationState>('idle');
  const [onDevice, setOnDevice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** El texto congelado al empezar: cada resultado parcial se suma a ESTE. */
  const baseRef = useRef('');
  /**
   * `true` desde que arranca hasta que el reconocedor dice que terminó.
   *
   * No es lo mismo que `state !== 'idle'`: al parar, el resultado **final**
   * —el bueno— llega después. Sin esta bandera pasaba lo que encontró la
   * revisión: ella corrige "260" por "160" a mano, el resultado final aterriza
   * un instante después y le pisa la corrección; o manda el mensaje y el
   * cuadro se vuelve a llenar solo, y termina registrando la insulina dos
   * veces.
   */
  const activeRef = useRef(false);
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;

  const finish = useCallback(() => {
    activeRef.current = false;
    setState('idle');
  }, []);

  useSpeechRecognitionEvent('result', (event) => {
    if (!activeRef.current) return;
    const transcript = event.results[0]?.transcript ?? '';
    sourcesRef.current.onText(mergeDictation(baseRef.current, transcript));
  });

  useSpeechRecognitionEvent('end', () => { finish(); });

  useSpeechRecognitionEvent('error', (event) => {
    finish();
    setError(describeError(event.error));
  });

  /** Abre el micrófono. `local` ya está decidido y consentido. */
  const listen = useCallback((local: boolean, locale: string | undefined) => {
    setOnDevice(local);
    try {
      const options = dictationStartOptions({
        onDevice: local,
        locale,
        insulinNames: sourcesRef.current.insulinNames,
        foodNames: sourcesRef.current.foodNames,
      });
      ExpoSpeechRecognitionModule.start({
        ...options,
        contextualStrings: [...options.contextualStrings],
        // El texto aparece mientras habla: si el reconocedor le entendió mal,
        // lo ve antes de terminar la frase y no después de mandarla.
        interimResults: true,
        continuous: false,
        maxAlternatives: 1,
      });
      activeRef.current = true;
      setState('listening');
    } catch {
      setError('No se pudo abrir el micrófono. Puedes escribirlo.');
      finish();
    }
  }, [finish]);

  /** Lo que el aparato puede hacer hoy. Se relee en cada dictado. */
  const pendingRef = useRef<{ local: boolean; locale: string | undefined } | null>(null);

  const start = useCallback(async (base: string) => {
    setError(null);
    baseRef.current = base;

    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!permission.granted) {
      setError('Type 1A necesita permiso para usar el micrófono. También puedes escribirlo.');
      return;
    }

    // Que el teléfono sepa transcribir sin red no basta: el modelo de español
    // tiene que estar descargado, o exigirlo lo deja mudo.
    let local = false;
    let locale: string | undefined;
    try {
      const supported = await ExpoSpeechRecognitionModule.getSupportedLocales({});
      local = dictationRunsOnDevice(
        ExpoSpeechRecognitionModule.supportsOnDeviceRecognition(),
        supported.installedLocales,
      );
      locale = pickDictationLocale(local ? supported.installedLocales : supported.locales);
    } catch {
      // Un teléfono que no sabe responder qué idiomas tiene dicta igual, con
      // los valores por defecto del sistema — y por lo tanto por la red.
      local = false;
    }

    if (!local && !sourcesRef.current.cloudAllowed) {
      // Se pregunta con el micrófono todavía cerrado.
      pendingRef.current = { local, locale };
      setState('asking');
      return;
    }
    listen(local, locale);
  }, [listen]);

  const allowCloud = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    sourcesRef.current.onAllowCloud();
    if (pending === null) { setState('idle'); return; }
    listen(pending.local, pending.locale);
  }, [listen]);

  const stop = useCallback(() => {
    ExpoSpeechRecognitionModule.stop();
    // NO se apaga `activeRef`: el resultado final todavía tiene que entrar.
    setState('finishing');
  }, []);

  const cancel = useCallback(() => {
    pendingRef.current = null;
    ExpoSpeechRecognitionModule.abort();
    // Deshace lo dictado: el cuadro vuelve a como estaba antes de apretar.
    if (activeRef.current) sourcesRef.current.onText(baseRef.current);
    finish();
    setError(null);
  }, [finish]);

  // Irse a segundo plano apaga el micrófono. Una llamada entrante, una
  // notificación o el botón de inicio dejaban el reconocedor escuchando con la
  // pantalla apagada — y, por la red, todavía transmitiendo.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) => {
      if (next !== 'active' && activeRef.current) {
        ExpoSpeechRecognitionModule.abort();
        activeRef.current = false;
        setState('idle');
      }
    });
    return () => { subscription.remove(); };
  }, []);

  return { state, onDevice, error, start, allowCloud, stop, cancel };
}
