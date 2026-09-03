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
| `correction.ts`, `bolus.ts` | aritmética de dosis sobre parámetros que cargó la usuaria. Descuentan IOB **solo de la corrección** |
| `ai-safety.ts` | `containsTherapyRecommendation` — el filtro por el que pasa toda salida de IA |
| `freshness.ts` | `assessFreshness`; distingue `sourceTimestamp` de `ingestedAt` |
| `glucose-thresholds.ts` | 54/70/180/250 mg/dL. Nadie los redeclara |
| `glucose-metrics.ts`, `agp.ts` | TIR, HbA1c estimada, percentiles, perfil AGP |
| `episode-context.ts` | qué eventos caen en la ventana de un episodio |
| `episode-local-time.ts` | la hora que el resumen tiene derecho a citar: reescribe las marcas del episodio con desfase local **antes** de salir a la IA. El desfase se pide por marca, no se lee: el horario de verano existe |
| `macro-glucose.ts` | subida tardía por grasa+proteína, ajustada por covariables |
| `regression.ts` | OLS por ecuaciones normales. Centra al ajustar; sus β **no salen** de aquí |
| `nutrition-insights.ts`, `nutrition-targets.ts` | patrones de comida y metas. La de fibra es un **piso** (14 g/1000 kcal) y nunca se descuenta de los carbohidratos |
| `macros-source.ts` | `resolveMacrosSource()` — quién puso los macros de una comida. Se imprime en el reporte médico; ningún `.tsx` lo decide |
| `vitals-summary.ts` | cómo se lee un registro de vitales, con la banda de `assessKetones`. El componente elige el color; no decide qué es urgente |
| `insulin-catalog.ts` | catálogo de insulinas, su duración y su nombre. `undefined` si no está configurada — nunca un default silencioso |
| `food-catalog.ts` | `foodKey`, `blendCatalogEntry`; misma implementación en teléfono y servidor. `imageUri` es representación, nunca base de un macro. `listed` = "solo receta": ausente es visible, y visible gana al fusionar |
| `meal-cart.ts` | el carrito multi-alimento: suma líneas y declara qué macro falta. Su total es **estimación**; confirmarlo es un acto de la usuaria |
| `recipe.ts` | una receta y sus componentes. **Los totales se derivan, nunca se guardan**: corregir un alimento corrige todas las recetas que lo usan. Redondea igual que el carrito a propósito |
| `catalog-similarity.ts` | qué alimento del catálogo ya cubre uno recién identificado. **Solo propone**: emparejar mal mezcla macros de dos alimentos y eso sugiere carbohidratos sin delatarse |
| `iob.ts` | insulina activa: curva exponencial de LoopKit/OpenAPS. Se descuenta **solo de la corrección**, nunca de la comida. Sin insulina configurada devuelve `undefined`, no cero. Ver `docs/adr/0005` |
| `insulin-effect-curve.ts` | cuánto se movió la glucosa a 1..8 h de cada dosis, por tramo de **inicio de la inyección**. Descriptivo: no propone ni adopta. No sufre la censura de la dosis siguiente que sí afecta a `insulin-duration` |
| `insulin-duration.ts` | cuánto dura y cuándo pega su insulina, por tramo del día, sobre **toda** dosis rápida: ventana recortada en la siguiente, carbohidratos como covariable. Comparar y adoptar son cifras distintas. Ver `reference/insulin-duration-method.md` |
| `coverage.ts` | cuánto del rango elegido tiene datos. Separa "faltan días" (descriptivo) de "no alcanza para la HbA1c estimada" (clínico, 14 días de consenso) |
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
- **Modal Maestro**: `UnifiedEntryModal.tsx` crea **y** edita (`mode` dice cuál).
  Sus reglas puras están en `masterModal.ts`: dónde escribe cada tipo (`masterTargetOf`),
  qué carga (`masterSeedFrom`), qué se abre (`masterSectionsFor`, **por contenido**).
  `TimelineDetailModal.tsx` solo lee.
- **Formularios de comida**: el maestro, `MealModal` (rápido) y `MealEditModal` (con
  IA). **Lo que comparten se comparte** —`MacroFields.tsx`, `MealCart.tsx`,
  `MealAiFields.tsx`—: un campo nuevo va ahí, no en un modal.
- **Accesos rápidos**: `MealModal`, `CorrectionModal` y `QuickNumericModal.tsx`
  (uno solo, para Basal y Cetonas). Breves a propósito, con salida al maestro.
- `FoodCard.tsx` — la tarjeta de un alimento, **la misma** en catálogo y carrito;
  solo cambia el control de la derecha (lápiz o X) y tocar el contenedor no edita.
  Calorías en chip neutro: no son un macro. En el catálogo los chips son **por
  porción** y `macrosCaption` dice el denominador: otra base, otros cinco números.
- `RecipeFixModal.tsx` — la salida al "no se puede borrar", **todo o nada**.
  `RecipeDetail.tsx` — el detalle **en lugar de** la lista; "Usar en una comida" la
  expande al carrito, una línea por componente.
- **Agua** (2026-09-03): `WaterEventSchema` + tabla `water_events`; meta en
  `nutrition-targets.ts`; se registra desde el maestro, Comida y su acceso rápido;
  la IA la propone en `analysis.waterMl` y **ella confirma**. Un jugo es comida.
- `InsulinBreakdown.tsx` — de dónde sale la dosis, en los tres modales que calculan: con IOB descontada el total ya no se rehace con lo que se ve. Declara el activo que **no** se usó (ADR 0006).
- `knownFoods.ts` — qué nombres del catálogo viajan con un análisis (solo nombres,
  máx. 300) para que la IA reuse el exacto y no nazca un duplicado.
- `MealAiFields.tsx` — los **dos** cuadros de texto de la IA, en los tres
  modales: pista para la foto y corrección sobre lo propuesto (**no reenvía la
  foto**). Adoptar una propuesta invalida la dosis calculada.
- **Gráficos**: `GlucoseChart.tsx`, `SummaryCharts.tsx` (incluye `InsulinEffectCurve`, pequeños múltiplos con escala compartida); `reportExport.ts` dibuja SVG inline para el PDF.
- `notifications.ts` — un canal por alarma; Android congela sonido y vibración al crearlo. `timelineVitals.ts` — cetonas y vitales **sueltos**; un `WHERE` de más los escondió. Agua: mismo patrón, tabla propia.
- `mealFields.ts` — qué campos **son** una comida; un `false` de más borra historial.
  `promotesLooseCarbToMeal` decide cuándo un carbohidrato suelto pasa a ser un
  plato — o sea cuándo nace un episodio y suenan alarmas.
- `mealNote.ts` — la nota de una comida. `note` es `max(300)`: pasarse hace que Zod rechace la comida entera.
- `mealCarbMirror.ts` — qué carbohidrato **es** una comida visible; de menos se cuenta dos veces.
- `entryTime.ts` — días, meses y la hora de un registro histórico (y la aritmética
  de `StripCalendar.tsx`). "Cuándo pasó" agrupa episodios y recorta ventanas.
- `dbWriteQueue.ts` — la **única** cola FIFO por la que pasa toda transacción de
  `db.ts`. Puro y con test. `expo-sqlite` abre el `BEGIN` dentro del `try`: dos
  solapadas no fallan limpio — la segunda hace un `ROLLBACK` ajeno y la primera
  escribe suelta. La tarea de fondo abre la suya (`useNewConnection`).
- `catalog-proposal.ts` (dominio) — qué propone la IA guardar al catálogo y **qué
  se rechaza con su razón**. Escribir directo daba dos fallas opuestas: alimentos
  descartados en silencio y porción siempre en 100 g. `confirmProposal` marca lo
  confirmado `'user'`, que es lo que protege `blendCatalogEntry`.
- `entryGroupClaim.ts` — promoción + edición en una sola transacción: relectura del
  grupo ganador, alineación del espejo y rollback conjunto. Puro, con tests de fallo,
  idempotencia y carrera; el adaptador SQLite lo pone `db.ts`.
- En `db.ts`: `promoteEventToEntryGroup` (suelto → grupo, idempotente y sin perder
  identidad), `moveEntryGroupRows` (mover la hora sin tocar `ingestedAt`) y
  `applyVitalsPatchRows` (parche: corregir una cetona no borra el peso).

- `theme.ts` — tokens. `branding.ts` — el logo. `sensorConnection.ts` — su cuenta LibreLinkUp.

## `docs/adr`
Append-only. `README.md` es el índice; nunca se renumera ni se borra un ADR.
