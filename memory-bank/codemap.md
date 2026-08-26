# Codemap — vas a tocar X, lee Y

Índice semántico para ubicar el archivo correcto sin leer el árbol. No es un
inventario: los archivos obvios por su nombre no están acá.

## Vista general

```
apps/api/       Fastify. Normaliza CGM, orquesta IA, guarda el catálogo compartido.
apps/mobile/    Expo/React Native. UI, SQLite local, notificaciones.
packages/domain/   Determinístico y crítico de seguridad. Sin IA, sin red.
packages/cgm/      CGMProvider + implementaciones.
packages/ai/       Cliente Abacus RouteLLM. Nunca se bundlea en mobile.
packages/schemas/  Zod compartido — el contrato entre las tres capas.
```

## Guía de entrada

| Vas a tocar… | Lee primero |
|---|---|
| dosis, corrección, bolo | `AGENTS.md` + `contracts/safety-acceptance.md` + `domain/src/correction.ts`, `bolus.ts` y sus tests |
| cualquier prompt o salida de IA | `AGENTS.md` §Safety + `domain/src/ai-safety.ts` + `ai/src/prompts.ts` |
| un proveedor CGM | `contracts/cgm-provider.md` + `cgm/src/provider.ts` |
| variables de entorno o secretos | `api/src/config.ts` + `.env.example` + `AGENTS.md` §Privacy |
| cualquier `.tsx` | `contracts/ux-checklist.md` + `mobile/src/theme.ts` |
| un gráfico | `contracts/dataviz-palette.md` + skill global `dataviz` |
| el contrato de datos entre api y mobile | `schemas/src/index.ts` |
| el chat de IA | `memory-bank/reference/ai-chat-capabilities.md` |

## `packages/schemas`

Un solo archivo, `src/index.ts`. Todo tipo compartido vive ahí como esquema Zod.
Es donde se ejerce la **frontera estructural**: un esquema que no declara un
campo no puede filtrarlo. `MealSnapshotSchema` (sin insulina) y
`SharedCatalogEntryInputSchema` (sin id de usuaria, foto ni glucosa) son los dos
casos que dependen de eso — no se les agrega un campo "por comodidad".

## `packages/domain` — crítico de seguridad

Puro, determinístico, con test. **Ningún `.tsx` calcula una métrica de salud.**

| Archivo | Qué resuelve |
|---|---|
| `correction.ts`, `bolus.ts` | aritmética de dosis sobre parámetros que cargó la usuaria. Nunca IOB |
| `ai-safety.ts` | `containsTherapyRecommendation` — el filtro por el que pasa toda salida de IA |
| `freshness.ts` | `assessFreshness`; distingue `sourceTimestamp` de `ingestedAt` |
| `glucose-thresholds.ts` | 54/70/180/250 mg/dL. Nadie los redeclara |
| `glucose-metrics.ts`, `agp.ts` | TIR, HbA1c estimada, percentiles, perfil AGP |
| `episode-context.ts` | qué eventos caen en la ventana de un episodio |
| `macro-glucose.ts` | subida tardía por grasa+proteína, ajustada por covariables |
| `regression.ts` | OLS por ecuaciones normales. Centra al ajustar; sus β **no salen** de aquí |
| `nutrition-insights.ts`, `nutrition-targets.ts` | patrones de comida y metas |
| `macros-source.ts` | `resolveMacrosSource()` — quién puso los macros de una comida. Se imprime en el reporte médico; ningún `.tsx` lo decide |
| `vitals-summary.ts` | cómo se lee un registro de vitales, con la banda de cetonas de `assessKetones`. El componente elige el color; no decide qué es urgente |
| `insulin-catalog.ts` | catálogo de insulinas y su duración. Devuelve `undefined` si no está configurada — nunca un default silencioso |
| `food-catalog.ts` | `foodKey`, `blendCatalogEntry`; misma implementación en teléfono y servidor |
| `report.ts`, `units.ts`, `ketones.ts`, `meal.ts`, `mysugr-import.ts` | reporte, conversión, cetonas, comida, importación |

## `packages/cgm`

`provider.ts` define `CGMProvider`. **El proveedor en producción es
LibreLinkUp** (`librelinkup.ts`) — ver `docs/adr/0004`. `junction.ts` está
implementado pero fuera de la ruta de datos; `libreview-csv.ts` importa
historial; `mock.ts` es sintético. `trend.ts` normaliza la flecha de tendencia.

⚠️ `packages/cgm` lo bundlea Metro, así que sus imports relativos **no llevan
extensión `.js`**.

## `packages/ai`

`abacus.ts` (cliente), `prompts.ts` (los prompts, versionados: al ampliar lo que
el modelo puede decir se amplía el filtro en el mismo cambio). Vive detrás del
backend; `apps/mobile` no depende de este paquete y no debe empezar a hacerlo
sin arreglar antes sus imports `.js` — ver `progress.md`.

## `apps/api`

`config.ts` es la **única** lectura de `process.env`. `app.ts` arma las rutas e
instancia el provider. `food-catalog-store.ts` es la excepción acotada al
backend sin estado (ADR 0003). `junction-link.ts` quedó sin uso activo.

## `apps/mobile`

`App.tsx` (~1.500 líneas) es el orquestador: estado, guardado y ruteo de
modales. `db.ts` (~2.300) es SQLite, migraciones y el timeline.

- **Navegación**: no hay librería. Una pantalla es un `Modal` vía `ModalShell`;
  sub-páginas son pestañas (`SummaryModal.tsx`). `BottomNav.tsx` +
  `useSwipeNavigation.ts` + `swipeOrder.ts`.
- **Modal Maestro**: `UnifiedEntryModal.tsx` es el formulario único de
  creación (`projectbrief.md`). `EntrySection.tsx` pliega sus secciones y
  `masterModal.ts` tiene sus dos reglas, puras y con test. `MealModal` y
  `MealEditModal` siguen siendo modales hospedados: son las herramientas de
  catálogo e IA, pendientes de absorber.
- **Formularios de comida**: `UnifiedEntryModal`, `MealModal`, `MealEditModal`,
  `TimelineDetailModal`. Son cuatro flujos distintos a propósito, pero **lo que
  comparten se comparte**: `MacroFields.tsx` (el trío proteína/grasa/fibra y el
  campo numérico de la app) y los `parseBlankAs*` de `format.ts`. Un campo
  nuevo va ahí primero, no suelto en un modal.
- **Gráficos**: `GlucoseChart.tsx`, `SummaryCharts.tsx` (`react-native-svg`);
  `reportExport.ts` dibuja SVG inline para el PDF.
- `notifications.ts` — un canal de Android por tipo de alarma. Android congela
  sonido y vibración al crear el canal.
- `timelineVitals.ts` — las cetonas y demás vitales **sueltos** del timeline.
  Puro y con test: un `WHERE` de más los escondió una vez, y son el dato de
  triage de cetoacidosis.
- `mealFields.ts` — qué campos **son** una comida. Puro y con test porque
  decide si la fila se escribe y si se conserva: un `false` de más borra
  historial. Si agregas un campo de comida a `UnifiedEntryInput`, va acá.
- `theme.ts` — todos los tokens. `branding.ts` — el logo, en una variable.
- `sensorConnection.ts` — cada usuaria conecta su propia cuenta LibreLinkUp.

## `docs/adr`

Append-only. `README.md` es el índice; nunca se renumera ni se borra un ADR.
