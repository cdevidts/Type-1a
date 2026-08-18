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
| **5** | Flujo unificado de registro "+": un botón que junta foto (IA estima HdC), HdC confirmados, glucosa actual (auto desde CGM), y calcula la dosis total (bolo de comida por `carbRatio` + corrección por `correctionFactor`) en una función nueva y determinística de `packages/domain`. | 4 |
| **6** | Alarmas configurables: generalizar `scheduleEpisodeNotifications` (ya existe para comidas a 60/120/180min) para que los offsets sean configurables, y agregar el mismo mecanismo para correcciones. Guardar la config en `app_settings` (tabla que ya existe). | — |
| **7** | Muestreo autónomo de glucosa (mínimo 10/día aunque el usuario no abra la app): investigar factibilidad real de background fetch en Expo/Android (hay límites del SO, puede necesitar caer a "al abrir/reanudar la app" como estrategia principal en vez de cron verdadero en segundo plano) antes de prometer una cadencia exacta. | — |
| **8** | Chat de IA: endpoint nuevo en `apps/api` sobre RouteLLM, sin autenticación de por medio (el cliente manda el contexto histórico relevante en cada request, el backend sigue sin estado), guardrail extendido de `ai-safety.ts`, y todo lo que el chat "proponga" pasa por confirmación explícita del usuario antes de tocar SQLite — mismo patrón que ya existe en todo el resto de la app. | 1, 6 (para poder proponer recordatorios) |
| **9** | Reportes Excel/PDF, generados en el dispositivo (`expo-print` para PDF, librería JS pura para xlsx) para mantener el local-first. | 1, 2 |
| **10** | Alertas de glucosa alta/baja por umbral. | 7 (necesita datos frescos aunque la app esté cerrada) |
| **11** | Pantalla "Resumen": Time in Range real (agregado multi-día sobre `cgm_readings`, no el aproximado por-episodio que ya existe), HbA1c estimada (fórmula eA1c/GMI estándar, rotulada explícitamente como *estimada*, separada de la `HbA1cLabResultSchema` de laboratorio), y las demás métricas clínicas relevantes para T1D que se investiguen al llegar a esta fase (variabilidad/CV, promedio, eventos de hipo/hiperglucemia). | 1, 2, 7 |
| **12** | Capa de aprendizaje/insight adaptativo (ver el límite de seguridad arriba) — patrones descriptivos, nunca ajusta dosis. | 8, 11 |

No se numeró por prioridad de negocio sino por dependencia técnica — el
orden de ejecución real se acuerda con Verónica fase por fase, no se asume.

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
