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

function providerFor(credentials: SensorCredentials): LibreLinkUpCGMProvider {
  return new LibreLinkUpCGMProvider({
    email: credentials.email,
    password: credentials.password,
    region: credentials.region,
    sha256Hex,
  });
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
 * Estado del sensor: cuenta propia si la hay, backend si no.
 *
 * Nota deliberada: si la ruta del dispositivo falla, **no** se cae de vuelta
 * al backend. Hacerlo mostraría el sensor de otra persona (el de la
 * credencial global del servidor) presentado como propio, que es exactamente
 * el problema que este módulo existe para resolver.
 */
export async function fetchSensorStatus(): Promise<CGMProviderStatus> {
  const credentials = await getSensorCredentials();
  if (credentials === null) return fetchCGMStatus();
  return providerFor(credentials).getStatus();
}

export async function fetchSensorReadings(from: Date, to: Date): Promise<CGMReading[]> {
  const credentials = await getSensorCredentials();
  if (credentials === null) return fetchCGMReadings(from, to);
  return providerFor(credentials).getReadings({ from, to });
}
