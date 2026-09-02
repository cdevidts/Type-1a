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
| 2026-09-01 | Macros por porción, meta de fibra, hora local del resumen, y los hallazgos de su revisión | **SÍ, y es el que dispara este redeploy.** `glucose-insight` v6 + patrones nuevos en `ai-safety.ts`. |

## Qué cambió desde el último deploy

**Lo desplegado hoy es el commit `7fec114` (2026-08-21)**, verificado contra el
servidor real el 2026-09-01: `GET /v1/food-catalog?q=arroz` responde `200
{"foods":[]}` (o sea que ese deploy y su `DATABASE_URL` ya están hechos) y
`POST /v1/ai/meal-analysis` con un cuerpo inválido responde `400
invalid_meal_input` con el mensaje actual. Los dos pendientes que este
documento arrastraba desde agosto —el tercer modo de la Fase 17 y el catálogo
compartido— **están resueltos**.

`apps/api/src/*` no ha cambiado desde entonces. Lo que quedó atrás son los dos
paquetes que el backend **importa**: `packages/ai` (los prompts) y
`packages/domain` (el filtro de salida). Por eso este redeploy no toca
configuración ni variables de entorno: es traer el código nuevo y nada más.

### 1. El filtro de seguridad de salida está desactualizado en producción 🔴

Es lo más importante y no es cosmético. `AbacusGlucoseInsightService.summarize`
pasa toda respuesta del modelo por `containsTherapyRecommendation`
(`packages/domain/src/ai-safety.ts`). **En producción corre la versión de 4
patrones**; la de hoy tiene 14. Faltan, entre otros:

- los de **insulina activa (IOB)**, agregados el 2026-08-22 tras la revisión de
  la Fase 23 — y son los que más importan, porque desde el build del
  2026-08-31 la app **sí manda** `contextEvents` (las dosis de la ventana),
  mientras el prompt desplegado (v2) no dice nada sobre qué hacer con ellas;
- los de **juicio de suficiencia** sobre una dosis ("fue insuficiente", "se
  quedó corta"), del 2026-08-25;
- los de **juicio o consejo sobre la hora de comer**, del 2026-09-01.

O sea: hoy el modelo recibe dosis con sus unidades y sus minutos, sin
instrucción de prompt y sin la mitad del filtro. No hay evidencia de que haya
producido una salida así, pero la barrera que debía atraparla no está puesta.

### 2. `glucoseInsightSystemPrompt`: v2 desplegado, v6 en el repo

El prompt en producción tiene dos párrafos: unidades en mg/dL y las
prohibiciones básicas. Le faltan cuatro bloques:

- **v3** — describir los `contextEvents` sin evaluarlos, y que
  `minutesAfterAnchor` **puede ser negativo** (una dosis *antes* de la comida).
  Sin esto, el modelo puede leer `-45` como "45 minutos después" e invertir la
  lectura clínica del episodio.
- **v4/v5** — no describir insulina como todavía activa, acumulándose o
  solapándose (es una estimación de IOB, que el MVP no computa); no juzgar si
  un evento fue apropiado; una nota no lleva texto, no especular sobre él.
- **v6** — **el arreglo del bug que reportó Verónica**: las marcas de tiempo
  ahora viajan en hora local con desfase explícito
  (`2026-09-01T17:30:00.000-04:00`) y el prompt prohíbe convertir de zona.
  Sin redeploy, el resumen puede seguir diciendo "el episodio empezó a las
  21:30" para una comida de las 17:30. Incluye además la prohibición de juzgar
  o aconsejar la hora de comer, que existe justamente porque la hora local le
  da al modelo material para hacerlo.

### 3. Los tres prompts de comida: v1 desplegado, v2 en el repo

`FoodEstimateSchema` gana `servingGrams` y `servingLabel`, y los tres prompts
piden la porción típica del alimento con su etiqueta en lenguaje natural. El
JSON Schema que se le manda al modelo se deriva de ese Zod **en el servidor**,
así que hasta el redeploy el modelo **no tiene dónde devolver la porción**: la
pantalla de confirmación aparece igual, pero siempre con el default de 100 g y
sin propuesta que confirmar. Es la otra mitad del bug del catálogo.

No rompe nada: los dos campos son `.default(null)` en el cliente, así que una
respuesta vieja parsea bien y solo pierde la porción.

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

Actualizado el 2026-09-01 para la rama `claude/prompt-maestro-14-cambios-pa5ale`,
commit `6849f11`. **Ya no pide variables de entorno**: `DATABASE_URL` quedó
configurada en el deploy del 2026-08-21 y el catálogo compartido responde 200.

```
Necesito que redespliegues el backend de Type 1A (apps/api de
github.com/cdevidts/type-1a) a producción, en el mismo host que ya está
sirviendo https://237e8b7f1.abacusai.cloud.

Rama: claude/prompt-maestro-14-cambios-pa5ale
Commit: 6849f11

No hay código que escribir ni variables de entorno que tocar. El deploy
actual es del commit 7fec114 (21 de agosto) y apps/api/src/ no ha cambiado
desde entonces: lo que quedó atrás son dos paquetes del monorepo que el
backend importa, packages/ai (los prompts que se le mandan al modelo) y
packages/domain (el filtro que revisa lo que el modelo responde). Traer el
código nuevo es todo.

Por qué importa, en orden:

1. SEGURIDAD. El backend pasa toda respuesta del modelo por
   containsTherapyRecommendation (packages/domain/src/ai-safety.ts). En
   producción corre la versión con 4 patrones; la del repo tiene 14. Faltan
   los que detectan afirmaciones de insulina activa (IOB), los de juicio
   sobre si una dosis fue suficiente, y los de consejo sobre la hora de
   comer. Mientras tanto la app sí le manda al modelo las dosis registradas
   en la ventana del episodio, con sus unidades y sus minutos.

2. UN BUG REPORTADO POR LA USUARIA. El resumen post-comida cita la hora en
   UTC: dice "el episodio empezó a las 21:30" para una comida de las 17:30.
   La app ya manda las marcas de tiempo en hora local con desfase explícito
   (2026-09-01T17:30:00.000-04:00), pero la instrucción de no convertir de
   zona vive en el prompt, que está en el servidor. La mitad del arreglo
   está esperando este deploy.

3. OTRO BUG REPORTADO. Los prompts de análisis de comida pasaron a pedir la
   porción típica de cada alimento (servingGrams / servingLabel). El JSON
   Schema que se le manda al modelo se deriva en el servidor, así que hasta
   el redeploy el modelo no tiene dónde devolver la porción y todo el
   catálogo queda con 100 g por defecto.

Importante: no cambies el dominio ni la URL. La app móvil apunta a
EXPO_PUBLIC_API_BASE_URL, ya configurada contra ese host, y cambiarla
obligaría a un build nuevo del APK. Las variables de entorno actuales quedan
como están: no las hardcodees, no las rotes, no agregues ninguna (ver
apps/api/src/config.ts y .env.example en el repo).

Después del deploy, confirma con estos tres curl:

A) El servidor arriba y respondiendo:

   curl https://237e8b7f1.abacusai.cloud/health
   (200 con {"status":"ok","version":"0.1.0"})

B) La hora local — es la verificación que de verdad importa. Este episodio
   es de las 13:00 hora local; en UTC serían las 17:00:

   curl -X POST https://237e8b7f1.abacusai.cloud/v1/ai/glucose-insight \
     -H 'Content-Type: application/json' \
     -d '{"mealTimestamp":"2026-09-01T13:00:00.000-04:00","startingGlucose":110,"glucose60":170,"glucose120":150,"peakGlucose":180,"peakDelta":70,"timeToPeakMinutes":75,"minGlucose":108,"timeAboveRangeMinutes":10,"timeBelowRangeMinutes":0,"confirmedCarbsG":45,"readingCount":24}'

   Debe responder 200 con un resumen en español. Si menciona una hora, tiene
   que ser las 13:00 y NUNCA las 17:00. Si dice 17:00, el deploy no tomó el
   prompt nuevo — avísame antes de dar el trabajo por terminado.

C) La porción propuesta por la IA:

   curl -X POST https://237e8b7f1.abacusai.cloud/v1/ai/meal-analysis \
     -H 'Content-Type: application/json' \
     -d '{"description":"una lata de bebida cola de 350 ml"}'

   Debe responder 200 y cada alimento del arreglo "foods" debe traer las
   claves servingGrams y servingLabel. Si esas claves no aparecen, el deploy
   quedó con el schema viejo.

Contexto de arquitectura por si influye en cómo lo despliegas: es el mismo
servicio Fastify de siempre, con la única tabla Postgres del catálogo
compartido que ya existe y se auto-provee al arrancar (CREATE TABLE IF NOT
EXISTS). No hay migración que correr.
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
