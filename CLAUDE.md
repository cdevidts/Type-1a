# Type 1A — Claude Code project guide

Type 1A es un MVP Android-first, local-first, de acompañamiento para diabetes
tipo 1 (glucosa, comidas, carbohidratos confirmados, insulina, análisis
post-comida descriptivo). Ver [`README.md`](README.md) para el resumen de
producto.

## Leer primero, siempre

@AGENTS.md

Esas reglas de seguridad y arquitectura aplican a todo el repo y no son
negociables — en particular todo lo relacionado a dosis de insulina, IOB,
y qué puede o no decir la IA.

Antes de construir o tocar cualquier pantalla de `apps/mobile`, invoca la
skill `/ui-screen`, que arranca por
[`docs/UX_GUIDELINES.md`](docs/UX_GUIDELINES.md) (checklist al inicio del
documento). Pedido explícito de Verónica (2026-08-18): la app tiene que
empezar a ser cómoda, no solo funcional — este documento traduce las Apple
Human Interface Guidelines y buenas prácticas de apps de salud a reglas
concretas contra el código real del repo. No es opcional para features de UI
nuevas ni para revisiones de pantallas existentes.

**Jerarquía explícita (2026-08-19, pedido explícito de Verónica):**
`/ui-screen` (y, dentro de ella, la skill global `dataviz` cuando aplica) se
invoca **siempre** que una corrida toque cualquier archivo bajo
`apps/mobile/src/components/`, `App.tsx`, o cualquier `.tsx` con JSX —
**incluso cuando el pedido original de la corrida no es una tarea de UI**
(ej. un fix de datos que de paso toca un componente, una corrida enfocada en
backend que termina tocando un modal). No es una skill exclusiva de la Fase
13 ni de features nuevas: es la que gobierna *cualquier* toque a interfaz,
todo el tiempo. Se buscaron skills de terceros para reforzar esto (formularios,
onboarding, revisión de layout React Native) — no existe ninguna más
específica en el marketplace hoy; `/ui-screen` + `dataviz` son lo más
afinado disponible, así que la disciplina recae en invocarlas siempre, no en
sumar herramientas.

## Cómo navegar el repo

Este es un monorepo pnpm (`apps/api`, `apps/mobile`, `packages/domain`,
`packages/cgm`, `packages/ai`, `packages/schemas`). En vez de explorar a
ciegas, usa [`docs/CODE_MAP.md`](docs/CODE_MAP.md): es el índice semántico
del repo — qué archivo hace qué, y una tabla "vas a tocar X → lee Y primero".
Mantenlo actualizado cuando agregues un módulo, paquete o decisión nueva.

Otros documentos de contexto en `docs/`:

- `ROADMAP_V0.2.md` — plan de fases post-MVP en curso (rediseño de UX,
  importación de historial, chat de IA, reportes, etc.), con los hallazgos
  de diagnóstico que lo sustentan. Léelo antes de tocar cualquier feature
  nueva de esta ronda — evita re-explorar lo que ya está documentado ahí.
- `MVP_IMPLEMENTATION_BRIEF.md` — alcance y criterios de aceptación de
  seguridad de la v0.1.
- `CGM_INTEGRATION_DECISION.md` — por qué Junction/LibreView EU y no
  LibreLinkUp/Libre Data Share.
- `HANDOFF_ES.md` — estado de entrega en español.
- `RESEARCH_SOURCES.md` — fuentes usadas para las decisiones de arriba.
- `UX_GUIDELINES.md` — reglas de diseño/interacción (HIG + apps de salud)
  aplicadas a los componentes reales de `apps/mobile/src/components/`.
- `AI_CHAT_ARCHITECTURE.md` — documento vivo: qué funciones de la app debe
  poder alcanzar el futuro chat de IA y con qué arquitectura, sin cruzar las
  fronteras de seguridad de `AGENTS.md`. Ver "Cierre de corrida" más abajo.
- `adr/` — decisiones de arquitectura (local-first, límite de IA).
- `DEEPAGENT_REDEPLOY_PROMPT.md` — prompt listo para pedirle a DeepAgent el
  redeploy de `apps/api` a producción. Pedido explícito de Verónica
  (2026-08-18): tenerlo preparado de antemano y **no dispararlo** salvo que
  sea realmente crítico — cada redeploy consume créditos de Abacus.

## Comandos de desarrollo

```bash
cp .env.example .env
cp apps/mobile/.env.example apps/mobile/.env.local
pnpm install
pnpm verify        # lint + typecheck + test en todos los paquetes
pnpm dev:api
pnpm dev:mobile
```

El backend funciona sin credenciales externas (CGM sintético rotulado, IA se
degrada a entrada manual). Nunca se necesitan secretos reales para verificar
que el código compila y pasa tests.

## Skills de este repo

- `/ui-screen` — **obligatoria antes de construir o revisar cualquier
  pantalla, modal o gráfico de `apps/mobile`.** Instancia `UX_GUIDELINES.md`
  y los tokens reales de `theme.ts` en reglas accionables, y dice qué cargar
  además (la skill global `dataviz`) cuando el cambio incluye un gráfico.
- `/verify` — corre `pnpm verify` y resume fallas de lint/typecheck/test por
  paquete, en vez de pegar el log completo.
- `/new-cgm-provider` — scaffolding para un `CGMProvider` nuevo: crea el
  archivo en `packages/cgm/src`, su test, y un recordatorio de qué actualizar
  en `docs/CGM_INTEGRATION_DECISION.md` y `docs/CODE_MAP.md`.
- `/safety-audit` — revisa un diff (o los cambios pendientes) contra los
  "Safety boundaries" de `AGENTS.md` antes de dar algo por terminado.

## Subagente de este repo

- **domain-safety-reviewer** (`.claude/agents/domain-safety-reviewer.md`) —
  úsalo antes de considerar terminado cualquier cambio que toque
  `packages/domain`, `packages/ai`, `packages/cgm`, o el manejo de
  `.env`/secrets. Verifica específicamente los criterios de
  "Safety acceptance criteria" del brief y las reglas de `AGENTS.md`.

## Reglas de trabajo futuras

- Todo cambio en `packages/domain` o `packages/ai` necesita test nuevo o
  actualizado (ver `AGENTS.md` § Completion).
- Corre `pnpm verify` antes de declarar cualquier tarea terminada.
- Si agregas un paquete, app o integración externa nueva, agrégala a
  `docs/CODE_MAP.md` en el mismo cambio — el mapa se desactualiza rápido si
  no se mantiene junto con el código.
- No hardcodees claves de Abacus/Junction/firma en ningún archivo que se
  empaquete en `apps/mobile`.

## Cierre de corrida — checklist obligatorio

Pedido explícito de Verónica (2026-08-18, ampliado 2026-08-19): la
documentación se mantiene **en la misma corrida** que el código, no después.
Si se desactualiza, la corrida siguiente gasta tokens re-explorando lo que ya
estaba resuelto, y el chat de IA futuro nace ciego a media app.

Antes de dar por terminada cualquier corrida, repasa estos cinco puntos. Los
que no apliquen, se saltan explícitamente — no en silencio.

1. **`pnpm verify` en verde.** Sin excepciones.
2. **`domain-safety-reviewer`** si tocaste `packages/domain`, `packages/ai`,
   `packages/cgm`, `.env`/secretos, o **cualquier texto visible al usuario
   que hable de dosis, insulina o una métrica derivada de ellas**. La
   redacción que ve la usuaria es superficie de seguridad, no decoración.
3. **`docs/CODE_MAP.md`** — módulo, paquete, componente o decisión nueva.
4. **`docs/AI_CHAT_ARCHITECTURE.md`** — si la corrida **agrega o cambia una
   capacidad de la app** (una función de `db.ts`, un endpoint de `apps/api`,
   un módulo de `packages/domain`, una integración externa, un ajuste nuevo):
   agrégala al catálogo (§3) marcada R (lectura) o W (escritura), con de
   dónde sale y su nota de seguridad; y si aprendiste algo sobre cómo el chat
   debería alcanzar esa función sin romper `AGENTS.md`, déjalo en §2 o §5.
   La idea es que, cuando armemos el chat en su fase, no se nos escape
   ninguna función y nazca poderoso y con buenas prácticas.
5. **Los reportes y el prompt de redeploy.**
   - Si la corrida produce **información que le sirve a un médico o a la
     usuaria en un reporte** (una métrica, un agregado, un patrón, un
     gráfico), incorpórala a `apps/mobile/src/reportExport.ts` — PDF **y**
     Excel — en la misma corrida. Un dato que solo existe dentro de la app no
     llega a la consulta médica.
   - Si tocaste `apps/api`, evalúa si hace falta redeploy y sigue
     `docs/DEEPAGENT_REDEPLOY_PROMPT.md` (**no lo dispares** salvo que sea
     crítico — cada redeploy consume créditos de Abacus). Si **no** lo
     tocaste, anótalo en la tabla "corridas que NO requirieron redeploy" de
     ese mismo documento, para que la corrida siguiente no vuelva a
     preguntárselo.

Y si en el camino descubres que estas reglas o las skills del repo no
alcanzaron para evitar un error, arregla la regla o la skill en la misma
corrida: el sistema agéntico también es parte del entregable.
