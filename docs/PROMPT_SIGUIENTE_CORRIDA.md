# Prompt para la corrida siguiente — Fase 22 (animación del swipe) + cierre de la Fase 21

Copiar y pegar **todo lo que está dentro del bloque**. Está escrito para que la
corrida no gaste tokens re-explorando: las decisiones ya están tomadas y los
archivos, líneas y constantes ya están localizados.

> **Hábito permanente (pedido de Verónica, 2026-08-20):** este archivo se
> reescribe **al cierre de cada corrida**, apuntando a la corrida siguiente.
> Es el punto 6 del checklist de `CLAUDE.md § Cierre de corrida`. Una corrida
> que termina sin dejar este prompt apuntando a lo próximo no está cerrada.

> **Estado al 2026-08-25.** Quedaron cerradas la **Fase 21** (fusión de
> "Carbos"/"Rápida" en "Comida", las tres decisiones independientes, y macros
> al editar) y el **catálogo de insulinas** con su duración configurable, que
> a su vez cerró la limitación de "la ventana mira solo hacia adelante" de la
> Fase 23. Se gastó un build al final de esa corrida.
>
> **Lo único pendiente de la Fase 21**: editar una glucosa o una entrada
> empaquetada todavía no ofrece **foto ni re-análisis de IA**. La capa de
> datos ya lo aguanta (`UnifiedEntryInput` acepta `imageUri`, `aiAnalysisId`,
> `aiEstimatedCarbsG`, y `saveUnifiedEntry` los escribe) — es trabajo de UI.

---

```
Dos cosas, ninguna necesita build nativo:

═══ PARTE 1 — Fase 22: animación del swipe entre pantallas ═══

Lee docs/ROADMAP_V0.2.md § "Fase 22". El gesto YA navega bien; lo que falta
es la sensación: hoy al soltar el dedo la pantalla siguiente aparece de
golpe. Verónica pidió que se vea entrar en tiempo real con el gesto, como un
carrusel.

Ubicaciones ya localizadas:

- `apps/mobile/src/useSwipeNavigation.ts` — decide a dónde ir recién en
  `onPanResponderRelease`. Ahí es donde hoy se pierde el seguimiento del
  dedo: para animarlo de verdad, la pantalla destino tiene que estar montada
  (o pre-renderizada) y desplazarse en `onPanResponderMove` según
  `gesture.dx`, con un resorte de vuelta si no llega al umbral.
- `apps/mobile/src/swipeGuard.ts` — **NO tocar**. Es el árbitro que evita
  robarle el gesto al scroll horizontal de `GlucoseChart`. Ya está resuelto.
- `apps/mobile/src/swipeOrder.ts` — **NO tocar**. El recorrido ya tiene test.
- `ModalShell` ya lee "Reduce Motion" del sistema: con la preferencia
  activa la transición debe seguir siendo instantánea, no animada.

Invoca `/app-shell` (toca el swipe entre secciones) y `/ui-screen`.

═══ PARTE 2 — Cerrar la Fase 21: foto e IA al editar ═══

Hoy `TimelineDetailModal` deja editar glucosa, carbohidratos, comida
(texto), macros, insulina y nota — pero no foto ni re-análisis de IA. Eso
hace que editar siga siendo más pobre que crear, que es justo lo que la
Fase 21 vino a arreglar.

Lo que ya está hecho y NO hay que rehacer:

- `UnifiedEntryInput` (`apps/mobile/src/db.ts:666`) ya acepta `imageUri`,
  `aiEstimatedCarbsG`, `aiAnalysisId`, `caloriesKcal` y los tres macros.
- `saveUnifiedEntry` los escribe al `MealEvent`.
- `updateUnifiedEntryGroup` ya persiste los macros; **falta que persista
  `imageUri` y los campos de IA** — hoy sobreviven solo por el spread de
  `...existing` en `updateMealCarbsAndNoteRows`, así que se conservan pero no
  se pueden cambiar.
- `TimelineEntryGroupRaw` ya trae `imageUri` de vuelta (se agregó el
  2026-08-25 para poder mostrarla), pero el formulario todavía no la usa.

Reusar los componentes de `MealEditModal.tsx`, que ya tiene cámara y los
tres modos de IA, en vez de construir un segundo flujo. Ojo con el
comentario de `types.ts` sobre por qué la comida NO tiene variante en
`TimelineEditPayload`: la dirección correcta es que los otros `kind`
lleguen al mismo componente, no que la comida vuelva al payload plano.

═══ FRONTERA DE SEGURIDAD ═══

La IA puede proponer macros; NUNCA insulina. `MealSnapshotSchema` lo
garantiza estructuralmente (no tiene dónde poner una dosis) — no le agregues
un campo de insulina "para que tenga contexto".

Y la regla que la revisión de la Fase 23 dejó escrita con sangre: **cada vez
que le des al modelo un dato nuevo, revisa si el filtro de salida cubre lo
que ese dato le permite decir.** Al sumar la lista de dosis al prompt, se
abrió la puerta a afirmar insulina activa sin que ningún patrón lo
detectara.

**Nada puede estimar insulina activa (IOB).** El catálogo de insulinas
guarda duraciones, y es tentador multiplicarlas por unas unidades: eso ya
sería IOB y `AGENTS.md` lo prohíbe en el MVP. Su único uso legítimo es
decidir sí/no si un episodio entra a un promedio.

═══ CIERRE OBLIGATORIO ═══

1. `pnpm verify` en verde — sin excepciones.
2. Reproducir el conteo de módulos de Metro y compararlo con el de la
   corrida anterior (**1329**). Un salto grande = alguien importó un barrel.
3. `/ui-screen` y `/app-shell` invocadas; `dataviz` si tocas un gráfico.
4. `domain-safety-reviewer` si tocas `packages/domain`, `packages/ai`,
   `packages/cgm`, `.env`, o texto visible sobre dosis.
5. `docs/CODE_MAP.md` y `docs/AI_CHAT_ARCHITECTURE.md` (§3, catálogo R/W).
6. `docs/ROADMAP_V0.2.md`: marca la Fase 22 y escribe su sección de
   resultado.
7. `docs/DEEPAGENT_REDEPLOY_PROMPT.md`: si NO tocaste `apps/api`, anótalo en
   la tabla de "corridas que NO requirieron redeploy".
8. Reescribe ESTE archivo apuntando a la corrida siguiente.
9. `CLAUDE.md § "Auditoría de cambios relacionados"`: aplícala y repórtala en
   texto al cierre, con los tres niveles separados.
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

Al 2026-08-25 se gastó un build con las Fases 19, 21, 23 y el catálogo de
insulinas dentro. Lo que queda sin entregar al teléfono es lo que se
construya de acá en adelante.

La Fase 22 (animación del swipe) es **JS puro**: no necesita build. La
Fase 20 (widget de pantalla de inicio) **sí lo necesita**, porque exige un
config plugin. El criterio de siempre: agrupar y gastar un build solo cuando
haya algo que realmente obligue a compilar.

<details>
<summary>Nota anterior (2026-08-22), ya resuelta</summary>

Al 2026-08-22 había **dos fases completas sin llegar al teléfono** (19 y 23,
más los fixes de catálogo), ninguna de las cuales necesitó build nativo — o
sea, son entregables por OTA. La Fase 21 tampoco necesita build.

El criterio que se viene usando y conviene mantener: **agrupar** y gastar un
build solo cuando haya algo que realmente exija compilar (hoy: el icono
pequeño por tipo de notificación, descartado; y la Fase 20, el widget, que
sí lo exige). Si la Fase 21 sale limpia, lo natural es cerrar también la
Fase 22 (animación del swipe, también JS) y recién entonces evaluar si el
próximo build se junta con la Fase 20.

</details>
