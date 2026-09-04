# Chat de IA — catálogo de capacidades

**Documento vivo.** Cada corrida que agrega una capacidad a la app (una función
de `db.ts`, un endpoint, un módulo de `packages/domain`) la anota acá en la
misma corrida. Si no se mantiene junto al código, el chat futuro nace ciego a la
mitad de la app.

## La frontera que no se cruza

El chat es un asistente **conversacional y de navegación**, no un motor de
decisiones clínicas. Sobre las reglas de `AGENTS.md`, tres que gobiernan todo:

- **Toda acción que escribe o produce un número sensible pasa por una
  herramienta determinística** (`db.ts` o `packages/domain`), nunca por texto
  libre del modelo. El modelo elige *qué* herramienta y *con qué argumentos*; la
  herramienta valida con Zod y ejecuta. El modelo no es la fuente del dato.
- **Toda salida pasa por `containsTherapyRecommendation`** antes de mostrarse.
- **La frontera es la forma del tipo, no una frase del prompt.** Un prompt se
  puede ignorar; un campo que no existe no se puede alcanzar. Es el principio de
  `MealSnapshotSchema` (sin insulina) y de `SharedCatalogEntryInputSchema` (sin
  id de usuaria).

## Arquitectura

El LLM vive **detrás del backend** (`apps/api`): el móvil nunca habla directo
con el proveedor de modelo ni empaqueta secretos. Las herramientas de lectura
corren **localmente** contra SQLite y solo se manda al backend el mínimo para
razonar — no se sube el timeline entero. Todo contexto va con su origen y su
antigüedad.

El patrón de escritura ya está resuelto por la Fase 17 y **se copia, no se
reinventa**: (1) guardrail **de entrada** —`requestsInsulinAdvice()` rechaza
"¿cuánta insulina me pongo?" antes de gastar la llamada—; (2) el modelo devuelve
el objeto **completo** revisado, no un diff, porque fusionar diffs en el cliente
es donde se cuelan los errores; (3) la UI muestra un **antes/después campo por
campo** y no escribe hasta que la usuaria confirma. Un "¿lo aplico?" sin mostrar
qué cambia no es confirmación informada.

## Las cinco capacidades peligrosas

Estas son las que pueden cruzar la línea. El resto del catálogo es rutina.

| Capacidad | Fuente | Por qué es peligrosa |
|---|---|---|
| Grasa/proteína vs. glucosa tardía | `buildMacroGlucoseComparison` | Describe una subida tardía que la literatura resuelve **ajustando la insulina** (bolo dual/extendido). El chat nunca puede sugerir eso, ni un tiempo de espera, ni comer menos grasa. Si la llama, **tiene que pasarle `insulin`, `carbs` y `activity`**: son opcionales por compatibilidad y omitirlos la devuelve en silencio a la versión que mezclaba. |
| Patrones por franja horaria | `buildNutritionInsights` | Puede describir ("el 70% de las veces quedaste en rango a la hora") pero nunca convertirlo en consejo ni derivar un ratio, factor u objetivo. **Cita siempre los tres lados juntos** (`below`/`in`/`aboveTargetPct`): decir solo "70% en rango" esconde si el 30% fueron hipos o hipers —problemas opuestos— e invita a concluir que falta insulina. |
| Bandas de cetonas | `assessKetones` sobre `getVitalsEvents` | La literatura de cetonas viene con protocolos de corrección con insulina, y una banda alta es el momento de máximo riesgo. Puede decir en qué banda cayó y que corresponde contactar al equipo clínico; **nunca** qué hacer con insulina, ni si suspender una dosis. |
| Contexto de un episodio | `MealEpisodeMetrics.contextEvents` | Con la lista de dosis a la vista el modelo puede afirmar superposición ("la segunda se solapó con la primera, que seguía activa") sin recomendar nada — **y eso ya es estimar IOB**. Hereda la prohibición del prompt y los patrones de IOB del filtro. |
| Qué insulina usa y cuánto dura | `TherapyProfile.*InsulinId/*DurationHours` | Puede decir cuál eligió y qué duración tiene guardada. **Nunca** usarla para estimar insulina activa ni cuánto queda actuando. Su único uso legítimo es explicar por qué un tramo quedó fuera de un promedio. |

⛔ **`packages/domain/src/regression.ts` no es alcanzable por el chat, a
propósito.** Es OLS genérico: el coeficiente de una columna de unidades de
insulina es, dimensionalmente, un factor de corrección derivado de sus datos, y
`AGENTS.md` prohíbe inferir parámetros de terapia. Su único llamador legítimo es
`macro-glucose.ts`, que residualiza y descarta los coeficientes.

**Regla general:** cada vez que se le da al modelo un dato nuevo, se revisa si el
filtro de salida cubre lo que ese dato le permite decir.

## Lectura (R)

| Capacidad | Fuente | Nota |
|---|---|---|
| Glucosa actual, tendencia, antigüedad | `latestLiveReading`, `assessFreshness`, `getCGMReadings` | siempre con `origin` y `sourceTimestamp` |
| Estado del sensor y con qué cuenta | `fetchSensorStatus`, `getSensorCredentials` | **`fetchSensorStatus`, nunca `fetchCGMStatus` a secas** — esa es la ruta heredada con la credencial global del backend y mostraría el sensor de otra persona. La contraseña nunca sale del teléfono |
| Timeline unificado | `getTimeline(db)` | respeta el empaquetado por `entry_group_id` |
| Insulina rápida reciente (sin IOB) | `getRecentRapidInsulin` | **nunca afirmar completitud sin mirar el `DecodeTally`**: con `unreadable > 0`, "no tienes insulina reciente" es falso justo donde más importa |
| Integridad de la lectura del historial | `DecodeTally` / `createDecodeTally` | un TIR sobre una muestra silenciosamente recortada no es un dato omitido, es un número inventado. Anteponer "faltan N registros" antes de cualquier agregado |
| TIR, promedio, CV%, HbA1c estimada (GMI) | `summarizeGlucose` | rotular **siempre** "estimada (GMI)"; jamás junto a un dato de laboratorio sin distinguirlos |
| Día promedio ponderado (AGP) | `buildAmbulatoryProfile` | **la forma correcta de dar contexto temporal**: ~48 franjas en vez de la serie completa |
| Cuán confundido está un patrón | `MacroGlucosePoint.adjusted`/`.confoundedCount` | nunca citar un promedio sin decir de cuántas comidas sale, cuántas traían eventos, y si está ajustado o crudo. El ajuste **reduce** el sesgo de un confusor medido, no lo elimina |
| Parámetros de terapia y si están configurados | `getTherapyProfile`, `isTherapyConfigured` | solo mostrar. **`getTherapyProfile` lanza si la fila existe y no decodifica**: no atrapar ese error y seguir con un default — sería presentar como suyos parámetros que nunca eligió |
| Metas de energía y macros, y consumo del día | `calculateNutritionTargets`, `energyFromMacros` | referencia poblacional, nunca prescripción. Respetar `clampedBy` y `partial`: un macro ausente **nunca** es 0 g |
| Catálogo de alimentos propio | `getCatalogFoods` | son estimaciones de IA y lo siguen siendo al salir del catálogo; los carbos se **sugieren**, jamás se guardan como confirmados |
| Procedencia de los macros | `MealEvent.macrosSource` | "la IA estimó 30 g" y "anotaste 30 g" no son lo mismo para un equipo clínico. **Ausente = desconocida**, nunca "confirmado por ella" |
| Reporte tabular de un rango | `buildReportRows` + los `get*Events` | si ofrece "arma un reporte", genera el PDF/Excel en el dispositivo, nunca resume en prosa libre |
| Ajustes, alarmas, recordatorios | `getMealAlarmOffsets`, `getSetting`, … | — |

## Escritura (W) — siempre con confirmación

| Capacidad | Fuente | Nota |
|---|---|---|
| Entrada empaquetada | `saveUnifiedEntry` | la insulina es lo que tecleó ella, nunca sugerido |
| Adjuntar a una lectura del sensor | `attachEntryToReading` | no reescribe el valor del sensor ni su origen |
| Editar/borrar una entrada | `updateUnifiedEntryGroup`, `deleteUnifiedEntryGroup` | un ancla de sensor se preserva; no se borra dato real |
| Estimar macros desde foto o texto | `analyzeMealImage`, `analyzeMealDescription` | precargan proteína/grasa/fibra editables. **Los carbohidratos NO se precargan a propósito**: son los que determinan el bolo |
| Editar una comida con lenguaje natural | `editMealWithInstruction` → `updateMealFromEdit` | el patrón que el chat reusa tal cual (ver Arquitectura). `undefined` = no tocar, `null` = borrar |
| Catálogo: ver, corregir, variantes, borrar | `updateCatalogFood`, `createCatalogFoodVariant`, … | todo pasa por `isPlausibleCatalogEntry`: un valor imposible por 100 g sugiere carbos imposibles en **cada** comida futura que reuse el alimento |
| Qué hacer con el catálogo al corregir | `ConfirmedMealDraft.catalogWrite` | **el chat va a necesitar esta misma pregunta de tres salidas**: propagarla en silencio es corrupción de datos; no propagarla nunca obliga a repetirla siempre |
| Perfil de nutrición | `saveNutritionProfile` | deliberadamente separado de `TherapyProfile`, para que cambiar una meta de peso no toque algo que llega a una jeringa |
| Alarmas, importación MySugr, conectar sensor | `save*Settings`, `importMySugrCsv`, `connectFreestyleLibre` | lo importado queda marcado como tal |
| Catálogo COMPARTIDO | `GET`/`POST /v1/food-catalog` | backend listo, **sin cliente en mobile** (ADR 0003). La subida es la única W que no necesita confirmación: es anónima por construcción, no hay nada suyo que confirmar |
| Recetas: ver, componer, reusar | `getRecipes`, `recipeTotals`, `updateRecipeItems`, `updateRecipe`, `recipeToCartLines`, `setCatalogFoodListed` | los totales **se derivan**, nunca se citan como guardados; reusar una receta es una línea por componente y sigue siendo estimación. Un componente `listed: false` existe solo dentro de sus recetas: no ofrecerlo suelto |

## Cálculo determinístico — el chat *muestra*, no inventa

`calculateCorrection` y `calculateMealBolus` (bloqueados si la terapia no está
configurada), `glucose-thresholds`, `units`, `freshness`, `percentile`,
`estimateA1cFromMeanGlucose` (fórmula fija de Bergenstal et al. 2018, no un
modelo), y `containsTherapyRecommendation` como filtro obligatorio de salida.

## Lista de rechazos

Decir o insinuar una cantidad de insulina · proponer objetivo, factor,
incremento o ratio · estimar IOB o dosificación automática · confirmar carbos ·
borrar una lectura real de sensor · presentar dato atrasado o sintético como en
vivo · mandar más datos personales de los necesarios o loguear cuerpos
sensibles.

Ante cualquiera: explicar el límite y redirigir al equipo clínico o a la
herramienta determinística con sus propios parámetros.

## Pendientes de diseño

- Formato de las *tool specs* y dónde vive el registro (probable: un módulo que
  derive los esquemas Zod existentes).
- Política de contexto: cuánto timeline resumir y cómo.
- Telemetría de rechazos del guardia, para verificar que el filtro se dispara.
- **Confirmar soporte de `tools`/function-calling en la API de RouteLLM** —
  bloqueante antes de escribir el bucle de tool use.
- Si una tarea requiere **operar** el panel de Abacus (no solo leer su
  documentación), necesita su propio documento con el paso a paso y el prompt
  textual a pegar, preparado de antemano y reutilizable.
