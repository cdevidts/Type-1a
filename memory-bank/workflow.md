# Workflow de corrida — commits, disparo de skills y auditoría

> Cómo se trabaja en este repo. Los *patrones de código* están en
> `systemPatterns.md`; esto es el proceso alrededor de ellos.

## Convención de commits

**No hay Conventional Commits, y no hay husky ni commitlint.** La convención es
de facto, consistente, y se respeta estrictamente:

1. **Español.**
2. **Asunto sin prefijo ni scope**: frase declarativa/imperativa que describe el
   **efecto**, no el archivo.
   `Arregla el swipe entre secciones, que nunca navegó a ninguna parte`
3. **Cuerpo obligatorio** en todo cambio sustantivo: explica **por qué** y **qué
   falla concreta evita**. Secciones en MAYÚSCULAS cuando el cambio toca varias
   áreas (`DOSIS`, `DATOS`, `PATRONES`, `PURGA`). Cierra con el resultado de
   `pnpm verify` y el conteo de módulos del bundle.
4. **Trailer:** `Co-authored-by: Claude <claude@anthropic.com>`
5. **Nunca** un identificador de modelo en commits, PRs, código o docs.

Patrón recurrente sano: un commit de feature seguido de
`Corrige los hallazgos de la revisión de seguridad de la Fase N`.

---

## Disparo automático de skills

Estas se invocan solas, sin que nadie las pida, cuando la corrida toca la fila:

| Si la corrida toca… | Invoca |
|---|---|
| cualquier `.tsx` con JSX, `App.tsx`, `apps/mobile/src/components/` | `/ui-screen` |
| un gráfico, barra de progreso, medidor o paleta de datos | `dataviz` (global) |
| barra inferior, swipe entre secciones, insets, destinos de nivel superior | `/app-shell` |
| un símbolo en pantalla, el logo, el aspecto de una notificación | `/iconography` |
| `packages/domain`, `packages/ai`, `packages/cgm`, `.env`, o texto visible sobre dosis/insulina | subagente `domain-safety-reviewer` |
| un `CGMProvider` nuevo | `/new-cgm-provider` |
| cerrar cualquier corrida | `/verify` |

El subagente `domain-safety-reviewer` encontró **23 hallazgos en dos revisiones
consecutivas**, dos de los cuales habrían llegado al dispositivo. No es
opcional.

## Dónde se escribe al cerrar

Obligatorio, en la misma corrida que el código:

| Si en la corrida… | Escribe en |
|---|---|
| cambió el foco, se cerró o se abrió algo | `memory-bank/activeContext.md` |
| corriste `pnpm verify`, o descubriste deuda o una trampa | `memory-bank/progress.md` |
| agregaste un archivo, componente o módulo | `memory-bank/codemap.md` |
| agregaste una capacidad que el chat futuro debería alcanzar | `memory-bank/reference/ai-chat-capabilities.md` |
| cambiaste una constante clínica | `memory-bank/reference/clinical-sources.md`, con la cita |
| tomaste una decisión cara de revertir cuyo porqué no se deduce del código | un ADR nuevo en `docs/adr/` + su fila en el `README.md` de ahí |
| cambiaste una regla que un skill verifica | el contrato de `/contracts/`, nunca una copia paralela |

Nada de esto se escribe en `docs/`: ahí solo quedan los ADR (Capa 3,
append-only) y dos guías operativas de humano —conectar el sensor y redesplegar
el backend—. Si `pnpm verify` falla con "puntero muerto", es que un documento se
movió y alguien quedó apuntando al lugar viejo.

## Auditoría de cambios relacionados (se reporta SIEMPRE al cierre, en texto)

1. **Corrección obligatoria** — rompe `AGENTS.md`, corrompe un dato, deja
   `pnpm verify` en rojo, o es consecuencia mecánica del cambio. Se arregla sin
   preguntar.
2. **Con criterio** — cambio de comportamiento relacionado donde la respuesta
   correcta depende de una preferencia de producto. Si hay precedente claro en
   el repo, decide y avanza; si es ambiguo, se anota y se **pregunta al cierre**.
3. **Para Verónica, siempre** — amplía el alcance de una fase aprobada, cambia
   arquitectura sin pedido, o reemplaza un flujo que ella definió. No se
   implementa: se reporta con 2-3 alternativas y sus tradeoffs.

Los tres niveles se reportan **separados**, aunque alguno quede vacío.
