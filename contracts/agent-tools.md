# Contrato — herramientas del agente de IA

> **Capa 1 · consumido por** `domain-safety-reviewer`, `/safety-audit`
> El registro vive en `packages/domain/src/agent-tools.ts`; el porqué de las
> capacidades peligrosas, en `memory-bank/reference/ai-chat-capabilities.md`.

`pnpm verify:contracts` falla si una función exportada de `db.ts` no está ni
registrada ni excluida. **No hay default**: agregar una capacidad sin decidir si
el agente la alcanza rompe el build.

## Antes de dar por buena una herramienta nueva

- [ ] Está en `AGENT_TOOLS` **o** en `NOT_REACHABLE_BY_AGENT` **con su motivo
      escrito**. Un motivo vacío o "no aplica" no es un motivo.
- [ ] Si `risk` no es `routine`, tiene `caution` y dice **qué NO se puede
      afirmar** con ese dato, no solo qué hace.
- [ ] Si escribe, la usuaria confirma antes, viendo **qué cambia** — un
      "¿lo aplico?" sin el antes/después no es confirmación informada.
- [ ] `name` es estable: viaja guardado en respuestas ya emitidas (Regla 3a).

## Las fronteras, que no dependen del prompt

- **El modelo elige qué herramienta y con qué argumentos; nunca produce el
  dato.** Todo número sensible sale de `packages/domain` o de `db.ts`, validado
  con Zod. Un prompt se puede ignorar; un tipo sin el campo, no.
- **Ninguna herramienta devuelve ni acepta unidades de insulina propuestas por
  el modelo.** El bolo lo calcula `calculateMealBolus` con los parámetros que
  ella cargó, y solo si la terapia está configurada.
- **`saveTherapyProfile` no es alcanzable, y no lo será.** Escribir objetivo,
  factor, incremento o ratio desde el chat es inferir parámetros de terapia.
- **`regression.ts` no es alcanzable.** Un coeficiente sobre una columna de
  unidades es, dimensionalmente, un factor de corrección derivado de sus datos.
- **Toda salida pasa por `containsTherapyRecommendation`** antes de mostrarse.
- **Cada dato nuevo que se le da al modelo obliga a revisar el filtro de
  salida**, porque crece lo que el modelo *puede decir*, no solo lo que ve.

## Lo que se revisa en el diff

Si la corrida agregó o cambió una herramienta:

1. ¿El `caution` cubre la inferencia equivocada más probable, no la más obvia?
2. ¿Se movió la versión del prompt, si el payload cambió?
3. ¿Hay test de que el filtro de salida ataja lo que ese dato nuevo habilita?
