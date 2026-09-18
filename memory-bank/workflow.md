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

## Cómo se le escribe a Verónica (regla dura, 2026-09-10)

**Verónica no programa.** Pidió esto explícitamente, harta y con razón: los
cierres eran largos, llenos de nombres de archivo, y terminaban preguntando
cosas que solo se entendían habiendo leído los diez párrafos de arriba.

### El cierre de una corrida

- **Máximo ~15 líneas** antes de las preguntas. Si no cabe, es que se está
  contando el *cómo* en vez del *qué*.
- **Cero nombres de archivo, funciones, comandos, SHAs o siglas.** Nada de
  `useDictation.ts`, `pnpm verify`, `R8`, `logcat`, `entry_group_id`. Si un
  concepto técnico es imprescindible para decidir, se explica con palabras
  normales y **una sola vez**: "el registro interno donde el teléfono anota lo
  que pasa".
- Se cuenta **qué cambia para ella cuando use la app**, no qué se editó.
- Lo técnico va al **cuerpo del commit y al memory bank**, que es donde sirve.
  El chat no es el registro del proyecto.

### Las preguntas

Van **al final, separadas, numeradas**, y cada una **se entiende sola** sin
haber leído nada de lo anterior. Cada pregunta lleva:

1. **Qué es**, en una frase, como si no supiera nada del tema.
2. **Qué pasa si dice que sí** y **qué pasa si dice que no**, en concreto.
3. **Qué recomiendo yo**, y por qué, en una línea.

Prohibido: "¿lanzo el build?" a secas, "queda pendiente lo de X", o referirse a
algo por un nombre que apareció antes en la corrida. Si una pregunta necesita
contexto, ese contexto va **dentro** de la pregunta.

**Preguntar solo lo que ella realmente decide.** Lo que tiene una respuesta
correcta evidente no es una pregunta: se hace y se avisa en una línea.
