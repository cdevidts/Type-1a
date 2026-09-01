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
| `food-catalog.ts` | `foodKey`, `blendCatalogEntry`; misma implementación en teléfono y servidor. `imageUri` es representación del alimento, nunca base de un macro |
| `meal-cart.ts` | el carrito multi-alimento: suma líneas y declara qué macro falta. Su total es **estimación**; confirmarlo es un acto de la usuaria |
| `insulin-catalog.ts` § naming/purpose | nombre por configuración y propósito descriptivo coherente al reclasificar. Nunca calcula dosis |
| `report.ts`, `units.ts`, `ketones.ts`, `meal.ts`, `mysugr-import.ts` | reporte (deduplica el espejo de una comida), conversión, cetonas, comida, importación |

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
  creación **y** edición; `mode` dice cuál. `EntrySection.tsx` pliega, y
  `masterModal.ts` tiene sus reglas puras y con test: a dónde escribe cada tipo
  (`masterTargetOf`), qué carga (`masterSeedFrom`) y qué se abre
  (`masterSectionsFor`, **por contenido**). `TimelineDetailModal.tsx` solo lee.
- **Formularios de comida**: el maestro, `MealModal` (rápido) y `MealEditModal`
  (el editor con IA), que el maestro hospeda cuando la comida ya existe. **Lo
  que comparten se comparte**: `MacroFields.tsx`, `MealCart.tsx` y los
  `parseBlankAs*` de `format.ts`. Un campo nuevo va ahí, no suelto en un modal.
- **Accesos rápidos**: `MealModal`, `CorrectionModal` y `QuickNumericModal.tsx`
  (uno solo, parametrizado, para Basal y Cetonas). Breves a propósito; cada uno
  ofrece la salida hacia el maestro.
- `FoodCard.tsx` — la tarjeta de un alimento, **la misma** en catálogo y
  carrito. Lo único que cambia es el control de la derecha: lápiz o X. Tocar el
  contenedor no edita.
- `StripCalendar.tsx` — la fila de días de Nutrición. Su aritmética vive en
  `entryTime.ts`.
- **Gráficos**: `GlucoseChart.tsx`, `SummaryCharts.tsx` (`react-native-svg`);
  `reportExport.ts` dibuja SVG inline para el PDF.
- `notifications.ts` — un canal de Android por tipo de alarma. Android congela
  sonido y vibración al crear el canal.
- `timelineVitals.ts` — las cetonas y vitales **sueltos** del timeline. Puro y
  con test: un `WHERE` de más los escondió, y son el dato de triage de CAD.
- `mealFields.ts` — qué campos **son** una comida. Puro y con test: un `false`
  de más borra historial. Un campo de comida nuevo en `UnifiedEntryInput` va
  acá. `promotesLooseCarbToMeal` decide cuándo un carbohidrato suelto pasa a
  ser un plato — o sea cuándo nace un episodio y suenan alarmas.
- `mealCarbMirror.ts` — qué fila de carbohidratos **es** una comida ya visible
  y cuál es un hecho propio. Puro y con test: esconder de más borra un dato de
  la vista, esconder de menos lo cuenta dos veces en el reporte médico.
- `entryTime.ts` — días, meses y la hora de un registro histórico. Puro porque
  "cuándo pasó" es la columna que agrupa episodios y recorta ventanas, y sus
  casos son de calendario (fin de mes, año, medianoche), no de pantalla.
- `dbWriteQueue.ts` — la **única** cola FIFO por la que pasa toda transacción
  de `db.ts`. Puro y con test. `expo-sqlite` abre el `BEGIN` dentro del `try`,
  así que dos transacciones solapadas no fallan limpio: la segunda hace un
  `ROLLBACK` ajeno y la primera termina escribiendo suelta. Dos colas no
  sirven; contra una conexión se anidan igual. La tarea de fondo no la usa
  porque abre su propia conexión (`backgroundSync.ts`, `useNewConnection`).
- `catalog-proposal.ts` (dominio) — qué propone la IA guardar al catálogo y
  **qué se rechaza con su razón**; puro y con test. Escribir directo daba dos
  fallas opuestas: alimentos descartados en silencio y porción siempre en
  100 g. `normalizationBasis` usa la porción típica de denominador cuando no
  hay gramos del plato; `confirmProposal` marca lo confirmado `'user'`, que es
  lo que `blendCatalogEntry` protege. Su pantalla: `CatalogServingModal.tsx`.
- `entryGroupClaim.ts` — promoción + edición como una sola transacción:
  relectura del grupo ganador, alineación del espejo y rollback conjunto. Puro
  y con tests de fallo, idempotencia y carrera; `db.ts` aporta el adaptador
  SQLite serializado sobre la conexión SQLCipher ya autenticada.
- En `db.ts`: `promoteEventToEntryGroup` (evento suelto → grupo, idempotente y
  sin perder identidad), `moveEntryGroupRows` (mover la hora, sin tocar
  `ingestedAt` ni una lectura externa) y `applyVitalsPatchRows` (parche, no
  reemplazo: corregir una cetona no borra el peso).
- `theme.ts` — todos los tokens. `branding.ts` — el logo, en una variable.
- `sensorConnection.ts` — cada usuaria conecta su propia cuenta LibreLinkUp.

## `docs/adr`

Append-only. `README.md` es el índice; nunca se renumera ni se borra un ADR.
