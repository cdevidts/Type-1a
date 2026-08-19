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
> _Última actualización: 2026-08-19 (pantalla Resumen: AGP + patrones por franja)._

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

---

## 3. Catálogo de capacidades que el chat debe alcanzar

Agrupadas por tipo. **R** = lectura, **W** = escritura. Mantener esta tabla al
día es el objetivo del documento.

### Lectura de estado (R) — para responder preguntas

| Capacidad | De dónde | Notas de seguridad |
|---|---|---|
| Glucosa actual + tendencia + antigüedad | `latestLiveReading`, `assessFreshness` (domain), `getCGMReadings` (db) | Siempre con `origin` y `sourceTimestamp`; marcar stale/sintético. |
| Serie de glucosa (multi-día) | `getCGMReadings(db, from, to)` | Distinguir real/importado/sintético. |
| Estado del proveedor CGM | `fetchCGMStatus` (api) | — |
| Timeline unificado (eventos, comidas, episodios, notas, entradas empaquetadas) | `getTimeline(db)` | Respeta el empaquetado por `entry_group_id`. |
| Insulina rápida reciente (contexto, sin IOB) | `getRecentRapidInsulin(db)` | **Nunca** derivar insulina activa/IOB. |
| Métricas y análisis de un episodio de comida | `meal_episodes` vía `getTimeline`; `MealEpisodeMetrics` | El análisis es descriptivo, no prescriptivo. |
| Parámetros de terapia + si están configurados | `getTherapyProfile`, `isTherapyConfigured` (db) | Solo mostrar; nunca proponer valores. |
| Ajustes (alarmas, estilo de alerta, recordatorio capilar, privacidad) | `getMealAlarmOffsets`, `getCorrectionReminderSettings`, `getReminderAlertStyle`, `getCapillaryReminderSettings`, `getSetting` (db) | — |
| Reporte tabular del historial en un rango (glucosa, insulina, carbos, comidas, actividad, notas, vitales, HbA1c) | `buildReportRows` (domain) + `getCGMReadings`/`getInsulinEvents`/`getCarbEvents`/`getMealEvents`/`getActivityEvents`/`getNoteEvents`/`getVitalsEvents`/`getHbA1cResults` (db) | Fase 9. Puro formato de eventos, sin agregados clínicos; si el chat llega a ofrecer "arma un reporte", debe generar el PDF/Excel en el dispositivo igual que `SettingsModal` (`apps/mobile/src/reportExport.ts`), nunca resumir los valores él mismo en prosa libre sin la guardia de `containsTherapyRecommendation`. |
| Resumen clínico de glucosa: Time in Range por banda, promedio, variabilidad (CV%), HbA1c estimada (GMI) | `summarizeGlucose` (domain, `glucose-metrics.ts`) sobre `getCGMReadings` | Fase 11 ✅. Excluye `origin:'synthetic'` del cálculo. El chat debe rotular la HbA1c siempre como "estimada (GMI)" y jamás mezclarla con `HbA1cLabResultSchema` (dato de laboratorio real) sin distinguirlas. |
| Día promedio ponderado (perfil ambulatorio AGP): percentiles p05/p25/p50/p75/p95 por franja de 30 min sobre 24 h | `buildAmbulatoryProfile` (domain, `agp.ts`) sobre `getCGMReadings` | Fase 11 ✅. Responde "¿cómo se ve un día típico mío?" y "¿a qué hora se me descontrola?" sin que el chat tenga que razonar sobre miles de lecturas crudas — **esta es la forma correcta de darle contexto temporal al modelo**: un perfil de ~48 franjas en vez de la serie completa, que además cumple la regla de mandar el mínimo necesario. Excluye sintéticas. |
| Patrones por franja horaria: promedio de carbohidratos confirmados, de insulina rápida y basal, y % de dosis rápidas seguidas de una lectura en rango a 1/2/3 h | `buildNutritionInsights` (domain, `nutrition-insights.ts`) | Fase 11/12 descriptiva ✅. **La capacidad más delicada del catálogo.** El chat puede describirla ("en la mañana sueles registrar ~45 g y 6 U; el 70% de las veces quedaste en rango a la hora") pero **nunca** convertirla en consejo ("deberías ponerte más"), ni derivar de ahí un ratio, un factor o un objetivo — sería exactamente la inferencia de parámetros de terapia que prohíbe AGENTS.md. Debe arrastrar siempre el `sampleSize`, respetar `inTargetPct: undefined` como "no hay datos suficientes" (nunca leerlo como 0%), **y citar siempre los tres lados juntos** (`belowTargetPct` / `inTargetPct` / `aboveTargetPct`): decir solo "70% en rango" esconde si el 30% restante fueron hipoglucemias o hiperglucemias, que son problemas opuestos, e invita a la conclusión errónea de que falta insulina. Acompañar cualquier mención con el aviso de que es observacional y que las dosis se deciden con el equipo clínico. Toda salida del modelo que hable de esto pasa igual por `containsTherapyRecommendation`. |

### Escritura / acciones (W) — siempre con confirmación de la usuaria

| Capacidad | De dónde | Notas de seguridad |
|---|---|---|
| Registrar entrada empaquetada (glucosa capilar + carbos + insulina + nota) | `saveUnifiedEntry(db, input)` | Insulina = lo que tecleó la usuaria, nunca sugerido. |
| Adjuntar carbos/insulina/nota a una lectura del sensor | `attachEntryToReading(db, readingId, input)` | No reescribe el valor del sensor ni su origen. |
| Editar / borrar una entrada empaquetada | `updateUnifiedEntryGroup`, `deleteUnifiedEntryGroup` (db) | Un ancla de sensor se preserva; no se borra dato real. |
| Registrar/editar/borrar glucosa manual, carbos, insulina, comida, nota sueltos | `saveCarbEvent`, `saveInsulinEvent`, `updateManualCGMReading`, `updateMealNote`, `updateNoteEvent`, `delete*` (db) | Solo lecturas `origin:'manual'` son editables en valor. |
| Confirmar carbos de una comida | modales de comida → `saveMealWithEpisode` | La confirmación es acto de la usuaria, no de la IA. |
| Estimar carbos desde foto o texto | `analyzeMealImage`, `analyzeMealDescription` (api) | Resultado va a `aiEstimatedCarbsG`, separado de lo confirmado. |
| Programar/ajustar alarmas y recordatorios | `saveMealAlarmOffsets`, `saveCorrectionReminderSettings`, `saveReminderAlertStyle`, `saveCapillaryReminderSettings` + `schedule*` (notifications) | Recordatorios avisan; no calculan dosis. |
| Importar historial MySugr | `importMySugrCsv(db, csv)` | Datos importados quedan marcados como tales. |
| Conectar FreeStyle/LibreView | `connectFreestyleLibre(email)` (api) | Sin exponer secretos en el móvil. |

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
  confirmación por acción? ¿"deshacer"?).
- Política de contexto: cuánto timeline resumir y cómo, sin subir todo.
- Telemetría de rechazos del guardia de seguridad (para verificar que el filtro
  efectivamente se dispara).
