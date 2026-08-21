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
| 2026-08-19 | Registro de bugs de interfaz del Resumen encontrados en dispositivo (Fase 13, solo documentación) | No — solo `docs/ROADMAP_V0.2.md`. |
| 2026-08-19 | Fase 13 Grupo A: bug de unidades mg/dL↔mmol/L (`meal.ts`, `GlucoseCard`, `GlucoseChart`, `CorrectionModal`, `EntryModal`, `notifications.ts`, `db.ts`) + fixes de layout del Resumen | 🟡 Matizado. `apps/api` en sí no se tocó, pero sí `packages/ai/src/prompts.ts` (`glucoseInsightSystemPrompt`), que `apps/api/src/app.ts` importa. El backend desplegado sigue corriendo con el prompt viejo hasta el redeploy — ver el punto "mg/dL" más abajo, sigue pendiente. |
| 2026-08-19 | Fase 13 Grupo B: `SafeAreaView` de los modales, lectura tolerante de filas, `ErrorBoundary`, botón "Reintentar" del Resumen, onboarding, Ajustes en 4 pestañas | No. `apps/api` y `packages/ai` no se tocaron. |
| 2026-08-19 | Fase 13 Grupo C: conexión al sensor por usuaria, cetonas, macronutrientes | No. `apps/api/src/app.ts` se tocó (inyecta `sha256Hex`), pero sin cambio de comportamiento. **Pendiente para el redeploy**: quitar `LIBRELINKUP_EMAIL`/`LIBRELINKUP_PASSWORD` del entorno — condicionado a que Verónica confirme su cuenta propia. Ver la nota al final del prompt consolidado. |
| 2026-08-20 | Fase 14: pantalla de Nutrición | No — solo `packages/domain`, `packages/schemas`, `apps/mobile`. |
| 2026-08-20 | Fase 15: catálogo de alimentos propio (local) + macros de la IA en el registro de comida | No para lo construido. |
| 2026-08-20 | Fase 16: barra inferior, swipe, iconos Lucide, marcas de hora | No — solo `apps/mobile`. |
| 2026-08-21 | Fase 17: editar una comida con IA (foto, texto, instrucción) | **SÍ.** Tercera rama en `MealAnalysisBodySchema` + tercer modo en `AbacusMealVisionService`. Sin redeploy, "Explícale el cambio" responde 400. |
| 2026-08-21 | Fase 18: catálogo de alimentos editable, porciones, pregunta de tres salidas | No — reusa la rama que la Fase 17 ya agregó. |
| 2026-08-21 | Corrección de swipe (bug reportado) | No — solo `apps/mobile`. |
| 2026-08-21 | **Catálogo de alimentos COMPARTIDO — backend completo** (`apps/api/src/food-catalog-store.ts`, endpoints `GET`/`POST /v1/food-catalog`, `docs/adr/0003-shared-food-catalog.md`) | **SÍ.** Primera vez que el backend gana un estado persistente (Postgres). Sin `DATABASE_URL`, los dos endpoints nuevos responden 503 y el resto del backend sigue exactamente igual — no es bloqueante para nada de lo que ya funciona, pero la función en sí no existe hasta el redeploy + la variable de entorno. |

## Qué cambió desde el último deploy

Todo lo pendiente en producción, para no re-derivarlo — este es el que se
junta en el prompt consolidado de más abajo:

1. **Tercer modo de `/v1/ai/meal-analysis`: edición por instrucción (Fase 17).**
   `MealAnalysisBodySchema` acepta `{ instruction, current }`;
   `AbacusMealVisionService` tiene su prompt propio (`mealEditSystemPrompt`)
   y su guardrail de entrada (`requestsInsulinAdvice`). Sin redeploy, el
   botón "Explícale el cambio" (comidas y catálogo, Fase 17/18) recibe
   **HTTP 400 `invalid_meal_input`**.
2. **Catálogo de alimentos compartido (backend completo, sin cliente aún).**
   `GET`/`POST /v1/food-catalog`. Necesita `DATABASE_URL` apuntando al
   Postgres que ya viene con esta instancia de app — sin esa variable, los
   endpoints existen pero responden 503. El esquema se auto-provee solo al
   arrancar: no hay SQL que correr a mano.
3. **Sigue pendiente desde la Fase 13**: `glucoseInsightSystemPrompt` con la
   instrucción explícita de decir "mg/dL" (riesgo bajo: número correcto,
   posible palabra de unidad equivocada en la prosa).
4. **Opcional, condicionado**: quitar `LIBRELINKUP_EMAIL`/`LIBRELINKUP_PASSWORD`
   del entorno — solo si Verónica confirma que su cuenta propia funciona
   conectada desde la app (Fase 13 Grupo C). Ver la nota al final del
   prompt consolidado; no está incluido en el cuerpo principal porque es una
   decisión suya, no algo que se pueda inferir del código.

Cómo verificar, contra el servidor real, qué tan atrás está el deploy:

```bash
# Modo de edición por instrucción (Fase 17) — 400 = servidor viejo.
curl -X POST https://237e8b7f1.abacusai.cloud/v1/ai/meal-analysis \
  -H 'Content-Type: application/json' \
  -d '{"instruction":"era media porción","current":{"confirmedCarbsG":30}}'

# Catálogo compartido — 404 (ruta no existe) = servidor viejo;
# 503 food_catalog_not_configured = servidor nuevo sin DATABASE_URL;
# 200 con {"foods":[]} = servidor nuevo y ya configurado.
curl https://237e8b7f1.abacusai.cloud/v1/food-catalog?q=arroz
```

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

## El prompt consolidado (copiar/pegar a DeepAgent tal cual, completando rama y commit)

Junta el redeploy y el catálogo compartido en un solo pedido — es
deliberado, ver la nota del principio de este documento.

```
Necesito que redespliegues el backend de Type 1A (apps/api de
github.com/cdevidts/type-1a) a producción, en el host que ya está
sirviendo https://237e8b7f1.abacusai.cloud, y que fijes una variable de
entorno nueva. No hay código que escribir de tu lado — ya está todo en el
repo.

Rama: <RAMA>. Commit: <SHA>.

Contexto de lo que trae este código nuevo:
1. Un tercer modo del endpoint /v1/ai/meal-analysis (edición de una comida
   por instrucción en lenguaje natural).
2. Un catálogo de alimentos COMPARTIDO nuevo, en dos endpoints:
   GET /v1/food-catalog y POST /v1/food-catalog. Usa Postgres. La tabla se
   auto-crea sola la primera vez que el proceso arranca con DATABASE_URL
   configurada (CREATE TABLE IF NOT EXISTS en el código) — no hace falta que
   corras ninguna migración ni SQL a mano.

Por favor:
1. Redespliega apps/api desde la rama <RAMA> (commit <SHA>) al mismo host
   que ya sirve producción — no cambies el dominio ni la URL que usa la app
   móvil (apps/mobile apunta a EXPO_PUBLIC_API_BASE_URL, ya configurada
   contra ese host).
2. Agrega la variable de entorno DATABASE_URL, apuntando al Postgres que ya
   viene incluido con esta instancia de app (no crees una base nueva ni
   contrates nada — es la que ya está provisionada). El resto de las
   variables de entorno siguen igual: no las hardcodees ni las cambies (ver
   apps/api/src/config.ts y .env.example en el repo).
3. Después del deploy, confirma con estos dos curl que ambos cambios están
   activos:

   curl -X POST https://237e8b7f1.abacusai.cloud/v1/ai/meal-analysis \
     -H 'Content-Type: application/json' \
     -d '{"instruction":"era media porción","current":{"confirmedCarbsG":30}}'
   (debe dejar de responder 400 invalid_meal_input)

   curl https://237e8b7f1.abacusai.cloud/v1/food-catalog?q=arroz
   (debe responder 200 con {"foods":[]} — no 404 ni 503)

Nota de arquitectura, por si es relevante para cómo lo despliegas: hasta
ahora este backend era un proxy sin estado (ver docs/adr/0001-local-first.md
del repo) — el catálogo de alimentos es la PRIMERA tabla que persiste datos,
y está documentado en docs/adr/0003-shared-food-catalog.md. Es deliberadamente
anónima: solo nombres de alimentos y macros por 100 g, ningún dato de
usuaria, glucosa, insulina ni fotos pasa nunca por esos dos endpoints.
```

### Opcional — agregar SOLO si Verónica ya confirmó su propia conexión al sensor

Desde la Fase 13 Grupo C, cada instalación conecta su propio LibreLinkUp
desde el teléfono; el backend ya no necesita una credencial global. Si
Verónica ya confirmó que su cuenta quedó conectada desde la app, agregar al
mismo prompt antes de enviarlo:

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
