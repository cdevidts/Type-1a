import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { LibreLinkUpCGMProvider, LLU_REGIONS, type LibreLinkUpRegion } from '@type1a/cgm';
import type { CGMProviderStatus, CGMReading } from '@type1a/schemas';

import { fetchCGMReadings, fetchCGMStatus } from './api';
import { logSaveError } from './log';

/**
 * Conexión al sensor **propia de cada usuaria**, resuelta en el teléfono.
 *
 * ## Por qué existe
 *
 * Hasta ahora la única ruta al sensor era el backend, que se autentica con
 * `LIBRELINKUP_EMAIL`/`LIBRELINKUP_PASSWORD`: **variables de entorno del
 * servidor, leídas una sola vez al arrancar** (`buildProvider` en
 * `apps/api/src/app.ts`). Es decir, una credencial global única. Eso hacía la
 * app de un solo usuario: cualquiera que instalara el APK leía el sensor de
 * la dueña de esa credencial, no el suyo — un bloqueador para repartir la app
 * y, peor, una fuga de datos de glucosa entre personas.
 *
 * ## Cómo funciona
 *
 * Si la usuaria conectó su cuenta, sus credenciales se guardan en
 * `expo-secure-store` (Keystore de Android) y el teléfono habla **directo con
 * LibreLinkUp**, sin pasar por nuestro backend. Si no conectó nada, se usa la
 * ruta de siempre (el backend), sin ningún cambio de comportamiento.
 *
 * Tres consecuencias buenas de resolverlo en el dispositivo y no en el
 * servidor:
 *
 * 1. **La instalación de Verónica no se toca.** Sin credenciales locales, el
 *    camino es byte por byte el de antes. No hace falta redeploy de
 *    `apps/api` para que nada se rompa.
 * 2. **Su contraseña de LibreLinkUp nunca llega a nuestro servidor.** Va solo
 *    del teléfono a Abbott. Nosotros no almacenamos ni transportamos
 *    credenciales de terceros, que es la postura correcta y además evita
 *    tener que custodiarlas.
 * 3. Es coherente con `docs/adr/0001-local-first.md`.
 *
 * ## Advertencia sobre la API
 *
 * LibreLinkUp es una API **no oficial y de ingeniería inversa** (Abbott no
 * publica SDK). Puede cambiar sin aviso. Por eso toda falla degrada a
 * registro manual, como exige `AGENTS.md`, y nunca se presenta un dato viejo
 * como si fuera en vivo — de eso se encargan `assessFreshness` y el
 * `sourceTimestamp` que el proveedor ya preserva.
 *
 * ## Cuenta de seguidor, no la del paciente
 *
 * LibreLinkUp es la app de *seguimiento*: se conecta con una cuenta que
 * **sigue** a un sensor, no con el login de LibreLink del propio paciente.
 * Ver `docs/CONECTAR_SENSOR.md` para el paso a paso que hay que seguir en el
 * teléfono antes de que esto pueda funcionar.
 */

/**
 * Marca que ESTA instalación puede usar la cuenta global del backend.
 *
 * Vive en la tabla `settings` (no en SecureStore) porque es una propiedad de
 * la instalación, no un secreto. Se resuelve **una sola vez**, en
 * `resolveLegacyBackendSensor`: `true` solo si al migrar ya había lecturas
 * reales guardadas, es decir si esta instalación venía sincronizando contra
 * el backend desde antes de que existiera la conexión por usuaria.
 *
 * Sin esto, "no hay credenciales guardadas" significaba "usa el backend", y
 * eso hacía que **una instalación nueva mostrara el sensor de otra persona**
 * antes siquiera de abrir Ajustes — exactamente la fuga que este módulo
 * existe para cerrar.
 */
export const LEGACY_BACKEND_SENSOR_KEY = 'legacyBackendSensor';

const EMAIL_KEY = 'type1a.llu.email.v1';
const PASSWORD_KEY = 'type1a.llu.password.v1';
const REGION_KEY = 'type1a.llu.region.v1';

export interface SensorCredentials {
  email: string;
  password: string;
  region: LibreLinkUpRegion;
}

export function isLibreLinkUpRegion(value: string): value is LibreLinkUpRegion {
  return (LLU_REGIONS as readonly string[]).includes(value);
}

/** SHA-256 hex vía `expo-crypto`; el proveedor lo pide inyectado porque en el backend viene de `node:crypto`. */
function sha256Hex(input: string): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input, {
    encoding: Crypto.CryptoEncoding.HEX,
  });
}

export async function getSensorCredentials(): Promise<SensorCredentials | null> {
  const [email, password, region] = await Promise.all([
    SecureStore.getItemAsync(EMAIL_KEY),
    SecureStore.getItemAsync(PASSWORD_KEY),
    SecureStore.getItemAsync(REGION_KEY),
  ]);
  if (email === null || password === null) return null;
  return {
    email,
    password,
    region: region !== null && isLibreLinkUpRegion(region) ? region : 'la',
  };
}

export async function saveSensorCredentials(credentials: SensorCredentials): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(EMAIL_KEY, credentials.email),
    SecureStore.setItemAsync(PASSWORD_KEY, credentials.password),
    SecureStore.setItemAsync(REGION_KEY, credentials.region),
  ]);
}

export async function clearSensorCredentials(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(EMAIL_KEY),
    SecureStore.deleteItemAsync(PASSWORD_KEY),
    SecureStore.deleteItemAsync(REGION_KEY),
  ]);
}

/**
 * Una instancia por juego de credenciales, reusada entre llamadas.
 *
 * `LibreLinkUpCGMProvider` cachea el ticket de autenticación **en la
 * instancia**, así que construir una nueva por llamada hacía un
 * `POST /llu/auth/login` completo cada vez — y `refresh()` pide estado y
 * lecturas, o sea dos logins por refresco, en cada arranque, cada vuelta a
 * primer plano y cada pull-to-refresh. LibreLinkUp es una API no oficial que
 * limita y bloquea cuentas por logins repetidos: eso dejaría a la usuaria sin
 * su propio sensor.
 */
let cachedProvider: { key: string; provider: LibreLinkUpCGMProvider } | null = null;

function providerFor(credentials: SensorCredentials): LibreLinkUpCGMProvider {
  const key = `${credentials.email}\u0000${credentials.region}\u0000${credentials.password}`;
  if (cachedProvider !== null && cachedProvider.key === key) return cachedProvider.provider;
  const provider = new LibreLinkUpCGMProvider({
    email: credentials.email,
    password: credentials.password,
    region: credentials.region,
    sha256Hex,
  });
  cachedProvider = { key, provider };
  return provider;
}

/** Suelta la sesión cacheada. Obligatorio al cambiar o borrar credenciales. */
export function resetSensorProviderCache(): void {
  cachedProvider = null;
}

/**
 * Prueba las credenciales pidiendo el estado una vez. Devuelve el mensaje que
 * se le muestra a la usuaria. No guarda nada: guardar es decisión de quien
 * llama, y solo tras un resultado bueno.
 */
export async function testSensorCredentials(
  credentials: SensorCredentials,
): Promise<{ ok: true; detail: string } | { ok: false; detail: string }> {
  try {
    const status = await providerFor(credentials).getStatus();
    if (status.state === 'authentication_required') {
      return {
        ok: false,
        detail: 'LibreLinkUp rechazó ese correo o contraseña. Revisa que sean los de tu cuenta de LibreLinkUp (la de seguimiento), no los de LibreLink.',
      };
    }
    if (status.state === 'not_connected') {
      return {
        ok: false,
        detail: 'La cuenta existe, pero no está siguiendo ningún sensor todavía. Acepta la invitación en la app LibreLinkUp y vuelve a intentar.',
      };
    }
    // Solo `connected`/`stale` cuentan como éxito. Un `provider_error` (5xx,
    // respuesta inválida, bucle de redirección) u `offline` NO prueban nada
    // sobre las credenciales, y guardarlas ahí dejaría a la usuaria creyendo
    // que está en su propia cuenta cuando puede no estarlo.
    if (status.state !== 'connected' && status.state !== 'stale') {
      return {
        ok: false,
        detail: `No se pudo verificar la conexión con LibreLinkUp (${status.state}). No guardamos nada: vuelve a intentar en un momento.`,
      };
    }
    return { ok: true, detail: status.detail ?? 'Conectado.' };
  } catch (error) {
    logSaveError('sensorConnection.test', error);
    return {
      ok: false,
      detail: 'No se pudo contactar a LibreLinkUp. Revisa tu conexión a internet y vuelve a intentar.',
    };
  }
}

/**
 * De dónde salen las lecturas de esta instalación.
 *
 * - `own`: la usuaria conectó su cuenta de LibreLinkUp. El teléfono habla
 *   directo con Abbott.
 * - `legacyBackend`: instalación anterior a la conexión por usuaria, que
 *   venía leyendo la cuenta global del backend. Se conserva **solo** para no
 *   romperla; ver `LEGACY_BACKEND_SENSOR_KEY`.
 * - `none`: no hay sensor. La app funciona igual para registrar a mano, que
 *   es la degradación que exige `AGENTS.md`.
 */
export type SensorSource = 'own' | 'legacyBackend' | 'none';

// OJO: la regla de abajo está duplicada en `src/sensorSource.test.ts`, que no
// puede importar este módulo (arrastra `expo-crypto`/`expo-secure-store`, que
// no cargan bajo vitest). Si cambias esta función, cambia también ese test.
export async function resolveSensorSource(
  isLegacyBackendInstall: boolean,
): Promise<SensorSource> {
  if ((await getSensorCredentials()) !== null) return 'own';
  return isLegacyBackendInstall ? 'legacyBackend' : 'none';
}

/**
 * `CGMProviderStatus` para el caso "no hay sensor conectado".
 *
 * Es un estado explícito, no un error: la app es perfectamente usable sin
 * sensor. Lo que **no** puede hacer es caer al backend, porque eso mostraría
 * el sensor de otra persona como propio.
 */
export const NO_SENSOR_STATUS: CGMProviderStatus = {
  provider: 'sin-sensor',
  state: 'not_connected',
  detail: 'No has conectado tu sensor. Ve a Ajustes → Dispositivos para conectarlo, o sigue registrando a mano.',
  isSynthetic: false,
  checkedAt: new Date(0).toISOString(),
};

/**
 * Estado del sensor según la fuente resuelta.
 *
 * Nota deliberada: si la ruta del dispositivo falla, **no** se cae al
 * backend. Y si no hay ninguna fuente, se devuelve `NO_SENSOR_STATUS` en vez
 * del backend. Las dos cosas por el mismo motivo: cualquier caída hacia la
 * credencial global mostraría la glucosa de otra persona como propia.
 */
export async function fetchSensorStatus(source: SensorSource): Promise<CGMProviderStatus> {
  if (source === 'none') return { ...NO_SENSOR_STATUS, checkedAt: new Date().toISOString() };
  if (source === 'legacyBackend') return fetchCGMStatus();
  const credentials = await getSensorCredentials();
  if (credentials === null) return { ...NO_SENSOR_STATUS, checkedAt: new Date().toISOString() };
  return providerFor(credentials).getStatus();
}

export async function fetchSensorReadings(
  source: SensorSource,
  from: Date,
  to: Date,
): Promise<CGMReading[]> {
  if (source === 'none') return [];
  if (source === 'legacyBackend') return fetchCGMReadings(from, to);
  const credentials = await getSensorCredentials();
  if (credentials === null) return [];
  return providerFor(credentials).getReadings({ from, to });
}
