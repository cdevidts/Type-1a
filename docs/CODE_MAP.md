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
  parámetros que el usuario ingresó (nunca inferidos).
- `freshness.ts` — decide si una lectura CGM está "stale"; `assessFreshness`
  se usa en `apps/api` antes de exponer una lectura como actual.
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

- `abacus.ts` — `AbacusRouteLLMClient`, `AbacusMealVisionService` (visión de
  comida → macros + incertidumbre), `AbacusGlucoseInsightService` (insight
  descriptivo post-comida). Las claves viven solo en `apps/api` — nunca en
  el bundle de `apps/mobile` (ver AGENTS.md § Privacy and secrets).
- `prompts.ts` — prompts usados por los servicios de arriba.
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
  historial antiguo.
- `src/episodes.ts` — lógica de asociación comida–insulina en cliente.
- `src/notifications.ts` — notificaciones locales de episodios.
- `src/components/` — `Timeline`, `GlucoseCard`, `GlucoseChart`,
  `CorrectionModal`, `MealModal`, `InsulinAssociationModal`,
  `NumericEntryModal`, `SettingsModal`, `ModalShell` (shell común de modal).
- `src/theme.ts`, `src/format.ts`, `src/types.ts` — soporte de UI.
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
| Cálculo de corrección, IOB, dosis | `AGENTS.md` + `packages/domain/src/correction.ts` + su test |
| Cualquier prompt o salida de IA | `AGENTS.md` § Safety boundaries + `packages/domain/src/ai-safety.ts` |
| Un proveedor CGM nuevo o existente | `packages/cgm/src/provider.ts` + `docs/CGM_INTEGRATION_DECISION.md` |
| Variables de entorno / secrets | `apps/api/src/config.ts` + `.env.example` + `AGENTS.md` § Privacy and secrets |
| UI de mobile | `apps/mobile/src/components/` + `apps/mobile/AGENTS.md` (versión Expo) |
| Contrato de datos entre api/mobile | `packages/schemas/src/index.ts` |
| Contexto de producto / alcance MVP | `docs/MVP_IMPLEMENTATION_BRIEF.md`, `docs/HANDOFF_ES.md` |
