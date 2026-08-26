# Type 1A — router

Esto es un índice, no el contexto. El contexto vive en `/memory-bank/`.

## Antes de escribir una línea

Lee estos seis, en este orden, **cada corrida** y no de memoria:

1. `memory-bank/projectbrief.md` — qué es la app y qué no puede hacer nunca
2. `memory-bank/techContext.md` — stack, prohibiciones, comandos, trampas
3. `memory-bank/systemPatterns.md` — las tres Reglas de Oro del código
4. `memory-bank/workflow.md` — commits, qué skill se dispara sola, auditoría
5. `memory-bank/activeContext.md` — el foco de ahora
6. `memory-bank/progress.md` — qué está hecho, qué está roto, qué deuda hay

Lo demás **no se precarga**: `memory-bank/index.md` dice qué archivo traer y
cuándo (`codemap.md` para ubicar código, `reference/` para el porqué,
`docs/adr/README.md` para decisiones viejas).

No trabajes de memoria ni asumas continuidad con una corrida anterior.

## Las capas

| Capa | Qué es | Cuándo se carga |
|---|---|---|
| 0 | `CLAUDE.md` + `AGENTS.md` | siempre. Techo duro: 100 líneas entre los dos |
| 1 | `/contracts/` | quien lo declara en `contracts/manifest.json`, entero |
| 2 | `/memory-bank/` | los seis de arriba siempre; el resto por `index.md` |
| 3 | `docs/adr/` | nunca sola; se consulta. Append-only |

`pnpm verify` corre `verify:contracts`, que rompe el build si un activo de
`.claude/` apunta a un documento que no existe o si una capa excede su techo.

## Al terminar

**Actualiza `activeContext.md` y `progress.md` en la misma corrida que el
código.** Una tarea que termina sin eso no está terminada.

- `activeContext.md`: qué cambió el foco, qué se cerró, qué quedó abierto.
- `progress.md`: estado de `pnpm verify`, conteo de tests, módulos del bundle, y
  cualquier deuda o trampa nueva.

Si agregaste una capacidad que el chat futuro debería alcanzar, va también a
`memory-bank/reference/ai-chat-capabilities.md`; si agregaste un archivo o
componente, a `memory-bank/codemap.md`.

## Reglas de seguridad

@AGENTS.md
