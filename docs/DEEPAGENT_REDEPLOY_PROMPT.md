# Prompt de redeploy — backend de producción (Abacus / DeepAgent)

Este documento existe para **no gastar créditos de Abacus en un redeploy
hasta que sea realmente necesario**. Pedido explícito de Verónica
(2026-08-18): preparar el prompt de antemano, no dispararlo ahora.

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
| 2026-08-19 | Fase 13 Grupo A: bug de unidades mg/dL↔mmol/L (`meal.ts`, `GlucoseCard`, `GlucoseChart`, `CorrectionModal`, `EntryModal`, `notifications.ts`, `db.ts`) + fixes de layout del Resumen | 🟡 Matizado, no un "no" limpio. `apps/api` en sí no se tocó, pero sí `packages/ai/src/prompts.ts` (`glucoseInsightSystemPrompt`), que `apps/api/src/app.ts` importa y usa en cada llamada al insight post-comida — el backend YA desplegado sigue corriendo con el prompt viejo hasta que se redespliegue. La parte peligrosa del bug (el valor crudo entrando a la calculadora de dosis) era 100% cliente y ya queda resuelta con solo instalar el APK nuevo — la app ahora manda al backend los números de `MealEpisodeMetrics` ya en mg/dL, redeploy o no. Lo único que sigue atrasado en producción es que el modelo puede seguir sin la instrucción explícita de decir "mg/dL" en el texto que genera — riesgo bajo (número correcto, posible palabra de unidad equivocada en la prosa), no bloqueante. Redeploy real solo si se confirma que el texto generado sigue mencionando mmol/L después de que Verónica actualice la app. |
| 2026-08-19 | Fase 13 Grupo B: `SafeAreaView` de los modales, lectura tolerante de filas (`rowDecode.ts` + `DecodeTally`), `ErrorBoundary`, botón "Reintentar" del Resumen, onboarding de primer uso, Ajustes en 4 pestañas | No. Todo es `apps/mobile` y `packages/domain` (`units.ts`: `formatGlucose`). `apps/api` y `packages/ai` no se tocaron, así que a diferencia de la corrida anterior acá no hay ni siquiera un matiz: el backend desplegado sirve exactamente el mismo código que necesita esta versión de la app. |
| 2026-08-19 | Fase 13 Grupo C: conexión al sensor por usuaria, cetonas, macronutrientes | No, **y es el punto interesante de esta corrida**. `apps/api/src/app.ts` sí se tocó (inyecta `sha256Hex` al construir `LibreLinkUpCGMProvider`), pero es un refactor sin cambio de comportamiento: el backend desplegado sigue funcionando igual con el código viejo. La conexión al sensor por usuaria se resolvió **en el teléfono** justamente para no depender de un redeploy y para no arriesgar la conexión existente de Verónica — ver `docs/ROADMAP_V0.2.md` § "Conexión al sensor". **Pendiente para cuando sí haya un redeploy:** una vez que Verónica confirme que su cuenta quedó conectada desde la app, conviene **quitar `LIBRELINKUP_EMAIL`/`LIBRELINKUP_PASSWORD` del entorno de Abacus**, para que no quede viva una credencial global que cualquier instalación sin cuenta propia seguiría usando. |
| 2026-08-20 | Fase 14: pantalla de Nutrición (metas de calorías/macros, patrones de grasa/proteína vs. glucosa tardía) | No — solo `packages/domain`, `packages/schemas` y `apps/mobile`. Todo el cálculo es local por diseño (`docs/adr/0001-local-first.md`): no hay llamada nueva al backend ni a ninguna API de alimentos. |
| 2026-08-20 | Fase 15: catálogo de alimentos propio + macros de la IA en el registro de comida | No para lo construido — es todo `packages/domain`, `packages/schemas` y `apps/mobile`, y el catálogo es **local** (tabla `food_catalog` en SQLite). El backend ya devolvía todos los macros; el bug era que la app los tiraba. **Pero sí hay trabajo de backend preparado y sin disparar**: el catálogo compartido entre usuarias, ver § "Catálogo de alimentos compartido" más abajo. |
| 2026-08-20 | Fase 16: barra inferior, swipe, iconos Lucide, marcas de hora | No — solo `apps/mobile`. Ni `apps/api` ni `packages/*` se tocaron. La única dependencia nueva (`lucide-react-native`) es de la app. |
| 2026-08-21 | **Fase 17: editar una comida con IA** (foto, texto, instrucción en lenguaje natural) | **SÍ, esta vez sí.** Es la primera corrida desde la Fase 13 que agrega comportamiento nuevo al backend: una tercera rama en `MealAnalysisBodySchema` (`apps/api/src/app.ts`) y un tercer modo en `AbacusMealVisionService` con su prompt (`packages/ai`). **Consecuencia concreta:** hasta que se redespliegue, los modos de foto y texto siguen funcionando igual, pero **"Explícale el cambio" responde HTTP 400 `invalid_meal_input`** — el backend viejo no conoce esa forma de body. La app degrada bien (muestra el mensaje de error y deja corregir los campos a mano), así que **no es bloqueante para instalar el APK**, pero la función estrella de la fase no funciona hasta el redeploy. Ver § "Qué cambió desde el último deploy". |
| 2026-08-21 | Fase 18: catálogo de alimentos editable, porciones, pregunta de tres salidas | No, **y a propósito**. La edición del catálogo con IA reusa la rama que la Fase 17 ya agregó (`{ instruction, current }`), presentando el alimento como una comida de un ítem de 100 g — no hay endpoint ni schema nuevo. Todo lo demás es `packages/domain` y `apps/mobile`. El redeploy pendiente sigue siendo el de la Fase 17, uno solo para las dos fases. |

## Qué cambió desde el último deploy (2026-08-21, Fase 17)

Lo pendiente en producción, para no re-derivarlo:

1. **Tercer modo de `/v1/ai/meal-analysis`: edición por instrucción.**
   `MealAnalysisBodySchema` (`apps/api/src/app.ts`) pasó a aceptar
   `{ instruction, current }`, y `AbacusMealVisionService` (`packages/ai`)
   tiene su prompt propio (`mealEditSystemPrompt`) y su guardrail de entrada
   (`requestsInsulinAdvice`, en `packages/domain`). Sin redeploy, el botón
   "Explícale el cambio" recibe **HTTP 400 `invalid_meal_input`**.
2. **Sigue pendiente desde la Fase 13**: `glucoseInsightSystemPrompt` con la
   instrucción explícita de decir "mg/dL" (riesgo bajo, ver la fila de esa
   corrida en la tabla de arriba).
3. **Y aprovechar el mismo redeploy** para quitar
   `LIBRELINKUP_EMAIL`/`LIBRELINKUP_PASSWORD` del entorno de Abacus, una vez
   que Verónica confirme que su cuenta quedó conectada desde la app (ver la
   fila de la Fase 13 Grupo C).

Cómo verificar que el deploy quedó al día, contra el servidor real:

```bash
curl -X POST https://237e8b7f1.abacusai.cloud/v1/ai/meal-analysis \
  -H 'Content-Type: application/json' \
  -d '{"instruction":"era media porción","current":{"confirmedCarbsG":30}}'
```

Un `400 invalid_meal_input` = el backend todavía es el viejo. Cualquier otra
cosa (200 con la estimación, o 503 `ai_not_configured`) = ya conoce el modo.

## Cuándo usarlo

Solo cuando algo que ya está arreglado en este repo (`apps/api`) siga
fallando en producción porque el servidor desplegado está desactualizado.
Antes de disparar el redeploy, confirmar que es genuinamente ese caso y no
otra cosa:

1. Reproducir el fallo contra el servidor real (no contra `apps/api` local)
   con un `curl` directo. Ejemplo ya documentado en
   [`ROADMAP_V0.2.md`](ROADMAP_V0.2.md) (§ "No-bug encontrado en
   dispositivo... backend desplegado desactualizado"):
   ```bash
   curl -X POST https://237e8b7f1.abacusai.cloud/v1/ai/meal-analysis \
     -H 'Content-Type: application/json' \
     -d '{"description":"una manzana"}'
   ```
2. Comparar el código/mensaje de error de la respuesta contra
   `apps/api/src/app.ts` en este repo (rama actual). Si el código de error o
   el schema que rechaza la request **no existen** en el `app.ts` de hoy,
   el servidor desplegado predata el cambio — eso es la señal real de que
   hace falta redeploy, no una suposición.
3. Confirmar que `pnpm verify` pasa en verde en este repo antes de pedir el
   redeploy — nunca desplegar código que no pasa su propia verificación.

Si el fallo resulta ser otra cosa (bug real de código, error del cliente,
CGM/Junction caído, etc.), **no** dispares este prompt — arregla el código
acá y commitea, o diagnostica el problema real primero.

## El prompt (copiar/pegar a DeepAgent tal cual, completando el resumen)

```
Necesito que redespliegues el backend de Type 1A (apps/api de
github.com/cdevidts/type-1a) a producción, en el host que ya está
sirviendo https://237e8b7f1.abacusai.cloud.

Contexto: el código de apps/api en la rama <RAMA> ya tiene el fix/cambio
para <RESUMEN DEL CAMBIO — completar antes de enviar>, pero el servidor
desplegado sigue corriendo una versión anterior. Verificado con:

<PEGAR AQUÍ EL CURL Y LA RESPUESTA QUE PRUEBA QUE ESTÁ DESACTUALIZADO>

Por favor:
1. Redespliega apps/api desde la rama <RAMA> (commit <SHA> si lo tienes) al
   mismo host que ya sirve producción — no cambies el dominio ni la URL que
   usa la app móvil (apps/mobile apunta a EXPO_PUBLIC_API_BASE_URL, que ya
   está configurada contra ese host).
2. No hace falta ninguna credencial nueva: apps/api sigue leyendo las mismas
   variables de entorno de siempre (ABACUS_API_KEY, JUNCTION_*, etc. — ver
   apps/api/src/config.ts y .env.example en el repo). No las hardcodees ni
   las cambies.
3. Después del deploy, confirma con el mismo curl de arriba que la respuesta
   cambió (código de error nuevo, o 200 si el caso ya no debería fallar).

Este backend no persiste datos de usuario (es un proxy sin estado hacia
CGM/Abacus RouteLLM — ver docs/adr/0001-local-first.md del repo), así que
un redeploy no tiene riesgo de pérdida de datos ni de downtime con estado.
```

## Catálogo de alimentos compartido (preparado, NO disparado)

Investigado el 2026-08-20 a pedido de Verónica. **Es viable**, con una
salvedad importante sobre qué producto de Abacus sirve.

### Qué de Abacus sirve y qué no

- **El "Feature Store" de Abacus NO sirve para esto.** Es ingeniería de
  features para entrenar modelos y correr predicciones batch, alimentado
  desde S3/Snowflake/Redshift, con feature groups en SQL. Es un sistema
  analítico, no una base transaccional: mal encaje para "buscar un alimento y
  escribir una fila en cada comida".
- **Lo que sí sirve: las instancias de app de DeepAgent traen su propia base
  de datos persistente (Postgres), disco persistente, HTTPS de entrada, 2
  vCPU y 8 GB.** Nuestro backend ya vive en una de esas
  (`237e8b7f1.abacusai.cloud`), así que el catálogo compartido no requiere
  contratar nada nuevo.

### Por qué NO se hizo compartido de entrada

El orden importa y lo local va primero, por tres razones:

1. **La mayor parte del valor es local.** La gente come casi siempre lo mismo:
   un catálogo del propio teléfono ya elimina la foto, la espera y la llamada
   remota del desayuno repetido. Funciona sin conexión y sin redeploy.
2. **Es el prerrequisito.** Hay que tener los registros por alimento antes de
   poder compartirlos.
3. **Compartir cambia la arquitectura.** El backend hoy es un proxy **sin
   estado** por decisión explícita (`docs/adr/0001-local-first.md`). Darle una
   base de datos propia merece su propio ADR, no ser el efecto colateral de
   una corrida de features.

### Qué pedirle a DeepAgent cuando se decida hacerlo

```
Necesito agregarle al backend de Type 1A (apps/api de
github.com/cdevidts/type-1a) un catálogo de alimentos compartido, usando la
base de datos Postgres que ya viene con esta instancia de app.

Contexto: la app estima los macros de cada alimento con IA (visión y texto) y
ya guarda un catálogo LOCAL por usuaria en SQLite, normalizado por 100 g (ver
packages/domain/src/food-catalog.ts en el repo). Quiero que ese conocimiento
se acumule también del lado del servidor, para que una usuaria nueva reciba
buenas estimaciones de alimentos comunes desde el primer día.

Por favor:
1. Crea una tabla `food_catalog` en el Postgres de la instancia:
   key TEXT PRIMARY KEY, name TEXT NOT NULL,
   carbs_per_100g, protein_per_100g, fat_per_100g, fiber_per_100g,
   kcal_per_100g  (todos DOUBLE PRECISION NOT NULL),
   times_seen INTEGER NOT NULL, last_seen_at TIMESTAMPTZ NOT NULL.
   `key` es el nombre normalizado que ya produce foodKey() en el repo
   (minusculas, sin acentos ni puntuacion, espacios colapsados).
2. Agrega dos endpoints a apps/api:
   - GET  /v1/food-catalog?q=<texto>&limit=<n>  -> alimentos que hacen match.
   - POST /v1/food-catalog  -> recibe entradas ya normalizadas por 100 g y
     hace upsert promediando ponderado por times_seen, igual que
     recordCatalogFoods() en apps/mobile/src/db.ts.
3. IMPORTANTE - privacidad: estos endpoints reciben y devuelven SOLO nombres
   de alimentos y macros por 100 g. Nunca un identificador de usuaria, ni una
   foto, ni una glucosa, ni una dosis de insulina, ni una marca de tiempo de
   comida. Un alimento no puede quedar asociado a quien lo comio.
4. Rechaza entradas absurdas antes de escribir: gramos no positivos, macros
   negativos, o cuya energia no cuadre con los macros (4/4/9 kcal/g) con mas
   de un 25 % de desvio.
5. No cambies el dominio ni la URL que ya usa la app movil.

apps/api no persiste datos de usuario hoy (es un proxy sin estado, ver
docs/adr/0001-local-first.md). Esta tabla es la primera excepcion y es
deliberadamente anonima: catalogo de alimentos, no de personas.
```

### Antes de disparar eso

- Escribir el ADR que registra el cambio de "backend sin estado" a "backend
  con un catálogo anónimo". Sin eso, la próxima corrida se encuentra una base
  de datos que ningún documento explica.
- Decidir moderación: un catálogo compartido acepta escrituras de cualquier
  instalación, así que una estimación muy mala se propaga. El promedio
  ponderado ayuda, pero conviene un piso de `times_seen` antes de servir un
  alimento a otras usuarias.

## Nota de costo

Verónica pidió explícitamente no disparar esto salvo que sea crítico —
cada redeploy vía DeepAgent consume créditos de Abacus. Si el problema puede
esperar a acumularse con otros cambios pendientes de backend, prefiere
agrupar varios fixes de `apps/api` en un solo redeploy en vez de disparar
este prompt cada vez que se cierra un bug individual.
