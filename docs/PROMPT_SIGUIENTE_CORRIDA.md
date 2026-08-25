# Prompt para la corrida siguiente — 3 fixes rápidos + Fase 19

Copiar y pegar **todo lo que está dentro del bloque**. Está escrito para que la
corrida no gaste tokens re-explorando: las decisiones ya están tomadas y los
archivos y constantes ya están localizados.

> **Hábito permanente (pedido de Verónica, 2026-08-20):** este archivo se
> reescribe **al cierre de cada corrida**, apuntando a la corrida siguiente.
> Es el punto 6 del checklist de `CLAUDE.md § Cierre de corrida`. Una corrida
> que termina sin dejar este prompt apuntando a lo próximo no está cerrada.

> **Añadido 2026-08-22**: Verónica identificó tres problemas nuevos al
> revisar el roadmap. Ninguno de los tres necesita build nativo, así que se
> agrupan ANTES de la Fase 19 (que sí lo necesita) para gastar un solo build
> al final — mismo criterio que ya se usó para las Fases 16-18-21-22.

> **Corrección 2026-08-22 (importante, ya aplicada abajo):** Verónica
> corrigió el alcance de la Parte C (no es solo insulina, es TODO evento
> dentro de la ventana) y de la Fase 21 (no es unificar los seis tipos de
> `TimelineItem` en una tabla — es el menú de edición uniforme + fusionar
> "Carbos"/"Rápida" en "Comida"). La Fase 21 ya acotada no entra en esta
> corrida por tamaño, pero queda lista como la siguiente.

> **Nuevo, pedido explícito de Verónica (2026-08-22):** esta corrida aplica
> `CLAUDE.md § "Auditoría de cambios relacionados"` — clasifica en 3 niveles
> cualquier cosa relacionada que encuentre mal mientras trabaja, y reporta
> los tres en texto al cierre. Ver el punto correspondiente en el CIERRE
> OBLIGATORIO más abajo.

---

```
Corrida combinada: tres correcciones sin build nativo (partes A, B, C) más
la Fase 19 del roadmap (parte D, notificaciones — SÍ necesita build). Un
solo build al final, cuando las cuatro partes estén en verde.

═══ PARTE A — "Nueva entrada" con foto no alimenta el catálogo ═══

Lee docs/ROADMAP_V0.2.md § Fase 21, sub-sección "Bug chico y aparte,
encontrado revisando esto". Ya está diagnosticado: en apps/mobile/App.tsx,
saveEntry() no llama a recordCatalogFoods()/catalogEntriesFrom() cuando hay
draft.analysis — confirmMeal() sí lo hace para el mismo caso (comida con
foto). Agrega la misma llamada, mismo patrón que confirmMeal (try/catch:
el catálogo es comodidad, un fallo suyo NUNCA debe impedir que la comida se
guarde). Chico y aislado — no toques nada más de la Fase 21 (la unificación
completa de tipos de entrada es aparte, no cabe en esta corrida).

═══ PARTE B — Bug: un número de dos dígitos pierde el primero ═══

Lee docs/ROADMAP_V0.2.md § Fase 25 COMPLETO antes de tocar código. Tiene la
hipótesis (`selectTextOnFocus` + re-render en cada tecla, presente en casi
todos los campos numéricos) y los pasos de investigación. REPRODUCE PRIMERO
en el bundle/build, no asumas la causa. Si el patrón compartido es el
culpable, corrígelo ahí (no campo por campo, o queda arreglado en tres
modales y roto en un cuarto). Si no puedes confirmar la causa con certeza,
DILO explícitamente al entregar en vez de aplicar un fix a ciegas — es un
bug de foco/teclado, la clase de cosa que un test de JS puro no reproduce.

═══ PARTE C — El episodio debe capturar TODO lo que pasa en su ventana ═══

Lee docs/ROADMAP_V0.2.md § Fase 23 COMPLETO (ampliada 2026-08-22) antes de
escribir nada — el alcance NO es solo insulina, es cualquier evento dentro
de la ventana. Ya identifica el punto exacto: getInsulinEventsForMeal
(apps/mobile/src/db.ts:1370) busca insulina en una ventana de -90/+60 min
desde la comida, pero el seguimiento del episodio dura hasta 3h — y ninguna
otra clase de evento (carbohidratos, actividad, nota) entra jamás a
calculateMealEpisodeMetrics.
LA PARTE QUE MÁS IMPORTA, no te la saltes: packages/domain/src/macro-glucose.ts
(buildMacroGlucoseComparison) y nutrition-insights.ts (buildNutritionInsights)
HOY NO EXCLUYEN episodios confundidos por un evento dentro de su horizonte —
una colación a las +2h puede leerse como "efecto tardío de grasa/proteína"
de la comida original. Sin esto, el patrón que la app le muestra a Verónica
puede estar hecho de ruido sin que nadie lo sepa.
Trabajo: (1) ampliar la captura a TODOS los eventos dentro de la ventana de
seguimiento del episodio (insulina de cualquier tipo, carbohidratos, activi-
dad, notas), guardado como contexto descriptivo; (2) actualizar
glucoseInsightSystemPrompt para que pueda mencionarlos descriptivamente;
(3) hacer que buildMacroGlucoseComparison y buildNutritionInsights EXCLUYAN
de sus promedios cualquier episodio con un evento confundente en su
horizonte — esta parte (3) es la que arregla la correlación, las partes
(1)-(2) sin ella son solo cosmética.
FRONTERA DE SEGURIDAD: todo esto es descriptivo. El insight puede decir "se
registró una corrección de N U a las 2h" — NUNCA evaluar si fue acertada, ni
sugerir si hacía falta una. containsTherapyRecommendation sigue filtrando
toda salida. Esto SÍ necesita domain-safety-reviewer (tocas packages/domain
y el prompt de packages/ai).

═══ PARTE D — Fase 19: notificaciones distinguibles ═══

Lee docs/ROADMAP_V0.2.md § "Fase 19" — la investigación ya está hecha y la
decisión ya está tomada, NO la re-derives. Invoca /iconography (disparo
automático: tocas cómo se ve una notificación).

POR QUÉ IMPORTA: es seguridad, no estética. Con las tres alarmas
(post-comida, corrección, capilar) llegando iguales, se vuelven
indistinguibles y se ignoran todas — incluidas las que importan. Fatiga de
alarma.

LA DECISIÓN, YA TOMADA: se combinan las CUATRO capas, porque cada una opera
en un plano distinto y ninguna sola resuelve el problema.
  1. Emoji al inicio del título       → distinguir de un vistazo, sin leer
  2. `content.color` por tipo         → Android tiñe icono y nombre de la app
  3. Título explícito por tipo        → saber qué es sin abrir
  4. UN CANAL DE ANDROID POR TIPO     → distinguir SIN MIRAR, y —clave— poder
                                        silenciar un tipo sin perder los otros
                                        desde los ajustes del sistema
LO QUE NO SE HACE: un icono pequeño distinto por tipo. Verificado contra
expo-notifications@57 en node_modules: `NotificationContentAndroid` expone
solo `badge`, `color`, `priority`, `vibrationPattern` — no hay `smallIcon`, y
el config plugin compila UN icono a `@drawable/notification_icon`. Cambiarlo
exige un config plugin propio con varios drawables y `setSmallIcon` por
notificación. No lo justifica.

TRAMPAS YA VERIFICADAS EN EL CÓDIGO (no las re-investigues):

1. ANDROID CONGELA EL CANAL AL CREARLO. El sonido y la vibración de un canal
   son inmutables después de la primera creación, y los canales actuales YA
   EXISTEN en el teléfono de Verónica desde instalaciones anteriores. Cambiar
   sus propiedades en código NO HACE NADA. Un canal con sonido distinto
   necesita un **id nuevo**. Ojo con dejar huérfanos los viejos: quedan
   visibles en los ajustes de Android confundiendo a la usuaria; hay que
   borrarlos con `deleteNotificationChannelAsync`.

2. CON LA APP ABIERTA NO SUENA, Y ES UN BUG. `setNotificationHandler` en
   apps/mobile/src/notifications.ts devuelve `shouldPlaySound: false`, que
   gobierna la presentación en primer plano. Si Verónica probó las alarmas
   con la app abierta escuchó silencio aunque hubiera elegido "sonido".
   Arréglalo: el estilo elegido (`ReminderAlertStyle` en src/types.ts) tiene
   que respetarse también en primer plano.

3. La notificación pegajosa de registro rápido tiene su propio canal
   silencioso y **nunca** debe sonar: se repone cada ~15 min.

CIERRE OBLIGATORIO (CLAUDE.md § Cierre de corrida):
- pnpm verify en verde (las cuatro partes).
- npx expo export:embed --eager --platform android --dev false desde
  apps/mobile, ANTES de gastar build. Metro NO reescribe .js→.ts en imports
  relativos: tsc y vitest pasan y el build muere. Ya pasó dos veces.
- Iconos SIEMPRE por subpath (Metro no hace tree-shaking; medido 1.263 →
  3.088 módulos por el barrel, 1.325 hoy por subpath). Kebab-case.
    import Plus from 'lucide-react-native/icons/plus';   // ✅
- domain-safety-reviewer: obligatorio por la parte C (tocas packages/domain
  y packages/ai) y por el texto de las alarmas de la parte D. OJO: el
  subagente puede fallar por límite de gasto de la cuenta; si pasa, corre
  /safety-audit tú mismo y DILO explícitamente al entregar, no lo des por
  hecho.
- docs/CODE_MAP.md y docs/AI_CHAT_ARCHITECTURE.md (§3: programar alarmas ya
  está listado, actualízalo si cambia la forma; agrega la ampliación de
  MealEpisodeMetrics con múltiples dosis si aplica a alguna fila existente).
- docs/DEEPAGENT_REDEPLOY_PROMPT.md: la parte C SÍ toca packages/ai — si
  cambia el prompt de insight, anótalo como pendiente de redeploy nuevo (no
  lo dispares). Las partes A y B no tocan apps/api.
- docs/ROADMAP_V0.2.md: marca 19, 23, y el bug de la parte A/25 (si se
  resolvieron con certeza) como completados. NO toques la Fase 21 (fusión
  de "Carbos"/"Rápida" en "Comida" + menú de edición uniforme) ni la 24
  (gráficos con eventos) en esta corrida — la 21 ya está acotada y lista
  para construirse, pero es demasiado para sumarla a A+B+C+D en una sola
  pasada; queda como la corrida siguiente a esta. La 24 sigue necesitando
  conversarse con Verónica antes de construir nada.
- **CLAUDE.md § "Auditoría de cambios relacionados"**: aplícala a las cuatro
  partes de esta corrida. Repórtala en texto al cierre, con los tres
  niveles separados (obligatorio arreglar / con criterio, pregunta al
  cierre si hay duda / para Verónica siempre) — aunque algún nivel quede
  vacío, dilo en vez de omitirlo.
- Reescribe docs/PROMPT_SIGUIENTE_CORRIDA.md apuntando a la Fase 21 (ya
  acotada, ver docs/ROADMAP_V0.2.md § Fase 21) — o a lo que haya quedado
  pendiente de esta corrida, si algo no se terminó.
- Commit + push a claude/revision-build-prep-b6p20n.

Y AVISA AL ENTREGAR: una notificación no se puede dar por verificada sin
probarla en el teléfono, igual que un gesto, igual que el bug de la parte B.
Di explícitamente qué quedó sin probar en cada una.

Haz UN build al final, solo si las cuatro partes quedaron verdes. Reporta
los cambios, el reporte de la auditoría de cambios relacionados, y espera
aprobación antes de lanzarlo.
```

---

## Por qué esta combinación y no otra

- **A y B son baratas y no necesitan build** — tiene sentido meterlas en la
  misma corrida que ya va a terminar en un build (la 19), en vez de gastar
  un ciclo de "corrida sin build" solo para dos fixes chicos.
- **C es más grande, pero tampoco necesita build**, y toca los mismos
  archivos de dominio/IA que ya se van a revisar con `domain-safety-reviewer`
  en esta corrida — agruparla evita pedirle una segunda revisión de
  seguridad al `domain-safety-reviewer` en la corrida siguiente por algo que
  se pudo hacer en esta.
- **D (Fase 19) es la única que obliga a un build**, así que se hace al
  final, después de que A/B/C ya estén verdes — si algo de A/B/C sale mal,
  se puede parar antes de gastar el build.
- **La Fase 21 (fusión "Carbos"/"Rápida" → "Comida", menú de edición
  uniforme) y la 24 (gráficos con eventos) quedan afuera a propósito.** La
  21 ya no es un rediseño abierto —Verónica la acotó el 2026-08-22 a algo
  concreto y buildable— pero sigue siendo comparable en tamaño a una fase
  completa (nuevo flujo, UI con combinaciones independientes, reusar
  MealEditModal, tocar registerNumeric/db.ts): sumarla a A+B+C+D sería
  exactamente el tipo de corrida mal dimensionada que ya causó problemas
  antes (Fases 17/18 juntas fue demasiado en una sola pasada). Queda como
  la corrida siguiente a esta, ya lista para empezar sin re-derivar nada.
  La 24 sigue necesitando conversarse con Verónica antes de construir nada.

## Estado de la ruta

| Fase | Alcance | ¿Build? | ¿Redeploy? |
|---|---|---|---|
| ~~16~~ | ~~Barra inferior, swipe, iconos, marcas de hora~~ | Hecho (`98acb218`) | No |
| ~~17~~ | ~~Editar comida con IA~~ | Sin build aún | Hecho (2026-08-21) |
| ~~18~~ | ~~Catálogo editable, porciones, pregunta de 3 salidas~~ | Sin build aún | Hecho (comparte el de la 17) |
| **19** | Notificaciones distinguibles (parte D de la corrida siguiente) | **Sí, propio** | No |
| — | Parte A: bug catálogo en "Nueva entrada" | No | No |
| — | Parte B: bug del primer dígito | No | No |
| **23** | Parte C: episodio no ve insulina adicional en la ventana | No | Posible (si cambia el prompt de insight) |
| 20 | Widget 4×3 de pantalla de inicio | **Sí, propio** | No |
| 21 | 🟡 Precisada 2026-08-22: fusiona "Carbos"/"Rápida" en "Comida", menú de edición uniforme. Ya acotada y lista — es la corrida siguiente a esta. | No | No |
| 22 | Animación del swipe | Sin build (JS/Animated) | No |
| 24 | Gráficos de reportes con eventos — **conversar enfoque con Verónica antes** | Sin build | No |
| 25 | Bug del primer dígito, si no se resuelve en la parte B | No | No |

## Deuda conocida, para no re-descubrirla

- **Ítem 10b**: mostrar glucosa en mmol/L en toda la app. Bloqueado hasta que
  `TherapyProfile` guarde la unidad como parte del modelo de datos.
- **Catálogo compartido entre usuarias**: construido y **ya desplegado**
  (2026-08-21, `apps/api/src/food-catalog-store.ts`,
  `docs/adr/0003-shared-food-catalog.md`, verificado en vivo con
  `GET /v1/food-catalog` → 200). Falta la fase de `apps/mobile` que lo
  consuma — todavía sin número de fase asignado en el roadmap.
- **Quitar `LIBRELINKUP_EMAIL`/`PASSWORD`** del entorno de Abacus: Verónica
  ya confirmó (2026-08-21) que su cuenta propia funciona, pero pidió
  DIFERIRLO al día de producción real, no dispararlo ahora. No preguntar de
  nuevo salvo que ella lo traiga; el addendum ya está escrito en
  `DEEPAGENT_REDEPLOY_PROMPT.md` para cuando llegue el momento.
- **Docs que describían Junction como la ruta real quedaron corregidas
  (2026-08-21)**: `README.md`, `HANDOFF_ES.md`, `MVP_IMPLEMENTATION_BRIEF.md`.
  El proveedor real es LibreLinkUp on-device; Junction sigue en el código
  como alternativa sin uso activo. Si escribes un doc nuevo que mencione cómo
  se conecta el sensor, parte de `CGM_INTEGRATION_DECISION.md`, no de
  `MVP_IMPLEMENTATION_BRIEF.md` ni `HANDOFF_ES.md` (son registro histórico).
- **Nada de gestos ni notificaciones se puede dar por verificado sin
  dispositivo.** El swipe de la Fase 16 pasó una corrida entera roto porque
  `pnpm verify` no dice nada al respecto.
- **Fase 21 (2026-08-21, precisada 2026-08-22 — ES LA CORRIDA SIGUIENTE A
  ESTA):** Verónica corrigió el alcance: los botones de acceso rápido NO
  cambian a nivel de interfaz. Lo que se unifica es (a) el menú de EDICIÓN
  de cualquier evento, completo sin importar qué botón lo creó, y (b) fusionar
  "Carbos" y "Rápida" en un solo botón "Comida" (con IA, catálogo, calculadora
  de bolo, y toggles independientes para catálogo/timeline/insulina) — corrige
  el bug real de que insulina y carbos sueltos no comparten timestamp y la
  asociación insulina↔comida falla. Ya está acotada y lista para construirse
  sin re-derivar nada. Ver `docs/ROADMAP_V0.2.md` § Fase 21.
- **Fase 22 (nueva, 2026-08-21):** el swipe ya navega pero sin animación —
  salta de golpe al soltar en vez de seguir el dedo. Ver `docs/ROADMAP_V0.2.md`
  § Fase 22.
- **Fase 23 (nueva, 2026-08-22):** el episodio post-comida no ve una
  corrección dada dentro de la ventana de seguimiento (3h) — el insight de
  IA puede describir una bajada sin saber que hubo una segunda dosis.
  Diagnosticado con línea exacta (`db.ts:1370`). Va como parte C del próximo
  prompt. Ver `docs/ROADMAP_V0.2.md` § Fase 23.
- **Fase 24 (nueva, 2026-08-22):** los gráficos de reportes no muestran
  eventos (comidas, insulina) sobre la curva de glucosa. **Conversar el
  enfoque con Verónica antes de construir** — dos ideas sobre la mesa, sin
  decidir. Ver `docs/ROADMAP_V0.2.md` § Fase 24.
- **Fase 25 (nueva, 2026-08-22):** bug reportado en dispositivo — un número
  de dos dígitos pierde el primero al escribirlo, en varios modales.
  Hipótesis: `selectTextOnFocus` + re-render por tecla. Va como parte B del
  próximo prompt; necesita reproducirse en dispositivo antes de asumir la
  causa. Ver `docs/ROADMAP_V0.2.md` § Fase 25.
- **Bug chico, va como parte A del próximo prompt:** `saveEntry` (App.tsx,
  camino de "Nueva entrada" con foto) no llama a `recordCatalogFoods` —
  `confirmMeal` sí. Dos formas de registrar una comida con foto, una
  alimenta el catálogo y la otra no.
- **2026-08-21**: el redeploy consolidado YA SE DISPARÓ y se verificó en
  vivo (modo de edición por instrucción + catálogo compartido, ambos 200).
  `apps/api` está al día con este repo.
