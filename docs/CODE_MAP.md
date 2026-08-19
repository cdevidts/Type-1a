# Code map — index de contexto para navegación semántica

Mapa de referencia rápida del monorepo, pensado para que un agente (o una persona nueva)
ubique el archivo correcto sin tener que leer todo el árbol. Para las reglas de seguridad
y arquitectura que gobiernan estos archivos, ver [`AGENTS.md`](../AGENTS.md) — es de
lectura obligatoria antes de tocar `packages/domain`, `packages/ai` o `packages/cgm`.

## Vista general

```
apps/
  api/        Backend Fastify — normaliza CGM, orquesta AI, expone HTTP a mobile.
  mobile/     App Expo/React Native — UI, SQLite local, notificaciones.
packages/
  domain/     Lógica determinística y crítica de seguridad (sin IA, sin red).
  cgm/        Abstracción CGMProvider + implementaciones (mock, Junction, CSV).
  ai/         Cliente Abacus RouteLLM (visión de comida, insight descriptivo).
  schemas/    Esquemas Zod compartidos — contrato entre api, mobile y packages.
docs/
  adr/        Decisiones de arquitectura (formato ADR corto).
  *.md        Brief de producto, decisión de integración CGM, research, handoff.
```

## `packages/schemas` — el contrato

- `src/index.ts` — todos los tipos compartidos vía Zod: `CGMReadingSchema`,
  `CGMTrendSchema`, `MealEpisodeMetricsSchema`, `InsulinEvent`, `MealEvent`,
  `GlucoseInsight`, etc. Si vas a cambiar la forma de un dato que cruza
  api ↔ mobile ↔ packages, empieza acá.
- Tipos de evento agregados en la Fase 1 de `docs/ROADMAP_V0.2.md`:
  `ActivityEventSchema` (actividad física), `NoteEventSchema` (nota suelta),
  `VitalsEventSchema` (peso/presión/cetonas, exige al menos una medición),
  `HbA1cLabResultSchema` (HbA1c **de laboratorio** — nunca confundir con una
  HbA1c estimada calculada por la app). `TherapyProfileSchema` ganó
  `carbRatio` (opcional, sigue siendo un valor que el usuario ingresa, nunca
  inferido). Todo esto es solo modelo de datos — nada de esto todavía se usa
  en `packages/domain` ni en ninguna pantalla.

## `packages/domain` — crítico de seguridad, sin IA ni red

- `correction.ts` — cálculo determinístico de dosis de corrección a partir de
  parámetros que el usuario ingresó (nunca inferidos). Corrección sola:
  el resultado se limita a 0 U cuando la glucosa está bajo el objetivo.
- `bolus.ts` — `calculateMealBolus()`: bolo combinado comida + corrección
  (`carbsG ÷ carbRatio` + `(glucosa − objetivo) ÷ factor`), redondeado al
  incremento con el mismo `roundToIncrement` de `correction.ts`. Requiere
  `carbRatio`: si el usuario no lo configuró, la UI **no** puede sustituirlo
  por un valor propio — debe negarse a calcular el componente de comida.
  Diferencia deliberada con `correction.ts`: aquí la corrección **sí** puede
  ser negativa (glucosa bajo objetivo resta del bolo de comida) y solo el
  total se limita a 0 — clampear cada componente por separado devolvería una
  dosis *mayor* a alguien que ya está bajo. Sin IOB, igual que todo el MVP.
- `freshness.ts` — decide si una lectura CGM está "stale"; `assessFreshness`
  se usa en `apps/api` antes de exponer una lectura como actual.
  `latestLiveReading()` decide cuál lectura cuenta como "actual" en la UI —
  excluye `origin:'imported'` (nunca `synthetic` ni `manual`, que sí son
  legítimamente "actuales"). Cualquier código nuevo que necesite "la última
  lectura" debe usar esto, no reimplementar `.at(-1)` a mano (ver hallazgo en
  `docs/ROADMAP_V0.2.md`). `isSensorReading()` es la otra mitad: solo
  `origin:'real'`. "Es actual" y "viene del sensor" son preguntas distintas
  — todo texto o badge que afirme procedencia ("EN LÍNEA", el nombre del
  proveedor, "precargada desde el sensor") tiene que consultar
  `isSensorReading`, no asumirla por ser la lectura más nueva.
- `meal.ts` — construcción de Meal Episodes y métricas +60/+120/+180, pico,
  delta, tiempo a pico.
- `units.ts` — conversión mg/dL ↔ mmol/L.
- `mysugr-import.ts` — parseo/mapeo puro (sin I/O) del CSV exportado de
  MySugr: `parseMySugrCsv`, `parseMySugrTimestamp` (fecha/hora en español +
  offset `GMT±HH:MM`, sin depender del huso horario del runtime),
  `mapMySugrRowToEvents` (una fila → `CGMReading`/`InsulinEvent[]`/
  `CarbEvent`/`MealEvent`/`ActivityEvent`/`NoteEvent`/`VitalsEvent`/
  `HbA1cLabResult`, con IDs determinísticos por timestamp+tipo, no
  aleatorios — así reimportar el mismo CSV es un no-op), `planMySugrImport`
  (orquesta ambos, sigue sin I/O). Quien escribe a SQLite es
  `apps/mobile/src/db.ts` (`importMySugrCsv`), no este archivo.
- `report.ts` — Fase 9: `buildReportRows()`, puro y determinístico, convierte
  el historial ya guardado (glucosa, insulina, carbohidratos, comidas,
  actividad, notas, vitales, HbA1c) a filas de texto ordenadas
  cronológicamente para el reporte PDF/Excel exportable desde
  `SettingsModal`. A propósito no agrega/calcula nada (eso vive en
  `glucose-metrics.ts`, abajo); nunca colapsa carbohidratos confirmados/
  estimados por IA en un solo número; la procedencia de glucosa usa las
  mismas categorías que `freshness.ts`/`glucoseOriginSuffix` de `db.ts`.
- `glucose-metrics.ts` — Fase 11 (2026-08-19, motor de cálculo + integrado al
  reporte; sin pantalla "Resumen" propia todavía): `summarizeGlucose()`
  agrega Time in Range por banda ATTD/ADA (`glucose-thresholds.ts`),
  promedio, desviación estándar, CV% y HbA1c **estimada** (`GMI`, fórmula de
  Bergenstal et al. 2018, vía `estimateA1cFromMeanGlucose()`) sobre lecturas
  ya guardadas. Excluye `origin:'synthetic'` de todo el cálculo (no solo la
  rotula — la saca, porque es dato fabricado de desarrollo, no glucosa real
  del usuario) y devuelve `null` si no queda ninguna lectura elegible. Nunca
  confundir el resultado con `HbA1cLabResultSchema` (medición de
  laboratorio real): dondequiera que se muestre debe decir "estimada" y
  quedar visualmente separado. Consumido por
  `apps/mobile/src/reportExport.ts` para el resumen clínico del reporte
  PDF/Excel; candidato natural para una futura pantalla "Resumen" en la app.
- `ai-safety.ts` — `containsTherapyRecommendation()`: filtro regex (español)
  que **rechaza** cualquier salida de IA que suene a consejo de dosis. Este es
  el guardrail técnico detrás de la regla "Never let an LLM calculate, infer,
  or recommend insulin" de `AGENTS.md`. Si tocas esto, agrega casos de test.
- `test/` — un archivo de test por módulo; son las pruebas de aceptación de
  seguridad (ver "Safety acceptance criteria" en `docs/MVP_IMPLEMENTATION_BRIEF.md`).

## `packages/cgm` — proveedores de glucosa

- `provider.ts` — interfaz `CGMProvider` (`getLatestReading`, `getReadings`,
  `getStatus`) y `CGMProviderError`. Cualquier proveedor nuevo implementa esto.
- `mock.ts` — proveedor sintético, **visiblemente rotulado**, usado en
  desarrollo cuando no hay `JUNCTION_API_KEY`.
- `junction.ts` — integración real vía Junction (`freestyle_libre`, LibreView
  EU). Ver `docs/CGM_INTEGRATION_DECISION.md` antes de tocar esto.
- `librelinkup.ts` — integración real vía la API no oficial de LibreLinkUp
  (`api-{region}.libreview.io`, cuenta seguidora). Sin SDK público de Abbott,
  así que esto es ingeniería inversa de comunidad (mismo patrón que
  `nightscout-librelink-up`), no un contrato soportado — puede romperse si
  Abbott cambia el API. Maneja login, redirect de región (`LIBRELINKUP_REGION`
  es solo el punto de partida), y expiración de sesión. Ver
  `docs/CGM_INTEGRATION_DECISION.md`.
- `libreview-csv.ts` — parser de exportación CSV de LibreView, fallback
  histórico (no se presenta como dato en vivo).
- `trend.ts` — normalización de tendencia (`rapid_up` … `rapid_down`).

## `packages/ai` — IA detrás del backend, nunca en mobile

- `abacus.ts` — `AbacusRouteLLMClient`, `AbacusMealVisionService` (foto → macros
  + incertidumbre, y desde 2026-08-18 también **solo texto** — `MealVisionInput`
  es una unión `{imageBase64,mimeType,description?}` | `{description}`, con
  prompt de sistema propio para el caso sin foto que pide confianza más baja
  e incertidumbre siempre explícita), `AbacusGlucoseInsightService` (insight
  descriptivo post-comida). Las claves viven solo en `apps/api` — nunca en
  el bundle de `apps/mobile` (ver AGENTS.md § Privacy and secrets).
- `prompts.ts` — `mealVisionSystemPrompt` (con foto) y `mealTextSystemPrompt`
  (sin foto) para `AbacusMealVisionService`, más el de glucose-insight.
- Toda salida de estos servicios pasa por `containsTherapyRecommendation()`
  (`packages/domain`) antes de llegar al usuario.

## `apps/api` — backend Fastify

- `server.ts` — entry point.
- `app.ts` — arma la app Fastify: wiring de CGM provider (mock vs Junction
  según `CGM_PROVIDER`), servicios de AI, rutas HTTP, validación con
  `MealEpisodeMetricsSchema` y schemas de `packages/schemas`.
- `config.ts` — `readConfig()` parsea `process.env` con Zod
  (`EnvironmentSchema`) — única fuente de verdad de variables de entorno.
- `junction-link.ts` — flujo de conexión/link de cuenta Junction.
- `test/app.test.ts` — tests de la API.

## `apps/mobile` — Expo / React Native

- `App.tsx`, `index.ts` — entry points.
- `src/api.ts` — cliente HTTP hacia `apps/api` (usa `EXPO_PUBLIC_API_BASE_URL`).
- `src/db.ts` — SQLite local (timeline de insulina, carbohidratos, comidas,
  CGM cacheado, y desde la Fase 1: actividad física, notas sueltas, vitales,
  HbA1c de laboratorio). Todas las tablas nuevas siguen el mismo patrón:
  `id/timestamp/payload JSON/created_at`, indexadas por `timestamp`, con un
  par `save*`/`get*` cada una que parsea con Zod y descarta filas inválidas
  en vez de tirar excepción (mismo patrón que `getCGMReadings`).
  `importMySugrCsv()` (Fase 2) orquesta `planMySugrImport` de
  `packages/domain` y escribe todo con `INSERT OR IGNORE` (idempotente por
  los IDs determinísticos del importador). Los eventos importados usan
  `saveImportedMealEvent` en vez de `saveMealWithEpisode` — a propósito no
  crean fila en `meal_episodes`, para que el tracker de episodios en vivo
  (`episodes.ts`) nunca los procese ni dispare llamadas de IA sobre
  historial antiguo. `update*`/`delete*` por tabla (Timeline editable,
  2026-08-18): cada uno re-valida con el mismo Zod schema del `save*`
  correspondiente antes de escribir. Ojo con `confirmedCarbsG` — vive
  duplicado en `meal_events.payload` y en su propia fila de `carb_events`
  (`source:'meal_confirmed'`); `updateCarbEvent` propaga a ambos lados por
  `timestamp` para no desincronizarlos (bug real que encontró el
  `domain-safety-reviewer` la primera vez que se implementó esto — no
  quitar esa propagación). `getMealAlarmOffsets`/`saveMealAlarmOffsets` y
  `getCorrectionReminderSettings`/`saveCorrectionReminderSettings` (Fase 6)
  guardan la config de alarmas en `app_settings`, con *fallback* al default
  conocido si el JSON guardado es inválido — nunca tiran excepción.
  `entry_group_id` (columna nullable en insulin/carb/cgm/note/meal, no en
  `packages/schemas` — es un concepto de UI, no del evento en sí): tagea
  todo lo escrito por un mismo guardado de "Nueva entrada", para que
  `getTimeline()` lo agrupe en un solo `TimelineItem` (`kind: 'entry'`) en
  vez de mostrarlo como filas sueltas.
  `updateUnifiedEntryGroup`/`deleteUnifiedEntryGroup` leen/editan/borran el
  paquete completo como una unidad — edición en el lugar cuando la fila ya
  existe (no borra-y-recrea, para no resetear un episodio `complete` a
  `collecting`), inserta si es nueva, borra si el formulario la dejó vacía.
  `attachEntryToReading(db, readingId, input)` empaqueta una lectura de sensor
  ya guardada: le pone `entry_group_id` y le adjunta carbos/insulina/nota con
  el `sourceTimestamp` de la lectura. Estas funciones son *provenance-aware*:
  un ancla de glucosa `origin != 'manual'` (sensor/importado/sintético) nunca
  se reescribe ni se borra — borrar la entrada solo quita adjunciones y
  desliga la lectura; vaciar todas las adjunciones también la desliga.
  `getReminderAlertStyle`/`saveReminderAlertStyle` y
  `getCapillaryReminderSettings`/`saveCapillaryReminderSettings` guardan el
  estilo de alerta (sonido/vibración) y el recordatorio capilar en
  `app_settings`.
  Toda función `save*`/`update*`/`delete*` que envuelve su propia
  transacción tiene (o debería tener) un núcleo `*Rows` no-transaccional
  para poder llamarse desde estas — patrón repetido varias veces esta
  sesión, ver `docs/ROADMAP_V0.2.md`.
  `getInsulinEvents`/`getCarbEvents`/`getMealEvents` (Fase 9, mismo patrón
  que `getCGMReadings`) leen un rango arbitrario de fechas para el reporte
  exportable — antes solo existían variantes acotadas
  (`getRecentRapidInsulin`, `getInsulinEventsForMeal`).
- `src/episodes.ts` — lógica de asociación comida–insulina en cliente.
  **Gap conocido**: si se edita/elimina una lectura CGM o una dosis de
  insulina que ya alimentó las métricas de un episodio `complete`, esas
  métricas no se recalculan (`processReadyEpisodes` solo toca episodios
  `collecting`) — ver `docs/ROADMAP_V0.2.md` § "Mejoras fuera de la
  numeración".
- `src/notifications.ts` — notificaciones locales: episodios de comida
  (offsets configurables, Fase 6), recordatorio post-corrección (Fase 6,
  opt-in, sin botones de acción rápida a propósito — no se quiere facilitar
  apilar una segunda dosis con un solo toque), recordatorios de medición
  capilar X veces/día (`scheduleCapillaryReminders`, DAILY repetidas,
  canceladas por `data.kind`), y la notificación fija de acceso rápido
  (`postQuickEntryNotification`, reutilizada por `backgroundSync.ts`). El
  botón "Actualizar" va **primero** en la categoría porque Android solo
  muestra 3 acciones en la fila. Sonido/vibración de recordatorios se maneja
  con 4 canales pre-creados (`reminderChannelId(style)`) porque Android fija
  eso por canal y no deja mutarlo; la notificación fija de glucosa queda en su
  propio canal silencioso.
- `src/backgroundSync.ts` — dos tareas headless que comparten `runCgmSync()`:
  la periódica (`expo-background-task`, Fase 7, ~15 min mejor esfuerzo) y la
  del botón "Actualizar" de la notificación fija
  (`Notifications.registerTaskAsync`, dispara con `opensAppToForeground:
  false` aunque la app esté cerrada). Abre SQLite por su cuenta (no vía
  `SQLiteProvider`) porque corre headless; riesgo de dos conexiones
  SQLCipher concurrentes anotado en `docs/ROADMAP_V0.2.md`, no confirmado
  en dispositivo aún.
- `src/components/` — `Timeline`, `TimelineDetailModal` (editar/eliminar
  por tipo, ver `db.ts` arriba para qué es editable), `GlucoseCard`,
  `GlucoseChart`, `EntryModal`, `CorrectionModal`, `MealModal`,
  `InsulinAssociationModal`, `NumericEntryModal`, `SettingsModal` (incl.
  sección "Reportes", Fase 9 + Fase 11: exporta el historial local a
  PDF/Excel — construcción del HTML/SVG y del workbook vive en
  `src/reportExport.ts` (no en el componente), vía `packages/domain`'s
  `buildReportRows`/`summarizeGlucose`, `expo-print`, `xlsx`, y
  `expo-sharing` — todo generado y compartido en el dispositivo, nada sube a
  ningún servidor), `ModalShell` (shell común de modal). `EntryModal` es la entrada
  principal estilo MySugr (glucosa + comida + carbos + insulina + nota en
  un solo registro, con calculadora de dosis, y estimación de IA por foto
  **o por texto**); los demás modales de registro quedan como atajos de un
  solo dato. Antes de tocar cualquiera de estos, leer
  `docs/UX_GUIDELINES.md`.
- `src/theme.ts`, `src/format.ts` (incl. `parseMinuteOffsets` para las
  alarmas y `capillaryReminderTimes`/`parseClockToMinutes` para el
  recordatorio capilar, con tests en `format.test.ts`), `src/types.ts` (incl.
  `TimelineEditPayload`, `ReminderAlertStyle` y `ReportExport`) — soporte de UI.
- `src/reportExport.ts` — Fase 9 + Fase 11 (2026-08-19): arma el HTML/SVG del
  PDF y el workbook del Excel exportables desde `SettingsModal`, a partir de
  un `ReportExport` (`{ rows, readings }`, ver `types.ts`). Reemplazó la tabla
  original de Fase 9 (una fila por lectura de glucosa — 7 días ya eran ~11
  páginas) por un gráfico SVG por día (hora en X, banda 70–180 sombreada,
  puntos coloreados por rango, atenuados si son `origin:'imported'`), más el
  resumen clínico de la Fase 11 (`summarizeGlucose`, domain) al inicio del
  reporte. `groupReadingsByDay()` excluye `origin:'synthetic'` igual que
  `summarizeGlucose` — un reporte para el equipo médico no debe graficar
  datos fabricados de desarrollo. Tests en `reportExport.test.ts` (incluye
  los casos de seguridad: exclusión de sintéticos, HbA1c estimada vs. de
  laboratorio nunca mezcladas).
- `src/log.ts` — `logSaveError(context, error)`: cada modal de guardado
  (`EntryModal`, `MealModal`, `NumericEntryModal`, `CorrectionModal`,
  `SettingsModal`, `InsulinAssociationModal`) atrapa sus errores con un
  mensaje genérico en pantalla ("No se pudo guardar..."), pero antes todos
  descartaban el error real con un `catch {}` mudo — sin esto, un fallo real
  (rechazo de schema, error nativo de SQLite, una llamada de notificaciones
  que lanza) no dejaba ningún rastro. Ahora se loguea `error.name`/
  `error.message` a consola, nunca el objeto de error completo ni los datos
  guardados — no `error.issues`/`error.cause`. Verificado que los mensajes
  por defecto de zod v4 para los schemas de este repo (`CGMReadingSchema`,
  `InsulinEventSchema`, `CarbEventSchema`, `TherapyProfileSchema`) no
  incluyen el valor rechazado, pero loguear solo `.message` en vez del
  objeto completo evita depender de que eso siga siendo cierto en cada
  cambio de schema — AGENTS.md prohíbe loguear cuerpos con
  glucosa/insulina/comida. **2026-08-19**, en respuesta a un reporte de
  Verónica de que "no me deja guardar entradas nuevas": revisión estática
  completa de `saveUnifiedEntry`/`writeMealWithEpisode`/`writeCGMReading`/la
  migración de `entry_group_id` no encontró ningún bug reproducible (y
  `pnpm verify` pasa limpio), así que esto es el paso de diagnóstico —
  la próxima vez que el mensaje genérico aparezca, el motivo real va a estar
  en la consola de Metro/Expo (o `adb logcat` en el APK), en vez de perderse.
  Sospecha más probable, aún no confirmada: el riesgo de doble conexión
  SQLCipher entre `backgroundSync.ts` (tarea en segundo plano) y la conexión
  de la app en primer plano, ya anotado como no probado en
  `docs/ROADMAP_V0.2.md`.
- `AGENTS.md` propio — recuerda que Expo cambió de versión (SDK 57): leer
  docs versionados antes de escribir código Expo nuevo.

## `docs/adr` — decisiones de arquitectura

- `0001-local-first.md` — por qué SQLite local es la fuente de verdad, no el
  backend.
- `0002-ai-boundary.md` — por qué la IA vive detrás del backend y nunca
  decide dosis.

## Cuándo leer qué (guía rápida para un agente)

| Vas a tocar... | Lee primero |
|---|---|
| Cálculo de corrección, IOB, dosis | `AGENTS.md` + `packages/domain/src/correction.ts` y `bolus.ts` + sus tests + `docs/ROADMAP_V0.2.md` § "El límite de seguridad que no se negocia" |
| Registro combinado de eventos (una entrada, varios tipos) | `apps/mobile/src/components/EntryModal.tsx` + `saveUnifiedEntry()` en `apps/mobile/src/db.ts` |
| Cualquier prompt o salida de IA | `AGENTS.md` § Safety boundaries + `packages/domain/src/ai-safety.ts` |
| Un proveedor CGM nuevo o existente | `packages/cgm/src/provider.ts` + `docs/CGM_INTEGRATION_DECISION.md` |
| Variables de entorno / secrets | `apps/api/src/config.ts` + `.env.example` + `AGENTS.md` § Privacy and secrets |
| UI de mobile | `apps/mobile/src/components/` + `apps/mobile/AGENTS.md` (versión Expo) + `docs/UX_GUIDELINES.md` |
| Notificaciones/alarmas | `apps/mobile/src/notifications.ts` + `apps/mobile/src/backgroundSync.ts` |
| Contrato de datos entre api/mobile | `packages/schemas/src/index.ts` |
| Contexto de producto / alcance MVP | `docs/MVP_IMPLEMENTATION_BRIEF.md`, `docs/HANDOFF_ES.md` |
