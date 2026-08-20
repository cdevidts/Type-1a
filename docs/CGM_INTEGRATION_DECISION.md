# CGM integration decision — 2026-08-12

> ## ⚠️ Actualización 2026-08-19: lo que se decidió acá NO es lo que quedó
> ## implementado. Lee esto antes que el resto del documento.
>
> Este documento sigue siendo el registro válido de *por qué* se eligió
> Junction en su momento, pero el código terminó por otro camino y durante
> meses nadie lo anotó. Estado real, verificado contra el backend en
> producción (`GET /v1/cgm/status` devuelve
> `"provider": "librelinkup-freestyle-libre"`):
>
> - **El proveedor en uso es LibreLinkUp**, la API no oficial y de ingeniería
>   inversa (`packages/cgm/src/librelinkup.ts`), seleccionada con
>   `CGM_PROVIDER=librelinkup`. Es exactamente lo que la tabla de abajo
>   descartaba como "experimental feature flag only".
> - **Junction quedó implementado pero sin uso en la ruta de datos.** El botón
>   "Iniciar conexión LibreView" de Ajustes llamaba a
>   `/v1/provider/junction/link`, que no cambia de dónde salen las lecturas.
>   Ese botón se eliminó en la Fase 13 y se reemplazó por una conexión real de
>   LibreLinkUp. `JunctionCGMProvider` y `JunctionLinkService` siguen en el
>   repo y funcionan; simplemente no son el camino activo.
> - **Hasta la Fase 13 la app era de un solo usuario.** Las credenciales de
>   LibreLinkUp eran variables de entorno del backend
>   (`LIBRELINKUP_EMAIL`/`LIBRELINKUP_PASSWORD`), leídas una única vez al
>   arrancar el servidor, así que **cualquiera que instalara el APK leía el
>   sensor de la dueña de esa credencial**. Resuelto: ahora cada usuaria
>   conecta su propia cuenta desde el teléfono
>   (`apps/mobile/src/sensorConnection.ts`), y las credenciales del backend
>   quedan solo como camino heredado para la instalación original.
> - Para conectar un sensor hoy, la guía de usuaria es
>   [`CONECTAR_SENSOR.md`](CONECTAR_SENSOR.md).
>
> **Lección de proceso, no solo técnica:** una decisión de arquitectura que se
> abandona en el código tiene que anotarse en su ADR/documento en la misma
> corrida. Este documento indujo a error a varias corridas de agente, que
> asumieron Junction porque era lo único documentado.

## Decision (histórica — ver la advertencia de arriba)

Use a provider abstraction and prioritize Junction's `freestyle_libre` practice-based LibreView connection in the EU region. Do not make LibreLinkUp reverse engineering a critical dependency.

## What changed since the master context v0.1

Junction's current documentation says its patient-login provider, `abbott_libreview`, is no longer available for new connections to organizations without an existing active connection. The supported new path is `freestyle_libre`, where the patient shares their LibreView account with a LibreView practice. Chile is listed under Junction's EU region.

For testing, Junction supports synthetic FreeStyle Libre data in sandbox. Demo users expire after seven days and provide normalized Summary data.

## Assessment of the three options visible in the FreeStyle app

| Option | Intended use | Runtime suitability | MVP decision |
|---|---|---:|---|
| LibreView | Historical/cloud data shared with a healthcare practice | High through an authorized integrator/practice, not as a public patient API | Primary via Junction `freestyle_libre` |
| LibreLinkUp | Near-real-time sharing with family/caregivers | Technically attractive, but no public general developer API was identified | Experimental feature flag only; not implemented as a hidden dependency |
| Libre Data Share | Temporary access code for a healthcare team; the current app explicitly describes limited-duration access | Low for continuous background sync | Excluded as runtime; useful only for temporary clinical review |

## Operational connection for the first tester

1. Create a Junction EU sandbox user and connect a FreeStyle demo provider.
2. Validate normalization, timestamps, data age, deduplication, and provider failures.
3. For real data, use a Junction EU production account.
4. In the FreeStyle app, open **Connected Apps → LibreView → Manage** and connect to the Junction-provided production practice (`tryVital`) or an approved custom practice.
5. Configure the backend with the Junction EU API key and user ID.
6. Confirm that the UI marks disconnections, delayed readings, and source attribution correctly before relying on it for episode analysis.

## Fallback ladder

1. Junction/LibreView practice connection.
2. Manual LibreView CSV import for historical data (not presented as live).
3. Manual glucose entry when no cloud data is available.
4. Consider a LibreLinkUp experimental adapter only after reviewing Abbott terms and accepting breakage risk for the private tester build.

## Non-decision

This decision does not claim Abbott approval of Type 1A, nor does it make Type 1A a primary glucose alarm system. FreeStyle remains the authoritative alarm surface.

## Addendum — 2026-08-17: LibreLinkUp added as the working path for a Chile account

Junction's shared sandbox practice (`tryVital-sandbox`) rejected the tester's
Chilean LibreView account when shared from the FreeStyle LibreLink app
("región geográfica diferente o la ID del centro/consultorio es inválida"),
and Junction's API confirmed the practice-share step (not the API call) is
the actual prerequisite — so the block is upstream of anything this repo's
code can influence. Root cause unconfirmed; Junction's own docs claim
`tryVital-sandbox` works "in all supported regions" including Chile, so this
may be a stale default practice ID rather than a real regional restriction.
Unresolved — filed with Junction support instead of guessed around.

Added `packages/cgm/src/librelinkup.ts` as a second real-data path:
unofficial, reverse-engineered LibreLinkUp API (no Abbott SDK exists; the
community reference is `timoschlueter/nightscout-librelink-up`). Confirmed
working end-to-end against the tester's real account: region `la` (Latin
America — `api-la.libreview.io`) is the correct one for a Chilean account,
distinct from Junction's EU grouping. This is the reverse of the earlier
assumption in this doc that Chile maps to Junction's EU region — that
mapping is Junction-specific and does not carry over to LibreLinkUp's own
region list (`ae, ap, au, ca, de, eu, eu2, fr, jp, us, la, ru, cn`).

Requires a **follower account** (invited from the patient's own LibreLink
app as a "Seguidor"), never the patient's own login — the same separation
LibreView itself expects between a patient account and a sharing account.
Follower credentials are stored the same way as any other provider secret:
backend-only `.env`, never in `apps/mobile`.

This does not replace the Junction path long-term — it's unofficial, Abbott
could change or block the API without notice, and `docs/adr` should get an
entry if this becomes the primary path rather than a stopgap. Revisit
Junction once support confirms the correct practice ID; `JUNCTION_API_KEY`
and `JUNCTION_USER_ID` stay configured in `.env` for that.

Updated fallback ladder:

1. LibreLinkUp (unofficial, working now for this Chilean account).
2. Junction/LibreView practice connection (blocked, pending Junction support).
3. Manual LibreView CSV import for historical data.
4. Manual glucose entry when no cloud data is available.
