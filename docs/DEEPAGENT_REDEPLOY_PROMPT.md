# Prompt de redeploy — backend de producción (Abacus / DeepAgent)

Este documento existe para **no gastar créditos de Abacus en un redeploy
hasta que sea realmente necesario**, y para que cuando sí se dispare, sea
**uno solo que junte todo lo pendiente** — no un redeploy por bug. Pedido
explícito de Verónica (2026-08-18, reforzado 2026-08-21: "que la corrida de
DeepAgent sea lo más optimizada posible, la mayor cantidad de cambio por la
menor cantidad de tokens posible").

**Consecuencia concreta de ese pedido en el código, no solo en el prompt:**
el catálogo de alimentos compartido (más abajo) se construyó **completo**
en este repo antes de pedirle nada a DeepAgent — tabla auto-provista al
arrancar, endpoints, validación, todo. El trabajo de diseño e implementación
lo hace Claude Code, que es barato y ya tiene todo el contexto del repo;
lo único que le queda a DeepAgent es una operación mecánica de
infraestructura (desplegar + fijar una variable de entorno), que es donde
sus tokens rinden peor si tiene que además diseñar el feature. Cualquier
trabajo de backend que se sepa que va a hacer falta, aunque la app todavía
no lo use, se construye en esta misma pasada — no se le pide a DeepAgent
que lo diseñe él.

## Registro de corridas que NO requirieron redeploy

Se anota acá para que una corrida futura no tenga que re-derivar si el
backend quedó atrás. Si tu cambio no tocó `apps/api`, agrégate a esta lista
en vez de abrir la pregunta de nuevo.

| Fecha | Corrida | Backend tocado |
|---|---|---|
| 2026-08-19 | Fase 9 reforzada: gráficos diarios en el reporte + Fase 11 (TIR, HbA1c estimada) | No — solo `packages/domain` y `apps/mobile`. |
| 2026-08-19 | Pantalla "Resumen" (AGP, métricas, patrones por franja) y su integración a los reportes | No — solo `packages/domain` y `apps/mobile`. Todo el cálculo es local por diseño (`docs/adr/0001-local-first.md`). |
| 2026-08-19 | Migración del proyecto EAS a la cuenta `cris-devit` (misma llave de firma) | No — solo `apps/mobile/app.json`/`eas.json` y credenciales locales fuera de git. |
| 2026-08-19 | Registro de bugs de interfaz del Resumen encontrados en dispositivo (Fase 13, solo documentación) | No — solo `el tag archive/pre-memory-bank`. |
| 2026-08-19 | Fase 13 Grupo A: bug de unidades mg/dL↔mmol/L (`meal.ts`, `GlucoseCard`, `GlucoseChart`, `CorrectionModal`, `EntryModal`, `notifications.ts`, `db.ts`) + fixes de layout del Resumen | 🟡 Matizado. `apps/api` en sí no se tocó, pero sí `packages/ai/src/prompts.ts` (`glucoseInsightSystemPrompt`), que `apps/api/src/app.ts` importa. El backend desplegado sigue corriendo con el prompt viejo hasta el redeploy — ver el punto "mg/dL" más abajo, sigue pendiente. |
| 2026-08-25 | Catálogo de insulinas + duración configurable, y Fase 21 (fusión de "Carbos"/"Rápida" en "Comida", macros al editar) | No — `apps/api` no se tocó. Todo es `packages/domain`, `packages/schemas` y `apps/mobile`. El catálogo de insulinas es local por diseño y no cruza a ningún servicio. |
| 2026-08-19 | Fase 13 Grupo B: `SafeAreaView` de los modales, lectura tolerante de filas, `ErrorBoundary`, botón "Reintentar" del Resumen, onboarding, Ajustes en 4 pestañas | No. `apps/api` y `packages/ai` no se tocaron. |
| 2026-08-19 | Fase 13 Grupo C: conexión al sensor por usuaria, cetonas, macronutrientes | No. `apps/api/src/app.ts` se tocó (inyecta `sha256Hex`), pero sin cambio de comportamiento. **Diferido a propósito**: quitar `LIBRELINKUP_EMAIL`/`LIBRELINKUP_PASSWORD` del entorno — Verónica ya confirmó su cuenta propia (2026-08-21), pero pidió dejarlo para el día de producción real, no para este redeploy. Ver la nota al final del prompt consolidado. |
| 2026-08-20 | Fase 14: pantalla de Nutrición | No — solo `packages/domain`, `packages/schemas`, `apps/mobile`. |
| 2026-08-20 | Fase 15: catálogo de alimentos propio (local) + macros de la IA en el registro de comida | No para lo construido. |
| 2026-08-20 | Fase 16: barra inferior, swipe, iconos Lucide, marcas de hora | No — solo `apps/mobile`. |
| 2026-08-21 | Fase 17: editar una comida con IA (foto, texto, instrucción) | **SÍ.** Tercera rama en `MealAnalysisBodySchema` + tercer modo en `AbacusMealVisionService`. Sin redeploy, "Explícale el cambio" responde 400. |
| 2026-08-21 | Fase 18: catálogo de alimentos editable, porciones, pregunta de tres salidas | No — reusa la rama que la Fase 17 ya agregó. |
| 2026-08-21 | Corrección de swipe (bug reportado) | No — solo `apps/mobile`. |
| 2026-08-22 | Fase 19 (notificaciones por tipo) + Parte A (catálogo en "Nueva entrada") + Parte B (bug de input, sin código) | No — todo `apps/mobile`. |
| 2026-08-22 | **Fase 23: el episodio captura todo su ventana + exclusión de episodios confundidos** | **SÍ, pero de bajo riesgo y NO urgente.** `apps/api/src/app.ts` no se tocó, pero sí `packages/ai/src/prompts.ts`: `glucoseInsightSystemPrompt` pasó de v2 a v3 para que el modelo pueda describir los `contextEvents` ("se registró una corrección de 2 U a las 2 h") sin evaluarlos. Hasta que se redespliegue, el backend sigue con el prompt v2: **el campo `contextEvents` viaja igual dentro de `MealEpisodeMetrics` pero el modelo no tiene instrucción sobre qué hacer con él**, así que probablemente lo ignore — no rompe nada, solo no aprovecha el dato. La parte que de verdad importaba de la Fase 23 (excluir episodios confundidos de las correlaciones) es **100 % cliente** y funciona con solo instalar el APK. Agrupar con el próximo redeploy en vez de gastar uno para esto. |
| 2026-08-21 | **Catálogo de alimentos COMPARTIDO — backend completo** (`apps/api/src/food-catalog-store.ts`, endpoints `GET`/`POST /v1/food-catalog`, `docs/adr/0003-shared-food-catalog.md`) | **SÍ.** Primera vez que el backend gana un estado persistente (Postgres). Sin `DATABASE_URL`, los dos endpoints nuevos responden 503 y el resto del backend sigue exactamente igual — no es bloqueante para nada de lo que ya funciona, pero la función en sí no existe hasta el redeploy + la variable de entorno. |
| 2026-08-25 | Fase 19 + Fase 23 + catálogo desde "Nueva entrada", y los 11 hallazgos de esa revisión | **SÍ.** `apps/api/src/*` no se tocó, pero sí `packages/ai/src/prompts.ts` y `packages/domain/src/ai-safety.ts`, que el backend importa. Ver la sección de abajo. |
| 2026-08-31 | Modal Maestro, carrito, calendario, transacciones SQLite | No — `packages/domain`, `packages/schemas` y `apps/mobile`. |
| 2026-09-01 | Porción propuesta por la IA, recetas, campos de IA separados, cobertura de días | **SÍ.** `FoodEstimateSchema` gana `servingGrams`/`servingLabel` y los tres prompts de comida pasan a v2. Sin redeploy la IA nunca propone porción. |
| 2026-09-01 | Macros por porción, meta de fibra, hora local del resumen, y los hallazgos de su revisión | **SÍ** — desplegado el 2026-09-02 como `30a87fa` (DeepAgent, verificado con los tres curl: hora local 13:00 ✓, `servingGrams` ✓). |
| 2026-09-02 | Recetas completas + `knownFoodNames` | **SÍ** — desplegado como `9f5251e`: v3 y `knownFoodNames` verificados. |
| 2026-09-02 | El 502 de las fotos: `exclusiveMinimum` fuera del saneado del esquema | **SÍ, y es el que dispara este redeploy.** Sin él las fotos no se analizan. Ver abajo. |

## Qué cambió desde el último deploy

**Lo desplegado hoy es `30a87fa` (2026-09-02, DeepAgent)**, verificado por él y
por Claude Code: la hora local del resumen tomó y `servingGrams` viene. Pero el
deploy trajo un problema de infraestructura que el anterior no tenía, y el repo
avanzó una vez más.

### 0. ✅ DESPLEGADO (2026-09-03): las fotos funcionan

Verificado contra el servidor real, no reportado: `POST /v1/ai/meal-analysis`
con un cuerpo grande responde 200. El `exclusiveMinimum` está corregido en
producción.

**Lo que sigue pendiente es solo el punto 3.** La misma prueba mostró que el
backend responde `meal-analysis-text.v3`, así que los prompts v4 con `waterMl`
no están arriba: hoy devuelve `{"name":"Agua","estimatedGrams":250,
"carbsG":0,...}` dentro de `foods`.

**Ya no es urgente**: el cliente rescata esa agua por su cuenta
(`separatePlainWater`, en `packages/domain`), así que la función anda igual y
"Agua" no ensucia el catálogo. El redeploy la hace más limpia y ahorra un
alimento inventado por análisis; no la desbloquea. **Puede esperar al próximo
cambio de backend que sí haga falta.**

### 1. ✅ El 502 de las fotos: no era el proxy, era el esquema

Diagnóstico de DeepAgent (2026-09-02), verificado contra el código. **La
hipótesis del `client_max_body_size` era falsa** y vale la pena guardar por qué:

- Con la foto real de 379 KB, **saltándose nginx** (directo a `127.0.0.1:4188`),
  también daba 502, y con cuerpo JSON: `AIServiceError: "Abacus RouteLLM
  returned HTTP 400"`. El cuerpo **sí llegaba** a Fastify.
- El 400 lo devuelve **RouteLLM**, y su motivo es el esquema, no el tamaño: el
  validador de **`gemini-2.5-flash` rechaza `exclusiveMinimum`** ("Extra inputs
  are not permitted"). Habla OpenAPI 3.0, donde la exclusividad es un booleano
  al lado de `minimum`, no un número aparte.
- **`route-llm` reparte por tamaño del payload**: fotos chicas → un GPT (200),
  fotos grandes → Gemini (400). Por eso *parecía* un límite de ~8 KB.

| Payload | `route-llm` | `gpt-5.6-sol` | `gemini-2.5-flash` |
|---|---|---|---|
| pequeño | 200 | 200 | 400 |
| foto real grande | **400** | **200** | 400 |

**Quién lo introdujo**: el `z.number().positive()` de `servingGrams`
(2026-09-01) — el único campo del esquema que emite `exclusiveMinimum`. La
lista `UNSUPPORTED_STRICT_JSON_SCHEMA_KEYWORDS` filtraba `minimum`, `maximum`,
`minItems`, `maxItems` y `$schema`: cuatro de las cinco que importaban.

**Arreglado en el repo** (opción A, la de código): se filtran también
`exclusiveMinimum`, `exclusiveMaximum` y `default`. No debilita nada — el
saneado solo afecta al esquema que se le **pide** al modelo; la respuesta se
re-valida entera contra el Zod real, cotas incluidas. Y ahora hay un test que
enumera lo que **sobrevive** al saneado contra una lista blanca, que fue el que
encontró `default` antes de que llegara al teléfono.

**No se fijó el modelo** (opción B): hardcodear `gpt-5.6-sol` deja el sistema
atado a un nombre que puede desaparecer, pierde el enrutador, y no arregla la
fragilidad — el próximo esquema podría romper también ese modelo. El
endurecimiento de nginx que DeepAgent dejó (`client_max_body_size 15m`) es
razonable y se conserva, aunque no era la causa.

### 2. `knownFoodNames`: la IA reusa el nombre exacto de lo que ya existe

Los tres modos de `/v1/ai/meal-analysis` aceptan `knownFoodNames` (solo
nombres, máximo 300 de hasta 80 caracteres; `KnownFoodNamesSchema`). Los
prompts de comida pasan a **v3** con la regla y su freno: reusar el nombre
exacto solo si es el mismo alimento; corte, preparación, variedad o marca
distinta es otro alimento. Sin redeploy, el campo viaja, Zod lo descarta en
silencio y el modelo sigue inventando "pata de pollo" al lado de "muslo de
pollo". Compatible hacia atrás: es opcional.

### 3. Agua en el análisis de comida (2026-09-03)

`MealAnalysisSchema` gana `waterMl` (`number | null`, `default null`) y los
tres prompts pasan a **v4**: devuelven los mililitros de **agua sola** que se
ven en la foto o que ella describió, para que un vaso no entre a `foods` como
un alimento de 0 g y ensucie el catálogo.

La regla que el prompt enumera en vez de dar por entendida: **solo agua**. Un
jugo, una bebida, leche, café con leche, té con azúcar, sopa o caldo llevan
carbohidratos y van en `foods`, donde reciben su dosis. Si el modelo mandara
un jugo a `waterMl`, esos carbohidratos desaparecerían del registro **y de la
dosis propuesta**. Sin volumen estimable, `null` — nunca un número redondo.

Sin redeploy la app funciona igual, pero la IA no detecta agua: `waterMl` sale
`null` siempre y el registro de agua queda solo manual (que sí funciona ya, con
su acceso rápido). Compatible hacia atrás: el campo tiene default.

### 4. Diferido a propósito, no pendiente de confirmación

Quitar `LIBRELINKUP_EMAIL`/`LIBRELINKUP_PASSWORD` del entorno — Verónica ya
confirmó (2026-08-21) que su cuenta propia funciona conectada desde la app,
pero pidió dejarlo para el día que se vaya a producción real. No preguntar de
nuevo salvo que ella lo traiga.

## Cuándo usarlo

Solo cuando algo que ya está arreglado en este repo (`apps/api`) siga
fallando en producción porque el servidor desplegado está desactualizado.
Antes de disparar el redeploy, confirmar que es genuinamente ese caso:

1. Reproducir el fallo contra el servidor real con un `curl` directo (los de
   arriba).
2. Comparar el código/mensaje de error contra `apps/api/src/app.ts` en la
   rama actual. Si el código de error o el schema que rechaza la request
   **no existen** en el `app.ts` de hoy, el servidor desplegado predata el
   cambio — esa es la señal real, no una suposición.
3. Confirmar que `pnpm verify` pasa en verde antes de pedir el redeploy —
   nunca desplegar código que no pasa su propia verificación.

Si el fallo resulta ser otra cosa (bug real de código, error del cliente,
CGM/Junction caído, etc.), **no** dispares este prompt — arregla el código
acá y commitea, o diagnostica el problema real primero.

## El prompt consolidado (copiar/pegar a DeepAgent tal cual)

Actualizado el 2026-09-02 tras el diagnóstico de DeepAgent. Solo queda
**desplegar**: la causa del 502 ya está arreglada en el repo.

```
Tenías razón y yo estaba equivocado: el 502 no era nginx. Tu diagnóstico dio en
el clavo y lo confirmé contra el código.

El validador de gemini-2.5-flash rechaza exclusiveMinimum, route-llm manda las
fotos grandes a Gemini y las chicas a un GPT, y por eso parecía un límite de
tamaño. Lo introdujo un z.number().positive() nuevo en el campo servingGrams:
era el único del esquema que emitía esa palabra, y la lista de palabras que
saneábamos tenía cuatro de las cinco que importaban.

Fui por tu opción A, la de código, y ya está arreglada y pusheada. Descarté la
opción B (fijar ABACUS_ROUTE_LLM_MODEL) porque ata el sistema a un nombre de
modelo que puede desaparecer y no arregla la fragilidad de fondo. Deja tu
endurecimiento de nginx como está: no era la causa, pero es razonable.

Necesito un redeploy más, el mismo procedimiento de siempre.

Rama: claude/prompt-maestro-14-cambios-pa5ale
Commit: el head de la rama (incluye fd3ad1a y todo lo posterior)

Qué trae, en dos partes:

1. sanitizeForStrictJsonSchema ahora filtra también exclusiveMinimum,
   exclusiveMaximum y default. No debilita nada — eso solo afecta al esquema
   que se le PIDE al modelo; la respuesta se sigue re-validando entera contra
   el Zod real, con todas sus cotas. Y hay un test nuevo que enumera lo que
   SOBREVIVE al saneado contra una lista blanca, para que la próxima palabra
   rara falle ahí y no en el teléfono. Sin esto, TODAS las fotos dan 502.

2. Los tres prompts de comida pasan a v4 y MealAnalysisSchema gana waterMl
   (number | null, default null): el agua sola que se ve en la foto o que la
   usuaria describe se devuelve aparte, para que un vaso no entre a `foods`
   como un alimento de 0 g. SOLO agua: jugo, bebida, leche, café con leche, té
   con azúcar, sopa y caldo van en `foods` con sus carbohidratos. Campo
   opcional con default, compatible hacia atrás.

Checkout, pnpm install --frozen-lockfile, reiniciar el servicio. Sin tocar
dominio, puerto ni variables de entorno.

Verificación, dos curl:

   A) La foto grande, que es lo que estaba roto. Usa una imagen real de al
      menos 300 KB en base64 (la que usaste para diagnosticar sirve):

      curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" -X POST \
        https://237e8b7f1.abacusai.cloud/v1/ai/meal-analysis \
        -H 'Content-Type: application/json' --data-binary @/tmp/foto.json

      → 200. Si sigue en 502, mándame el cuerpo del error completo (el JSON
        de la app, no el "error code: 502" de Cloudflare).

   B) Que no se haya roto lo de texto:

      curl -s -X POST https://237e8b7f1.abacusai.cloud/v1/ai/meal-analysis \
        -H 'Content-Type: application/json' \
        -d '{"description":"una manzana"}'

      → 200, analysisId empezando con meal-analysis-text.v3.

Y gracias por no aplicar A ni B sin preguntar. Fue lo correcto: la opción A
toca código versionado y tenía que salir del repo, con su test.
```

### Diferido a propósito — NO agregar todavía

> **2026-08-21: Verónica confirmó que su cuenta LibreLinkUp ya está
> conectada desde la app.** Aun así pidió explícitamente **dejar esto para
> el día que se vaya a producción real**, no dispararlo en este redeploy.
> No agregues el párrafo de abajo al prompt hasta que ella lo pida de nuevo.
> Quitar la credencial no afecta a nadie más: cada instalación conecta su
> propia cuenta desde el teléfono (`apps/mobile/src/sensorConnection.ts`),
> así que esta variable del backend no es un requisito para que otra
> persona pueda conectar su sensor — es una credencial heredada sin uso en
> la ruta activa.

Desde la Fase 13 Grupo C, cada instalación conecta su propio LibreLinkUp
desde el teléfono; el backend ya no necesita una credencial global. Cuando
llegue el momento, agregar al mismo prompt antes de enviarlo:

```
4. Además, quita LIBRELINKUP_EMAIL y LIBRELINKUP_PASSWORD del entorno: cada
   instalación de la app conecta su propio LibreLinkUp desde el teléfono
   (ver docs/CONECTAR_SENSOR.md del repo), así que esa credencial global ya
   no hace falta y no debería quedar viva.
```

## Catálogo de alimentos compartido — ya construido (2026-08-21)

Investigado el 2026-08-20, decidido y construido el 2026-08-21. El ADR
completo está en `docs/adr/0003-shared-food-catalog.md`; el resumen:

- **El "Feature Store" de Abacus no sirve** (analítico, no transaccional).
  **Lo que sí sirve**: el Postgres que ya viene con esta instancia de app.
- Reusa las funciones puras del catálogo local (`foodKey`,
  `isPlausibleCatalogEntry`, `blendCatalogEntry` en `packages/domain`) — una
  sola implementación de "cómo se agrupa y fusiona un alimento", usada en el
  teléfono y en el servidor.
- Anónimo **estructuralmente**: el schema de red
  (`SharedCatalogEntryInputSchema` en `packages/schemas`) no tiene campo de
  usuaria, foto, glucosa, insulina ni marca de tiempo de una comida.
- Piso de moderación (`SHARED_CATALOG_MIN_TIMES_SEEN`, default 3): un
  alimento visto pocas veces sigue acumulándose pero no se sirve a otras
  usuarias todavía.
- **La app móvil todavía no lo consume**, a propósito — es exactamente el
  pedido de Verónica de dejar el backend listo de antemano para que esa fase
  futura sea puro trabajo de `apps/mobile` sin otro redeploy.

## Nota de costo

Verónica pidió explícitamente no disparar esto salvo que sea crítico, y
cuando se dispare, que junte todo lo pendiente en un solo redeploy — nunca
uno por bug individual. El prompt consolidado de arriba es exactamente eso.
