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

## Cómo navegar el repo

Este es un monorepo pnpm (`apps/api`, `apps/mobile`, `packages/domain`,
`packages/cgm`, `packages/ai`, `packages/schemas`). En vez de explorar a
ciegas, usa [`docs/CODE_MAP.md`](docs/CODE_MAP.md): es el índice semántico
del repo — qué archivo hace qué, y una tabla "vas a tocar X → lee Y primero".
Mantenlo actualizado cuando agregues un módulo, paquete o decisión nueva.

Otros documentos de contexto en `docs/`:

- `MVP_IMPLEMENTATION_BRIEF.md` — alcance y criterios de aceptación de
  seguridad de la v0.1.
- `CGM_INTEGRATION_DECISION.md` — por qué Junction/LibreView EU y no
  LibreLinkUp/Libre Data Share.
- `HANDOFF_ES.md` — estado de entrega en español.
- `RESEARCH_SOURCES.md` — fuentes usadas para las decisiones de arriba.
- `adr/` — decisiones de arquitectura (local-first, límite de IA).

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
