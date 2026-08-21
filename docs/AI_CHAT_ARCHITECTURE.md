# Arquitectura del chat de IA — documento vivo

> **Propósito.** Este documento es la fuente de verdad para cuando construyamos
> el chat de IA de Type 1A (una fase futura del `ROADMAP_V0.2.md`). Describe
> **qué funciones de la app debe poder alcanzar el chat** y **con qué
> arquitectura** hacerlo poderoso sin romper ninguna de las fronteras de
> seguridad de [`AGENTS.md`](../AGENTS.md).
>
> **Es un documento vivo.** Cada corrida que agrega una capacidad nueva a la
> app (una función de `db.ts`, un endpoint, un módulo de `packages/domain`,
> una integración) debe reflejarla acá, en el catálogo de abajo, en la misma
> corrida. Instrucción registrada en `CLAUDE.md` → "Constancia para el chat de
> IA". Si no se mantiene junto al código, el chat futuro nacerá ciego a la
> mitad de la app.
>
> _Última actualización: 2026-08-19 (pantalla Resumen: AGP + patrones por franja; §2.1 mecanismo de implementación en Abacus; unidad mg/dL garantizada en MealEpisodeMetrics)._

---

## 1. La frontera que nunca se cruza

El chat de IA es un **asistente conversacional y de navegación**, no un motor
de decisiones clínicas. Antes de cualquier detalle de arquitectura, estas
reglas de `AGENTS.md` gobiernan todo lo que sigue y **no son negociables**:

- **La IA nunca calcula, infiere ni recomienda insulina.** Ni una dosis, ni un
  ajuste, ni "podrías ponerte un poco más". El cálculo de corrección/bolo vive
  en `packages/domain` (`calculateCorrection`, `calculateMealBolus`), es
  determinístico, y solo corre con parámetros que la usuaria ingresó a mano.
  El chat puede *mostrar* el resultado de esas funciones y *explicar* qué
  significan, pero el número lo produce el dominio, no el modelo.
- **La IA nunca infiere parámetros de terapia** (objetivo, factor de
  corrección, incremento, ratio de carbos). Son valores que ingresa la usuaria.
- **La salida de la IA se valida contra `containsTherapyRecommendation`**
  (`packages/domain/src/ai-safety.ts`) y se rechaza si contiene consejo que
  cambie una dosis. Esto ya se aplica a `meal-analysis`/`glucose-insight` en el
  backend; el chat debe pasar por el mismo guardia.
- **Los carbohidratos estimados por IA se mantienen separados de los
  confirmados por la usuaria** (`aiEstimatedCarbsG` vs `confirmedCarbsG`). El
  chat nunca "confirma" carbos en nombre de la usuaria.
- **Provenance de glucosa intacto.** El chat nunca presenta datos sintéticos,
  importados, manuales ni atrasados como lectura de sensor en vivo. Toda
  respuesta que cite una glucosa debe arrastrar su origen y su antigüedad
  (`origin`, `sourceTimestamp`, `assessFreshness`).
- **Degradación a manual.** Si la IA falla, el chat cae a registro manual y lo
  dice; nunca inventa datos para rellenar.

Regla práctica de diseño: **toda acción que escribe o que produce un número
sensible pasa por una herramienta determinística de la app** (una función de
`db.ts` o `packages/domain`), nunca por texto libre del modelo. El modelo
elige *qué* herramienta llamar y *con qué argumentos*; la herramienta valida
con Zod y ejecuta. El modelo no es la fuente del dato.

---

## 2. Arquitectura recomendada

```
┌────────────────┐     mensaje      ┌──────────────────────┐
│  Chat UI       │ ───────────────▶ │  Orquestador (backend)│
│  (apps/mobile) │                  │  apps/api            │
└────────────────┘ ◀─────────────── │  - arma el contexto  │
        │            respuesta       │  - expone tool specs │
        │  ejecuta tools locales     │  - llama al LLM       │
        ▼            (lectura/escr.) │  - valida salida      │
┌────────────────┐                  └──────────────────────┘
│  Registro de    │
│  herramientas   │  db.ts + packages/domain + api.ts
│  (local-first)  │
└────────────────┘
```

Decisiones clave:

1. **El LLM vive detrás del backend** (`apps/api`), como el resto de la IA
   (regla de `AGENTS.md`: "Runtime AI integrations live behind the backend").
   El móvil nunca habla directo con Abacus/el proveedor de modelo ni empaqueta
   secretos. El chat manda el mensaje + un contexto mínimo al backend; el
   backend arma el prompt, declara las herramientas y llama al modelo.

2. **Herramientas, no texto, para todo lo que importa.** El chat se implementa
   como un bucle de *tool use*: el modelo devuelve llamadas a herramientas
   tipadas; la app las ejecuta contra funciones reales; el resultado vuelve al
   modelo. Ver el catálogo (§3). Cada herramienta:
   - tiene un esquema Zod de entrada y salida (nada sin validar, regla de
     `AGENTS.md`);
   - es **de solo lectura** o **de escritura**, marcado explícitamente;
   - las de escritura y las que exponen dosis idealmente requieren
     confirmación de la usuaria en la UI antes de ejecutarse (patrón espejo del
     `isAuthenticationRequired` de las quick-actions y del "Guardar" explícito
     de cada modal).

3. **Datos local-first.** El timeline y los eventos viven en SQLite cifrado en
   el dispositivo (`db.ts`). Las herramientas de lectura del chat corren
   **localmente** contra esa base y solo mandan al backend el mínimo necesario
   para que el modelo razone (regla: "Send the minimum necessary data to
   external AI services"). No se sube el timeline completo a un servidor.

4. **Contexto mínimo y con provenance.** Lo que se le pasa al modelo como
   contexto (última glucosa, episodios recientes, parámetros) va siempre con su
   origen y antigüedad, y sin PII innecesaria. Nunca se loguean cuerpos con
   glucosa/insulina/comida/imágenes (regla de privacidad de `AGENTS.md`).

5. **Salida validada dos veces.** Toda respuesta del modelo pasa por
   `containsTherapyRecommendation` antes de mostrarse. Si el modelo intenta
   sugerir una dosis, se bloquea y se degrada a "esto lo decides con tu equipo
   clínico / usa la calculadora con tus parámetros".

### 2.1 Mecanismo de implementación en Abacus: API directa, no agente entrenado en su plataforma (2026-08-19)

**Pedido explícito de Verónica**: investigar cuál es la mejor práctica de
Abacus para este chat — ¿entrenar/configurar un agente dentro de Abacus
(Agent Studio/ChatLLM Teams) y llamarlo, o basta con API directa +
rigurosidad de código de este repo?

**Lo que se pudo verificar** (código real de este repo, ya funcionando en
producción):

- `packages/ai/src/abacus.ts` (`AbacusRouteLLMClient`) ya llama
  `https://routellm.abacus.ai/v1` directo, con `response_format:
  json_schema` estricto — RouteLLM es un router multi-modelo compatible con
  la forma de la API de OpenAI (`messages`, `choices[].message.content`,
  selección de `model`), y esto ya está probado en producción para
  `meal-analysis`/`glucose-insight` (`AbacusMealVisionService`,
  `AbacusGlucoseInsightService`).
- Abacus además ofrece, como productos separados dentro de la misma
  suscripción ChatLLM: **ChatLLM Teams** (chatbots/agentes armados dentro
  de su UI, pensados para conectarse a sistemas internos tipo Slack/Google
  Drive/Confluence) y **Agent Studio/AI Agents** (agentes de negocio que
  "acceden a fuentes de datos, deciden en tiempo real, ejecutan código").

**Lo que NO se pudo verificar** (queda pendiente, ver más abajo): las
páginas públicas de marketing y las FAQ de RouteLLM/ChatLLM no exponen
documentación técnica real (soporte de `tools`/function-calling estilo
OpenAI, streaming, límites de tasa, si un agente configurado en su Agent
Studio puede invocar funciones arbitrarias de un backend propio en vez de
solo sus integraciones nativas) — esa documentación vive detrás de login en
su panel, no accesible sin una cuenta con acceso.

**Recomendación, con la evidencia disponible**: seguir con **API directa
desde `apps/api`** (extender `AbacusRouteLLMClient` con un bucle de tool
use propio), **no** un agente entrenado/configurado dentro de la UI de
Abacus. Razones:

1. **Auditable en git.** Todo el modelo de seguridad de este repo
   (`containsTherapyRecommendation`, validación Zod, tests de
   `domain-safety-reviewer`) asume que el prompt, las herramientas
   declaradas y la validación de salida son **código en este repo**,
   revisable y testeable con `pnpm verify`. Un agente configurado dentro
   del panel de Abacus movería esa lógica a una UI de terceros, fuera de
   git, sin test, sin `pnpm verify`, sin diff para revisar — exactamente lo
   opuesto al patrón de seguridad que ya existe para `meal-analysis`/
   `glucose-insight`.
2. **Encaje de producto.** ChatLLM Teams/Agent Studio están armados para
   conectar Abacus a sistemas SaaS externos *desde su propia interfaz de
   chat* — no hay evidencia (en la documentación pública) de que sirvan
   para que una **app móvil propia** les pase herramientas custom que
   ejecutan contra SQLite local cifrado del dispositivo. El caso de uso de
   Type 1A (herramientas que leen/escriben `db.ts` en el teléfono, con
   confirmación de la usuaria) encaja con el patrón "yo declaro las
   herramientas, yo las ejecuto, el modelo solo decide cuál llamar" — que
   es exactamente lo que ya hace `AbacusRouteLLMClient` con `json_schema`.
3. Ya hay un patrón probado y en producción (`abacus.ts`) que solo hay que
   extender con `messages` tipo conversación + declaración de herramientas,
   en vez de aprender/mantener un segundo sistema de configuración (el
   panel de Abacus) en paralelo al código.

**Bloqueante real antes de arrancar la Fase 8**: confirmar contra la
documentación autenticada de Abacus (`routellm-apis.abacus.ai`, sección de
API reference, requiere login) que RouteLLM soporta un parámetro `tools`/
function-calling estilo OpenAI en `/chat/completions`. Si no lo soporta,
el bucle de tool use hay que armarlo a mano (pedirle al modelo que devuelva
un JSON con `{tool, args}` usando el mismo `json_schema` estricto que ya
usa `abacus.ts`, y parsear eso en vez de un campo `tool_calls` nativo) — es
más código pero el mismo patrón ya probado, no una alternativa impracticable.
Quien tenga acceso al panel de Abacus debería confirmar esto y actualizar
esta sección con el resultado, antes de que la Fase 8 escriba código real.

---

## 3. Catálogo de capacidades que el chat debe alcanzar

Agrupadas por tipo. **R** = lectura, **W** = escritura. Mantener esta tabla al
día es el objetivo del documento.

### Lectura de estado (R) — para responder preguntas

| Capacidad | De dónde | Notas de seguridad |
|---|---|---|
| Glucosa actual + tendencia + antigüedad | `latestLiveReading`, `assessFreshness` (domain), `getCGMReadings` (db) | Siempre con `origin` y `sourceTimestamp`; marcar stale/sintético. |
| Serie de glucosa (multi-día) | `getCGMReadings(db, from, to)` | Distinguir real/importado/sintético. |
| Estado del proveedor CGM | `fetchSensorStatus` (`apps/mobile/src/sensorConnection.ts`), que resuelve entre la cuenta LibreLinkUp propia de la usuaria y el backend | 2026-08-19: **ya no es solo `fetchCGMStatus`**. Si la usuaria conectó su cuenta, el teléfono habla directo con Abbott. El chat debe usar `fetchSensorStatus`, nunca `fetchCGMStatus` a secas: esta última es la ruta heredada con la credencial global del backend, y usarla mostraría el sensor de otra persona. |
| Si el sensor está conectado y con qué cuenta | `getSensorCredentials` (`sensorConnection.ts`) | 2026-08-19 ✅. Sirve para responder "¿por qué no veo mi glucosa?" y guiar el flujo de `docs/CONECTAR_SENSOR.md`. **La contraseña nunca se expone al chat ni sale del teléfono**: si alguna vez se le da esta capacidad, que devuelva solo el correo y la región, jamás el campo `password`. |
| Bandas de cetonas de una medición | `assessKetones` (domain, `ketones.ts`) sobre `getVitalsEvents` | 2026-08-19 ✅. **La capacidad más peligrosa del catálogo junto a los patrones por franja.** La literatura de cetonas viene con protocolos de corrección con insulina, y una banda alta es el momento de máximo riesgo de que el modelo cruce la línea. El chat puede decir en qué banda cayó y que corresponde contactar al equipo clínico; **nunca** qué hacer con insulina, cuánta agua tomar, ni si suspender una dosis. Toda salida que mencione cetonas pasa por `containsTherapyRecommendation`. |
| Promedios de macronutrientes por franja (proteína, grasa, fibra) | `buildNutritionInsights` (domain) | 2026-08-19 ✅. Cada macro trae su propio `sampleSize`: un promedio con `sampleSize: 0` es "no lo anotó", **no** "comió 0 g". El chat nunca debe leer un macro ausente como cero, ni derivar de estos promedios una recomendación nutricional o de dosis. |
| Timeline unificado (eventos, comidas, episodios, notas, entradas empaquetadas) | `getTimeline(db)` | Respeta el empaquetado por `entry_group_id`. |
| Insulina rápida reciente (contexto, sin IOB) | `getRecentRapidInsulin(db, before?, lookbackHours?, tally?)` | **Nunca** derivar insulina activa/IOB. Y **nunca afirmar completitud sin mirar el `DecodeTally`**: si `tally.unreadable > 0` hubo dosis que no se pudieron leer, así que "no tienes insulina reciente" sería falso justo donde más importa. Decir "no pude leer N registros" en vez de "no hay ninguno". |
| Métricas y análisis de un episodio de comida | `meal_episodes` vía `getTimeline`; `MealEpisodeMetrics` | El análisis es descriptivo, no prescriptivo. Todos los valores de glucosa de `MealEpisodeMetrics` son **siempre mg/dL** (2026-08-19, `calculateMealEpisodeMetrics` normaliza al calcular) — el chat puede citarlos tal cual, pero si alguna vez muestra la unidad, que diga "mg/dL", nunca la deje sin declarar (fue justo el bug: el modelo la inventaba). |
| Parámetros de terapia + si están configurados | `getTherapyProfile`, `isTherapyConfigured` (db) | Solo mostrar; nunca proponer valores. **`getTherapyProfile` lanza si la fila existe pero no decodifica** (2026-08-19): el chat NO debe atrapar ese error y seguir con un valor por defecto — sin fila, `DEFAULT_PROFILE` es legítimo porque el flag de configurado sigue ausente y las calculadoras quedan bloqueadas, pero con fila corrupta devolver 110/45/0.5 mientras el flag dice "configurado" sería presentar como propios unos parámetros que la usuaria nunca eligió. |
| Ajustes (alarmas, estilo de alerta, recordatorio capilar, privacidad) | `getMealAlarmOffsets`, `getCorrectionReminderSettings`, `getReminderAlertStyle`, `getCapillaryReminderSettings`, `getSetting` (db) | — |
| Reporte tabular del historial en un rango (glucosa, insulina, carbos, comidas, actividad, notas, vitales, HbA1c) | `buildReportRows` (domain) + `getCGMReadings`/`getInsulinEvents`/`getCarbEvents`/`getMealEvents`/`getActivityEvents`/`getNoteEvents`/`getVitalsEvents`/`getHbA1cResults` (db) | Fase 9. Puro formato de eventos, sin agregados clínicos; si el chat llega a ofrecer "arma un reporte", debe generar el PDF/Excel en el dispositivo igual que `SettingsModal` (`apps/mobile/src/reportExport.ts`), nunca resumir los valores él mismo en prosa libre sin la guardia de `containsTherapyRecommendation`. |
| Resumen clínico de glucosa: Time in Range por banda, promedio, variabilidad (CV%), HbA1c estimada (GMI) | `summarizeGlucose` (domain, `glucose-metrics.ts`) sobre `getCGMReadings` | Fase 11 ✅. Excluye `origin:'synthetic'` del cálculo. El chat debe rotular la HbA1c siempre como "estimada (GMI)" y jamás mezclarla con `HbA1cLabResultSchema` (dato de laboratorio real) sin distinguirlas. |
| Día promedio ponderado (perfil ambulatorio AGP): percentiles p05/p25/p50/p75/p95 por franja de 30 min sobre 24 h | `buildAmbulatoryProfile` (domain, `agp.ts`) sobre `getCGMReadings` | Fase 11 ✅. Responde "¿cómo se ve un día típico mío?" y "¿a qué hora se me descontrola?" sin que el chat tenga que razonar sobre miles de lecturas crudas — **esta es la forma correcta de darle contexto temporal al modelo**: un perfil de ~48 franjas en vez de la serie completa, que además cumple la regla de mandar el mínimo necesario. Excluye sintéticas. |
| Patrones por franja horaria: promedio de carbohidratos confirmados, de insulina rápida y basal, y % de dosis rápidas seguidas de una lectura en rango a 1/2/3 h | `buildNutritionInsights` (domain, `nutrition-insights.ts`) | Fase 11/12 descriptiva ✅. **La capacidad más delicada del catálogo.** El chat puede describirla ("en la mañana sueles registrar ~45 g y 6 U; el 70% de las veces quedaste en rango a la hora") pero **nunca** convertirla en consejo ("deberías ponerte más"), ni derivar de ahí un ratio, un factor o un objetivo — sería exactamente la inferencia de parámetros de terapia que prohíbe AGENTS.md. Debe arrastrar siempre el `sampleSize`, respetar `inTargetPct: undefined` como "no hay datos suficientes" (nunca leerlo como 0%), **y citar siempre los tres lados juntos** (`belowTargetPct` / `inTargetPct` / `aboveTargetPct`): decir solo "70% en rango" esconde si el 30% restante fueron hipoglucemias o hiperglucemias, que son problemas opuestos, e invita a la conclusión errónea de que falta insulina. Acompañar cualquier mención con el aviso de que es observacional y que las dosis se deciden con el equipo clínico. Toda salida del modelo que hable de esto pasa igual por `containsTherapyRecommendation`. |

| Integridad de la lectura del historial: cuántas filas de un rango no se pudieron decodificar | `DecodeTally` / `createDecodeTally` (`apps/mobile/src/rowDecode.ts`), aceptado por `getCGMReadings`/`getInsulinEvents`/`getCarbEvents`/`getMealEvents`/`getRecentRapidInsulin` | 2026-08-19 ✅. Una fila ilegible se descarta para que no tumbe la consulta entera, pero **cualquier agregado o afirmación de completitud construido sobre el resultado tiene que declarar el conteo**. Un TIR o una HbA1c estimada sobre una muestra silenciosamente recortada no es un dato omitido, es un número inventado. El chat debe pedir el tally siempre que vaya a citar una métrica agregada, y anteponer "faltan N registros de este rango" antes del número — igual que hacen hoy el banner del Resumen y el pie del reporte PDF/Excel. |

| Meta diaria de energía y macros | `calculateNutritionTargets` (domain, `nutrition-targets.ts`) sobre `getNutritionProfile` (db) | 2026-08-20 ✅. El chat puede citarla, **siempre como referencia poblacional y nunca como prescripción**, y debe mencionar `clampedBy` cuando esté presente (un piso de seguridad movió la meta). **Jamás derivar de la meta de carbohidratos una dosis, un ratio ni un factor**: los carbohidratos determinan el bolo de comida y esta es la vía más corta para cruzar la línea de `AGENTS.md`. Si la usuaria pregunta por bajar de peso usando insulina, la respuesta incluye que eso cambia las necesidades de insulina y se decide con el equipo clínico. |
| Consumo del día vs. la meta | `energyFromMacros` (domain) sobre `getMealEvents` del día | 2026-08-20 ✅. **Respetar `partial`**: si falta algún macro el total es un piso, no el valor real. Decir "llevas 1.200 kcal" cuando en realidad falta contar la grasa induce a comer de más. Un macro ausente nunca es 0 g. |
| Grasa/proteína frente a la glucosa tardía (2/3/4/5 h) | `buildMacroGlucoseComparison` (domain, `macro-glucose.ts`) | 2026-08-20 ✅. **La capacidad más peligrosa del catálogo.** Describe una subida retrasada y prolongada que la literatura resuelve **ajustando la insulina** (bolo dual o extendido) — el chat **nunca** puede sugerir eso, ni un tiempo de espera, ni comer menos grasa o proteína. Puede decir qué pasó con sus datos y que lo converse con su equipo. Arrastrar siempre los `sampleSize` y respetar `meanDeltaMgDl: undefined` como "sin datos suficientes", nunca como 0. Toda salida pasa por `containsTherapyRecommendation`. |

| Catálogo de alimentos propio: qué come habitualmente y sus macros por 100 g | `getCatalogFoods` (db) sobre la tabla `food_catalog`; normalización en `packages/domain/src/food-catalog.ts` | 2026-08-20 ✅. Le da al chat memoria alimentaria sin mandar nada afuera: puede responder "¿qué suelo desayunar?" y **precargar** una comida repetida sin gastar una llamada de visión. Dos reglas: (a) los valores son **estimaciones de IA** y siguen siéndolo al salir del catálogo — nunca presentarlos como confirmados por la usuaria; (b) los carbohidratos que salgan de acá se **sugieren**, jamás se guardan como `confirmedCarbsG` sin que ella los confirme, igual que con una foto. |
| Procedencia de los macros de una comida | `MealEvent.macrosSource` (`'ai'`/`'user'`/`'mixed'`) | 2026-08-20 ✅. El chat debe distinguirlos al citar una comida: "la IA estimó 30 g de proteína" y "anotaste 30 g de proteína" no son lo mismo para un equipo clínico. **Ausente = procedencia desconocida** (comidas anteriores al campo): nunca leerlo como confirmado por la usuaria. |
| Catálogo de alimentos COMPARTIDO entre usuarias | `GET /v1/food-catalog?q=&limit=` (apps/api) | **Backend preparado 2026-08-21, todavía sin cliente en `apps/mobile` — ver `docs/adr/0003-shared-food-catalog.md`.** Cuando el chat llegue a usarlo, aplican las mismas dos reglas que el catálogo propio: son estimaciones de IA de otras instalaciones, nunca confirmadas; los carbohidratos se sugieren, no se guardan solos. Además, **este catálogo no sabe quién comió qué** — no hay id de usuaria en la tabla, así que el chat jamás podría atribuir un alimento a una persona aunque se lo pidieran. |

### Escritura / acciones (W) — siempre con confirmación de la usuaria

| Capacidad | De dónde | Notas de seguridad |
|---|---|---|
| Registrar entrada empaquetada (glucosa capilar + carbos + insulina + nota) | `saveUnifiedEntry(db, input)` | Insulina = lo que tecleó la usuaria, nunca sugerido. |
| Adjuntar carbos/insulina/nota a una lectura del sensor | `attachEntryToReading(db, readingId, input)` | No reescribe el valor del sensor ni su origen. |
| Editar / borrar una entrada empaquetada | `updateUnifiedEntryGroup`, `deleteUnifiedEntryGroup` (db) | Un ancla de sensor se preserva; no se borra dato real. |
| Registrar/editar/borrar glucosa manual, carbos, insulina, comida, nota sueltos | `saveCarbEvent`, `saveInsulinEvent`, `updateManualCGMReading`, `updateNoteEvent`, `delete*` (db) | Solo lecturas `origin:'manual'` son editables en valor. |
| Confirmar carbos de una comida | modales de comida → `saveMealWithEpisode` | La confirmación es acto de la usuaria, no de la IA. |
| Estimar **todos los macros** desde foto o texto | `analyzeMealImage`, `analyzeMealDescription` (api) | 2026-08-20: el prompt siempre pidió carbohidratos, proteína, grasa, fibra, calorías y confianza por alimento, y `FoodEstimateSchema` los lleva — lo que faltaba era que la app los usara. Ahora precargan proteína/grasa/fibra (editables) y alimentan el catálogo. **Los carbohidratos NO se precargan a propósito**: son los que determinan el bolo, y `AGENTS.md` exige que lo estimado por IA no se confunda con lo confirmado. El chat debe respetar la misma asimetría. |
| **Editar una comida guardada con una instrucción en lenguaje natural** | `editMealWithInstruction({instruction, current})` (api) → tercer modo de `/v1/ai/meal-analysis` → `updateMealFromEdit(db, id, patch)` | 2026-08-21 ✅ (Fase 17). **Es el patrón que el chat va a reusar tal cual**, así que vale la pena leerlo entero: (1) el modelo recibe un `MealSnapshot`, que **no tiene campo de insulina, glucosa ni parámetro de terapia** — la frontera es la forma del tipo, no una frase del prompt, porque un prompt se puede ignorar y un campo que no existe no se puede alcanzar; (2) hay un guardrail **de entrada**, `requestsInsulinAdvice()`, que rechaza "¿cuánta insulina me pongo?" *antes* de gastar la llamada — el chat necesita el mismo, no solo el filtro de salida; (3) la respuesta es la comida **completa** revisada, no un diff, porque fusionar un diff en el cliente es donde se cuelan los errores; (4) la UI muestra un **antes/después campo por campo** y no escribe nada hasta que la usuaria confirma. Un "¿lo aplico?" sin mostrar qué cambia no es confirmación informada. |
| Editar macros / carbos confirmados / nota / foto de una comida | `updateMealFromEdit(db, id, patch)` (db) | 2026-08-21 ✅. `undefined` = no tocar, `null` = borrar — la distinción "no anotado" vs. "0 g" recorre toda la app. Sincroniza la fila espejo de `carb_events` vía `syncConfirmedCarbRow`, así que el chat no puede dejar las dos copias de los carbos confirmados en desacuerdo. `macrosSource` nunca queda en `user` tras una edición asistida por IA. |
| Guardar alimentos identificados en el catálogo | `recordCatalogFoods` (db) + `catalogEntriesFrom` (domain) | 2026-08-20 ✅. Promedia ponderado por veces vistas, así que el catálogo converge con el uso. Solo entran alimentos con gramos estimados: sin porción no se puede normalizar a 100 g y escalar sería inventar el dato. |
| Subir un alimento al catálogo COMPARTIDO | `POST /v1/food-catalog` (apps/api) | Backend preparado 2026-08-21, sin cliente todavía. Cuando exista, esta escritura **no necesita confirmación de la usuaria como las demás de esta tabla** — es puramente anónima (nombre + macros por 100 g, nada que la identifique), así que no hay nada suyo que confirmar. Lo que sí sigue igual: nunca se manda como parte de esta llamada un dato de glucosa, insulina, ni el id de la usuaria — el schema (`SharedCatalogEntryInputSchema`) no tiene dónde ponerlos. |
| Ver, corregir y borrar alimentos del catálogo | `getCatalogFoods(db, limit, search)`, `updateCatalogFood`, `createCatalogFoodVariant`, `deleteCatalogFood` (db) | 2026-08-21 ✅ (Fase 18). Toda escritura pasa por `isPlausibleCatalogEntry`: un valor imposible por 100 g guardado acá sugiere carbohidratos imposibles en **cada** comida futura que reuse el alimento, así que se rechaza en vez de fosilizarse. `timesSeen` no es editable — es el peso que `blendCatalogEntry` le da a lo ya sabido, o sea un parámetro del algoritmo, no un dato de la comida. |
| Corregir un alimento del catálogo con una instrucción | `editCatalogFoodWithInstruction` (api) | 2026-08-21 ✅. **Reusa el modo de la Fase 17 sin agregar rama al backend**: presenta el alimento como una comida de un solo ítem de 100 g. Hereda por lo tanto el guardrail de entrada `requestsInsulinAdvice`. Si el modelo devuelve otro tamaño de porción, quien llama re-normaliza a 100 g — si no, los números quedarían en otra base que el resto del catálogo. |
| Elegir qué hacer con el catálogo al corregir una comida | pregunta de tres salidas en `MealModal` → `ConfirmedMealDraft.catalogWrite` | 2026-08-21 ✅. Editar el alimento / crear una variante / solo esta comida. **El chat va a necesitar exactamente esta pregunta**: una corrección puntual que se propaga en silencio al alimento reutilizable es corrupción de datos, y una que no se propaga nunca obliga a repetirla en cada comida. La pregunta solo salta si el valor se aleja más de un 10 % (o 1 g) de lo previsto: sin tolerancia saltaría por redondear 42,5 a 42 y se respondería sin leer. |
| Programar/ajustar alarmas y recordatorios | `saveMealAlarmOffsets`, `saveCorrectionReminderSettings`, `saveReminderAlertStyle`, `saveCapillaryReminderSettings` + `schedule*` (notifications) | Recordatorios avisan; no calculan dosis. |
| Importar historial MySugr | `importMySugrCsv(db, csv)` | Datos importados quedan marcados como tales. |
| Conectar FreeStyle/LibreView | `connectFreestyleLibre(email)` (api) | Sin exponer secretos en el móvil. |
| Guardar el perfil de nutrición (peso, estatura, edad, actividad, meta) | `saveNutritionProfile` (db) | 2026-08-20 ✅. Deliberadamente **separado de `TherapyProfile`**: aquel guarda parámetros que alimentan cálculos de dosis y que `AGENTS.md` prohíbe inferir; este guarda datos corporales y una preferencia. No mezclarlos, para que cambiar una meta de peso no pueda tocar algo que llega a una jeringa. |
| Marcar la bienvenida como vista / volver a mostrarla | `getSetting`/`setSetting(db, 'onboardingSeenAt')` | 2026-08-19 ✅. Ajuste trivial, sin impacto clínico. Útil si la usuaria pide "muéstrame de nuevo la introducción". **No** confundir con `THERAPY_CONFIGURED_KEY`: haber visto la bienvenida no configura nada, y el onboarding a propósito no pide parámetros de terapia. |

### Cálculo determinístico (el chat *muestra*, no *inventa*)

| Capacidad | De dónde | Notas |
|---|---|---|
| Corrección sugerida (copiable) | `calculateCorrection` (domain) | Solo con parámetros ingresados; bloqueado si no configurados. |
| Bolo de comida | `calculateMealBolus` (domain) | Requiere `carbRatio` ingresado; nunca inferido. |
| Umbrales de glucosa, conversión de unidades, frescura | `glucose-thresholds`, `units`, `freshness` (domain) | Determinístico. |
| HbA1c estimada a partir de un promedio de glucosa (GMI) | `estimateA1cFromMeanGlucose` (domain, `glucose-metrics.ts`) | Fórmula fija (Bergenstal et al. 2018), no un modelo — el chat puede mostrar el número pero nunca presentarlo como medición de laboratorio. |
| Percentiles de una muestra de glucosa | `percentile` (domain, `agp.ts`) | Interpolación lineal determinística. |
| Guardia anti-recomendación | `containsTherapyRecommendation` (domain) | Filtro obligatorio de toda salida del modelo. |

---

## 4. Cosas que el chat NO debe hacer (lista de rechazos)

- Decir/insinuar una cantidad de insulina que la usuaria "debería" ponerse.
- Ajustar o proponer objetivo, factor, incremento o ratio de carbos.
- Estimar insulina activa (IOB) o dosificación automática.
- Confirmar carbos, borrar lecturas reales de sensor, o presentar dato
  atrasado/sintético como en vivo.
- Mandar al backend/modelo más datos personales de los necesarios, o loguear
  cuerpos sensibles.

Cuando la usuaria pida algo de esta lista, la respuesta correcta es explicar el
límite y redirigir a su equipo clínico o a la herramienta determinística
correspondiente con sus propios parámetros.

---

## 5. Pendientes de diseño (para la fase del chat)

- Definir el formato exacto de las *tool specs* y dónde vive el registro
  (probable: un módulo compartido que derive los esquemas Zod ya existentes).
- Mecanismo de confirmación en UI para herramientas de escritura (¿hoja de
  confirmación por acción? ¿"deshacer"?). **La Fase 17 ya resolvió una
  versión de esto** y conviene copiarla antes que inventar otra: se muestra
  el antes/después campo por campo, con lo que cambia marcado, y el botón de
  guardar es la única escritura. El chat puede reusar esa misma vista para
  cualquier herramienta W.
- Política de contexto: cuánto timeline resumir y cómo, sin subir todo.
- Telemetría de rechazos del guardia de seguridad (para verificar que el filtro
  efectivamente se dispara).
- **Confirmar soporte de `tools`/function-calling en la API autenticada de
  RouteLLM** (ver §2.1) — bloqueante antes de escribir el bucle de tool use
  real.
- **Si en algún momento una tarea de esta fase requiere hacer algo en el
  panel de Abacus (ChatLLM/DeepAgent/Agent Studio)** — no solo consultar su
  documentación, sino configurar/ejecutar algo ahí —, esa tarea necesita su
  propio documento con el paso a paso exacto y el prompt textual a pegar,
  mismo patrón que ya existe para el redeploy del backend
  (`docs/DEEPAGENT_REDEPLOY_PROMPT.md`). No improvisar esos pasos en el
  momento ni dejarlos solo en el chat de una corrida — igual que el prompt
  de redeploy, tienen que quedar preparados de antemano y reutilizables.
