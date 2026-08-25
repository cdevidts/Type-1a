# Prompt para la corrida siguiente — Fase 21

Copiar y pegar **todo lo que está dentro del bloque**. Está escrito para que la
corrida no gaste tokens re-explorando: las decisiones ya están tomadas y los
archivos, líneas y constantes ya están localizados.

> **Hábito permanente (pedido de Verónica, 2026-08-20):** este archivo se
> reescribe **al cierre de cada corrida**, apuntando a la corrida siguiente.
> Es el punto 6 del checklist de `CLAUDE.md § Cierre de corrida`. Una corrida
> que termina sin dejar este prompt apuntando a lo próximo no está cerrada.

> **Estado al 2026-08-22 (cierre de la corrida A/B/C/D):** quedaron cerradas
> la Fase 19 (notificaciones distinguibles), la Fase 23 (contexto del
> episodio + exclusión de confundidos por horizonte) y el bug chico de
> catálogo que vivía dentro de la Fase 21. La Fase 25 (dígito que
> desaparece) quedó **investigada y deliberadamente sin corregir** — ver por
> qué en el roadmap antes de intentar arreglarla.

> **Build:** al cierre de esa corrida **no se gastó build**. Descubrimiento
> que cambia la planificación: la Fase 19 resultó ser **100 % JavaScript**
> (los canales de Android se crean en runtime, no en `app.json`), así que la
> nota vieja "notificaciones ⇒ necesita build" era falsa. La Fase 21 tampoco
> necesita build. Con eso, hay **dos fases enteras acumuladas sin entregar**
> al teléfono; ver "Sobre el build" al final.

---

```
Fase 21 del roadmap: menú de edición completo y uniforme, y fusión de los
accesos rápidos "Carbos" y "Rápida" en uno solo, "Comida".

Antes de escribir código, lee docs/ROADMAP_V0.2.md § "Fase 21" completa. El
alcance ya está precisado por Verónica y NO hay que re-decidirlo — en
particular: la interfaz de creación (los botones sueltos de acceso rápido)
NO se rediseña, y NO se migra a una tabla única de SQLite. Los dos intentos
de ampliar el alcance más allá de eso ya fueron rechazados por ella.

Esta corrida toca `.tsx` con JSX y `apps/mobile/src/components/`, así que
invoca `/ui-screen` antes de escribir UI (tabla de disparo de CLAUDE.md).
No toca `packages/domain` salvo que decidas mover cálculo ahí; si lo tocas,
corre el subagente `domain-safety-reviewer`.

═══ PARTE 1 — Fusionar "Carbos" + "Rápida" en un acceso "Comida" ═══

El QUÉ y el POR QUÉ están en el roadmap (§ Fase 21, "El bug real que esto
viene a resolver"): hoy cada botón guarda una fila suelta con su propio
timestamp, y por eso el emparejamiento insulina↔comida falla. El camino
correcto ya existe: `saveUnifiedEntry`, que guarda todo bajo UN mismo
timestamp.

Ubicaciones ya localizadas:

- `apps/mobile/App.tsx:947-950` — la fila de cuatro `QuickButton`
  ("Carbos", "Rápida", "Basal", "Corrección"). Quedan TRES: "Comida",
  "Basal", "Corrección".
- `apps/mobile/App.tsx:396` — `registerNumeric(route, value)`, el que hoy
  escribe las filas sueltas.
- `apps/mobile/src/components/NumericEntryModal.tsx` — NO se borra: sigue
  sirviendo a "Basal". Su `NumericRoute = Exclude<QuickRoute,'correction'>`
  (línea 16) pasa a ser solo `'basal'`.

⚠️ TRAMPA REAL, verificada: `QuickRoute` (`src/types.ts:84`) no lo consumen
solo los botones. Tiene TRES consumidores más, y si renombras la unión sin
tocarlos rompes caminos que hoy funcionan:

1. `App.tsx:152` `routeFromUrl()` — deep link
   `type1a://quick/(carbs|rapid|basal|correction)`.
2. `src/notifications.ts:220` `quickRouteFromNotificationAction()` — los
   botones "+ Carbos" y "+ Rápida" de la notificación pegajosa
   (`ACTION_CARBS`, `ACTION_RAPID`, definidos ~línea 206).
3. `NumericEntryModal` (arriba).

Y lo que de verdad importa: **la notificación pegajosa que ya está en la
bandeja de Verónica fue creada por un build anterior**, y sus botones siguen
emitiendo `carbs`/`rapid`. Lo mismo cualquier deep link viejo. Así que el
router tiene que **seguir aceptando los identificadores viejos** y
redirigirlos al flujo "Comida" — no basta con renombrar la unión. Un mapeo
de compatibilidad explícito y comentado, no un `as` silencioso.

═══ PARTE 2 — La pantalla "Comida" con tres decisiones independientes ═══

Roadmap § Fase 21, alcance punto 2. Las tres decisiones son ortogonales y la
UI tiene que dejarlas combinar libremente (esto es literal de Verónica, no
interpretación):

- guardar el alimento SOLO al catálogo, sin registrar comida de hoy;
- registrar la comida de hoy CON o SIN guardarla al catálogo;
- registrar la comida de hoy CON o SIN insulina.

Reusar `MealEditModal.tsx` / `MealModal.tsx` (Fase 17) en vez de construir un
formulario nuevo: ya tienen foto, los tres modos de IA, macros, carbohidratos
confirmados y `calculateMealBolus`. Lee `MealEditModal.tsx` antes de decidir
la forma; la mitad del trabajo probablemente sea exponer props que ya existen.

UI: la acción primaria tiene que ser visualmente única (UX_GUIDELINES). Tres
casillas + un botón "Guardar" es más honesto que tres botones del mismo peso,
pero decídelo contra el documento, no contra esta línea.

═══ PARTE 3 — Menú de edición uniforme para cualquier evento guardado ═══

Roadmap § Fase 21, alcance punto 3. Hoy `TimelineEditPayload`
(`src/types.ts:209-232`) es asimétrico: `kind: 'glucose'` y `kind: 'entry'`
aceptan números planos de carbos/insulina, texto y nota — pero NO foto, NO
IA, NO macros, NO calculadora, todo lo cual `EntryModal.tsx` sí ofrece al
CREAR. Editar es hoy estrictamente más pobre que crear, y ese es el bug.

Ojo con el comentario que ya está en `types.ts:212-216`: la comida NO tiene
variante en este payload a propósito (desde la Fase 17 se edita en
`MealEditModal`). No lo revientes — la dirección correcta es que los otros
`kind` lleguen al mismo componente, no que la comida vuelva al payload
plano.

Campos del superconjunto: glucosa, comida/foto/IA, macros, carbohidratos,
insulina, nota.

═══ FRONTERA DE SEGURIDAD (no negociable) ═══

La IA puede proponer macros; NUNCA insulina. Si la entrada ya tiene una
dosis registrada, ninguna edición asistida por IA la toca ni la ve —
`MealSnapshotSchema` lo garantiza estructuralmente (no tiene dónde poner una
dosis) y el flujo fusionado hereda esa garantía. No agregues un campo de
insulina a ese esquema "para que la IA tenga contexto".

Todo texto visible que hable de dosis es superficie de seguridad, no
decoración: si escribes o mueves uno, corre `domain-safety-reviewer`.

═══ CIERRE OBLIGATORIO ═══

1. `pnpm verify` en verde (18/18) — sin excepciones.
2. Reproducir el conteo de módulos del bundle de Metro y compararlo con el
   de la corrida anterior (**1326**). Un salto grande = alguien importó un
   barrel; ver la trampa de Lucide abajo.
3. `/ui-screen` invocada (toca componentes), y `dataviz` si tocas un gráfico.
4. `domain-safety-reviewer` si tocaste `packages/domain`, `packages/ai`,
   `packages/cgm`, `.env`, o texto visible sobre dosis.
5. `docs/CODE_MAP.md` y `docs/AI_CHAT_ARCHITECTURE.md` (§3, catálogo R/W) si
   agregas o cambias una capacidad.
6. `docs/ROADMAP_V0.2.md`: marca la Fase 21 y escribe su sección de
   resultado, con las decisiones que valga la pena no re-discutir.
7. `docs/DEEPAGENT_REDEPLOY_PROMPT.md`: si NO tocaste `apps/api` —
   probablemente no lo hagas— anótalo en la tabla de "corridas que NO
   requirieron redeploy", para que la corrida siguiente no se lo pregunte.
8. Reescribe ESTE archivo apuntando a la corrida siguiente.
9. `CLAUDE.md § "Auditoría de cambios relacionados"`: aplícala y repórtala
   en texto al cierre, con los tres niveles separados (los del nivel 3 con
   opciones, para que Verónica decida).
```

---

## Trampas del repo que ya costaron una corrida (releer, no re-descubrir)

- **Metro no reescribe `.js` → `.ts` en imports relativos**, aunque `tsc` y
  `vitest` sí lo hagan. Ya rompió dos builds. Si un import relativo apunta a
  un `.js` que en disco es `.ts`, `pnpm verify` pasa y el bundle falla.
- **Metro no hace tree-shaking de un barrel export.** Los iconos de Lucide
  van SIEMPRE por subpath: `lucide-react-native/icons/plus`, nunca
  `import { Plus } from 'lucide-react-native'`. Medido en este repo:
  1.263 → **3.088** módulos por el barrel, vs. 1.316 por subpath.
- **`\b` en regex de JavaScript es ASCII.** Falla después de una vocal
  acentuada: `qu[eé]\b` no matchea "qué". Usar
  `(?![a-záéíóúñ])` como lookahead. Ya hubo un guardrail de seguridad que no
  disparaba por esto.
- **`exactOptionalPropertyTypes: true`**: `{ x: undefined }` NO es lo mismo
  que `{}`. Omitir la propiedad, no pasarle `undefined`.
- **Android congela sonido y vibración de un canal de notificación al
  crearlo.** Cambiar esas propiedades exige un id de canal NUEVO, y borrar
  los huérfanos con `deleteNotificationChannelAsync` (ya implementado en
  `ensureReminderChannels`).
- **`panHandlers` sobre un `ScrollView` nativo no dispara nunca.** Van en un
  `View` que lo envuelve, reclamando el gesto en fase de captura
  (`onMoveShouldSetPanResponderCapture`). Ya resuelto en `swipeGuard.ts` —
  no lo re-derives.
- **Perfiles de EAS**: `preview` → `.apk` instalable. `production` → `.aab`,
  que **no se puede instalar** en el teléfono. Confundirlos ya costó un
  build entero.
- **Qué necesita build y qué no**: el corte NO es "toca notificaciones". Es
  **drawables / `app.json` / config plugin ⇒ build**, contra **API de
  runtime ⇒ OTA**. Canales, sonido, vibración, color, título y prioridad son
  runtime. El icono pequeño de notificación y el widget (Fase 20) sí obligan
  a compilar.

## Sobre el build

Al 2026-08-22 hay **dos fases completas sin llegar al teléfono** (19 y 23,
más los fixes de catálogo), ninguna de las cuales necesitó build nativo — o
sea, son entregables por OTA. La Fase 21 tampoco necesita build.

El criterio que se viene usando y conviene mantener: **agrupar** y gastar un
build solo cuando haya algo que realmente exija compilar (hoy: el icono
pequeño por tipo de notificación, descartado; y la Fase 20, el widget, que
sí lo exige). Si la Fase 21 sale limpia, lo natural es cerrar también la
Fase 22 (animación del swipe, también JS) y recién entonces evaluar si el
próximo build se junta con la Fase 20.
