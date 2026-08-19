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

Antes de construir o tocar cualquier pantalla de `apps/mobile`, lee también
[`docs/UX_GUIDELINES.md`](docs/UX_GUIDELINES.md) (checklist al inicio del
documento). Pedido explícito de Verónica (2026-08-18): la app tiene que
empezar a ser cómoda, no solo funcional — este documento traduce las Apple
Human Interface Guidelines y buenas prácticas de apps de salud a reglas
concretas contra el código real del repo. No es opcional para features de UI
nuevas ni para revisiones de pantallas existentes.

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
  fronteras de seguridad de `AGENTS.md`. Ver "Constancia para el chat de IA"
  más abajo.
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

## Constancia para el chat de IA (al final de cada corrida)

Pedido explícito de Verónica (2026-08-18): mantener vivo
[`docs/AI_CHAT_ARCHITECTURE.md`](docs/AI_CHAT_ARCHITECTURE.md). Al terminar
cualquier corrida que **agregue o cambie una capacidad de la app** (una función
de `db.ts`, un endpoint de `apps/api`, un módulo de `packages/domain`, una
integración externa, un ajuste nuevo), actualiza ese documento en la **misma
corrida**:

- agrega la capacidad nueva al catálogo (§3), marcada R (lectura) o W
  (escritura), con de dónde sale y su nota de seguridad;
- si aprendiste algo sobre la mejor arquitectura para que el chat acceda a las
  funciones sin romper las fronteras de `AGENTS.md`, déjalo escrito en §2 o §5.

La idea es que, cuando armemos el chat en su fase, no se nos escape ninguna
función y el chat nazca poderoso y con buenas prácticas. Si no se mantiene junto
al código, se desactualiza y el chat nacerá ciego a media app.
