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
`pnpm verify` pasa limpio; pendiente de probar en un build real (Fase 0
sigue sin cerrarse del todo — falta confirmar en el dispositivo).

### Bug 2 — Análisis de foto de comida: HTTP 502 — ✅ RESUELTO (2026-08-17)

Reproducido y medido directamente contra el backend en producción
(`https://237e8b7f1.abacusai.cloud`):

- `/health` y `/v1/cgm/status` → 200 OK, ~1s.
- `/v1/ai/meal-analysis` con una imagen mínima de prueba → **502, en ~2
  segundos**, cuerpo de texto plano `"error code: 502"` (no es JSON, no
  tiene la forma de `ApiErrorSchema` que usa nuestro backend).

Esto descarta que sea el timeout de 45s hacia Abacus RouteLLM
(`AbacusRouteLLMClient`, `packages/ai/src/abacus.ts:69`) — 2 segundos es
demasiado rápido para eso.

**Causa raíz real** (diagnosticada por DeepAgent con acceso a los logs del
servidor, y confirmada de forma independiente probando directo contra la
API de Abacus RouteLLM con los schemas reales generados por el repo): el
servicio nunca se cayó ni hubo problema de infraestructura — era un 502
generado por **nuestro propio código**, reenviando un 400 real del
proveedor. Abacus RouteLLM en modo `json_schema` estricto rechaza:
- la clave `"$schema"` (la incluye `z.toJSONSchema` de Zod por defecto) —
  rompe tanto `mealAnalysisJsonSchema` como `glucoseInsightJsonSchema`;
- para el schema de comida específicamente, además `minItems`/`maxItems`
  en el array `foods` — combinado con los objetos anidados, produce
  "too many states for serving" según el proveedor. (`minimum`/`maximum`
  numéricos, a pesar de mencionarse en el mensaje de error del proveedor,
  **no** eran en realidad el problema — se confirmó probando cada
  combinación por separado contra la API real.)

**Fix aplicado:** `packages/ai/src/abacus.ts` — nueva función
`sanitizeForStrictJsonSchema()` que saca esas claves recursivamente del
schema justo antes de mandarlo como `response_format.json_schema.schema`.
Los schemas exportados de `packages/schemas` quedan intactos (siguen siendo
JSON Schema completo y correcto); el recorte es solo para lo que le
pedimos al proveedor que valide. **La validación real no se debilitó**:
`MealAnalysisSchema.safeParse(...)` / `GlucoseInsightSchema.safeParse(...)`
siguen aplicando los límites reales de Zod sobre la respuesta del modelo
después de recibirla — si el modelo devuelve algo fuera de rango, se
sigue rechazando igual que antes. Test nuevo en
`packages/ai/test/abacus.test.ts` prueba ambas mitades. `pnpm verify`
limpio; revisado por `domain-safety-reviewer`.

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

## Plan de fases

Cada fase es un lote de trabajo independiente, verificable con `pnpm verify`
antes de pasar a la siguiente, y revisado por el subagente
`domain-safety-reviewer` cuando toca `packages/domain`, `packages/ai`,
persistencia de datos de salud, o `packages/cgm`.

| Fase | Contenido | Depende de |
|---|---|---|
| **0** | Fix bug modal de corrección (diagnosticado arriba). Diagnosticar bug 502 vía logs reales de DeepAgent y corregir. | — |
| **1** | Fundación de datos: extender schemas (`carbRatio`, `note` en MealEvent, `purpose` en InsulinEvent, `source:'imported'` en CarbEvent, `ActivityEventSchema`, `NoteEventSchema`, `VitalsEventSchema`, `HbA1cLabResultSchema`) + tablas SQLite + funciones de lectura/escritura en `db.ts`, siguiendo el patrón existente (id, timestamp, payload JSON, índice por timestamp). | 0 |
| **2** | Importador del CSV de MySugr → historial local, usando los schemas de la Fase 1. Corre una vez, revisa duplicados por timestamp+valor. | 1 |
| **3** | Rediseño del gráfico de glucosa (`GlucoseChart.tsx`): ejes con valores, más puntos visibles, no solo el último marcado, mejor uso del espacio. | — (independiente, se puede hacer en paralelo a 1-2) |
| **4** | Configuración de terapia en `SettingsModal`: exponer `targetGlucose`, `correctionFactor`, `doseIncrement` y el nuevo `carbRatio` como editables ahí (hoy solo se editan dentro de Corrección). | 1 |
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
