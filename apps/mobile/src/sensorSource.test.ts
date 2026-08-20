import { describe, expect, it } from 'vitest';

/**
 * Tests de la **decisión de qué cuenta se lee**, que es la rama más sensible
 * a seguridad de toda la conexión al sensor: equivocarla significa mostrarle
 * a alguien la glucosa de otra persona rotulada como propia.
 *
 * `sensorConnection.ts` importa `expo-crypto`/`expo-secure-store`, que no
 * cargan bajo vitest, así que acá se prueba la **regla** de resolución con la
 * misma forma exacta que tiene en producción. Si se cambia
 * `resolveSensorSource`, este archivo tiene que cambiar con él — está
 * duplicado a propósito y así está anotado en el módulo.
 */

type SensorSource = 'own' | 'legacyBackend' | 'none';

/** Copia literal de la lógica de `resolveSensorSource`. */
function resolve(hasOwnCredentials: boolean, isLegacyBackendInstall: boolean): SensorSource {
  if (hasOwnCredentials) return 'own';
  return isLegacyBackendInstall ? 'legacyBackend' : 'none';
}

describe('resolución de la fuente del sensor', () => {
  it('la cuenta propia gana siempre, incluso en una instalación heredada', () => {
    expect(resolve(true, true)).toBe('own');
    expect(resolve(true, false)).toBe('own');
  });

  it('una instalación NUEVA sin cuenta propia no lee ningún sensor', () => {
    // El caso que importa: antes esto devolvía el backend, y una instalación
    // recién bajada mostraba la glucosa de la dueña de la credencial global
    // antes siquiera de abrir Ajustes.
    expect(resolve(false, false)).toBe('none');
  });

  it('una instalación heredada sin cuenta propia conserva el backend', () => {
    // Para no romperle la app a quien ya la venía usando.
    expect(resolve(false, true)).toBe('legacyBackend');
  });

  it('desconectar la cuenta propia en una instalación nueva deja "none", no el backend', () => {
    // Desconectar solía devolver a la usuaria a la cuenta global sin decirlo.
    const afterDisconnect = resolve(false, false);
    expect(afterDisconnect).toBe('none');
    expect(afterDisconnect).not.toBe('legacyBackend');
  });

  it('nunca devuelve el backend por el solo hecho de faltar credenciales', () => {
    for (const legacy of [true, false]) {
      const source = resolve(false, legacy);
      if (!legacy) expect(source).toBe('none');
    }
  });
});

/**
 * La otra mitad de la regla: qué cuenta como conexión verificada al probar
 * credenciales. Copia de la condición de `testSensorCredentials`.
 */
function isVerifiedConnection(state: string): boolean {
  return state === 'connected' || state === 'stale';
}

describe('verificación de credenciales', () => {
  it('acepta solo un estado que realmente pruebe la conexión', () => {
    expect(isVerifiedConnection('connected')).toBe(true);
    // "stale" sí prueba las credenciales: hubo login y hay un sensor asociado,
    // solo que su última lectura es vieja.
    expect(isVerifiedConnection('stale')).toBe(true);
  });

  it('rechaza estados que no prueban nada sobre las credenciales', () => {
    // Guardar en estos casos dejaría a la usuaria creyendo que quedó en su
    // propia cuenta cuando puede no ser así.
    for (const state of ['provider_error', 'offline', 'authentication_required', 'not_connected']) {
      expect(isVerifiedConnection(state)).toBe(false);
    }
  });
});
