# ADR 0004: LibreLinkUp es la ruta de datos de CGM; Junction queda como alternativa

status: Accepted (2026-08-26)
supersedes: la narrativa de `docs/CGM_INTEGRATION_DECISION.md` (2026-08-12), que
describía a Junction como la ruta principal.

## Contexto

En agosto de 2026 se eligió Junction (`freestyle_libre`, práctica LibreView, región
EU) como proveedor principal, y se descartó explícitamente LibreLinkUp como
"experimental feature flag only" por ser una API no oficial y de ingeniería
inversa. **El código terminó por el otro camino y durante meses nadie lo anotó.**

Dos hechos lo forzaron:

1. **La práctica sandbox de Junction (`tryVital-sandbox`) rechazó la cuenta
   LibreView chilena de la usuaria** al compartirla desde la app FreeStyle
   LibreLink: *"región geográfica diferente o la ID del centro/consultorio es
   inválida"*. La API de Junction confirmó que el bloqueo está en el paso de
   compartir con la práctica, no en la llamada — es decir, aguas arriba de
   cualquier cosa que este repo pueda influir. Causa raíz sin confirmar: la
   documentación de Junction afirma que esa práctica funciona "en todas las
   regiones soportadas", Chile incluido, así que puede ser un ID de práctica
   por defecto obsoleto y no una restricción regional real. Quedó abierto con
   soporte de Junction en vez de adivinar alrededor.
2. **LibreLinkUp sí funciona end-to-end contra la cuenta real.** La región
   correcta para una cuenta chilena es `la` (Latinoamérica,
   `api-la.libreview.io`), distinta del agrupamiento EU de Junction — el mapeo
   de regiones de Junction no se traslada a la lista propia de LibreLinkUp
   (`ae, ap, au, ca, de, eu, eu2, fr, jp, us, la, ru, cn`).

El costo de no haberlo anotado fue concreto: **varias corridas de agente
asumieron la arquitectura equivocada** porque Junction era lo único documentado.

## Decisión

`LibreLinkUpCGMProvider` (`packages/cgm/src/librelinkup.ts`) es el proveedor que
instancia `apps/api/src/app.ts` con `CGM_PROVIDER=librelinkup`. Es la ruta de
datos de producción.

`JunctionCGMProvider` y `JunctionLinkService` se **conservan implementados y
funcionando**, fuera de la ruta de datos. `JUNCTION_API_KEY` y `JUNCTION_USER_ID`
siguen configurados para poder volver cuando soporte confirme el ID de práctica.

Escalera de degradación vigente:

1. LibreLinkUp (no oficial, funcionando).
2. Junction / práctica LibreView (bloqueado, pendiente de soporte).
3. Importación de CSV de LibreView para historial — **nunca presentado como en vivo**.
4. Registro manual de glucosa.

Requiere una **cuenta seguidora**, invitada desde la app LibreLink de la
paciente, nunca su propio login — la misma separación que LibreView espera entre
una cuenta de paciente y una de compartición. Desde la Fase 13 cada usuaria
conecta su propia cuenta desde el teléfono (`apps/mobile/src/sensorConnection.ts`);
antes las credenciales eran variables de entorno del backend, así que
**cualquiera que instalara el APK leía el sensor de la dueña de esa credencial**.
Las credenciales del backend quedan solo como camino heredado para la
instalación original, y en todos los casos viven en el backend, jamás en
`apps/mobile`.

## Consecuencias

- **La dependencia de producción es una API no oficial.** Abbott puede cambiarla
  o bloquearla sin aviso. Por eso la abstracción `CGMProvider` no se negocia: el
  reemplazo tiene que ser cambiar de implementación, no reescribir la app.
- Type 1A **no** es un sistema primario de alarmas de glucosa y esto no implica
  aprobación de Abbott. La app oficial de FreeStyle sigue siendo la superficie
  de alarma autoritativa.
- El contrato operativo para un provider nuevo vive en `contracts/cgm-provider.md`,
  que es lo que lee `/new-cgm-provider`. Este ADR es su respaldo citable.
- **Lección de proceso, no solo técnica:** una decisión de arquitectura que se
  abandona en el código se anota en su ADR en la misma corrida. Este ADR existe
  porque no se hizo, y el costo fueron corridas enteras trabajando sobre una
  arquitectura que no era la real.
