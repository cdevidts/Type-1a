# Roadmap v0.2 — de MVP funcional a app robusta

Este documento existe para que una sesión de Claude Code futura (con contexto
en cero) pueda retomar este trabajo sin tener que re-explorar todo el repo de
nuevo. Es el registro persistente de la petición grande de Verónica del
2026-08-17, el diagnóstico que se hizo antes de tocar código, y el plan de
fases acordado. Actualízalo a medida que cada fase se completa — no lo dejes
desincronizado del código real.

Ver también [`CODE_MAP.md`](CODE_MAP.md) para el índice general del repo y
[`AGENTS.md`](../AGENTS.md) para las reglas de seguridad no negociables que
todo lo de acá abajo respeta.

## Contexto

El MVP (v0.1) ya corre de punta a punta: CGM real vía LibreLinkUp, backend
desplegado, APK instalable. Verónica pidió una lista larga de mejoras de
diseño y funcionalidad de una sola vez, pero explícitamente pidió que se
haga **por fases, no todo apurado en una corrida**. Este doc es ese plan de
fases, más los hallazgos de diagnóstico que lo sustentan.

## Hallazgos previos (no volver a investigar esto)

- **"El widget" = el `GlucoseCard` de la pantalla principal**, no un widget de
  Android home-screen. Se confirmó con Verónica: no existe ningún widget de
  sistema en el repo ni en su historial de git — nunca existió. No hay nada
  de Android nativo (`android/`) en el proyecto; es un proyecto Expo
  managed puro.
- **No existe backend de persistencia.** `apps/api` solo hace de proxy a
  CGM (Junction/LibreLinkUp) y a Abacus RouteLLM (`/v1/ai/meal-analysis`,
  `/v1/ai/glucose-insight`), más el link de Junction. Todo lo demás
  (insulina, carbohidratos, comidas, perfil de terapia, episodios) vive
  **solo en SQLite local** (`apps/mobile/src/db.ts`, cifrado con SQLCipher,
  clave en `expo-secure-store`). Esto es intencional (`docs/adr/0001-local-first.md`)
  y este plan lo mantiene así — no se agrega backend de cuentas/sync salvo
  que se pida explícitamente.
- **No existe autenticación en ningún endpoint del backend**, confirmado
  leyendo `apps/api/src/app.ts` completo. Relevante para el chat de IA: el
  backend no sabe "quién es el usuario" — el contexto histórico para el chat
  tiene que viajar desde el cliente en cada request, no vivir en el server.
- **El guardrail anti-recomendación-de-dosis (`containsTherapyRecommendation`,
  `packages/domain/src/ai-safety.ts`) es una lista de regex en español**,
  aplicada hoy solo en los dos endpoints de IA existentes. Cualquier
  feature de IA nueva (el chat) tiene que engancharse explícitamente a esto
  y probablemente ampliarlo (hoy no cubre inglés ni frases fuera de esos 4
  patrones).
- **Invariante confirmado y que hay que preservar siempre:** en ningún lugar
  del código actual una salida de IA se aplica sola — toda escritura a
  SQLite pasa por una acción explícita del usuario (confirmar, guardar,
  registrar). El chat de IA nuevo debe seguir exactamente este patrón:
  proponer, nunca escribir directo.
- **"Última lectura" nunca debe calcularse con `.at(-1)` a mano sobre el
  array de `CGMReading`.** El `domain-safety-reviewer` encontró que al
  agregar `origin:'imported'` (Fase 2), tanto `App.tsx` como `GlucoseCard.tsx`
  calculaban `latest` por separado con `readings.at(-1)`, sin filtrar
  `origin` — una fila importada con `sourceTimestamp` reciente (ej.
  importar el mismo día) se mostraba como "EN LÍNEA" y se precargaba sola
  en el calculador de corrección. Se centralizó en
  `packages/domain/src/freshness.ts` → `latestLiveReading()` (excluye
  `imported`, no `synthetic` — sintético sí es "actual" legítimo, solo que
  rotulado). **Cualquier lugar nuevo que necesite "la lectura actual" debe
  usar `latestLiveReading()`, nunca reimplementar la lógica.** Segunda
  vuelta del reviewer encontró que `GlucoseChart.tsx` tenía el mismo
  problema por su cuenta (dibuja el punto resaltado "Ahora" con
  `coordinates.at(-1)` sobre lo que le pasen, sin filtrar `origin`) —
  `GlucoseCard.tsx` le pasaba el array crudo. Se agregó `liveReadings()`
  (mismo archivo, mismo filtro) y ahora `GlucoseCard` le pasa
  `liveReadings(readings)` al gráfico. **Moraleja: cuando encuentres un
  patrón repetido (`.at(-1)` sobre `CGMReading[]`), busca TODOS los
  lugares donde se repite, no solo el que reportó el bug original.**
  **Cerrado y verificado por el reviewer en las tres superficies** (badge,
  autofill de Corrección, gráfico). Nota para el futuro, no un gap activo
  hoy: `CGMReading.origin` también acepta `'manual'`, y ni `liveReadings`
  ni `latestLiveReading` lo excluyen — hoy no hay ningún código que cree
  una lectura `origin:'manual'`, pero si se agrega una función de "ingreso
  manual de glucosa" más adelante, hay que decidir explícitamente si eso
  cuenta como "actual" o no, y probablemente extender el filtro.

## Bugs encontrados (van primero, antes que features nuevas)

### Bug 1 — Modal de corrección: no muestra el resultado ni guarda — ✅ RESUELTO (2026-08-17)

**Causa raíz diagnosticada** (no es una promesa no manejada ni un error de
red): `apps/mobile/src/components/CorrectionModal.tsx`, el `useEffect` que
resetea el formulario tiene como dependencias `[visible, latest, profile]`
— pero `latest` y `profile` son objetos **recién parseados de JSON en cada
refresh** (`App.tsx` → `loadLocalState`/`refresh`, disparado en cada
`AppState` a `'active'` y después de cada registro rápido), por lo que
cambian de *identidad* aunque el valor sea el mismo. Además, el propio botón
"Guardar parámetros y calcular" llama a `onSaveProfile` → `setProfile(...)`,
lo que cambia la identidad de `profile` **como efecto secundario de su
propio click** — puede disparar el reset justo después (o en vez) de
mostrar el resultado recién calculado. Por eso no hay mensaje de error: no
es un fallo, es el efecto de "modal recién abierto" re-disparándose solo.

**Fix aplicado:** `apps/mobile/src/components/CorrectionModal.tsx` — el
efecto de reset ahora usa un `useRef` para detectar la transición real de
`visible` de `false` a `true` (el modal recién se abrió), y solo
inicializa el formulario en ese momento. `latest`/`profile` siguen en las
dependencias (se leen dentro del efecto), pero ya no disparan un reset por
sí solos mientras el modal permanece abierto — ni por un refresh en
segundo plano, ni por el propio `onSaveProfile` de "Guardar y calcular".
**Confirmado en el dispositivo real por Verónica (2026-08-17): funciona.**

### Bug 2 — Análisis de foto de comida: HTTP 502 — ✅ RESUELTO (2026-08-17)

**Causa raíz real** (no era infra, era el schema): Abacus RouteLLM rechaza
en modo `json_schema` estricto la clave `$schema` (siempre) y, para el
schema de `meal-analysis` específicamente, también `minItems`/`maxItems`
en arrays anidados ("too many states for serving"). Verificado
directamente contra la API real de Abacus, probando cada combinación de
claves por separado — el schema de `glucose-insight` solo necesitaba sacar
`$schema`; el de `meal-analysis` necesitaba además sacar `minItems`/
`maxItems` (no `minimum`/`maximum`, que sí bastaban para el insight pero no
alcanzaban solos para el meal-analysis).

**Fix aplicado:** `packages/ai/src/abacus.ts` — nueva función
`sanitizeForStrictJsonSchema()` que saca esas claves del schema saliente
antes de mandarlo a Abacus, pero **solo en las posiciones reales de
keyword** (no dentro de `properties`, donde las claves son nombres de
campo de la aplicación, no keywords de JSON Schema — así un futuro campo
llamado literalmente "maximum" no perdería su descripción sin que nadie lo
note). La validación de la respuesta (`MealAnalysisSchema.safeParse` /
`GlucoseInsightSchema.safeParse`, con los límites reales intactos) no
cambió — sacar las claves del *hint* que le mandamos al modelo no debilita
lo que nosotros aceptamos después. Revisado por `domain-safety-reviewer`
dos veces (una por el fix, otra por el endurecimiento posterior).
**Redeploy verificado en producción por DeepAgent con una foto de comida
real: 200 OK end-to-end.** Confirmado también por Verónica en el
dispositivo.

## Mapeo de datos de MySugr (para la importación de historial)

CSV exportado: `mySugr_Exportar_202608171354.csv` (62 filas de eventos,
13-17 ago 2026). Columnas del export vs. lo que hoy existe en
`packages/schemas/src/index.ts` / `apps/mobile/src/db.ts`:

| Columna MySugr | Mapea a (hoy) | Gap a resolver |
|---|---|---|
| Fecha, Hora, Zona horaria | timestamp ISO de cualquier evento | parsear fecha en español + offset |
| Medición de azúcar (mg/dL) | `CGMReadingSchema`, `origin:'imported'` | ninguno — el schema ya soporta `imported` |
| Unid. bolo (pen/bomba) + Insulina (alimento) | `InsulinEventSchema` `type:'rapid'`, `source:'imported'` | ninguno — `source` ya acepta `imported` |
| Unid. basal | `InsulinEventSchema` `type:'basal'`, `source:'imported'` | ninguno |
| Insulina (corrección) | — | **falta** distinguir "bolo de comida" vs "bolo de corrección" dentro de un rapid — agregar `purpose?: 'meal'\|'correction'\|'combined'` opcional |
| Hidratos de carbono | `CarbEventSchema.carbsG` | **`source` no acepta `'imported'` hoy** — agregar al enum |
| Descripción de la comida | — | **`MealEventSchema` no tiene campo de texto libre** — agregar `note?: string` |
| Duración/intensidad/descripción de actividad, Pasos | — | **no existe ningún concepto de actividad física** — nuevo `ActivityEventSchema` + tabla |
| Apunte (nota suelta, sin comida asociada) | — | **no existe "nota" como evento independiente** — nuevo `NoteEventSchema` + tabla |
| Peso, Tensión arterial, Cetonas | — | **no existen** — nuevo `VitalsEventSchema` (todos opcionales) + tabla |
| HbA1c (%) | — | **no existe** — nuevo `HbA1cLabResultSchema` (medida de laboratorio, manual). **Debe quedar visualmente distinta** de cualquier HbA1c *estimada* que calculemos desde CGM (Fase de Resumen) — una es dato médico real, la otra es un cálculo nuestro. |
| Tipo de alimento | — | baja prioridad — se puede plegar dentro de `note` por ahora |
| Medicamento (no-insulina) | — | baja prioridad — `MedicationEventSchema` simple si se pide explícitamente |
| Lugar, Latitud, Longitud | — | **decisión: no se importa ni se implementa geolocalización**, por privacidad — se puede revertir si Verónica lo pide explícitamente |
| Porcentaje/duración de basal temporal | — | fuera de alcance — eso es función de bomba de insulina; este MVP modela solo inyecciones discretas (pen). Se importa como nota si aparece, no como dato estructurado. |

Ninguno de estos campos nuevos toca `TherapyProfileSchema` salvo el que sí
pidió explícitamente Verónica: agregar `carbRatio` (gramos de carbohidrato
por unidad de insulina rápida) — sigue siendo **valor ingresado por el
usuario**, nunca inferido del CSV ni de nada (regla no negociable de
`AGENTS.md`).

## El límite de seguridad que no se negocia (releer antes de la Fase 5 y la Fase 8)

Dos de los pedidos rozan la regla central de `AGENTS.md`
("Never let an LLM calculate, infer, or recommend insulin" /
"Never infer therapy parameters" / "Never implement insulin-on-board or
automatic dosing"):

- *"que la IA aprenda cómo reacciona el usuario a distintos inputs de
  comida y pinchazos"* — se implementa como **capa de insight descriptivo
  y retrospectivo únicamente** (ej.: "las comidas con arroz muestran un
  segundo pico a las 3h" o "las correcciones matutinas tienden a quedar
  altas"). **Nunca** retroalimenta `carbRatio` ni `correctionFactor`, ni
  ajusta una dosis calculada. Esos dos valores solo cambian cuando
  Verónica los edita a mano en Configuración.
- El cálculo "mira tu glucosa actual + cuenta los HdC → cuánto inyectarte"
  (Fase 5) es una **fórmula determinística nueva en `packages/domain`**
  (extensión de `correction.ts`, mismo patrón, mismo dueño: código, no
  IA), usando `carbRatio` y `correctionFactor` que Verónica ya configuró.
  La IA (cámara) solo estima gramos de carbohidrato — igual que hoy con
  `MealAnalysisSchema` — nunca calcula unidades de insulina.

Este documento asume que estas dos reformulaciones son aceptables; si
Verónica quisiera literalmente que la IA ajuste la dosis sola, eso está
fuera de lo que este proyecto puede construir sin violar `AGENTS.md`.

## Lecciones de la auditoría de la Fase 5 (2026-08-18) — releer antes de tocar cualquier cálculo de dosis

La primera versión de la calculadora de bolo pasó `pnpm verify` en verde y
aun así el `domain-safety-reviewer` encontró **tres fallas bloqueantes**.
Ninguna era un error de aritmética: las tres eran sobre *la procedencia de
los datos que alimentan la fórmula*. Ese es el patrón a vigilar.

1. **Un parámetro por defecto se ve idéntico a uno real.** `db.ts` sembraba
   `targetGlucose: 110, correctionFactor: 45` para tener algo que mostrar, y
   la pantalla nueva los usaba para calcular sin que Verónica los hubiera
   confirmado nunca. Una dosis calculada con un factor de fábrica se ve en
   pantalla exactamente igual que una correcta. Ahora existe la bandera
   `therapyConfiguredAt` (`isTherapyConfigured()`): **cualquier pantalla que
   convierta parámetros en unidades de insulina debe negarse a calcular
   mientras sea falsa**, y debe además mostrar en el resultado con qué
   parámetros calculó. Regla general: si un valor de terapia puede venir de
   un default, no alcanza con validarlo — hay que poder distinguir "el
   usuario lo eligió" de "venía puesto".
2. **`origin: 'manual'` no estaba decidido.** El roadmap ya había anotado en
   la Fase 2 que había que decidir explícitamente si una glucosa escrita a
   mano cuenta como "actual" *antes* de crear la primera; se creó sin
   decidir. Decisión tomada: **sí cuenta como actual** (un pinchazo de hace
   un minuto es el dato más fresco que existe, excluirlo haría que la
   calculadora ignore el mejor valor disponible), **pero nunca puede
   atribuirse al sensor**. Para eso está `isSensorReading()` (solo
   `origin: 'real'`): toda afirmación de procedencia ("EN LÍNEA", el nombre
   del proveedor, "precargada desde el sensor") tiene que pasar por ahí.
3. **Revalidar frescura contra la variable equivocada.** Los modales
   precargaban la glucosa desde `latest` al abrirse, pero al momento de
   calcular revalidaban `latest` — que ya no era la misma lectura, porque la
   app refresca al volver del segundo plano. Resultado: una lectura nueva
   "avalaba" un número viejo que seguía en el campo. Ahora se congela un
   snapshot `{glucose, sourceTimestamp, isSensor, isSynthetic}` en el
   momento del prefill y se valida **ese**. Regla general: si un valor se
   copió de una fuente que sigue cambiando, hay que guardar la fuente, no
   volver a leerla.

La segunda ronda de auditoría encontró que dos de esos tres arreglos estaban
solo a medias, lo cual es su propia lección:

- **Una bandera de "configurado" vale lo que valga el camino que la
  escribe.** La primera versión marcaba `therapyConfiguredAt` en cualquier
  `saveTherapyProfile`, pero el modal de Corrección también guarda — ahí
  guardar es un *efecto secundario* de pedir un número ("Guardar parámetros
  y calcular"), no un acto de configuración. Un solo toque sobre los
  defaults pre-llenados desbloqueaba permanentemente la calculadora de
  comida. Ahora solo la pantalla de Ajustes pasa `markConfigured: true`, y
  el modal de Corrección también se niega a calcular sin la bandera.
- **Arreglar procedencia puede romper frescura.** Al agregar el badge
  MANUAL se puso antes que el chequeo de `isStale`, así que una medición
  manual de hace 8 horas perdía el ATRASADO y quedaba con un badge calmado.
  Procedencia y frescura son ejes independientes: se componen
  (`MANUAL · ATRASADO`), no se rankean, y el color siempre lo gana el
  atraso. Regla: al agregar un estado visual nuevo a un indicador de
  seguridad, revisar que no *reemplace* a otro que ya estaba.

**Violación abierta conocida (pendiente, no la arregla la Fase 5)**: la
notificación fija de pantalla bloqueada (`apps/mobile/src/notifications.ts`)
muestra `${glucosa} ${flecha} mg/dL` sin marcar procedencia ni antigüedad, y
al ser fija nunca se refresca — una lectura sintética, manual o de hace
horas queda ahí pareciendo actual. Es la superficie de glucosa peor rotulada
que queda en la app. Arreglar junto con la Fase 7 (muestreo en segundo
plano), que es cuando esa notificación pasa a actualizarse de verdad.

Otras dos que valen como patrón: `saveUnifiedEntry` escribía 4-5 filas sin
transacción (un rechazo de schema a mitad dejaba una entrada a medias que al
reintentar se duplicaba, porque cada intento genera IDs nuevos — SQLite no
tiene transacciones anidadas, por eso existen los cores
`writeMealWithEpisode`/`writeCGMReading`); y una dosis ya copiada al campo
de insulina sobrevivía a cambiar los carbohidratos que la produjeron.

Sobre la corrección negativa (la decisión de diseño que se consultó
explícitamente): **se mantiene**. Sumar una corrección con signo y limitar a
0 solo el total es la convención estándar de las calculadoras de bolo, y
clampear cada componente por separado le daría una dosis *mayor* justo a
quien ya está bajo objetivo. La asimetría del error decide: sobreestimar
causa hipoglucemia (minutos, potencialmente grave), subestimar causa
hiperglucemia transitoria (horas, visible y corregible). Se agregó
`isHypoglycemic` (umbral 70 mg/dL — constante clínica, no un parámetro de
terapia del usuario; **no altera las unidades**, solo cambia el mensaje a
"trata la hipoglucemia primero"). No se puso tope a cuánto puede restar la
corrección inversa: ese tope sí sería un parámetro clínico y inventarlo
sería exactamente lo que `AGENTS.md` prohíbe.

## Bugs/gaps encontrados probando la Fase 2 en el dispositivo (2026-08-17)

Verónica importó su CSV real y reportó: no aparece ninguna glucosa en el
Timeline, y ningún ítem del Timeline se puede tocar para ver detalle o
editar. Investigado — **no es pérdida de datos**:

- **`getTimeline()` (`apps/mobile/src/db.ts`) nunca consulta `cgm_readings`.**
  Solo arma la lista desde `insulin_events`, `carb_events`, `meal_events` y
  `meal_episodes`. Esto es así desde antes de la Fase 2 — nunca fue
  específico del importador, ni de datos en vivo ni importados. Las
  glucosas importadas SÍ están en la base (se guardan vía
  `upsertCGMReadings`, ya idempotente), simplemente no hay ninguna pantalla
  que las liste hoy. Tampoco aparecen en el gráfico principal porque ese
  solo muestra la ventana de las últimas 3 horas — historial de días atrás
  no tiene dónde mostrarse todavía.
- **Ningún ítem de `Timeline.tsx` es tocable.** Están armados con `<View>`,
  no `<Pressable>` — cero detalle, cero edición, para cualquier tipo de
  evento (no es algo que rompió el importador, nunca existió).

Ambos son gaps reales de UX, agravados por la Fase 2: ahora mismo, después
de importar, no hay ninguna forma de verificar visualmente que la
importación funcionó — hay que confiar en el resumen de conteos. Se agregan
como ítems concretos al plan de fases (ver Fase 3).

## Plan de fases

Cada fase es un lote de trabajo independiente, verificable con `pnpm verify`
antes de pasar a la siguiente, y revisado por el subagente
`domain-safety-reviewer` cuando toca `packages/domain`, `packages/ai`,
persistencia de datos de salud, o `packages/cgm`.

| Fase | Contenido | Depende de |
|---|---|---|
| **0** | Fix bug modal de corrección (diagnosticado arriba). Diagnosticar bug 502 vía logs reales de DeepAgent y corregir. | — |
| **1** | ✅ **Completada (2026-08-17).** Fundación de datos: extender schemas (`carbRatio`, `note` en MealEvent, `purpose` en InsulinEvent, `source:'imported'` en CarbEvent, `ActivityEventSchema`, `NoteEventSchema`, `VitalsEventSchema`, `HbA1cLabResultSchema`) + tablas SQLite y funciones `save*`/`get*` en `db.ts`, siguiendo el patrón existente (id, timestamp, payload JSON, índice por timestamp). Primer archivo de test de `packages/schemas` (10 tests). Revisado por `domain-safety-reviewer` — sin hallazgos, todo confirmado inerte (nada de esto se usa aún en `packages/domain` ni en ninguna pantalla). No requiere build de APK (sin UI todavía). | 0 |
| **2** | ✅ **Código completado y auditado (2026-08-17), pendiente de correr en el dispositivo.** Importador del CSV de MySugr → historial local. Parseo/mapeo puro en `packages/domain/src/mysugr-import.ts` (17 tests, usando filas reales del CSV) + orquestador `importMySugrCsv()` en `db.ts` (idempotente vía IDs determinísticos — reimportar el mismo archivo no duplica). Botón nuevo en Ajustes ("Elegir archivo CSV de MySugr", usa `expo-file-system`'s `File.pickFileAsync`, 100% en el dispositivo, el CSV nunca sale del teléfono). Los eventos importados no crean `meal_episodes` (evita ráfagas de llamadas de IA sobre historial viejo). El `domain-safety-reviewer` encontró y se corrigió en el camino un bug real (lectura importada mostrándose como "en vivo" — ver hallazgo arriba). Falta: que Verónica corra la importación real con su archivo en el APK nuevo y confirme los conteos. | 1 |
| **3** | ✅ **Gráfico rediseñado (2026-08-17), robustecido a scroll multi-día (2026-08-18).** `GlucoseChart.tsx`: cada punto marcado, color según rango (rojo &lt;70, naranjo &gt;180, teal en rango); ejes Y con valores numéricos (70/180). **2026-08-18 — pedido explícito de Verónica ("como en MySugr, poder escrolear hacia atrás")**: la ventana de carga pasó de 3 horas a 30 días (`App.tsx`), el gráfico ahora vive dentro de un `ScrollView horizontal` con ancho proporcional a las horas de datos (30px/hora, mínimo 280px), auto-scrollea al extremo más reciente al abrir, y dibuja líneas verticales + etiqueta por cada cambio de día. Ya no se filtran los puntos importados antes de graficar (antes `GlucoseCard` pasaba `liveReadings(readings)`; ahora pasa `readings` completo) — es correcto porque un gráfico de tendencia multi-día debe mostrar el historial importado en su posición temporal real; lo que nunca debe pasar es que se lo marque como "ahora", y eso lo sigue garantizando `latestLiveReading` para el punto de énfasis "Ahora". **Hallazgo del `domain-safety-reviewer` (ronda dedicada a este cambio) y ya corregido**: con 30 días de datos a ~5min de intervalo (~8600 puntos) el thinning de marcadores (`MAX_MARKERS=300`) dejaba tramos importados de horas sin ningún punto hueco visible — la polyline compartida no distinguía origen, así que un tramo importado largo podía verse idéntico a uno en vivo. Fix: la polyline ahora se parte en segmentos contiguos por `origin`, cada uno con su propio `<Polyline>` — tramos importados en `colors.muted`, punteados (`strokeDasharray`), opacidad reducida; tramos en vivo en teal sólido. **Lección para el futuro**: cualquier codificación visual "esto es importado/sintético" que dependa de un subconjunto de puntos (markers, badges puntuales) puede desaparecer con el thinning/zoom — la distinción tiene que vivir también en cualquier trazo continuo (líneas, áreas) que una esos puntos, no solo en los marcadores discretos. **2026-08-18 (cont.) — cerrados los dos pendientes chicos de Fase 3**: (a) los `synthetic` ahora se distinguen en el Timeline (sufijo "· sintético", tono `warning`, igual que el badge de GlucoseCard) y los `imported` recibieron tono `muted` propio (antes compartían el `teal` de un dato en vivo, solo distinguibles por texto) — alinea el Timeline con el tratamiento punteado/atenuado que ya usa GlucoseChart; (b) los ítems del Timeline ahora son `Pressable` y abren `TimelineDetailModal` (nuevo componente, solo lectura) con los campos completos del evento subyacente (`raw` en `TimelineItem`) — insulina muestra tipo/unidades/propósito, comida muestra macros e IA-vs-confirmado por separado, glucosa muestra `sourceTimestamp` e `ingestedAt` como filas separadas (nunca colapsadas, por la regla de AGENTS.md), episodio muestra métricas + insight completo. Revisado por `domain-safety-reviewer` sin hallazgos bloqueantes. Sigue pendiente (no bloqueante, anotado por el propio reviewer): la mezcla de las 5 queries con `LIMIT` + slice puede dejar que la densidad de CGM saque de vista eventos de insulina/comida una vez que haya varios días de historial real — resolver antes de confiar en el Timeline como "ya registré esto". Pendiente confirmar en dispositivo. | — (independiente, se puede hacer en paralelo a 1-2) |
| **4** | ✅ **Completada (2026-08-18).** Configuración de terapia en `SettingsModal`: `targetGlucose`, `correctionFactor`, `doseIncrement` y `carbRatio` ahora editables en una sección nueva ("Parámetros de terapia"), con el mismo patrón de validación (`parsePositiveNumber`, `doseIncrement` ≤ 1 U) y de guardado (`onSaveProfile` → `saveTherapyProfile`) que ya usaba `CorrectionModal`. Reutiliza el fix del bug de reseteo de Fase 0 (`wasVisibleRef`-gated: solo reinicializa los campos en la transición real de apertura del modal, no en cada re-render del padre). Revisado por `domain-safety-reviewer`: sin hallazgos — confirma que no hay ningún cálculo/inferencia de estos valores (siempre vienen de `TextInput`), que `parsePositiveNumber` rechaza cero/negativos/NaN correctamente, y que `TherapyProfileSchema.parse` en `db.ts` re-valida como segunda barrera. Pendiente confirmar en dispositivo. | 1 |
| **5** | ✅ **Completada (2026-08-18).** Flujo unificado de registro. **Pedido explícito de Verónica** (con screenshots de MySugr): "no así como que es una entrada por cada tipo distinto, debería poder ponerse todo en una entrada", con un botón calcular "en base a tu cálculo, no con inteligencia artificial". Implementado: botón primario "Nueva entrada" → `EntryModal.tsx`, un solo formulario con hora, glucemia (precargada del CGM si está vigente, editable), descripción de la comida, foto opcional (IA solo estima gramos), carbohidratos confirmados, calculadora de dosis, insulina rápida, insulina de acción prolongada y nota. Todo se guarda con `saveUnifiedEntry()` (`db.ts`) bajo **un mismo timestamp**, así el Timeline lo lee como un solo momento y no como 4 filas sueltas. Los atajos de un dato (Carbos/Rápida/Basal/Corrección) siguen existiendo. Cálculo nuevo: `packages/domain/src/bolus.ts` → `calculateMealBolus()`, 8 tests. **Decisiones de seguridad tomadas acá (releer antes de tocar la calculadora)**: (1) la dosis calculada **nunca** se auto-completa en el campo de insulina — hay un botón "Usar N U" que la copia y el valor queda editable; lo que se guarda es siempre lo que el usuario escribió, no lo calculado; (2) si `carbRatio` no está configurado, la app **se niega a calcular** el componente de comida y manda a Ajustes — nunca sustituye un valor propio (sería inferir un parámetro de terapia); (3) con 0 carbohidratos no se llama a `calculateMealBolus` sino al `calculateCorrection` que ya existía; (4) la frescura de la lectura CGM se re-verifica en el momento de calcular, no solo al abrir el modal — una lectura que se puso vieja con el modal abierto no puede empujar una dosis; (5) sigue sin haber IOB y el aviso lo dice explícitamente. | 4 |
| **6** | ✅ **Completada (2026-08-18).** `scheduleEpisodeNotifications` ahora recibe los offsets en vez de tenerlos hardcodeados; se guardan en `app_settings` (`getMealAlarmOffsets`/`saveMealAlarmOffsets`, default 60/120/180 min, el mayor del set marca "episodio listo"). Nuevo mecanismo separado para correcciones: `scheduleCorrectionReminder()`, opt-in (apagado por defecto), un solo recordatorio "revisa tu glucosa" tras registrar una corrección — **no calcula ni sugiere nada**, es solo un tap-to-open. Decisión de diseño deliberada: **sin botones de acción rápida** en esa notificación (a diferencia de la de acceso rápido), para no facilitar apilar una segunda dosis con un solo toque sin haber vuelto a mirar la app. Sección nueva "Alarmas" en Ajustes, con el mismo patrón `wasVisibleRef` de reset-solo-al-abrir que el resto del modal. | — |
| **7** | Muestreo autónomo de glucosa (mínimo 10/día aunque el usuario no abra la app). **Aclaración 2026-08-18** (Verónica preguntó si esto ya pasaba, porque ve una lectura cada ~15 min): no, Type 1A no recolecta nada en segundo plano hoy — `App.tsx` solo llama `fetchCGMReadings` al montar y cuando `AppState` pasa a `'active'` (`App.tsx:162`), y no hay `BackgroundFetch`/`TaskManager`/cron en ningún lado del repo (verificado por grep en `apps/mobile` y `apps/api`). Lo que ella ve tiene dos explicaciones posibles según el proveedor activo: (a) si está en modo sintético, `MockCGMProvider.getReadings()` (`packages/cgm/src/mock.ts:28-39`) calcula una lectura determinística cada 5 minutos **al vuelo**, para cualquier rango de fechas pedido — no es una lectura "tomada", es una fórmula evaluada retroactivamente; (b) si tiene LibreLinkUp real conectado, el sensor Libre sube directo a la nube de LibreView cada ~15 min por su cuenta (infraestructura de Abbott, no de Type 1A) — el backend solo hace de proxy y pide lo que ya está guardado ahí cuando la app abre. En ambos casos, si la app estuviera cerrada varios días y la abrieras, verías el historial completo igual (viene de la fuente, no de que Type 1A lo haya ido guardando) — pero cualquier cosa que dependa de que Type 1A *reaccione* mientras está cerrada (alertas de glucosa alta/baja, Fase 10) sí necesita esta fase de verdad. **2026-08-18 (cont.) — primera implementación real**, motivada por el reclamo de Verónica de que la notificación fija ("widget") no servía si no se actualizaba: `apps/mobile/src/backgroundSync.ts` (nuevo) registra una tarea real con `expo-background-task`/`expo-task-manager` (`minimumInterval: 15` min — piso de Android, no garantía; el SO puede demorarlo más bajo Doze/ahorro de batería). Cada corrida trae CGM reciente y lo guarda local, y si la notificación de acceso rápido está activada, la reposta con datos frescos vía `postQuickEntryNotification()` (extraído de `notifications.ts`, comparte código con la ruta desde la UI). Se activa solo cuando el usuario prende esa notificación (persistido en `app_settings`), y `App.tsx` se auto-repara el registro en cada arranque por si el SO limpió el `WorkManager`. **Riesgo señalado por el `domain-safety-reviewer`, pendiente de probar en dispositivo real**: la tarea abre la base SQLite con `SQLite.openDatabaseAsync` directamente (no vía `SQLiteProvider`), y en Android un background task headless corre en una instancia JS separada de la app en primer plano — son dos conexiones SQLCipher independientes al mismo archivo cifrado, no una sola compartida. WAL ayuda pero no está probado que sea seguro bajo SQLCipher con dos conexiones concurrentes. **Antes de confiar en esto**: disparar la tarea manualmente mientras la app está en primer plano escribiendo una entrada, y confirmar que no hay corrupción ni pérdida silenciosa de datos. Investigar factibilidad real de background fetch en Expo/Android (hay límites del SO, puede necesitar caer a "al abrir/reanudar la app" como estrategia principal en vez de cron verdadero en segundo plano) antes de prometer una cadencia exacta. | — |
| **8** | Chat de IA: endpoint nuevo en `apps/api` sobre RouteLLM, sin autenticación de por medio (el cliente manda el contexto histórico relevante en cada request, el backend sigue sin estado), guardrail extendido de `ai-safety.ts`, y todo lo que el chat "proponga" pasa por confirmación explícita del usuario antes de tocar SQLite — mismo patrón que ya existe en todo el resto de la app. | 1, 6 (para poder proponer recordatorios) |
| **9** | ✅ **Completada (2026-08-19), reforzada (2026-08-19).** Reportes Excel/PDF, generados en el dispositivo (`expo-print` para PDF, `xlsx`/SheetJS para Excel, `expo-sharing` para compartir) para mantener el local-first. **Pedido explícito de Verónica**: la tabla original (una fila por lectura de glucosa) hacía que 7 días fueran ~11 páginas solo de glucosa — reemplazada por un gráfico diario. Ver detalle abajo. | 1, 2 |
| **10** | Alertas de glucosa alta/baja por umbral. | 7 (necesita datos frescos aunque la app esté cerrada) |
| **11** | ✅ **Completada (2026-08-19).** Pantalla "Resumen" con tres sub-páginas (Días / Métricas / Comidas), abierta desde el botón ◔ de la barra superior. Time in Range real por las cinco bandas de consenso, HbA1c estimada (GMI, rotulada como *estimada* y separada de la `HbA1cLabResultSchema` de laboratorio), variabilidad (CV%), promedio, gráficos diarios y día promedio ponderado en formato AGP con selector de 7/14/30/90 días. Motor en `glucose-metrics.ts` + `agp.ts`; todo también incorporado al reporte PDF/Excel. Ver detalle abajo. | 1, 2, 7 |
| **12** | 🟡 **Parte descriptiva completada (2026-08-19)**, en la sub-página "Comidas" del Resumen: patrones por franja horaria (`nutrition-insights.ts`) — promedio de carbohidratos confirmados e insulina por franja, y % de dosis rápidas seguidas de una lectura en rango a 1/2/3 h, con mínimo de muestra y advertencia de que es observacional. Pendiente el resto de la fase: insights conversacionales//adaptativos vía el chat (depende de la Fase 8). Nunca ajusta dosis. | 8, 11 |
| **13** | 🟡 **Grupos A, B y C completados (2026-08-19)**. Grupo A: ítems 1, 2, 4, 9 y 11. Grupo B: ítems 3, 5, 10a y 12. Grupo C: ítems 7, 8 y **la conexión al sensor por usuaria** (ver § "Conexión al sensor" más abajo — se descubrió que la app era de un solo usuario). Queda pendiente el ítem **10b** (elegir mmol/L, que resultó ser un cambio de modelo de datos y no de presentación). El ítem 6 no es construible hasta la Fase 8 (chat). Ver detalle abajo. | 11 |

| **14** | ✅ **Completada (2026-08-20).** Pantalla de Nutrición: metas de calorías/macros y patrones de grasa/proteína vs. glucosa tardía. Ver detalle abajo. | 1, 7 |
| **15** | ✅ **Completada (2026-08-20).** La IA estima todos los macros (foto y texto) y arma el catálogo propio de alimentos. Ver detalle abajo. | 14 |
| **16** | ✅ **Completada (2026-08-20).** Barra inferior, swipe y sistema de iconos. Reorganiza la navegación entera y reemplaza los glifos Unicode por iconos SVG reales. **Todo JS: no necesita build nativo.** Ver detalle abajo. | 14, 15 |
| **17** | 🟡 **Solo comidas, construido.** Editar entradas con la misma potencia que crearlas, incluida la IA en modo edición (foto, texto, y "explícale el cambio"). Ver detalle abajo — el alcance completo (glucosa automática, entrada empaquetada) quedó en la **Fase 21**. | 15 |
| **18** | **Catálogo de comidas editable** (pantalla propia), porciones, y la pregunta de "¿editar la del catálogo o crear una nueva?". Ver detalle abajo. | 15, 17 |
| **19** | **Notificaciones distinguibles**: un icono, un color y un título propios por tipo de alarma. **Necesita build nativo** (los iconos de notificación de Android son recursos drawable). Ver detalle abajo. | 16 (usa el sistema de iconos) |
| **20** | **Widget de pantalla de inicio** 4×3. **Necesita build nativo** (config plugin). Ver detalle abajo. | 8 (para los accesos al chat), 16 |
| **21** | 🟡 **Ampliada 2026-08-22.** Un solo tipo de entrada, editable con el mismo poder que crearla — colapsa `insulin`/`carbs`/`meal`/`glucose`/`note`/`entry` en un concepto: cualquier valor guardado es una entrada con el resto de campos vacíos. Incluye que el botón "Carbos" deje de ser un número suelto y abra la sección de comida. Ver detalle abajo. | 17 |
| **22** | **Animación del swipe entre pantallas.** El gesto ya navega (corregido 2026-08-21); falta que la pantalla siguiente se vea aparecer mientras se desliza, en vez de saltar de golpe al soltar. Ver detalle abajo. | 16 |
| **23** | **Episodio post-comida no reconoce insulina adicional dentro de la ventana** (ej. una corrección a los 90 min). El insight de IA describe la bajada sin saber que hubo una segunda dosis. Ver detalle abajo. | 12 |
| **24** | **Los gráficos de reportes deben mostrar los eventos**, no solo la curva de glucosa. Enfoque **a conversar con Verónica antes de construir** — dos ideas sobre la mesa, ninguna decidida. Ver detalle abajo. | 9 |
| **25** | **Bug: un número de dos dígitos pierde el primero al escribirlo**, en varios modales. Hipótesis: `selectTextOnFocus` + re-render en cada tecla. Necesita reproducirse en dispositivo. Ver detalle abajo. | — |

No se numeró por prioridad de negocio sino por dependencia técnica — el
orden de ejecución real se acuerda con Verónica fase por fase, no se asume.

## Detalle de la Fase 9 (2026-08-19) — reportes PDF/Excel

Nueva sección "Reportes" en `SettingsModal`: exporta el historial local
(glucosa, insulina, carbohidratos, comidas, actividad, notas, vitales, HbA1c
de laboratorio) a PDF o Excel, generado 100% en el dispositivo, para llevar
a un control médico. Nada se sube a ningún servidor — coherente con
`docs/adr/0001-local-first.md`.

- `packages/domain/src/report.ts` → `buildReportRows()`: puro y
  determinístico, sin IA ni red. Convierte los eventos ya guardados en filas
  de texto ordenadas cronológicamente. **A propósito no calcula nada**
  (ni Time in Range, ni HbA1c estimada, ni ningún agregado clínico) — eso
  vive aparte, en `glucose-metrics.ts` (Fase 11, detalle más abajo), y
  mezclarlo acá habría arriesgado presentar un cálculo propio de la app
  junto a datos crudos sin la distinción que exige AGENTS.md. Nunca colapsa
  `confirmedCarbsG`/`aiEstimatedCarbsG` de una
  comida en un solo número — ambos aparecen por separado en el detalle de la
  fila cuando están presentes. La procedencia de cada lectura de glucosa
  (`glucoseProvenance`) usa las mismas cuatro categorías que
  `glucoseOriginSuffix` en `db.ts`/`isSensorReading` en `freshness.ts` —
  "Sensor" solo para `origin: 'real'`, nunca para manual/importado/sintético.
- `apps/mobile/src/db.ts`: tres getters de rango nuevos siguiendo el patrón
  ya usado por `getCGMReadings`/`getActivityEvents`/etc. —
  `getInsulinEvents`, `getCarbEvents`, `getMealEvents` (antes solo existían
  variantes acotadas como `getRecentRapidInsulin`/`getInsulinEventsForMeal`,
  pero un reporte necesita el rango completo arbitrario que pida el usuario).
- `apps/mobile/src/components/SettingsModal.tsx`: selector de rango (7/30/90
  días o "Todo" — reutiliza el patrón de chips `styleGrid`/`styleChip` que
  ya existía para el estilo de alerta de recordatorios, en vez de introducir
  un control nuevo) + dos botones ("Exportar PDF"/"Exportar Excel"). La
  construcción del HTML/workbook vive en `apps/mobile/src/reportExport.ts`
  (extraído del componente, ver más abajo). Ambos se comparten con
  `expo-sharing`. Sin datos → mensaje explícito en vez de generar un archivo
  vacío.
- Sin selector de fecha nativo (no hay dependencia de date-picker en el
  repo todavía) — los cuatro rangos preestablecidos cubren el caso real
  (un tramo reciente para un control) sin agregar una dependencia solo para
  esto.

### Rediseño (2026-08-19) — gráficos diarios en vez de tabla de glucosa

**Pedido explícito de Verónica**, probando el reporte real: con CGM cada
5–15 min, un rango de 7 días ya listaba ~2000 filas de glucosa — la tabla
HTML original (`expo-print`) las paginaba en ~11 páginas ilegibles antes de
llegar a nada más. Reescrito en `apps/mobile/src/reportExport.ts`:

- La glucosa ya no es una fila por lectura. `groupReadingsByDay()` agrupa por
  día calendario (hora local) y cada día se grafica como un SVG inline
  (`dailyChartSvg()`) embebido en el HTML del PDF: eje X en horas (00:00 a
  24:00, marcas cada 3h), banda sombreada en el rango objetivo 70–180 mg/dL,
  punto por lectura coloreado según banda (mismo criterio de color que
  `GlucoseChart.tsx` en la app: rojo/teal/naranjo), atenuado (`opacity 0.5`)
  si es `origin:'imported'` — mismo tratamiento visual que ya usa el gráfico
  en vivo, para no perder la distinción real/importado que exige AGENTS.md.
  Como en `summarizeGlucose()`, las lecturas `origin:'synthetic'` se excluyen
  del todo, no se dibujan ni atenuadas.
  `expo-print` renderiza SVG embebido sin dependencias nuevas.
  Insulina/carbohidratos/comidas/actividad/notas/vitales/HbA1c de
  laboratorio siguen en una tabla debajo de los gráficos — mucho más corta
  sin las filas de glucosa, y es de ahí que salía casi todo el volumen
  original.
- `apps/mobile/src/types.ts`: nuevo tipo `ReportExport = { rows, readings }`
  — `App.tsx`'s `exportReport()` ahora devuelve también las `CGMReading[]`
  crudas (ya las estaba consultando para `buildReportRows`), no solo las
  filas aplanadas, porque el gráfico diario y el resumen de la Fase 11
  necesitan la glucosa estructurada (valor + `sourceTimestamp` + `origin`),
  no el string ya formateado que trae cada `ReportRow`.
  `SettingsModal.tsx` quedó sin la construcción de HTML/workbook (movida a
  `reportExport.ts`), solo orquesta rango → `onExportReport` → compartir.
- El Excel también ganó una hoja "Resumen" (Fase 11) antes de la hoja
  "Reporte" de siempre — el Excel nunca tuvo el problema de páginas (es
  tabular por naturaleza), así que ahí la tabla de glucosa completa se
  mantiene sin cambios; el gráfico diario es exclusivo del PDF.
- Tests nuevos en `apps/mobile/src/reportExport.test.ts`: exclusión de
  sintéticos en el conteo de puntos del SVG, atenuación de importados,
  rótulo de HbA1c estimada siempre distinto del de laboratorio, hoja
  "Resumen" del Excel con los mismos números.

## Detalle de la Fase 11 (2026-08-19) — resumen clínico (TIR + HbA1c estimada)

**Pedido explícito de Verónica**, en la misma corrida que el rediseño del
reporte de la Fase 9: aprovechar para implementar la Fase 11 (Time in Range +
HbA1c estimada) e incorporarla al reporte. Se hizo el motor de cálculo
completo, pero **no** la pantalla "Resumen" independiente que la fase
original describe — eso queda pendiente si se quiere ver esto también dentro
de la app, no solo en el PDF/Excel exportado.

- `packages/domain/src/glucose-metrics.ts` (nuevo) → `summarizeGlucose()`:
  puro y determinístico, sin IA ni red, mismo patrón que `report.ts`. Agrega
  sobre lecturas ya guardadas: Time in Range por banda ATTD/ADA (muy
  bajo &lt;54, bajo 54–69, objetivo 70–180, alto 181–250, muy alto &gt;250
  mg/dL — constantes nuevas en `glucose-thresholds.ts`), promedio,
  desviación estándar, coeficiente de variación, y HbA1c **estimada** vía
  `estimateA1cFromMeanGlucose()` (fórmula GMI de Bergenstal et al., Diabetes
  Care 2018: `3.31 + 0.02392 × promedio_mg/dL`).
- **Decisión de seguridad**: `summarizeGlucose()` excluye `origin:'synthetic'`
  de todo el cálculo (no solo lo rotula — lo saca antes de promediar). Son
  datos fabricados por `MockCGMProvider` para desarrollo; mezclarlos en un
  promedio o TIR real corrompería silenciosamente el número mostrado, aunque
  cada fila individual ya esté rotulada "Sintético" en la tabla de eventos.
  `manual`, `imported` y `real` sí se incluyen — son glucosa efectivamente
  medida. Si no queda ninguna lectura elegible, devuelve `null` en vez de un
  resumen con ceros engañosos. 10 tests nuevos en
  `packages/domain/test/glucose-metrics.test.ts`, revisado por
  `domain-safety-reviewer` sin hallazgos.
- **HbA1c estimada vs. de laboratorio**: dondequiera que se muestra el valor
  de `summarizeGlucose()` dice explícitamente "HbA1c estimada (GMI)" con una
  nota al pie citando la fórmula y aclarando que no reemplaza una medición de
  laboratorio; una `HbA1cLabResultSchema` real, si existe en el rango, sigue
  apareciendo por separado como "HbA1c (laboratorio)" en la tabla de eventos
  del reporte (comportamiento de la Fase 9, sin cambios) — nunca se
  colapsan en un solo número.
- Con menos de 14 días de cobertura (`daysCovered`), el reporte muestra una
  advertencia de cobertura limitada en vez de presentar la HbA1c estimada
  como si fuera igual de confiable con 2 días que con 30 (consenso ADA/ATTD:
  la fórmula GMI es más confiable con 14+ días de CGM continuo).
- Integrado en `apps/mobile/src/reportExport.ts` (ver detalle de la Fase 9
  arriba): sección "Resumen clínico" al inicio del PDF y hoja "Resumen" en
  el Excel, antes de los gráficos diarios/tabla de eventos.
- Pendiente real de la Fase 11 original: pantalla "Resumen" en la app (fuera
  del flujo de exportar reporte) y conteo de eventos de hipo/hiperglucemia
  como métrica aparte — no se hicieron en esta corrida.

## Detalle de la pantalla "Resumen" (2026-08-19) — Fases 11 y 12 descriptiva

**Pedido explícito de Verónica**: "haz la pantalla nueva, es muy importante",
dividida en tres sub-páginas. Se construyó como `SummaryModal`, un
`ModalShell` con barra de pestañas — **no se agregó librería de navegación**;
la app sigue siendo una pantalla con modales. Se entra por un botón ◔ nuevo
en la barra superior, al lado del de ajustes (no compite con "Nueva entrada",
que sigue siendo la única acción primaria dominante).

Un **único selector de rango 7/14/30/90 días** gobierna las tres sub-páginas,
en vez de uno por gráfico: es como funcionan los reportes de CGM
(LibreView/Clarity), donde el período de reporte es uno solo. Por defecto 14
días, que es el mínimo de consenso para que la HbA1c estimada y el perfil
promedio sean representativos.

- **Días** — un gráfico por día, 00:00 a 24:00, con la banda objetivo 70–180
  sombreada, grilla cada 6 h y etiquetas de hora; cada punto coloreado por su
  banda y atenuado si es historial importado. Encabezado por día con su % en
  rango y su número de lecturas. Tope de 30 días dibujados
  (`MAX_DAY_CHARTS`) para no montar 90 gráficos de una.
- **Métricas** — cuatro *stat tiles* (HbA1c estimada, promedio, tiempo en
  rango, CV), la barra apilada de Time in Range con las cinco bandas y sus
  metas de consenso ATTD/ADA al lado, y el **día promedio ponderado**.
- **Comidas** — los patrones por franja horaria de `nutrition-insights.ts`.

### Decisiones que conviene no volver a discutir

- **El día promedio es un AGP, no un promedio simple.** Verónica pidió "cómo
  se vería un día cualquiera promediando tus valores a las distintas horas".
  Un promedio aritmético por franja horaria habría sido lo literal, pero
  esconde justamente lo que importa: dos días, uno a 60 y otro a 240 mg/dL,
  promedian 150 = "en rango". Se implementó el formato **AGP** (percentiles
  p05/p25/p50/p75/p95 sobre un día compuesto de 24 h, `packages/domain/src/agp.ts`),
  que es el estándar del consenso ATTD/ADA y lo que ya muestran LibreView y
  Dexcom Clarity — así el gráfico se lee en una consulta médica sin traducción.
  La mediana responde la pregunta original ("un día cualquiera"); las franjas
  agregan la variabilidad que un promedio habría borrado.
- **Franjas de 30 min** (48 por día): con CGM cada 5 min, 14 días dan ~84
  lecturas por franja — suficiente para percentiles estables sin aplanar el
  pico post-desayuno.
- **La paleta de bandas se validó, no se eligió a ojo.** `glucoseBands` en
  `theme.ts` pasó por el validador de la skill `dataviz`. El primer intento
  (dos rojos para bajo/muy bajo) **falló**: ΔE de 13.1 para visión normal,
  bajo el piso de 15 — dos bandas clínicas distintas que se veían casi
  iguales. Se reencuadró como tres hues de estado (bajo/en rango/alto), cada
  uno con un segundo paso más oscuro para el nivel severo, formando rampas
  secuenciales monótonas en luminosidad. Se acepta a conciencia un único
  FAIL: el piso de croma del teal de marca, documentado en `theme.ts`.
  **Aprendizaje general: validar la paleta con el script antes de escribir el
  gráfico, no después** — rehacer el color con el SVG ya escrito cuesta el
  doble.

### La sub-página "Comidas" y su frontera de seguridad

Es la parte más delicada de toda la app hasta ahora, porque roza el límite
que `AGENTS.md` protege. Muestra, por franja horaria: promedio de
carbohidratos **confirmados** (nunca los estimados por IA), promedio de
insulina rápida y basal registrada, y el **% de dosis rápidas tras las cuales
había una lectura en rango 70–180 mg/dL a 1, 2 y 3 horas**.

Cómo se mantuvo del lado correcto de la línea:

- Se redacta siempre como **descripción de lo que pasó**, nunca como
  evaluación de si una dosis fue adecuada ni como sugerencia de cambiarla.
  El título es "Glucosa en rango objetivo después de una rápida", no
  "eficacia de tu insulina" — esa segunda formulación implica causalidad y
  adecuación de dosis, y era exactamente la trampa a evitar.
- **Nunca se deriva un parámetro de terapia** de estos porcentajes. Sería la
  inferencia que `AGENTS.md` prohíbe.
- **Mínimo de muestra** (`MIN_SAMPLE_FOR_RATE = 3`): con menos dosis no se
  muestra porcentaje, se muestra cuántas faltan. Con 1-2 dosis, "50% en
  rango" es ruido presentado como patrón — en una app de salud eso es
  peligroso, no solo impreciso. El `n` viaja siempre junto al porcentaje.
- Una dosis sin lectura cerca del horizonte (±20 min) **no cuenta**, en vez
  de asumir un valor.
- Aviso visible y permanente de que es observacional, que la glucosa a esa
  hora también depende de comida, actividad, estrés, basal y sitio de
  inyección, y que **Type 1A nunca calcula ni recomienda insulina**: los
  cambios se deciden con el equipo clínico. El mismo aviso viaja al PDF y a
  la hoja "Patrones" del Excel (con test que lo verifica).

### Hallazgos del `domain-safety-reviewer` en esta corrida (y qué enseñan)

La revisión encontró tres cosas reales. Vale registrarlas porque las tres son
tipos de error que se van a repetir:

1. **Doble conteo de carbohidratos.** `buildNutritionInsights` sumaba los
   `CarbEvent` de la franja *más* los `confirmedCarbsG` de las comidas — pero
   `writeMealWithEpisode` (db.ts) escribe **siempre** un `CarbEvent` con
   `source:'meal_confirmed'` al mismo timestamp que el `MealEvent`, y el
   importador de MySugr hace lo mismo. Cada plato confirmado se contaba dos
   veces: un promedio ~20% inflado, con un `n` inflado que además lo hacía
   parecer mejor respaldado. Y se imprimía en el PDF que va al control
   médico. **Lección: en este esquema hay datos duplicados a propósito
   (`db.ts` lo documenta como "a second copy of the same fact"). Antes de
   agregar dos fuentes de lo mismo, verificar en `db.ts` si una ya incluye a
   la otra.** Corregido: la comida solo aporta si no hay `CarbEvent` a su
   timestamp, con test de regresión del par exacto.
2. **Una métrica de "logro" que escondía la dirección del fallo.** El
   "% en rango a 1/2/3 h" colapsaba hipoglucemia e hiperglucemia en el mismo
   número, dibujado como una barra teal que se llena, justo debajo del
   promedio de insulina de la franja. Aunque el texto no sugería nada, la
   lectura inevitable era "poca barra = me falta insulina" — cuando los
   fallos podían haber sido hipos. **Lección: en esta app, un disclaimer no
   arregla una visualización que invita a la inferencia equivocada. Si un
   número puede leerse como una nota de desempeño al lado de una dosis, hay
   que descomponerlo hasta que la inferencia equivocada sea imposible, no
   solo desaconsejada.** Corregido: los tres lados (bajo / en rango / alto)
   en pantalla, PDF y Excel, con los colores de `glucoseBands`.
3. **Lecturas manuales dibujadas como si fueran del sensor.** El gráfico
   diario nuevo atenuaba solo `origin:'imported'`, dejando un capilar
   tecleado a mano idéntico a una lectura del CGM, y unía todos los puntos
   con una única polyline continua. `GlucoseChart.tsx` ya había resuelto
   exactamente esto (su comentario de 2026-08-18 lo explica) y el componente
   nuevo no heredó la convención. **Lección: cuando ya existe un componente
   que resolvió una distinción de seguridad, el componente nuevo copia su
   predicado, no reinventa uno más laxo.** Corregido en la pantalla **y** en
   el gráfico del PDF, que tenía el mismo bug: predicado compartido
   (`isNonSensorReading`), línea partida en tramos por origen, puntos huecos.

### Reportes actualizados en la misma corrida

Regla de trabajo pedida por Verónica: si una corrida produce información útil
para los reportes, los reportes se actualizan en la misma corrida. El PDF
ganó las secciones "Día promedio (perfil ambulatorio)" y "Patrones por franja
horaria"; el Excel ganó la hoja "Patrones". Quedó registrado en `CLAUDE.md`
como regla permanente.

### Backend

**No se tocó.** `apps/api`, `packages/ai` y `packages/cgm` quedaron
intactos: todo el cálculo nuevo es local (`packages/domain` + `apps/mobile`),
coherente con `docs/adr/0001-local-first.md`. **No hace falta redeploy a
Abacus** por esta corrida — ver `docs/DEEPAGENT_REDEPLOY_PROMPT.md`.

## Diagnóstico de guardado (2026-08-19) — `logSaveError`

No es parte de la Fase 9, pero se hizo en la misma corrida en respuesta a un
reporte en vivo de Verónica ("no me deja guardar entradas nuevas"): ver la
sección dedicada más abajo, "Bug reportado en dispositivo (2026-08-19)".

## Mejoras fuera de la numeración (2026-08-18)

Pedidos explícitos de Verónica al probar la Fase 5 en el dispositivo, hechos
en paralelo a la Fase 6 en vez de esperar:

- **Timeline: editar y eliminar registros.** Antes `TimelineDetailModal`
  era de solo lectura. Ahora cada tipo tiene su propio alcance de edición
  (`isEditable()` en el modal + guardas equivalentes en `db.ts`, defensa en
  profundidad): insulina (tipo/unidades/nombre), carbohidratos (gramos),
  comida (solo la nota — los carbohidratos confirmados se editan desde su
  propio ítem del Timeline para no bifurcar el dato, ver abajo), glucosa
  (solo si `origin === 'manual'` — nunca se puede "corregir" una lectura de
  sensor/importada/sintética, sería falsificar lo que esa fuente reportó).
  Los episodios no son editables (son un agregado calculado) pero sí se
  pueden eliminar (`deleteMealEpisode`, borra solo el seguimiento, no la
  comida). Eliminar una comida (`deleteMealEvent`) cascadea al episodio (FK
  `ON DELETE CASCADE`) y borra también el `carb_events` asociado.
  **Bug real encontrado y corregido por el `domain-safety-reviewer`**: los
  carbohidratos confirmados de una comida existen en dos lugares (el
  `payload` de `meal_events` y su propia fila en `carb_events`, con
  `source:'meal_confirmed'`) — editar solo la fila de `carb_events` los
  desincronizaba, y todo lo que lee `confirmedCarbsG` desde `meal_events`
  (métricas del episodio, el insight de IA, el prompt de asociación de
  insulina) seguía mostrando el valor viejo mientras el Timeline ya mostraba
  el corregido. `updateCarbEvent` ahora propaga el cambio a `meal_events`
  cuando el origen es `meal_confirmed`. **Gap conocido, no bloqueante**: si
  se edita o elimina una lectura CGM o una dosis de insulina que ya
  alimentó las métricas de un episodio `complete`, esas métricas/insight NO
  se recalculan (`processReadyEpisodes` solo procesa episodios
  `collecting`) — puede quedar un resumen post-comida que ya no coincide
  con los eventos que lo originaron. Extender `processReadyEpisodes` para
  recalcular (o al menos marcar como desactualizado) es el fast-follow
  natural cuando se retome este flujo.
- **Estimación de comida por texto, sin foto.** Pedido explícito: "ahora
  solo se puede sacar una foto... me gustaría que yo pudiera explicarle qué
  comí". `packages/ai`: `MealVisionInput` ahora es una unión (con imagen, o
  solo `{ description }`), con un prompt de sistema propio para el caso sin
  foto (`mealTextSystemPrompt` — pide confianza más baja que una estimación
  con foto, ya que no hay evidencia visual, y al menos una nota de
  incertidumbre siempre). Mismo endpoint (`/v1/ai/meal-analysis`, ahora con
  un `z.union` en el body), mismas dos barreras de seguridad sin cambios
  (`MealAnalysisSchema` + `containsTherapyRecommendation`). Disponible
  tanto en `EntryModal` como en `MealModal`, como botón secundario
  (outline, no sólido) junto al de foto — según `docs/UX_GUIDELINES.md`,
  no debe competir visualmente con la acción primaria de la pantalla.

## Mejoras fuera de la numeración (2026-08-18, cont.) — entradas empaquetadas

Verónica probó todo lo de arriba y pidió un cambio de modelo de datos, no
solo de UI — cita textual: *"lo guardado en una misma instancia, tiene que
quedar empaquetado junto"*. Antes, una sola sesión de "Nueva entrada" (+)
con glucosa + carbohidratos + insulina + nota producía N filas
independientes en el Timeline, cada una editable por separado — exactamente
lo que reclamó. Además pidió un selector explícito Sensor/Capilar en el
campo de glucosa (no sabía que sobrescribir el valor precargado ya se
guardaba distinto a una lectura del sensor), y un botón "Actualizar" en la
notificación fija para forzar el refresco sin depender solo del ciclo de
~15 min ni abrir la app.

- **Entradas empaquetadas (`entry_group_id`).** `initializeDatabase`
  agrega una columna nullable `entry_group_id` a `insulin_events`,
  `carb_events`, `cgm_readings`, `note_events` y `meal_events` (mismo
  patrón de migración que ya se usaba para las columnas de
  `meal_episodes`). `saveUnifiedEntry` genera un id una vez por guardado y
  lo tagea en cada fila que escribe — incluso una entrada de solo-glucosa,
  para que si más adelante se le agregan carbohidratos vía edición, se
  unan al mismo grupo en vez de arrancar uno nuevo desconectado.
  `getTimeline()` agrupa cualquier fila con `entry_group_id` no nulo en un
  solo `TimelineItem` (`kind: 'entry'`) con un resumen combinado (ej. "180
  mg/dL · 45 g · 2 U rápida"); las filas sin grupo (atajos de un dato,
  importaciones) se siguen mostrando sueltas exactamente como antes — nada
  de lo viejo cambia de comportamiento. `updateUnifiedEntryGroup()` edita
  el paquete completo como una unidad: cada campo presente en el formulario
  se actualiza **en el lugar** (no se borra y recrea — así no se resetea a
  `collecting` un episodio que ya estaba `complete` solo porque se corrigió
  la nota), cada campo que el formulario deja vacío se borra del grupo, y
  cada campo nuevo se inserta y se tagea con el mismo id.
  `deleteUnifiedEntryGroup()` borra el paquete entero de una vez. Nueva
  `updateMealCarbsAndNoteRows` (a diferencia de la `updateMealNote` ya
  existente, que a propósito solo toca la nota) edita carbohidratos y nota
  juntos para el caso de una entrada empaquetada, propagando el cambio a la
  fila `carb_events` vinculada con la misma técnica ya usada para el bug de
  `updateCarbEvent`. **Nota de proceso**: como esta ronda tocó tantas
  funciones con `db.withTransactionAsync`, varias ya tenían el bug de
  transacción anidada que este proyecto viene encontrando repetido — se
  volvió a extraer el núcleo no-transaccional (`deleteMealEventRows`,
  `updateMealCarbsAndNoteRows` interno) antes de usarlas desde dentro de
  `updateUnifiedEntryGroup`/`deleteUnifiedEntryGroup`. **Lección para el
  futuro, ya van tres veces**: cualquier función `save*`/`update*`/`delete*`
  nueva que pueda necesitar llamarse desde otra operación compuesta debe
  nacer con su núcleo no-transaccional separado desde el principio, no
  agregarlo reactivamente cuando aparece el primer caso de uso anidado.
- **Selector Sensor/Capilar explícito en `EntryModal`.** El campo de
  glucosa ya guardaba un valor tipeado a mano como `origin:'manual'`
  (distinto de una lectura de sensor), pero no había ninguna UI que lo
  hiciera evidente. Ahora hay un control de dos segmentos; "Sensor" solo
  está habilitado cuando la última lectura viva es genuinamente del sensor
  (o sintética en modo demo — comparten pestaña, con su propio aviso). Si
  la última lectura viva resulta ser una medición manual previa (las
  manuales también cuentan como "vivas"), el campo arranca en blanco en vez
  de precargar ese valor viejo disfrazado de nuevo.
- **Botón "Actualizar" en la notificación fija.** Nueva acción de
  notificación `ACTION_REFRESH` con `opensAppToForeground: false`, manejada
  por una tarea headless separada (`Notifications.registerTaskAsync`, no
  `expo-background-task`) definida en `backgroundSync.ts` junto a la tarea
  periódica — ambas comparten ahora el mismo `runCgmSync()`. Según la
  documentación de Expo, en Android esto corre en respuesta al toque de la
  acción aunque la app esté en segundo plano o cerrada del todo, sin
  necesidad de traerla al frente — mismas limitaciones de mejor esfuerzo
  que el resto de lo de segundo plano (Doze, ahorro de batería).

## Mejoras fuera de la numeración (2026-08-18, cont. 2) — widget, edición de sensor, alertas y capilar

Cuarta tanda de pedidos de Verónica sobre el mismo build:

- **Botón "Actualizar" ahora visible en la notificación.** El bug era de
  plataforma: Android solo dibuja **3** botones de acción en la fila de una
  notificación (iOS los apila todos), y `ACTION_REFRESH` era el 4º, así que
  no aparecía. Se reordenó la categoría para que "Actualizar" vaya **primero**
  (siempre visible), ya que ver la glucosa sin abrir la app es el motivo
  mismo de la notificación. En un dispositivo que solo muestra 3, el que cae
  es "Corrección" (el último): es el más redundante acá, porque está en la
  app y además tiene su propia notificación de recordatorio. No hay forma de
  mostrar 4 en Android; si algún día se quiere priorizar otro, es reordenar
  el array en `configureNotifications`.
- **Editar lecturas auto-guardadas del sensor para adjuntarles datos.**
  Pedido textual: poder tomar *"la hora en que comí y me pinché"* — una
  lectura del sensor ya guardada — y adjuntarle carbos/insulina/nota. Modelo:
  `attachEntryToReading(db, readingId, input)` le pone un `entry_group_id`
  nuevo a la fila `cgm_readings` existente y escribe las adjunciones con el
  `sourceTimestamp` de la lectura, delegando en el mismo
  `updateUnifiedEntryGroup` de siempre. **Regla de seguridad clave**: el valor
  y el `origin` del sensor **nunca** se reescriben ni se borran. Para lograrlo
  hubo que hacer `updateUnifiedEntryGroup` y `deleteUnifiedEntryGroup`
  *provenance-aware*: si el ancla del grupo no es `origin:'manual'`, se
  preserva (borrar la "entrada" solo quita las adjunciones y desliga la
  lectura, no destruye dato real de sensor); y si a una entrada anclada en
  sensor se le quitan todas las adjunciones, se desliga (`entry_group_id =
  NULL`) y vuelve a ser una lectura suelta. El `TimelineDetailModal` muestra
  el valor del sensor como solo-lectura y ofrece los campos de adjunción; el
  suffix de provenance en el Timeline se derivó a un helper
  `glucoseOriginSuffix` (antes el grupo hardcodeaba "(manual)").
- **Sonido/vibración configurable en recordatorios.** Android fija
  sonido/vibración **por canal** y no deja mutarlo después de crearlo, así que
  no se puede "cambiar el sonido" de un canal — hay que enrutar a canales
  pre-creados. Se crean 4 (`reminders-both/sound/vibrate/silent`) y cada
  recordatorio (post-comida, corrección, capilar) se agenda en el canal del
  estilo elegido (`reminderChannelId(style)`). `silent` usa importancia LOW;
  `vibrate` usa `sound: null` + patrón de vibración; el resto HIGH. La
  notificación fija de glucosa **no** usa estos canales (repostea cada ~15 min,
  jamás debe sonar). Se borran los canales viejos `meal-episodes`/
  `correction-reminders`.
- **Recordatorio de mediciones capilares X veces/día.** Ajuste nuevo: la
  usuaria ingresa su horario de vigilia (inicio/fin) y cuántas veces al día;
  `capillaryReminderTimes(wakeStart, wakeEnd, count)` (puro, con tests en
  `format.test.ts`) reparte los avisos anclados al inicio, cada
  `ventana/count` minutos, y se agendan como notificaciones DAILY repetidas.
  Se cancelan/reprograman por `data.kind === CAPILLARY_REMINDER_KIND`. Se
  auto-reparan al abrir la app (como el registro de background sync), porque
  reinstalar o un update de OS puede borrarlas.
- **Constancia para el chat de IA.** Nuevo `docs/AI_CHAT_ARCHITECTURE.md`
  (documento vivo) + regla en `CLAUDE.md`: cada corrida que agregue una
  capacidad a la app debe reflejarla en el catálogo de ese documento, para que
  cuando armemos el chat de IA (fase futura) no se nos escape ninguna función
  y nazca respetando las fronteras de `AGENTS.md`.

**Seguimiento aceptado (no accionar salvo pedido):** al adjuntar una comida a
una lectura vieja de sensor, el episodio se computa retroactivamente con
`processReadyEpisodes` a partir del CGM alrededor de esa hora — correcto — pero
las alarmas +60/+120/+180 caen en el pasado y se saltan solas (esperado).
Además, `apps/mobile/src/db.ts` no tiene arnés de tests (expo-sqlite es
nativo, no corre directo en vitest), así que la lógica *provenance-aware*
nueva (ancla de sensor nunca mutada/borrada) quedó cubierta solo por
typecheck + revisión de seguridad, no por un test unitario — vale la pena
montar un test con SQLite en memoria antes de que esa lógica crezca más.

## No-bug encontrado en dispositivo (2026-08-18) — estimación por texto: backend desplegado desactualizado

Verónica reportó que "la parte para aproximar carbohidratos con IA usando
texto no funciona, solo con fotos". Investigado: **el código está bien y
probado** (`packages/ai/src/abacus.ts`, `apps/api/src/app.ts`'s
`MealAnalysisBodySchema` union, `apps/mobile/src/components/EntryModal.tsx` y
`MealModal.tsx`'s `analyzeFromDescription()` — todo correctamente wireado, tal
como quedó documentado cuando se implementó). El problema es que el **backend
desplegado en producción** (`https://237e8b7f1.abacusai.cloud`, el mismo host
citado en la Fase 0/bug 502, desplegado y actualizado por "DeepAgent", una
herramienta externa a este repo/sesión de Claude Code) sigue corriendo una
versión **anterior** a la que agregó el camino solo-texto.

**Verificado con curl directo contra el servidor real**:
```
POST /v1/ai/meal-analysis {"description":"una manzana"}
→ 400 {"error":{"code":"invalid_image","message":"La imagen o su descripción
   no son válidas.","retryable":false}}
```
El código `invalid_image` y ese mensaje **no existen en el `app.ts` actual**
(hoy sería `invalid_meal_input` / "Falta una imagen válida o una descripción
de texto."), lo que confirma que el servidor desplegado predata este cambio.

**No es accionable desde esta sesión**: no hay credenciales ni script de
deploy para ese host en este repo (solo `apps/api` tiene un `start` local vía
`tsx src/server.ts`); el redeploy a producción lo dispara "DeepAgent" por
fuera de Claude Code, como ya pasó una vez para el bug 502 (línea ~128 de
este documento — "Redeploy verificado en producción por DeepAgent"). **Acción
pendiente de Verónica**: pedir/disparar un redeploy de `apps/api` a
producción; una vez hecho, el camino de texto debería funcionar sin ningún
cambio de código adicional — se puede reverificar con el mismo curl de arriba.

## Bug encontrado en dispositivo (2026-08-18) — crash de SQLite al tocar "Actualizar" varias veces

El riesgo de doble-conexión SQLCipher que quedó anotado como "sin probar en
dispositivo real" **se confirmó**: Verónica tocó "Actualizar" en la
notificación 3 veces seguidas y la app quedó mostrando, en Ajustes → Estado
CGM: *"Call to function 'NativeDatabase.execAsync' has been rejected. →
Caused by: java.lang.NullPointerException"*.

**Causa raíz**: `openDb()` en `backgroundSync.ts` abría una conexión SQLite
nativa nueva en **cada** invocación de la tarea headless
(`NOTIFICATION_TASK_ID`, disparada por cada toque de "Actualizar") y **nunca
la cerraba**. Tres toques rápidos (probablemente con la bandeja de
notificaciones abierta, o sea con la app en un estado "backgrounded" que
según la documentación de expo-notifications sí dispara la tarea headless
aunque el proceso siga vivo) dejaban varias conexiones nativas abiertas al
mismo tiempo contra el mismo archivo SQLCipher/WAL — encima de la conexión
propia del `SQLiteProvider` de la app si el proceso seguía vivo. Eso es lo
que rompió a nivel nativo.

**Arreglo**: `backgroundSync.ts` ahora serializa toda llamada de ambas tareas
(`PERIODIC_TASK_ID` y `NOTIFICATION_TASK_ID`) a través de una sola cadena de
promesas (`runSyncSerialized`), y cierra la conexión (`db.closeAsync()`) en un
`finally` antes de que la siguiente llamada pueda abrir otra — nunca hay más
de una conexión de este módulo abierta a la vez, y una ráfaga de toques se
vuelve secuencial en vez de concurrente. **Nota de honestidad**: esto ayuda
con certeza cuando las invocaciones comparten el mismo motor JS (lo más
probable para toques seguidos dentro de una ventana corta); si Android llega
a lanzar un proceso headless totalmente nuevo por cada toque, el cierre en
`finally` sigue siendo correcto (nunca deja una conexión huérfana abierta más
de lo necesario) pero la serialización entre procesos separados no se puede
garantizar sin un mecanismo cross-proceso — no hay forma de confirmar esto sin
más pruebas en dispositivo.

**Bug secundario encontrado de paso**: el `catch` de `refresh()` en `App.tsx`
envolvía tanto el fetch de red (`fetchCGMStatus`/`fetchCGMReadings`) como la
escritura local (`upsertCGMReadings`), así que un fallo de SQLite local se
mostraba como *"Backend sin conexión"* — mandando el diagnóstico en la
dirección equivocada. Separado en dos bloques: un fallo de red se etiqueta
como antes; un fallo al guardar localmente ahora dice explícitamente que no
se pudo guardar, sin culpar al backend.

**Seguimiento sugerido, no urgente**: si el crash volviera a reproducirse tras
este arreglo, el siguiente paso sería instrumentar con logs de diagnóstico
(sin cuerpos sensibles) qué contexto de ejecución usa cada invocación headless
en un dispositivo real, para confirmar o descartar el escenario de "proceso
headless nuevo por toque".

## Bug reportado en dispositivo (2026-08-19) — "no me deja guardar entradas nuevas"

Verónica reportó que `EntryModal` no guarda; el mensaje que ve es el genérico
"No se pudo guardar la entrada. Inténtalo otra vez." Investigado a fondo sin
poder reproducir: revisión estática completa de `saveUnifiedEntry`,
`writeMealWithEpisode`, `writeCGMReading`, la migración de `entry_group_id`
en `initializeDatabase`, y el flujo de `EntryModal.save()` no encontró ningún
bug de lógica, y `pnpm verify` pasa limpio (lint + typecheck + los 51+8+10
tests existentes). **No es accionable a ciegas** — ese mensaje genérico venía
de un `catch {}` mudo que descartaba el error real, y ese mismo patrón se
repetía en los otros 7 modales de guardado de la app.

**Arreglado (diagnóstico, no una corrección del bug en sí)**: nuevo
`apps/mobile/src/log.ts` → `logSaveError(context, error)`, ahora usado en
los ocho `catch` de guardado (`EntryModal`, `MealModal`, `NumericEntryModal`,
`CorrectionModal` ×2, `SettingsModal` ×2, `InsulinAssociationModal`). Loguea
solo `error.name`/`error.message` a consola — nunca el objeto completo (un
`ZodError` trae en `issues` el valor que falló la validación, y eso puede
ser glucosa/insulina/carbohidratos reales, prohibido por AGENTS.md). La
próxima vez que el mensaje genérico aparezca, el motivo real va a quedar en
la consola de Metro/Expo (o `adb logcat` para el APK) en vez de perderse sin
dejar rastro.

**Sospecha principal, sin confirmar**: el riesgo de dos conexiones SQLCipher
concurrentes entre `backgroundSync.ts` (tarea en segundo plano, Fase 7) y la
conexión en primer plano de la app, ya anotado como "no probado en
dispositivo" en la Fase 7 de este mismo documento — encaja con el patrón de
"a veces falla, mensaje genérico, sin causa clara en el código". **Acción
pendiente de Verónica**: la próxima vez que el guardado falle, revisar el
log de Metro/Expo (o pedir un `adb logcat` si es el APK instalado) y pasar
la línea `[type1a] EntryModal.save failed — ...` — con eso se puede
diagnosticar la causa real y cerrar este bug en vez de solo instrumentarlo.

## Migración de cuenta EAS (2026-08-19)

**Pedido explícito de Verónica**: la cuenta Expo `cdevidts` agotó su cupo
gratis de builds Android del mes (15/mes, resetea el 1 de septiembre).
Se migró el proyecto a una cuenta nueva (`cris-devit`) para tener cupo
propio, **preservando la misma llave de firma** — es la parte no negociable
de esta migración: Android exige el mismo certificado de firma para tratar
un APK nuevo como actualización de uno ya instalado, y esta app es
local-first sin backup en la nube (`docs/adr/0001-local-first.md`), así que
firmar con una llave distinta habría forzado desinstalar + reinstalar en
cualquier teléfono con la app puesta, **borrando todo el historial de
Verónica** sin forma de recuperarlo.

### Qué cambió

- `apps/mobile/app.json`: `owner` pasó de `cdevidts` a `cris-devit`,
  `extra.eas.projectId` apunta al proyecto nuevo
  (`05df8f63-7a23-40b1-96b8-4d40b33d3360` — el proyecto viejo,
  `189f9b72-73be-4a79-9d7a-33090236bb36` bajo `cdevidts`, sigue existiendo
  pero ya no se usa; no se borró).
- `apps/mobile/eas.json`: los perfiles `preview` y `production` de Android
  llevan `"credentialsSource": "local"` — dejan de usar el keystore
  auto-gestionado por EAS y usan el que apunta `credentials.json`.
- El keystore real (`apps/mobile/credentials/android/keystore.jks`) y sus
  contraseñas (`apps/mobile/credentials.json`) están **gitignored a
  propósito** (`*.jks` y `credentials.json` en `apps/mobile/.gitignore`) —
  nunca deben llegar a un commit. Se sacaron del proyecto viejo con
  `eas credentials` (menú: "Credentials.json: Upload/Download..." →
  "Download credentials from EAS to credentials.json") y se verificaron
  **antes** de usarlos, comparando el fingerprint SHA-256 del certificado
  contra el del APK ya instalado (`3D:42:7A:25:E7:93:A8:E0:34:31:0E:A5:41:
  7C:7F:92:CF:33:DE:23:BD:E3:85:24:4E:E1:47:9F:E7:94:62:33`) — coincidencia
  exacta, confirmando de forma independiente que es la llave de producción
  real, no algo mal copiado.
- Ambos proyectos EAS tienen la variable `EXPO_PUBLIC_API_BASE_URL` con el
  mismo valor (`https://237e8b7f1.abacusai.cloud`) en el entorno `preview`.
- **`eas init` agregó permisos de Android no pedidos** (`READ/WRITE_
  EXTERNAL_STORAGE`, `INTERNET`) al vincular el proyecto — efecto colateral
  del comando, no un cambio deliberado. Se revirtieron antes de confirmar
  nada; quedó solo `CAMERA`/`POST_NOTIFICATIONS`, como estaba.

### ⚠️ Para cualquier corrida futura que toque `apps/mobile` o EAS

- **Nunca corras `eas credentials` en este proyecto y elijas "Set up a new
  keystore" / "Generate a new Android Keystore".** Regeneraría la llave y
  volvería a poner a Verónica en la misma disyuntiva (perder el historial o
  no poder actualizar), esta vez sin vuelta atrás.
- `credentials.json` y `credentials/android/keystore.jks` **no viven en
  git** — son solo del árbol de trabajo local. Un checkout nuevo, en un
  entorno nuevo, **no los va a tener**, y el build va a fallar hasta que se
  reprovisionen. Para reprovisionarlos: repetir la descarga con
  `eas credentials` bajo la cuenta que los tenga configurados (hoy,
  cualquiera de las dos cuentas ya tiene el mismo keystore como managed o
  local), y volver a verificar el fingerprint contra un APK ya instalado
  antes de confiar en el archivo.
- **Pendiente, no bloqueante**: subir este mismo keystore como credencial
  *administrada por EAS* en el proyecto de `cris-devit` (menú inverso:
  "Upload credentials from credentials.json to EAS servers"), para que un
  entorno nuevo no dependa de tener el archivo local. No se hizo en esta
  corrida a propósito — es un asistente interactivo (`eas credentials` no
  tiene modo `--non-interactive` para esto, confirmado con `--help`), y
  automatizarlo a ciegas sobre una llave de producción real es exactamente
  el tipo de riesgo que esta migración estaba tratando de evitar. Si se
  hace, que sea con alguien mirando cada paso del menú.
- El primer build de la cuenta nueva se disparó para validar justamente
  esto (que instale como actualización, sin pedir desinstalar). Confirmarlo
  en un dispositivo real antes de asumir que la migración quedó cerrada.

## Detalle de la Fase 13 (2026-08-19) — bugs de interfaz del Resumen, encontrados en dispositivo

Verónica probó el build real (el de la migración de cuenta EAS, arriba) en
su teléfono e instaló la pantalla "Resumen" por primera vez. Reportó 5
problemas con capturas. **A pedido explícito de ninguno se tocó en esta
corrida** ("en esta corrida quiero que revises exclusivamente lo del
backend") — quedan acá con hipótesis de causa para que la próxima corrida
no tenga que re-investigar desde cero.

1. ✅ **Resuelto (2026-08-19).** Los gráficos se salían del contenedor por la
   derecha. Causa confirmada: doble padding. `ModalShell` aplicaba
   `padding: spacing.lg` en su `content` **incluso con `scroll={false}`**
   (como lo usa `SummaryModal`), y `SummaryModal` además envuelve sus
   tarjetas en su propio `ScrollView` con otro `padding: spacing.lg` — dos
   capas, mientras `chartWidth` solo restaba una. Fix: `ModalShell` ya no
   aplica padding en la rama `scroll={false}` (es el único consumidor de
   esa rama en todo el repo, cero riesgo de romper otro modal); `chartWidth`
   no necesitó cambiar, su fórmula ya asumía una sola capa y ahora es
   correcta. Sin test automatizado posible (es layout de RN) — pendiente
   confirmar en el próximo build.
2. ✅ **Resuelto junto con el punto 1 (2026-08-19).** Era el mismo problema
   de contenedores anidados — el `tabBar`/`rangeRow` de `SummaryModal`
   también tenían doble inset horizontal por la misma causa. Mismo fix.
3. ✅ **Resuelto (2026-08-19, Grupo B).** Botones superiores (ej. "Cerrar")
   tapados por la barra de estado de Android. La hipótesis original (`edges`
   sin fijar) era **incorrecta**; la causa real es más simple y más grave:
   `ModalShell.tsx` importaba `SafeAreaView` de **`react-native`**, que es
   iOS-only — en Android se comporta como un `View` común y no aplica ningún
   inset. `App.tsx` siempre usó el correcto, el de
   `react-native-safe-area-context`, y por eso la pantalla principal nunca
   tuvo el problema y los modales sí. Con edge-to-edge obligatorio desde
   Expo SDK 54, la app dibuja bajo la barra de estado, así que el header de
   cada modal quedaba tapado. Fix: importar de `react-native-safe-area-context`
   con `edges={['top', 'bottom']}`. Afecta a **todos** los modales, no solo
   al Resumen. Pendiente confirmar en dispositivo.
4. ✅ **Resuelto (2026-08-19).** Contenedores de fecha mal dimensionados —
   causa confirmada: `cardTitle` tenía `flexShrink: 1` pero `cardMeta` no
   tenía ningún límite de ancho, así que en una fila `justifyContent:
   'space-between'` el título se comprimía hasta casi cero para dejarle
   todo el espacio al meta largo. Fix: `cardHeader` pasó de fila a columna
   (fecha arriba, stats abajo) — más robusto que ajustar `flexShrink` en
   ambos lados, y más legible en pantallas angostas en general.
5. ✅ **Resuelto (2026-08-19, Grupo B), y no hacía falta `adb logcat`.** Al
   cambiar el chip de rango de días, la app mostró un error de que no se
   podían encontrar los datos y pidió cerrar y volver a abrir; **solo cerrar
   la app entera lo resolvía**. Resultaron ser **dos defectos encadenados**,
   ambos identificables leyendo el código:

   **(a) Por qué falló la carga.** Los ~12 getters de rango de `db.ts`
   hacían `Schema.safeParse(JSON.parse(row.payload))`. El `safeParse` estaba
   ahí justamente para tolerar una fila inválida, pero el `JSON.parse` que lo
   alimentaba quedaba **fuera** de esa red: una sola fila con el JSON corrupto
   (una importación de MySugr cortada a media escritura, una fila de un
   esquema viejo) lanza un `SyntaxError` que rechaza la consulta **entera**.
   Por eso fallaba al ampliar el rango y no en 14 días: el rango más ancho
   alcanzaba la fila mala. Y no afectaba solo al Resumen — la exportación del
   reporte usa los mismos getters. Fix: `safeJsonParse()` + `decodeRow()` en
   `db.ts`; una fila ilegible se descarta y el resto se lee. Los 6 sitios que
   usan `.parse()` estricto son rutas de **mutación** de una fila y se
   dejaron lanzando a propósito: nunca sobrescribir una fila que no pudiste
   leer.

   **(b) Por qué había que cerrar la app.** `SummaryModal` se renderiza
   siempre (solo alterna `visible`), así que **nunca se desmonta** y
   `rangeDays` sobrevive a cerrar y reabrir el modal. El mensaje decía
   "cierra y vuelve a abrir el resumen", pero al reabrir se reintentaba
   exactamente el mismo rango que ya había fallado. Cerrar la app no
   "arreglaba" nada: reiniciaba el estado a los 14 días por defecto, que
   sí funcionaban. Fix: botón **"Reintentar"** real (un `reloadToken` en las
   dependencias del efecto), mensaje honesto que nombra el rango que falló, y
   una pista de probar un rango más corto.

   **(c) Dos rondas de `domain-safety-reviewer` sobre este mismo fix.** La
   primera versión hacía que `getTherapyProfile` **lanzara** ante una fila
   corrupta, para no caer nunca a los placeholders. Correcto en la intención,
   pésimo en el efecto: la llamada vive dentro del `Promise.all` de
   `loadLocalState`, y `refresh()` la envuelve en un `try/finally` **sin
   `catch`**. Resultado: la app arrancaba en blanco y sin avisar, con la base
   llena de datos; el sync de CGM dejaba de correr; y —lo peor— como **cada
   ruta de guardado termina con `await loadLocalState()`**, un guardado
   exitoso reportaba "No se pudo guardar", la usuaria volvía a tocar el botón
   y **registraba la misma insulina dos veces**. Versión final:
   `getTherapyProfile` devuelve un resultado discriminado
   (`fresh` / `ok` / `unreadable`, en `rowDecode.ts`, puro y con test); ante
   `unreadable` la app muestra los placeholders pero **fuerza
   `therapyConfigured` a false** (calculadoras bloqueadas) y levanta un aviso
   persistente que dice cómo salir, mientras todo el registro manual sigue
   funcionando — que es lo que exige la regla de degradar a manual de
   `AGENTS.md`. La revisión también encontró que los descartes silenciosos
   seguían alimentando afirmaciones de completitud, y que tres textos
   (PDF, Excel y Resumen) todavía decían "Type 1A nunca calcula ni recomienda
   insulina", que es **falso** — la app sí hace la aritmética con los
   parámetros que cargó la usuaria; lo que nunca hace es decidir o sugerir.
   Corregido en las tres superficies, y en el onboarding se completó la lista
   de qué sale del teléfono (faltaba que `fetchGlucoseInsight` manda las
   métricas del episodio post-comida **automáticamente**, sin elección).

   **(d) Además, red de seguridad.** Se agregó `ErrorBoundary.tsx`: una
   excepción lanzada **durante el render** (no dentro del `await`, que ya
   tenía su `.catch`) desmontaba el árbol de React entero y dejaba la app
   inservible hasta cerrarla. Los cálculos de `packages/domain` lanzan a
   propósito ante un dato que no pueden interpretar y eso **no se relajó** —
   lo que se arregló es la consecuencia desproporcionada. Si vuelve a pasar,
   el stack real queda en `logSaveError` en vez de requerir `adb logcat`.

### Notas de WhatsApp de Verónica (18-19/8), interpretaciones confirmadas

Verónica escribió estas notas antes de ver la pantalla Resumen terminada.
Se interpretaron una por una y ella confirmó cada una antes de agregarlas acá
— quedan con la lectura ya validada, no una hipótesis mía.

6. **Alarmas a voluntad vía el chat de IA.** No es una feature suelta para
   construir ahora: es una capacidad que el chat de la Fase 8 tiene que
   poder ofrecer — que la usuaria le pida en lenguaje natural un
   recordatorio a medida, en vez de limitarse a los 3 tipos de alarma fija
   que ya existen (post-comida, corrección, capilar). Ya está anotado como
   capacidad de escritura (W) en `docs/AI_CHAT_ARCHITECTURE.md` §3
   ("Programar/ajustar alarmas y recordatorios") — este ítem es el
   recordatorio de que ese catálogo tiene que cubrir alarmas *a medida*, no
   solo las 3 fijas, cuando se implemente el chat.
7. ✅ **Resuelto (2026-08-19, Grupo C).** Seguimiento nutricional más allá de
   carbohidratos. Proteína, grasa y fibra se registran en `MealModal` (campos
   opcionales, colapsados por defecto: el registro frecuente es "carbos y
   listo" y pedir cuatro campos más haría lento justo el flujo que tiene que
   ser rápido), se promedian por franja horaria en `buildNutritionInsights`,
   y aparecen en la pestaña Comidas del Resumen y en el reporte PDF/Excel.

   **La decisión de diseño que importa:** un macro en blanco se **omite**, no
   cuenta como 0 g. Por eso cada macro lleva su propio `sampleSize` en vez de
   compartir `mealCount`: "no lo anoté" y "comí 0 g de proteína" son cosas
   distintas, y promediarlas juntas inventaría un número. Las columnas de
   macros del reporte solo aparecen si se anotó alguno, para no llenar de
   guiones el documento que lee el médico. `caloriesKcal` sigue en el esquema
   pero sin campo de entrada: es derivable de los otros tres y pedirla
   aparte invita a que no cuadren entre sí.

   Detalle original del ítem: **Seguimiento nutricional más allá de carbohidratos.** `MealEventSchema`
   ya tiene `proteinG`/`fatG`/`fiberG`/`caloriesKcal`, pero ningún flujo de
   registro los pide ni ninguna pantalla los muestra. Construir: campos en
   el registro de comida (`EntryModal`/`MealModal`) y sumarlos como
   dimensión de los insights alimentarios de la pestaña Comidas del Resumen
   (hoy solo mira carbohidratos e insulina).
8. ✅ **Resuelto (2026-08-19, Grupo C).** Registro de mediciones de cetonas.
   Quinto atajo en la grilla de la pantalla principal (cae en su propia fila
   por el `flexWrap`, lo que además lo separa visualmente de los cuatro
   rutinarios) → `KetonesModal`, que guarda un `VitalsEvent` con
   `ketonesMmolL`. Las bandas clínicas (0,6 / 1,5 / 3,0 mmol/L en **sangre**)
   viven en `packages/domain/src/ketones.ts` con test, no en el componente.

   **Frontera de seguridad, la más delicada de este grupo:** la literatura de
   cetonas viene casi siempre acompañada de protocolos de corrección con
   insulina, y una banda alta es justo el momento de máximo riesgo de cruzar
   la línea de `AGENTS.md`. La app dice en qué banda cayó la medición y, si
   es urgente, que contacte a su equipo clínico **ahora** — nada más. Hay un
   test que falla si alguna etiqueta llega a mencionar insulina, unidades o
   dosis. El reporte también muestra la banda junto al número, para que un
   equipo clínico la ubique de un vistazo en una tabla larga.

   Detalle original del ítem: **Registro de mediciones de cetonas.** `VitalsEventSchema` ya tiene
   `ketonesMmolL` y aparece en el reporte PDF/Excel, pero no hay ningún
   punto de entrada en la app para cargarlas — hoy solo llegan si vienen de
   una importación de MySugr. Construir un flujo de registro real (atajo
   de un dato, como Carbos/Rápida/Basal, o un campo dentro de "Nueva
   entrada"). Relevante para riesgo de cetoacidosis, no es un "nice to
   have" cosmético.
9. ✅ **Resuelto (2026-08-19).** Marcas de hora en el gráfico principal
   (`GlucoseChart.tsx`, pantalla de inicio). Antes solo marcaba cambios de
   día; ahora agrega una línea + etiqueta cada `HOUR_TICK_STEP` (6) horas
   dentro del día, mismo criterio visual recesivo que `SummaryCharts.tsx`.
10. ✅ **Resuelto en parte (2026-08-19, Grupo B)** — el onboarding sí, el
    selector de unidad no, y el motivo importa.

    **10a — Flujo de primer uso: hecho.** `OnboardingModal.tsx`, 4 pasos,
    se muestra una sola vez (flag `onboardingSeenAt` en `settings`). Cubre
    qué hace la app y qué no (nunca calcula ni recomienda insulina), que
    todo es local y cifrado, en qué unidades trabaja, y que las calculadoras
    quedan bloqueadas hasta cargar los parámetros en Ajustes → Terapia.
    **No pide parámetros de terapia en el onboarding a propósito**:
    `AGENTS.md` prohíbe inferirlos, y un formulario de bienvenida con campos
    prellenados es la forma más fácil de que alguien "confirme" de un toque
    unos números que nunca eligió. Ajustes → Terapia sigue siendo el único
    lugar que marca el perfil como configurado.

    **10b — Elegir mg/dL vs. mmol/L: PENDIENTE, y es más grande de lo que
    parece.** Se intentó en esta corrida y se revirtió con causa. El
    bloqueador no es la capa de presentación —para eso ya quedaron listos y
    con test `formatGlucose()` / `formatGlucoseWithUnit()` en
    `packages/domain/src/units.ts`— sino el **modelo de datos**:
    `TherapyProfile.targetGlucose` y `TherapyProfile.correctionFactor` **no
    llevan campo de unidad**, son mg/dL implícito. Y un factor de corrección
    no se "reformatea": 45 mg/dL/U son 2,5 mmol/L/U, un número distinto.
    Mostrar mmol/L sin migrar antes esos parámetros dejaría la calculadora de
    dosis operando en una unidad y el resto de la app en otra — exactamente
    la clase de bug del ítem 11, pero de fábrica. Lo que hace falta, en su
    propia corrida y con prueba en dispositivo:
    - agregar unidad explícita a `TherapyProfile` (o fijar por contrato que
      se persiste siempre en mg/dL y se convierte solo al mostrar/recibir);
    - una migración para los perfiles ya guardados;
    - convertir en los ~47 sitios de presentación, incluidos los campos de
      entrada de `CorrectionModal`/`EntryModal`;
    - `domain-safety-reviewer` sobre el resultado, porque toca la ruta de
      dosis.

    Mientras tanto el onboarding **declara** la unidad ("esta versión trabaja
    en mg/dL") en vez de ofrecer una opción que la app no respetaría. Un
    selector que no se cumple es peor que no tenerlo.
11. ✅ **Resuelto (2026-08-19), y bastante más grande de lo reportado.** El
    síntoma original: con la app en mg/dL, el resumen de IA post-comida
    ("te partió en X y alcanzó un máximo de Y, 25 minutos después") mostró
    los valores en mmol/L. Investigando la causa apareció el mismo patrón
    en **toda la app**: cualquier lugar que copiaba `CGMReading.glucose` a
    otro lado asumía mg/dL sin convertir, y **Junction** (el proveedor CGM
    real en producción, región EU — Chile) puede legítimamente devolver
    lecturas en mmol/L, no es un caso hipotético de CSV. Se corrigió el
    patrón completo, no solo el síntoma:
    - `calculateMealEpisodeMetrics` (`packages/domain/src/meal.ts`) ahora
      normaliza cada lectura a mg/dL (`convertGlucose`) antes de calcular
      cualquier métrica — incluye el peak/mínimo y las comparaciones de
      umbral para tiempo sobre/bajo rango, que antes comparaban un número
      mmol/L crudo contra 70/180 mg/dL y nunca disparaban correctamente.
      `MealEpisodeMetricsSchema` quedó documentado (JSDoc) como "siempre
      mg/dL", sin agregar un campo de unidad nuevo.
    - `glucoseInsightSystemPrompt` (`packages/ai/src/prompts.ts`) ahora le
      dice explícitamente al modelo que todo viene en mg/dL, en vez de
      dejarlo adivinar (bump a `glucose-insight.v2`, solo trazabilidad).
    - **El hallazgo más serio no era de texto — era de cálculo**: el campo
      de glucosa que precarga la calculadora de dosis en
      `CorrectionModal.tsx` y `EntryModal.tsx` (`calculateCorrection`/
      `calculateMealBolus`) tomaba `latest.glucose` crudo. Un valor mmol/L
      sin convertir ahí no es un error de visualización, es un número
      equivocado entrando a un cálculo de dosis real. Corregido para
      convertir antes de precargar.
    - También corregido: el valor **hero** de glucosa de toda la app
      (`GlucoseCard.tsx`, lo primero que se ve al abrir), el gráfico
      principal (`GlucoseChart.tsx` — con mmol/L crudo se habría visto
      pegado abajo del todo, además de mal etiquetado), la notificación
      fija de acceso rápido (`notifications.ts`), y tres sitios en
      `apps/mobile/src/db.ts` que arman el texto/objeto del Timeline
      (lectura suelta, entrada empaquetada, y el `raw.glucose` que lee
      `TimelineDetailModal`).
    - Ya no había que tocar: los gráficos y el reporte de la Fase 11
      (`SummaryCharts.tsx`, `reportExport.ts`, `glucose-metrics.ts`,
      `agp.ts`, `nutrition-insights.ts`) — esos ya convertían con
      `convertGlucose` desde que se escribieron hoy mismo, antes de este
      bug. `TimelineDetailModal.tsx` no necesitó cambios propios: sus
      valores ya vienen convertidos desde `db.ts`/`meal.ts`.
    - Tests nuevos en `packages/domain/test/meal.test.ts`: normalización
      mmol/L→mg/dL en el cómputo, y que las comparaciones de umbral usan el
      valor convertido. Revisado por `domain-safety-reviewer`.
    - **Limitación que queda:** los episodios ya guardados en SQLite antes
      de este fix conservan los números viejos (posiblemente mal
      convertidos) — no se migraron datos retroactivamente, solo se
      corrigió el cálculo hacia adelante.
    - **Casi rompe el build de Android**: los dos imports nuevos en
      `meal.ts` se escribieron como `'./glucose-thresholds.js'` y
      `'./units.js'` (con extensión `.js`), mientras que el resto de
      `packages/domain` usa imports relativos sin extensión. `tsc` y
      `vitest` resuelven ambas formas igual, así que `pnpm verify` pasó en
      verde sin avisar nada — pero Metro (el bundler que usa EAS Build)
      resuelve imports relativos contra el filesystem literal y no
      reescribe `.js`→`.ts`, así que el build `2949f0b0-...` falló en la
      fase "Bundle JavaScript" con `Unable to resolve module
      ./glucose-thresholds.js`. Se detectó bajando y descomprimiendo
      (brotli) el log real de EAS — el resumen `UNKNOWN_ERROR` de
      `eas build:view` no decía nada útil. Fix: quitar la extensión
      (`980d328`), y se verificó localmente *antes* de gastar otro build
      corriendo el mismo comando que usa EAS
      (`npx expo export:embed --eager --platform android --dev false`),
      que reprodujo el bundle exitosamente (966 módulos). **Lección para
      `packages/domain`**: nunca usar extensión `.js` en imports
      relativos ahí — `pnpm verify` no lo va a atrapar, solo un build real
      o un `expo export:embed --eager` local lo detecta.
12. ✅ **Resuelto (2026-08-19, Grupo B).** `SettingsModal` pasó de ocho
    secciones planas en un modal de ~660 líneas a **cuatro pestañas**, con el
    mismo patrón y los mismos tokens que la barra de `SummaryModal` (la app
    no tiene librería de navegación y no se agregó una para esto):
    - **Dispositivos** — estado CGM, conectar FreeStyle, importar historial.
    - **Alarmas** — post-comida, corrección, capilar, sonido/vibración,
      notificación de pantalla bloqueada.
    - **Terapia** — parámetros de terapia, sola en su pestaña **a propósito**:
      es la única cuyos valores alimentan un cálculo de dosis, y mezclada
      entre recordatorios y exportaciones era fácil de tocar de paso.
    - **Reportes** — exportar PDF/Excel y diagnóstico.

    De paso, el título del modal era "Conexiones y privacidad", que hacía
    rato no describía la mitad de lo que contenía; ahora es "Ajustes"
    (y se corrigió el `accessibilityLabel` del botón que lo abre). El
    contenido de cada sección se movió tal cual, sin reescribir textos.

## Conexión al sensor: la app era de un solo usuario (2026-08-19, Grupo C)

Verónica preguntó cuál era el método real de conexión al sensor, porque
sospechaba que era LibreLinkUp y no Junction. Tenía razón, y al verificarlo
apareció algo más grave.

### Lo que se encontró

1. **El proveedor real es LibreLinkUp**, no Junction. Confirmado por dos vías
   independientes: `CGM_PROVIDER=librelinkup` selecciona
   `LibreLinkUpCGMProvider` en `apps/api/src/app.ts`, y el backend en
   producción responde `"provider": "librelinkup-freestyle-libre"` a
   `GET /v1/cgm/status`. `docs/CGM_INTEGRATION_DECISION.md` decía Junction y
   quedó desactualizado sin que nadie lo anotara — ya lleva una advertencia
   al principio.

2. **El botón "Iniciar conexión LibreView" de Ajustes no hacía nada útil.**
   Llamaba a `/v1/provider/junction/link`, que es la ruta de Junction: no
   cambia de dónde salen las lecturas. Eliminado.

3. **La app era de un solo usuario, y eso es una fuga de datos.**
   `LIBRELINKUP_EMAIL`/`LIBRELINKUP_PASSWORD` son variables de entorno del
   backend, leídas **una sola vez al arrancar el servidor** en
   `buildProvider()`. Hay una credencial global única para todas las
   instalaciones. Cualquier persona que instalara el APK habría visto la
   glucosa de Verónica, no la suya.

### Lo que se hizo

Cada usuaria conecta **su propia** cuenta de LibreLinkUp desde el teléfono
(`apps/mobile/src/sensorConnection.ts`), y el teléfono habla **directo con
Abbott**, sin pasar por nuestro backend.

Por qué en el dispositivo y no en el servidor, que era la alternativa obvia:

- **No requiere redeploy.** Sin credenciales locales guardadas, el camino es
  byte por byte el de antes, así que la instalación de Verónica no se toca y
  su conexión no corre ningún riesgo — que era su condición explícita.
- **Su contraseña de LibreLinkUp nunca llega a nuestro servidor.** Va solo del
  teléfono a Abbott. No custodiamos credenciales de terceros, que además nos
  ahorra una responsabilidad que no queremos.
- Es coherente con `docs/adr/0001-local-first.md`.

Detalles de implementación que conviene no re-derivar:

- Se comparte **la misma** `LibreLinkUpCGMProvider` de `packages/cgm` entre
  backend y teléfono, en vez de reescribirla: es una API de ingeniería
  inversa y mantener dos copias garantiza que se desincronicen. Además la
  del backend ya está probada en producción, que es la mejor razón para
  reusarla. La única diferencia es `sha256Hex`, ahora inyectado
  (`node:crypto` en el servidor, `expo-crypto` en el teléfono) — el import de
  `node:crypto` a nivel de módulo rompía el bundle de Metro.
- Al conectar/desconectar, `App.tsx` **limpia `readings` y `status` en memoria
  antes de recargar**, para que no se muestre ni un instante la glucosa de la
  cuenta anterior como si fuera de la nueva.
- Si la ruta del dispositivo falla, **no** se cae de vuelta al backend, a
  propósito: eso mostraría el sensor de otra persona presentado como propio,
  que es exactamente el bug que este trabajo cierra.
- Bundlear `packages/cgm` desde Metro por primera vez destapó el mismo bug de
  extensiones `.js` en imports relativos que ya habíamos visto en
  `packages/domain` (Fase 13, ítem 11). Corregido en los 5 archivos de
  `packages/cgm/src` y en sus tests. La regla ya estaba en `CODE_MAP.md`;
  ahora aplica a los dos paquetes.

Guía de usuaria: [`CONECTAR_SENSOR.md`](CONECTAR_SENSOR.md), enlazada desde el
onboarding y desde Ajustes → Dispositivos.

### Fugas entre pacientes encontradas por `domain-safety-reviewer`

La primera versión de este trabajo dejaba **tres caminos** por los que la
glucosa de otra persona llegaba a la pantalla como propia. Vale anotarlos
porque comparten una misma causa de diseño: **"no hay credenciales" se estaba
tratando como "usa el backend"**, cuando lo correcto es "no hay sensor".

1. **`backgroundSync.ts` seguía llamando al backend directo.** `App.tsx` se
   migró, ese archivo no. Corre cada ~15 min vía WorkManager y en cada toque
   de "Actualizar" de la notificación, **con la app cerrada**, así que
   escribía lecturas ajenas en el mismo SQLite y las ponía en la pantalla
   bloqueada rotuladas como sensor en vivo. Una vez mezcladas son
   indistinguibles: quedan con `origin:'real'` y el mismo `source`.
2. **"Desconectar este sensor" reconectaba en silencio a la cuenta global.**
   Sin credenciales se caía al backend, y el mensaje decía "solo dejamos de
   leer lecturas nuevas", que era literalmente falso.
3. **Una instalación nueva mostraba el sensor compartido antes de abrir
   Ajustes.** El onboarding "Conecta tu sensor" se mostraba encima de una
   pantalla que ya estaba mostrando la glucosa de otra persona.

Solución: un flag `legacyBackendSensor` resuelto **una sola vez**
(`resolveLegacyBackendSensor` en `db.ts`), `true` únicamente si al migrar ya
había lecturas `origin:'real'` guardadas — o sea, si esa instalación venía
sincronizando con el backend desde antes. Instalación nueva → `none`, sin
sensor, degradando a registro manual como exige `AGENTS.md`. La fuente pasó a
ser un tipo explícito (`SensorSource`) que se resuelve en un solo lugar y se
pasa a `fetchSensorStatus`/`fetchSensorReadings`, en vez de que cada función
la adivine.

Además:

- **Cambiar de cuenta no purgaba las lecturas anteriores.** Limpiar el estado
  en memoria no servía de nada: `refresh()` arranca con `loadLocalState()`,
  que las vuelve a leer de SQLite antes de la primera respuesta de red. Ahora
  `deleteSensorReadings()` borra las de `origin:'real'` (lo manual e
  importado se conserva) y se avisa cuántas.
- **`testSensorCredentials` daba por buena la conexión con `provider_error` u
  `offline`**, que no prueban nada sobre las credenciales. Ahora exige
  `connected` o `stale`.
- **Dos logins a LibreLinkUp por refresco.** El proveedor cachea el ticket en
  la instancia y se construía una nueva por llamada. Es una API no oficial que
  bloquea cuentas por logins repetidos: habría dejado a la usuaria sin su
  propio sensor. Ahora hay una instancia cacheada por credencial.
- **`parseNonNegativeNumber('')` devuelve `0`, no `null`** (`Number('')` es 0).
  Por eso el ítem 7 guardaba `proteinG: 0, fatG: 0, fiberG: 0` en **cada**
  comida aunque la usuaria nunca abriera la sección, y el reporte al médico
  mostraba "0 g de proteína, promedio de N" como dato medido — destruyendo
  justamente la distinción "no anotado" vs "0 g" sobre la que está construido
  el ítem. El helper quedó documentado y con test.

### Pendiente

- **Nadie ha probado esto contra la API real de LibreLinkUp desde el
  teléfono.** El código es el mismo que funciona en el backend, pero la
  ejecución en React Native (fetch nativo, `expo-crypto`) no está verificada.
  Es lo primero a confirmar en el próximo build.
- Las variables `LIBRELINKUP_*` del backend siguen sirviendo a la instalación
  de Verónica. Cuando ella conecte su cuenta desde la app, conviene sacarlas
  del entorno de Abacus para que no quede una credencial global viva.

## Fase 14 — Nutrición (2026-08-20)

Pedido de Verónica: una página aparte de la principal donde se lleven de
verdad los datos de comida que ya se guardaban y no se mostraban, con metas de
calorías y macros al estilo de Nutria / Fitia / MyFitnessPal, y que **integre
el cuidado de la diabetes con el de la comida**.

### Lo que se construyó

- **`packages/domain/src/nutrition-targets.ts`** — Mifflin-St Jeor → TDEE →
  reparto de macros. Puro, con 18 tests.
- **`packages/domain/src/macro-glucose.ts`** — la integración real entre las
  dos mitades (ver abajo). 8 tests.
- **`apps/mobile/src/components/NutritionModal.tsx`** — la pantalla, en tres
  pestañas: Hoy / Metas / Patrones. Botón ◍ en la barra superior.
- **`NutritionProfileSchema`** + persistencia en `app_settings`, paso nuevo en
  el onboarding, `macroColors` en `theme.ts`, y la sección de grasa/proteína
  en el reporte PDF.

### La decisión de producto que importa

La integración no es poner las dos cosas en la misma app: es **medir lo que el
conteo de carbohidratos no explica**. La evidencia en diabetes tipo 1 dice que
la grasa y la proteína mueven la glucosa de forma **retrasada y prolongada**
—entre 1,5 y 6 h, con la grasa haciendo pico cerca de las 2 h, la proteína
cerca de las 3,5 h, y un efecto **aditivo** entre las 3 y las 5 h cuando la
comida es alta en ambas—. Nada de eso se veía en la app, que solo miraba la
primera hora tras una dosis rápida.

Ahora que se registran proteína y grasa (Fase 13, ítem 7), se puede comparar
las comidas de mayor y menor carga de grasa+proteína contra el cambio de
glucosa a 2/3/4/5 h, con los datos de la propia usuaria. Eso es lo que hace
`macro-glucose.ts`, y va también al reporte que se lleva al médico.

### Las fronteras de seguridad, que acá son estrechas

Esta fase mezcla metas de peso con una app de insulina, que es donde un texto
mal calibrado hace daño de verdad. Las reglas que quedaron codificadas:

1. **El déficit está capado a 500 kcal/día**, no a los 1000 que usan las
   calculadoras genéricas. Un déficit agresivo sobre una pauta de insulina que
   no cambió al mismo tiempo es riesgo de hipoglucemia, no solo de perder
   músculo.
2. **Pisos duros**: nunca bajo el metabolismo basal, nunca bajo 1200 kcal
   (mujeres) / 1500 (hombres). Si un piso muerde, `clampedBy` lo reporta y la
   pantalla lo dice — una meta corregida en silencio es una meta que la
   usuaria no puede evaluar.
3. **La proteína sube en déficit** (1,6 vs 1,2 g/kg): la ADA pide cuidar
   específicamente la insuficiencia proteica en pérdida de peso intencional.
4. **Carbohidratos al 50 % de la energía**, el techo del rango que ISPAD
   recomienda en T1D — no un porcentaje inventado ni una dieta baja en carbos.
5. **`macro-glucose.ts` describe y nunca acciona.** La respuesta que da la
   literatura a la subida tardía es *ajustar la insulina* (bolos duales o
   extendidos). Eso es exactamente lo que `AGENTS.md` prohíbe, y este es el
   módulo desde donde sería más tentador. Hay un test en
   `reportExport.test.ts` que falla si la sección del reporte llega a
   mencionar un bolo extendido o un verbo imperativo de ajuste.
6. **"Sin anotar" nunca es 0 g.** Sostiene toda la pantalla:
   `energyFromMacros` devuelve `partial`, el total del día se muestra como un
   mínimo cuando falta un macro, y una comida sin grasa **o** sin proteína no
   entra en la comparación de patrones (tratar el ausente como 0 la mandaría
   al grupo equivocado).

### Hallazgos de `domain-safety-reviewer` corregidos en la misma corrida

La revisión encontró siete cosas; dos eran graves y una la había encontrado
yo antes con un barrido propio de perfiles.

1. **Sin puerta de edad: un chico de 12 años recibía un déficit de 500 kcal
   en silencio.** El esquema aceptaba desde los 12, pero *todos* los pisos del
   módulo son de adulto — Mifflin-St Jeor es una ecuación de adultos y los
   1200/1500 kcal también—, así que en un menor no muerden nunca y
   `clampedBy` jamás se levantaba. Además de la aritmética hay una razón
   clínica más fuerte: la adolescencia con T1D es la población de mayor riesgo
   de trastornos de la conducta alimentaria y de omisión de insulina para
   bajar de peso, y una meta de pérdida de peso puesta por una app es
   exactamente el disparador que no corresponde. **`ageYears` pasó a mínimo
   18**, con test.
2. **Los carbohidratos del atajo rápido se contaban como 0.** `loadNutritionDay`
   cargaba `dayCarbs` pero la pantalla **nunca los leía**: solo sumaba
   `MealEvent.confirmedCarbsG`. Como el atajo de la pantalla principal escribe
   un `CarbEvent`, alguien que registrara 120 g por ahí veía "0 g" y un día
   entero de margen. Corregido sumando ambas fuentes, excluyendo los
   `CarbEvent` con `source: 'meal_confirmed'` para no duplicar los de las
   comidas, y marcando el día como incompleto (un carbo suelto no trae
   proteína ni grasa).
3. **La proteína aplastaba a los carbohidratos.** Detectado con un barrido
   propio de las 800 combinaciones que el esquema permite: un perfil de 200 kg
   en déficit daba 320 g de proteína (69 % de la energía) y dejaba los
   carbohidratos en **11 %**. Una dieta muy baja en carbohidratos en T1D sin
   supervisión es riesgo de hipoglucemia. Corregido con un techo de proteína
   del 30 % de la energía (dentro del AMDR de 10–35 %). El 30 % no es
   arbitrario: a 25 % ya recortaba un perfil corriente de 70 kg, anulando sin
   querer la regla de la ADA sobre la masa magra.
4. **La advertencia de hipoglucemia no estaba donde se decide.** Existía al
   pie de la pestaña Metas, igual para las cuatro metas, y sin decir la
   palabra. Ahora aparece junto al selector y solo al elegir "bajar de peso",
   diciendo explícitamente que comer menos con la misma pauta de insulina
   puede causar hipoglucemias y que el ajuste lo hace el equipo clínico.
5. **La pestaña Hoy no decía que la meta es una referencia.** Es la pantalla
   que se mira a diario, y una línea sobre gramos de carbohidrato en una app
   de insulina se lee como un límite si nadie aclara lo contrario. Agregado.
6. **El texto prometía "50 % de carbohidratos" y entregaba otra cosa.** Cuando
   el acotado de grasa muerde, la diferencia se compensa con carbohidratos y
   el valor real sube. Ahora la pantalla muestra el **porcentaje calculado**
   de los tres macros en vez de repetir una cifra fija, así el texto no puede
   divergir del número.
7. **Faltaban tests de esos bordes.** Agregados: puerta de edad, techo de
   proteína, y un barrido que falla si los carbohidratos bajan del 40 % en
   cualquier perfil que el esquema acepte.

Quedó limpio en la revisión: `macro-glucose.ts` y sus dos superficies (nada
sugiere bolo extendido, tiempo de espera ni comer menos grasa), la ausencia de
cualquier camino del objetivo de carbohidratos hacia un cálculo de insulina,
la distinción "no anotado" vs "0 g" en `energyFromMacros` y en el filtro de
elegibilidad, y la exclusión de sintéticas con `sourceTimestamp` preservado.

### Paleta

`macroColors` (carbos / proteína / grasa) es **categórica** y deliberadamente
distinta de `glucoseBands`, que es de **estado** clínico: reusar el color de
una banda de glucosa para un macro haría que una barra de proteína se leyera
como "en rango". Validada con el script de la skill `dataviz` contra la
superficie real de la app — los cinco checks pasan. El par más justo está
apenas sobre el umbral de daltonismo, así que cada barra lleva siempre su
etiqueta y sus gramos.

### Pendiente

- Las calorías se derivan de los macros (4/4/9). No hay base de datos de
  alimentos ni código de barras: quien quiera un seguimiento fino tiene que
  anotar los macros a mano. Es la diferencia más grande contra Fitia/MFP y el
  candidato natural a la fase siguiente.
- `caloriesKcal` existe en `MealEventSchema` pero no tiene campo de entrada:
  se deriva. Pedirla aparte invita a que no cuadre con los macros.

## Fase 15 — La IA estima los macros y arma nuestro catálogo (2026-08-20)

Verónica corrigió una suposición mía de la Fase 14: yo había dado por hecho
que los macros se anotaban a mano. No hacía falta.

### Lo que ya existía y no se estaba usando

**La IA siempre estimó todos los macros.** El prompt de visión y el de texto
(`packages/ai/src/prompts.ts`) piden por cada alimento: gramos,
carbohidratos, proteína, grasa, fibra, calorías y confianza. `FoodEstimateSchema`
los lleva. El backend los devolvía. La app los guardaba en el `MealEvent`…
y el desglose **por alimento** se usaba una vez y se tiraba.

### Bug real encontrado y corregido

En `confirmMeal` (`App.tsx`), el spread del análisis de IA iba **después** de
los macros escritos por la usuaria, así que **pisaba en silencio sus
correcciones**. Si ella corregía la proteína que la IA había estimado mal, su
número se descartaba. Es exactamente lo contrario de lo que manda `AGENTS.md`
sobre separar lo estimado de lo confirmado. Ahora el análisis va primero y lo
suyo gana.

### Lo que se construyó

1. **La IA precarga proteína, grasa y fibra** al analizar (foto o texto),
   editables. **Los carbohidratos no se precargan, a propósito**: son los que
   determinan el bolo de comida, y ahí la regla de separar estimado de
   confirmado no admite comodidad. Proteína/grasa/fibra no entran en ningún
   cálculo de dosis, así que precargarlas sí es legítimo.
2. **`MealEvent.macrosSource`** (`'ai'`/`'user'`/`'mixed'`): la procedencia
   queda guardada. Para un equipo clínico, "la IA estimó 30 g de proteína" y
   "la paciente pesó y anotó 30 g" no son el mismo dato. Ausente = procedencia
   desconocida (comidas viejas), y nunca se asume confirmado.
3. **Catálogo de alimentos local** (`packages/domain/src/food-catalog.ts` +
   tabla `food_catalog`): cada alimento identificado se guarda normalizado por
   100 g. Volver a comer lo mismo se registra **sin llamar a la IA** — se elige
   del catálogo, se indican los gramos y escala solo. Instantáneo, sin
   conexión, y sin mandar otra foto afuera. Es el caso de uso real: la gente
   come casi siempre lo mismo.
   El upsert **promedia ponderado por veces vistas**, así que dos estimaciones
   del mismo pan convergen en vez de que la última pise a la anterior.

### La base compartida en Abacus: investigada, viable, y NO disparada

- El **Feature Store** de Abacus **no sirve** para esto: es ingeniería de
  features para entrenar modelos y correr predicciones batch desde
  S3/Snowflake/Redshift. Es analítico, no transaccional.
- Lo que **sí** sirve: las instancias de app de DeepAgent traen **Postgres
  persistente** incluido, y nuestro backend ya vive en una.
- Se dejó el prompt completo, con esquema de tabla, endpoints y reglas de
  privacidad, en `docs/DEEPAGENT_REDEPLOY_PROMPT.md` § "Catálogo de alimentos
  compartido". **No se disparó**, por tres razones: la mayor parte del valor
  es local y ya está; el catálogo local es el prerrequisito; y darle una base
  de datos al backend lo saca de ser un proxy **sin estado**, que es una
  decisión de `docs/adr/0001-local-first.md` y merece su propio ADR, no ser el
  efecto colateral de una corrida de features.

> **Actualización 2026-08-21: el ADR ya existe y el backend ya está
> construido, todavía sin disparar el redeploy.** `docs/adr/0003-shared-food-catalog.md`
> registra la decisión; `apps/api/src/food-catalog-store.ts` implementa
> `GET`/`POST /v1/food-catalog` reusando las mismas funciones puras del
> catálogo local (`foodKey`, `isPlausibleCatalogEntry`, `blendCatalogEntry`),
> auto-provee su tabla al arrancar (sin migración manual) y degrada a 503 sin
> `DATABASE_URL`. **La app móvil sigue sin tocarse a propósito** — el pedido
> explícito de Verónica fue dejar el backend listo de antemano para que,
> cuando esta fase se implemente en `apps/mobile`, esa corrida futura sea
> puro trabajo de cliente y no necesite otro redeploy. Ver
> `docs/DEEPAGENT_REDEPLOY_PROMPT.md` para el prompt consolidado.

### Hallazgos de `domain-safety-reviewer` corregidos en la misma corrida

Siete, dos de severidad alta. Los dos primeros los introduje yo en esta misma
fase, y son un buen recordatorio de que precargar campos cambia qué bugs son
posibles.

1. **Los macros se filtraban de una comida a la siguiente.** El `useEffect` de
   reset de `MealModal` no limpiaba los campos nuevos. Antes casi siempre
   estaban vacíos y no se notaba; ahora que la IA los precarga en cada
   análisis, era la norma: registrar una fruta después de un plato de pastas
   la guardaba con la proteína y la grasa de las pastas, **y etiquetada como
   estimación de IA de esa fruta**. Esos números entraban al promedio del
   reporte médico como ingesta real.
2. **Borrar un macro precargado no lo borraba.** Un campo en blanco significa
   "no lo anoté", pero como el spread del análisis ahora va primero, el número
   de la IA se volvía a escribir — y encima quedaba como `mixed`, o sea "ella
   lo revisó". Se agregó `clearedMacros`: vaciar un campo precargado descarta
   los macros del análisis, en vez de restaurarlos.
3. **Un carbo del catálogo quedaba indistinguible de uno pesado en balanza.**
   Al reusar un alimento sin sacar foto no había `analysis`, así que la comida
   se guardaba sin `aiEstimatedCarbsG`: ni ella ni el médico podían saber que
   ese número venía de una media de estimaciones de IA. Ahora el catálogo
   arrastra su procedencia.
4. **El promedio del catálogo podía corromperse sin salida.** Se movió a
   `packages/domain` (era un cálculo que termina sugiriendo carbohidratos y
   vivía suelto en `db.ts`, contra la regla de `AGENTS.md`), se le puso
   **tope al peso** —sin él, un alimento visto 50 veces quedaba inmutable y un
   error temprano no se corregía nunca, con la inercia creciendo al revés de
   lo deseable—, se agregó `isPlausibleCatalogEntry` (nada supera 100 g de un
   macro por 100 g de alimento, ni 900 kcal, ni más fibra que carbohidratos) y
   un `deleteCatalogFood`. Con tests.
5. **`macrosSource` era un campo de solo escritura.** Se guardaba y no se
   mostraba en ningún lado, incumpliendo el punto 5 del checklist de cierre
   (dato útil al médico → al reporte, PDF **y** Excel). Ahora el reporte trae
   una nota de procedencia: cuántas comidas tienen macros estimados por IA,
   corregidos, anotados a mano, o de procedencia no registrada. Además
   `saveEntry` —el otro camino que guarda una comida con análisis— no seteaba
   el campo, así que "ausente" mezclaba comidas viejas con comidas 100 % IA
   guardadas hoy y la semántica documentada era falsa.
6. **La rama `undefined` de `macrosSource` era inalcanzable**, así que una
   comida sin ningún macro se guardaba como `'user'`, afirmando una
   confirmación que nunca ocurrió.
7. `foodKey` llevaba los caracteres combinantes crudos en el fuente; ahora usa
   `\u0300-\u036f`. Un reformateo del archivo podía romperlo en silencio y
   partir "plátano"/"platano" en dos entradas con macros distintos.

Quedó limpio: los carbohidratos nunca se precargan en el campo de
confirmación por ningún camino; nada calcula ni sugiere insulina; el catálogo
es 100 % local y de hecho **reduce** lo que sale del teléfono; y un fallo al
escribirlo no impide guardar la comida.

### Pendiente

- El catálogo local no se muestra ni se edita en ninguna pantalla de gestión:
  si la IA guardó un alimento con una estimación mala, no hay dónde
  corregirlo o borrarlo. Es lo primero a agregar si el catálogo se usa mucho.
- `macrosSource` se guarda pero **no se muestra** todavía en el reporte
  PDF/Excel que va al médico.

## Fase 16 — Barra inferior, swipe y sistema de iconos ✅ (2026-08-20)

> **Corrección 2026-08-21: el swipe de esta fase nunca funcionó.** Verónica lo
> reportó al probarlo. Eran dos bugs independientes y cada uno bastaba:
> (1) los `panHandlers` estaban puestos encima del `ScrollView` de la pantalla,
> y un `ScrollView` es nativo — nunca le entrega la decisión al sistema de
> responders de JS, así que el gesto no se disparaba jamás (por eso tampoco
> "se rompía el gráfico": no había reconocedor compitiendo); (2) el orden del
> gesto incluía `entry` y `chat`, que son justamente los vecinos de la
> pantalla principal, así que ni con el gesto arreglado se habría llegado a
> Nutrición o Resumen. Arreglado con el `PanResponder` en un `View` que
> envuelve al `ScrollView` y reclama en fase de captura, un recorrido que
> salta lo que no es destino navegable, y un árbitro compartido
> (`src/swipeGuard.ts`) para no robarle el gesto al scroll horizontal del
> gráfico. El recorrido quedó con test (`src/swipeOrder.test.ts`).
>
> **Lección para la próxima corrida de UI:** un gesto no se puede dar por
> entregado sin probarlo en el teléfono. `pnpm verify` y el bundle de Metro no
> dicen nada sobre si un `PanResponder` llega a dispararse.


**Completada.** Lo construido: `BottomNav.tsx` (cinco destinos, el `+` central
más grande, `insets.bottom` sumado), `useSwipeNavigation.ts` (gesto lateral con
umbral direccional para no robarle el scroll al gráfico), `branding.ts`
(`APP_LOGO` por variable), iconos de **Lucide** reemplazando los glifos
Unicode de la barra superior, y marcas de hora cada 1 h en `GlucoseChart`.

Los tres botones se **movieron sin duplicarse**: "Nueva entrada" salió del
cuerpo del scroll, y Resumen y Nutrición salieron de la esquina superior.
Ajustes se quedó arriba. Catálogo y Chat quedan visibles pero inertes (Fases
18 y 8), con aviso al tocarlos, para fijar el layout y no rehacer la barra.

**Hallazgo medido que conviene no repetir:** importar iconos por nombre desde
el barrel de Lucide mete los ~1.500 al bundle (1.263 → **3.088** módulos).
Con el subpath oficial `lucide-react-native/icons/*` quedan **1.316**. Está en
la skill `/iconography`.

**Las marcas de hora**: se dibuja una línea cada hora, pero se **etiqueta cada
3** (`HOUR_LABEL_STEP`). A `PIXELS_PER_HOUR = 30` una etiqueta por hora se
solapa; la línea muda alcanza para contar y ubicarse, y las etiquetadas van un
punto más marcadas.

### Detalle original de la planificación

Pedido de Verónica. Hoy Ajustes está bien arriba a la derecha, pero Resumen y
Nutrición no: son navegación, no configuración, y están escondidos en la misma
esquina.

### Barra inferior

Fija y sticky (sobrevive al scroll), con cinco destinos en este orden:

| Posición | Destino | Icono |
|---|---|---|
| 1 (izq) | Nutrición | (mover el actual ◍) |
| 2 | Catálogo de comidas | plato |
| 3 (centro, **más grande**) | Nueva entrada | **+** |
| 4 | Chat de IA (reservado, Fase 8) | **el logo de la app** |
| 5 (der) | Resumen | (mover el actual ◔) |

- **Tres botones se MUEVEN, no se duplican**: nueva entrada (hoy es el botón
  grande del medio de la pantalla principal), Resumen y Nutrición. El botón
  de "Nueva entrada" que existe hoy en el cuerpo de la pantalla **se elimina**.
- Ajustes **se queda** arriba a la derecha: es configuración, no navegación.
- El botón del chat queda visible pero inerte hasta la Fase 8, con un aviso
  al tocarlo. Ponerlo desde ya fija el layout y evita rehacer la barra después.

### El logo, por variable

`APP_LOGO` en `apps/mobile/src/branding.ts`. **Ningún componente escribe el
nombre del archivo**; cambiar el logo debe ser cambiar una línea. Ver la skill
`/iconography`.

### Swipe

Navegación lateral entre los cinco destinos, además del toque. Con
`PanResponder`, sin librería nueva.

**El riesgo concreto**: `GlucoseChart` **es un `ScrollView` horizontal**. El
reconocedor tiene que exigir desplazamiento horizontal claramente mayor que el
vertical y no activarse si el gesto empezó sobre el gráfico, o se le roba el
scroll al gráfico principal de la app.

### Los tres botones del sistema Android

Con edge-to-edge (obligatorio desde SDK 54) la barra de navegación de Android
se dibuja **encima** del contenido. Una barra a `bottom: 0` sin inset queda
debajo de los botones del sistema y es intocable.

Se resuelve sumando `useSafeAreaInsets().bottom` al padding — **no**
ocultando la barra del sistema. Esconderla y reaparecerla con el scroll pelea
con el gesto de volver atrás y no es lo que hacen las apps nativas.

### Iconos

Reemplazar los glifos Unicode (`◔ ◍ ••• ƒ(x) ◎`) por componentes SVG en
`apps/mobile/src/components/icons/`, con `react-native-svg` — **que ya es
dependencia**, así que no se instala nada. Ver `/iconography` para las
convenciones (tamaño, trazo, color desde `theme.ts`, nunca color solo).

### Gráfico principal: marcas cada hora

`HOUR_TICK_STEP` en `GlucoseChart.tsx` pasa de 6 a **1**. Con marcas cada seis
horas es imposible ubicar a qué hora fue una medición.

**Ojo con la densidad**: a `PIXELS_PER_HOUR = 30` una etiqueta por hora se
solapa. Hay que dibujar la línea de cada hora pero **etiquetar solo algunas**
(cada 2 o 3 según el ancho), o subir `PIXELS_PER_HOUR`. Las líneas finas y
recesivas (`colors.line`), la etiqueta en `colors.muted`.

---

## Fase 17 — Editar una comida con la misma potencia que crearla ✅ (2026-08-21)

> **🟡 Alcance real vs. lo prometido en la tabla de fases (encontrado
> 2026-08-21, cuando Verónica preguntó por esto):** la fila de la tabla dice
> "editar **entradas**" en general; esta sección y lo construido son solo
> para **una comida** que ya existe como su propia entrada del Timeline. Una
> lectura automática de glucosa o una entrada empaquetada ("Nueva entrada")
> **no** ganaron esta potencia: hoy, al editarlas, solo se puede adjuntar un
> número de carbohidratos, texto libre, insulina y nota — sin foto, sin IA,
> sin macros, sin calculadora de dosis. Verificado contra el código:
> `TimelineEditPayload` (`apps/mobile/src/types.ts`) no tiene esos campos
> para `kind: 'glucose'` ni `kind: 'entry'` — no es que estén rotos, es que
> no se escribieron. El alcance completo queda como **Fase 21**.

**Entregado (para una comida).** Lo construido, y las decisiones que no
estaban en el plan:

- `apps/mobile/src/components/MealEditModal.tsx` — los tres modos (otra foto,
  descripción de texto, instrucción en lenguaje natural) más la corrección a
  mano de macros, carbohidratos confirmados y nota.
- El botón "Editar" de una comida en `TimelineDetailModal` abre este modal;
  **se eliminó el formulario inline anterior**, que solo llegaba a la nota, y
  con él la variante `{ kind: 'meal' }` de `TimelineEditPayload` y
  `updateMealNote`. Dos caminos de edición para lo mismo se habrían separado.
- `MealSnapshotSchema` / `MealEditInputSchema` (`packages/schemas`) — lo que
  viaja a la IA. **Sin campo de insulina, glucosa ni parámetro de terapia**:
  la frontera de `AGENTS.md` quedó en la forma del tipo, no en una frase del
  prompt. Un test de `apps/api` prueba que Zod descarta una dosis que un
  cliente mande igual.
- `requestsInsulinAdvice()` (`packages/domain/src/ai-safety.ts`) — guardrail
  **de entrada**: "¿cuánta insulina me pongo?" se rechaza antes de gastar la
  llamada. Los patrones son distintos de los de salida a propósito: una
  pregunta no dispara los patrones de recomendación. Trampa encontrada al
  escribirlo: `\b` en JavaScript es ASCII, así que después de "qué" no hay
  límite de palabra — ahí va un lookahead explícito.
- **Confirmación informada, no un "¿aplico?"**: se muestra el antes/después
  campo por campo, con lo cambiado marcado. Los carbohidratos siguen sin
  autocompletarse (siguen siendo acto de la usuaria); la propuesta queda como
  una sugerencia tocable al lado del campo.
- **Dos incoherencias encontradas revisando el propio diff, no en el plan:**
  1. Una foto nueva cuya propuesta no se aplicaba igual reemplazaba la foto
     guardada, dejando la imagen y los macros describiendo comidas distintas.
     Ahora la foto se adopta solo junto con su análisis.
  2. Un episodio post-comida ya `complete` congela sus métricas. Como hasta
     ahora solo la nota era editable, daba igual; con carbos y macros
     editables, el resumen post-comida seguiría mostrando el número viejo —
     y ese resumen es el que se lleva al médico. `updateMealFromEdit` devuelve
     el episodio a `collecting` y `App.saveMealEdit` lo recalcula en el acto.

**Requiere redeploy** (no build): el modo de instrucción es una rama nueva de
`/v1/ai/meal-analysis`. Hasta que se redespliegue, la foto y el texto siguen
funcionando y "Explícale el cambio" responde 400. Ver
`docs/DEEPAGENT_REDEPLOY_PROMPT.md` § "Qué cambió desde el último deploy".

### Plan original (2026-08-20)


Hoy se puede crear una comida con IA pero **no editarla con IA**. Si guardaste
solo los carbohidratos, no hay forma de decirle después "esto era un sándwich
de queso" y que complete los macros.

Al editar tiene que haber **exactamente las mismas opciones que al crear**:

1. **Foto** — agregar o reemplazar la foto y re-analizar.
2. **Texto** — describir la comida y que la IA estime.
3. **Solo en modo edición: explicarle el cambio en lenguaje natural.**
   "Agrégale una cucharada de aceite", "en realidad fue media porción",
   "esto era pan integral, no blanco". La IA recibe **la entrada actual + la
   instrucción** y devuelve la entrada modificada.

**Confirmación obligatoria antes de guardar.** La IA propone, la usuaria
confirma. Es el mismo patrón que ya rige en toda la app y lo exige
`AGENTS.md`: la estimación de la IA nunca se escribe sola.

**Frontera de seguridad**: la IA puede proponer macros; **no puede proponer
insulina**. Si la entrada tiene una dosis registrada, la instrucción de
edición no la toca. Esto necesita `domain-safety-reviewer` y probablemente un
guardrail nuevo en `packages/ai`.

**Backend**: la edición por instrucción es un modo nuevo de
`/v1/ai/meal-analysis` (o un endpoint hermano) → **requiere redeploy**.
Anotarlo en `docs/DEEPAGENT_REDEPLOY_PROMPT.md` cuando se construya.

---

## Fase 18 — Catálogo de comidas editable y porciones ✅ (2026-08-21)

**Entregado.** Lo construido y las decisiones que no estaban en el plan:

- `apps/mobile/src/components/CatalogModal.tsx` — listar, buscar, corregir a
  mano, corregir con IA por texto, borrar. El botón "Catálogo" de la barra
  inferior deja de ser un aviso.
- **La edición con IA no agregó ninguna rama al backend**: presenta el
  alimento como una comida de un solo ítem de 100 g y reusa el modo de
  instrucción de la Fase 17. Hereda gratis su guardrail de entrada. Por eso
  las dos fases comparten un único redeploy pendiente.
- **Porción de referencia opcional** (`servingGrams`/`servingLabel`). Se
  agregó con `ALTER TABLE ADD COLUMN`, nunca con un `CREATE` nuevo: hay datos
  reales en el teléfono de Verónica. Ausente = 100 g, así que toda fila vieja
  se comporta exactamente como antes. Al reusar un alimento se piden
  **porciones (0,1 a 10)**, con los gramos como segunda puerta para quien pesa
  en balanza.
- **La pregunta de tres salidas**, con dos matices que aparecieron
  construyéndola:
  1. **Tiene tolerancia (10 % o 1 g).** Con `!==` habría saltado por redondear
     42,5 g a 42 — es decir, en casi todas las comidas. Una pregunta que salta
     siempre se responde sin leer, y así es como se corrompe el catálogo que
     esta pregunta viene a proteger.
  2. **Un macro borrado no la dispara.** Dejar un campo en blanco es "no lo
     anoté", una afirmación sobre esa comida; pedirle que decida sobre el
     alimento por eso sería malinterpretar el gesto.
- `blendCatalogEntry` **conserva la porción que definió la usuaria**: un
  análisis nuevo de la IA no trae ese campo, así que sin esto se lo borraba en
  cada identificación.
- Toda escritura al catálogo pasa por `applyCatalogEdit` en `packages/domain`
  (puro y con test), que valida con `isPlausibleCatalogEntry`. Un valor
  imposible por 100 g guardado ahí sugeriría carbohidratos imposibles en cada
  comida futura que reuse el alimento.

**Cuatro hallazgos de la revisión de seguridad, corregidos en la misma
corrida.** Vale la pena dejarlos escritos porque tres de ellos eran
plausibles a la vista y ninguna validación los habría atrapado:

1. **El total de carbohidratos de la comida se escribía como si describiera a
   un solo alimento.** La app tiene un campo de carbos, y es de *la comida*:
   si ella reusa "Arroz" y además come pan, la diferencia contra lo que
   predijo el catálogo no es del arroz. La pregunta de tres salidas escribía
   ese total igual, dejando el arroz inflado ~65 % para siempre y con un
   número perfectamente plausible. Arreglado con dos defensas: la pregunta ya
   **no aparece** si la comida además pasó por un análisis (ahí hay otros
   alimentos identificados), y cuando aparece hay un **segundo paso que
   muestra lo que quedaría escrito por 100 g** y advierte que eso supone que
   la comida fue solo ese alimento. Un número inflado se ve a simple vista;
   un cambio silencioso, no.
2. **El editor mandaba `0` a la IA con decimales escritos con coma.** Usaba
   `Number()` crudo, y `Number('28,5')` es `NaN` → `|| 0`. En un teclado
   decimal chileno "28,5" es exactamente lo que se escribe, así que la IA
   recibía el alimento con **0 g por 100 g** como estado actual, "corregía"
   desde cero y devolvía macros inventados.
3. **La porción de referencia no tenía cota superior.** `isPlausibleCatalogEntry`
   solo miraba los macros, así que un 1500 donde iban 150 pasaba entero y
   multiplicaba por diez cada sugerencia. Ahora se valida en el dominio.
4. **Los guardas de escritura de `db.ts` no tenían test.** La lógica se movió
   a `applyCatalogEdit` en `packages/domain` y quedó cubierta.

**No requiere redeploy propio** ni cambios en los reportes: el catálogo es una
comodidad de registro, no una métrica clínica; lo que sí llega al reporte —los
macros de cada comida— ya viajaba desde la Fase 15.

### Plan original (2026-08-20)


### Pantalla de catálogo

Hoy el catálogo se llena solo pero **no hay dónde verlo ni corregirlo**: si la
IA guardó un alimento con una estimación mala, queda mala para siempre. La
función de borrado existe en el código, sin botón.

La pantalla necesita: listar, buscar, editar a mano, **editar con IA por
texto** ("el arroz que guardaste está mal, son 28 g de carbos por 100 g"), y
borrar.

### Porciones

- Al crear un alimento, la IA **o** la usuaria definen el tamaño de la
  porción de referencia (ej. 100 g).
- Al reutilizarlo, se elige **cuántas porciones**, de **0,1 a 10**.
- El tamaño de la porción de referencia **también se edita desde el catálogo**.

### La regla que evita corromper el catálogo

**El único campo editable sin tocar el catálogo es "Porción".** Cambiar la
cantidad de porciones es un dato de *esa comida*, no del alimento.

Cualquier otro cambio (macros, nombre, tamaño de la porción de referencia)
sobre una comida que vino del catálogo dispara, **antes de guardar**, una
pregunta de tres salidas:

1. **Editar el alimento del catálogo** — corrige el alimento para siempre.
2. **Crear uno nuevo** — deja el original intacto y guarda una variante.
3. **No guardar en el catálogo** — el cambio vale solo para esta comida.

Sin esa pregunta, corregir una comida puntual corrompería silenciosamente el
alimento que se reutiliza en todas las demás.

---

## Fase 19 — Notificaciones distinguibles (planificada 2026-08-20)

**Es un problema de seguridad, no de estética.** Con las tres alarmas
(post-comida, corrección, capilar) llegando con el mismo símbolo y color, se
vuelven indistinguibles y se ignoran todas — incluidas las que importan.
Fatiga de alarma.

Cada tipo lleva icono propio, color propio y un título que diga de qué es.

### Sobre si suenan: lo que se verificó en el código

Los canales están **bien configurados** (`apps/mobile/src/notifications.ts`):
`reminders-sound` es `importance: HIGH` + `sound: 'default'` +
`vibrationPattern: [0]`, y `reminders-vibrate` es `sound: null` + patrón de
vibración. Con la app **cerrada o en segundo plano, suena**.

**Pero con la app abierta, no suena**, y es un bug: el
`setNotificationHandler` devuelve `shouldPlaySound: false`, que gobierna la
presentación en primer plano. Si Verónica probó las alarmas con la app
abierta, escuchó silencio aunque hubiera elegido "sonido". Arreglarlo es
respetar el estilo elegido también en primer plano.

**Segunda trampa, ya documentada en el propio archivo**: Android **congela el
sonido y la vibración de un canal en el momento de crearlo** e ignora los
cambios posteriores. Los canales ya existen en el teléfono de Verónica desde
instalaciones anteriores, así que cambiar sus propiedades en código **no hace
nada**. Cambiar el sonido de un canal existente obliga a **crear un canal con
un id nuevo**.

### Hasta dónde se puede diferenciar, verificado contra la versión instalada

Esto se comprobó leyendo `expo-notifications@57` en `node_modules`, no de
memoria, porque marca el techo de la fase.

`NotificationContentAndroid` expone exactamente **cuatro** campos por
notificación: `badge`, `color`, `priority`, `vibrationPattern`. No hay
`smallIcon` ni `largeIcon`. Y el config plugin
(`withNotificationsAndroid`) toma **un** `icon` y **un** `color`, que compila
al recurso fijo `@drawable/notification_icon`.

**Se puede, sin código nativo:**

| Recurso | Alcance | Impacto |
|---|---|---|
| Emoji al inicio del título | Por notificación | El más alto. Es texto, se ve grande y es lo que hacen las apps reales para distinguir tipos |
| `content.color` | Por notificación | Android tiñe con él el icono pequeño y el nombre de la app |
| Título propio y explícito | Por notificación | Alto |
| **Un canal por tipo de alarma** | Por canal | Alto, y es el camino nativo correcto: cada canal trae su propio sonido, su propia vibración **y su propio interruptor en los ajustes de Android**, así que la usuaria puede silenciar "corrección" sin perder "capilar" |
| `priority` / importancia | Por canal | Medio |

**NO se puede sin salir de `expo-notifications`:** un **icono pequeño
distinto por tipo**. El icono de la barra de estado es uno solo para toda la
app, fijado en tiempo de compilación. Cambiar eso exige un config plugin
propio que agregue varios drawables y llame a `setSmallIcon` por
notificación — es trabajo nativo de verdad, no una prop.

### Decisión: las cuatro combinadas, no una sola

Se combinan **porque cada una opera en una capa distinta** y ninguna sola
resuelve el problema:

| Capa | Recurso | Qué resuelve |
|---|---|---|
| Lo que ve en la bandeja | **Emoji al inicio del título** | Distinguir de un vistazo, sin leer |
| El tinte | **`content.color` por tipo** | Refuerza el emoji; Android tiñe icono y nombre de la app |
| Lo que dice | **Título explícito por tipo** | Saber qué es sin abrir |
| Lo que suena | **Un canal por tipo** | Distinguir **sin mirar**, y —clave— poder silenciar un tipo sin perder los otros desde los ajustes de Android |

Mapa concreto propuesto:

| Alarma | Emoji | Color | Título |
|---|---|---|---|
| Post-comida | 🍽️ | `colors.orange` | "Revisa tu glucosa post-comida" |
| Corrección | 💧 | `colors.teal` | "Revisa tu glucosa tras la corrección" |
| Capilar | 🩸 | `colors.red` | "Toca medirte capilar" |

El **canal por tipo** es el de mayor valor real y el menos obvio: hoy los tres
tipos comparten canal, así que Android los trata como una sola cosa. Separarlos
le da a la usuaria un interruptor por tipo en los ajustes del sistema, que es
justo lo que necesita alguien que quiere silenciar los recordatorios de
corrección pero no los de capilar.

**El icono pequeño por tipo queda descartado para esta fase**, no por pereza
sino por costo/beneficio: exige un config plugin propio y aporta el
diferenciador más débil de los cinco (un símbolo monocromo de ~16 px). Se
reevalúa solo si con emoji + color + título + canal la confusión persiste.

**Sigue necesitando build** aunque el icono sea uno solo: los canales nuevos
y el drawable se fijan en configuración nativa. Y ojo con lo de siempre —
Android congela las propiedades de un canal al crearlo, así que los canales
por tipo tienen que nacer con ids nuevos.

---

## Fase 20 — Widget de pantalla de inicio (planificada 2026-08-20)

Widget de **4 de ancho × 3 de alto**, en la pantalla de inicio (no en
notificaciones):

| Fila | Contenido |
|---|---|
| 1 | Glucemia actual + botón de actualizar (refresca el widget sin pasar por la notificación) |
| 2 | Cuatro accesos de un toque: comida manual (con su insulina), corrección (calcular), insulina basal, cetonas |
| 3 | Comida con foto (1 celda) + entrada al chat de IA (3 celdas) |

### Viabilidad, verificada

Es factible en Expo por dos vías: `react-native-android-widget` (comunidad,
con config plugin, funciona con CNG/EAS) o `expo-widgets` (más nuevo,
componentes de Expo UI, sin setup nativo manual). Hay que evaluar cuál soporta
SDK 57 al momento de construirlo.

**Las dos requieren un config plugin → cambio nativo → build.** No hay forma
de entregar el widget en una corrida "sin build".

### Fronteras que el widget hereda

- La glucemia del widget **nunca puede presentarse como en vivo si está
  atrasada**: `assessFreshness` y `sourceTimestamp` aplican igual que en la
  app. Un widget que muestra un número viejo sin marcarlo es más peligroso que
  la app, porque se mira de pasada.
- Los accesos de insulina **abren la app**; el widget no calcula ni registra
  dosis por su cuenta.
- Depende de la Fase 8 para las celdas de chat.

## Fase 21 — Un solo tipo de entrada, editable con el mismo poder que crearla (planificada 2026-08-21, ampliada 2026-08-22)

**Es el alcance que la Fase 17 prometía en el título de la tabla y no
entregó** (ver el aviso al principio de la Fase 17). Confirmado y **ampliado**
por Verónica el 2026-08-22: no es solo que glucosa/entrada empaquetada deban
editarse con el poder de "Nueva entrada" — es que **debería dejar de existir
la diferencia**. Su pedido textual: "todas deben ser el mismo tipo de
entrada con el mismo menú editable. Es decir que cualquier valor guardado de
cualquier tipo es lo mismo que una nueva entrada pero con el resto de campos
vacíos, así al editar siempre se pueden cambiar todos los campos."

Esto es más grande que un fix de formulario: hoy `TimelineItem` (`types.ts`)
tiene **seis variantes distintas** (`insulin`, `carbs`, `meal`, `glucose`,
`note`, `entry`), cada una con su propio schema, su propia fila de SQLite, y
—salvo `entry`, que ya es el intento de unificación de la Fase 5— su propio
camino de guardado y edición. El pedido es colapsar esa distinción: un
registro de solo carbohidratos no es un "tipo" separado de una comida
completa, es una entrada con la mayoría de sus campos vacíos.

### Qué falta, concretamente (versión angosta, ya diagnosticada)

Hoy `TimelineEditPayload` para `kind: 'glucose'` y `kind: 'entry'` solo
acepta: glucosa (si es manual), un número plano de carbohidratos, descripción
de texto libre, insulina rápida, insulina basal y nota. Comparado con lo que
ya tiene `EntryModal.tsx` al crear, falta al editar: **foto con estimación de
IA**, **macros** (proteína, grasa, fibra), y la **calculadora de dosis**
(`calculateMealBolus`).

### Bug chico y aparte, encontrado revisando esto: "Nueva entrada" no alimenta el catálogo

`saveEntry` (`App.tsx`, el camino de `EntryModal`/"Nueva entrada" con foto)
**no llama a `recordCatalogFoods`** cuando hay análisis de IA — solo lo hace
`confirmMeal` (el camino de `MealModal`, comida standalone). Dos formularios
que hacen lo mismo (registrar una comida con foto) alimentan el catálogo de
forma distinta: uno sí, el otro no. Es independiente de la unificación de
arriba y barato de corregir (una llamada más, mismo patrón que ya existe en
`confirmMeal`) — candidato a resolverse antes, no hace falta esperar al
rediseño completo.

### La consecuencia directa que Verónica señaló por separado: el botón "Carbos"

El acceso rápido "Carbos" (`NumericEntryModal`, vía `registerNumeric`) hoy
**solo** guarda un número — no hay foto, no hay IA, no hay opción de
guardarlo en el catálogo. Con la unificación de arriba esto deja de ser un
caso especial: "Carbos" pasaría a abrir la misma sección de "agregar una
comida" que ya existe (con IA opcional y guardado a catálogo opcional), no
un formulario propio y más pobre. No se construye dos veces.

### Cómo encararla, para no repetir dos veces el mismo trabajo

`MealEditModal.tsx` (Fase 17) ya resolvió la parte difícil de este problema
para comidas: los tres modos de IA, la confirmación campo por campo, y el
guardrail estructural (`MealSnapshotSchema`) que impide que insulina o
glucosa viajen a la IA. Reusar esos componentes es más barato que
reconstruirlos. Pero la versión ampliada probablemente necesita empezar por
el modelo de datos (¿un solo `UnifiedEntry` en SQLite que reemplace a
`insulin_events`/`carb_events`/`meal_events`/`cgm_readings` manuales/`notes`
como filas sueltas, con migración de las que ya existen?) antes de tocar
ningún formulario — es una decisión de arquitectura, no una de UI, y merece
su propio diseño antes de estimarla en una corrida.

### Frontera de seguridad (sin cambios respecto a la Fase 17)

La IA puede proponer macros; **nunca** insulina. Si la entrada ya tiene una
dosis registrada, ninguna edición asistida por IA la toca ni la ve —
`MealSnapshotSchema` ya garantiza esto estructuralmente para comidas, y la
misma regla debe valer para el tipo unificado.

---

## Fase 22 — Animación del swipe entre pantallas (planificada 2026-08-21)

El gesto de swipe ya navega correctamente (corregido el 2026-08-21, ver el
aviso dentro de la Fase 16). Lo que falta es la sensación: hoy, al soltar el
dedo, la pantalla siguiente **aparece de golpe** — no hay transición. Pedido
explícito de Verónica: que mientras se desliza el dedo, se vea la pantalla
siguiente **entrar en tiempo real con el gesto** (como un carrusel), no un
salto instantáneo al soltar. Es lo que hace que se sienta inmersivo.

### Qué toca

`useSwipeNavigation.ts` decide a dónde navegar recién en
`onPanResponderRelease` (al soltar) — ahí es donde hoy se pierde la
sensación de "ir siguiendo el dedo". Para animarlo de verdad, la pantalla
destino tiene que estar montada (o pre-renderizada) y desplazarse en
`onPanResponderMove` según `gesture.dx`, con un resorte de vuelta si el
gesto no llega al umbral — no es un cambio de una línea, es la parte del
gesto que hoy no existe.

### Cuidado con lo que ya está resuelto

No tocar el árbitro de `swipeGuard.ts` (evita robarle el gesto al scroll
horizontal de `GlucoseChart`) ni el recorrido de `swipeOrder.ts` (ya tiene
test) — el problema es puramente de animación/transición, no de a dónde
navega. Respetar "Reduce Motion" (`ModalShell` ya lee la preferencia): con
la preferencia activa, la transición debe seguir siendo instantánea, no
animada.

## Fase 23 — Episodio post-comida no reconoce insulina adicional dentro de la ventana (identificada 2026-08-22)

Reportado por Verónica: si se registra una corrección **durante** la ventana
de seguimiento de un episodio (hasta 3h después de la comida), el episodio
no lo sabe.

### Confirmado contra el código, no supuesto

- `calculateMealEpisodeMetrics` (`packages/domain/src/meal.ts`) recibe **como
  mucho un** `InsulinEvent` (`rapidInsulin` — el bolo de la comida).
- `getInsulinEventsForMeal` (`apps/mobile/src/db.ts:1370`) solo busca
  insulina entre **-90 y +60 minutos** del timestamp de la comida — una
  corrección a los 90 o 150 minutos, dentro de la misma ventana de
  seguimiento de 3h, cae fuera de esa consulta y nunca se asocia al episodio.
- Consecuencia concreta: el insight de IA post-comida
  (`glucoseInsightSystemPrompt` sobre `MealEpisodeMetrics`) describe una
  bajada de glucosa a las 3h sin saber que hubo una segunda dosis de por
  medio — puede leerse como "la comida respondió bien" cuando en realidad
  respondió una corrección adicional. Las métricas de glucosa en sí (`peak`,
  `glucose60/120/180`) siguen siendo correctas —vienen del CGM, no de la
  insulina— pero la interpretación que las acompaña no tiene el contexto
  completo.

### Alcance

`MealEpisodeMetrics` necesita poder cargar **todas** las dosis de insulina
registradas dentro de la ventana del episodio (no solo el bolo inicial), y
el prompt de insight debe recibirlas y poder mencionarlas descriptivamente
("se registró una corrección de N U a las 2h") — nunca evaluar si la
corrección fue acertada ni sugerir si hacía falta. Mismo guardrail de
siempre: `containsTherapyRecommendation` sigue filtrando la salida.

---

## Fase 24 — Los gráficos de reportes deben mostrar los eventos, no solo la glucosa (identificada 2026-08-22)

Pedido de Verónica: un gráfico de glucosa en el reporte PDF/Excel no dice
**qué pasó** en esos momentos — cuándo hubo una comida, una dosis, una nota.
Sin eso, el equipo clínico ve la curva pero no el porqué.

**Explícitamente pidió conversar el enfoque antes de construir nada** — no
elegir por ella. Dos ideas que puso sobre la mesa, ninguna decidida:

1. Gráfico como hoy + una tabla tipo Excel debajo, fila por evento en ese
   tramo de tiempo.
2. Gráficos más grandes, con espacio propio para marcar los eventos encima
   de la curva (íconos o líneas verticales en el punto temporal).

### Antes de decidir (para la conversación, no para adelantarse)

- El reporte ya tiene toda la data cruda que haría falta (`ReportExport` trae
  `insulin`/`carbs`/`meals` además de `readings`) — esto es una pregunta de
  **presentación**, no de datos faltantes.
- El PDF usa SVG inline (`reportExport.ts`) y el Excel usa SheetJS: la opción
  1 es prácticamente gratis en Excel (ya es una hoja de cálculo) y both
  requieren layout nuevo en el PDF; la opción 2 es más trabajo de SVG pero
  más legible de un vistazo. Vale la pena decidir por separado para cada
  formato en vez de forzar el mismo enfoque a los dos.
- Con 30 días de historial la cantidad de eventos puede ser alta — cualquier
  enfoque necesita pensar en densidad (agrupar, paginar, o filtrar por
  importancia) antes de implementarse, no después.

---

## Fase 25 — Bug: al escribir un número de dos cifras, el primer dígito desaparece (reportado 2026-08-22)

Reportado por Verónica en dispositivo, "en cualquier modal": al escribir un
número de dos dígitos en un campo numérico, el primero queda reemplazado por
el segundo (escribir "12" deja "2").

### Hipótesis a verificar en dispositivo (no confirmada aún — no hay forma de reproducir un bug de foco/teclado con un test de JS puro)

`selectTextOnFocus` aparece en prácticamente todos los campos numéricos de la
app (`NumericEntryModal`, `CorrectionModal`, `MealEditModal`, campos de
`TimelineDetailModal`, etc.) — es el sospechoso más probable: si el campo
vuelve a "seleccionar todo" entre el primer y el segundo dígito (por un
re-render que le hace perder y recuperar foco, en vez de mantenerse
enfocado con el cursor al final), el segundo dígito escrito reemplaza al
primero en vez de agregarse después. Encaja con "cualquier modal" — es una
prop compartida, no un bug de un formulario puntual.

### Cómo investigarlo la próxima corrida

1. Reproducir en el dispositivo real (no en el simulador, puede no
   reproducirse igual) apuntando a un campo con `selectTextOnFocus`.
2. Si la hipótesis se confirma, revisar si el campo se re-renderiza con un
   `value` recalculado en cada `onChangeText` (algo que fuerce al
   `TextInput` a tratar el cambio como una edición externa en vez de una
   escritura del usuario) — ese es el patrón que típicamente dispara la
   re-selección.
3. Corregir en el patrón compartido si es posible, no campo por campo —
   evita que quede arreglado en tres modales y roto en un cuarto.

## Verificación por fase

- `pnpm verify` (lint + typecheck + test) antes de cerrar cualquier fase.
- Cualquier fase que toque `packages/domain`, `packages/ai`, `packages/cgm`,
  o el manejo de datos de salud/perfil de terapia: pasar por el subagente
  `domain-safety-reviewer` antes de darla por terminada.
- Fases de UI (3, 4, 6): probar manualmente el flujo en un build de
  preview antes de cerrarlas — type-checking no basta para UX.
- Fase 0 / bug 502: verificar contra el backend real desplegado
  (`https://237e8b7f1.abacusai.cloud`), no solo con tests locales, porque
  el bug es específico de ese entorno.
