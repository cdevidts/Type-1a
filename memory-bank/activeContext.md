# Active Context

_Última actualización: 2026-08-26 (Pecados Capitales 1 y 2 cerrados)._

## Migración de memoria agéntica — fusionada

Cerrada y en la rama principal. La memoria pasó de 16 documentos sueltos en
`docs/` a cuatro capas con presupuesto verificado: Capa 0 (`CLAUDE.md` router +
`AGENTS.md`, 83 líneas entre los dos), Capa 1 (`/contracts/`, lo que leen los
skills), Capa 2 (`/memory-bank/`, con `index.md` de ruteo y `reference/` bajo
demanda) y Capa 3 (`docs/adr/`, append-only). `verify:contracts` corre dentro de
`pnpm verify` y rompe el build si un puntero queda muerto o una capa se pasa de
su techo. El árbol viejo está en el commit `af6c865` — ver `index.md`.

## Corrupción de datos de macros — cerrada

Rama `fix/macros-data-corruption`. Los dos hallazgos que escribían mal en cada
uso están arreglados:

1. **`macrosSource` se descartaba al crear una entrada.** `UnifiedEntryInput`
   no declaraba el campo y `App.tsx` sí lo esparcía, así que se perdía en
   silencio y los macros de la IA llegaban al PDF del control médico como "de
   procedencia no registrada". Ahora el campo existe y `writeMealWithEpisode`
   lo persiste.
2. **Una entrada de solo macros se perdía entera** diciendo "Entrada guardada".
   `hasMeal` de crear y el de editar eran dos booleanos distintos que ya se
   habían desincronizado dos veces. Ahora hay **una sola lista**
   (`src/mealFields.ts`, puro y con test) que usan los dos caminos.

**Lo que sigue abierto de ese lote** (cuatro hallazgos, en `progress.md`): la
basal invisible al modelo de Patrones, `amount ?? 0` tratando una comida sin
carbos confirmados como "no pasó nada", el aviso de fallo al registrar insulina
que se pisa con un mensaje de éxito, y la insulina de comida escrita sin
`entryGroupId`.

---

## Pecado Capital 1 — cerrado

`resolveMacrosSource()` vive en `packages/domain/src/macros-source.ts`, pura y
con 18 tests. Los cuatro sitios que decidían procedencia por su cuenta
—`MealModal`, `MealEditModal`, `db.ts` y `macrosSourceFor` en `App.tsx`— la
consumen y ninguno calcula nada. Cero lógica de procedencia en un `.tsx`.

Las cuatro reglas quedaron escritas en un solo lugar: sin macros no hay
procedencia; lo que escribe la usuaria gana sobre lo de la IA; **desconocido se
queda desconocido**; y `'user'` no se degrada.

Dos cosas que se arreglaron de paso, porque salieron al unificar:

- **`'mixed'` que debía ser `'ai'`.** Desde que los campos se prellenan con lo
  estimado por la IA, "el campo tiene valor" dejó de significar "ella lo
  escribió". Ahora la comparación es contra el valor precargado, no contra la
  ausencia de valor.
- **`MealEditModal` inventaba `'user'` desde procedencia desconocida.** Era la
  dirección peligrosa que el comentario de `db.ts` ya nombraba, pero en el otro
  camino. Ahora los dos siguen la misma regla.

## Pecado Capital 2 — cerrado

`src/components/MacroFields.tsx` es el trío de macros y el campo numérico de la
app, en un solo lugar. Reemplazó **seis** copias del bloque proteína/grasa/fibra
—`EntryModal`, `MealModal`, `MealEditModal` y **dos veces** dentro de
`TimelineDetailModal`, un bloque de 24 líneas duplicado literalmente entre sus
dos ramas— más cuatro componentes `Field` locales con tres variantes visuales
del mismo input.

El chequeo del blanco (`en blanco ≠ 0 g`), que estaba escrito a mano en **53
lugares**, es ahora `parseBlankAsUnset` / `parseBlankAsUnsetPositive` /
`parseBlankAsClear` en `format.ts`, con test. Los tres tienen nombre propio
porque el editor invierte los sentinelas a propósito (`null` = borrar), y un
ternario suelto no dice cuál convención sigue.

**Un bug de accesibilidad de paso:** los campos de `MealEditModal` estaban en
`fontSize: 16` + `paddingVertical: spacing.sm` — unos 32 pt de área tocable,
bajo el mínimo de 44 de `contracts/ux-checklist.md`. El componente compartido
lo fija con `minHeight` explícito en vez de confiarlo al padding.

**Lo que queda de este pecado:** los cuatro modales siguen siendo cuatro (790 +
1.146 + 708 + 862 líneas). Eso es correcto y no se toca: son flujos distintos
con la misma materia prima. Lo que se extrajo es lo que de verdad se repetía.
`CatalogModal` tiene su propio `Field` y su propio trío, pero edita un alimento
por 100 g, no una comida: es otro dominio y se deja aparte.

## ⛔ Siguiente: Pecado Capital 3 — cetonas invisibles en el timeline

**Estado:** parcialmente cerrado el 2026-08-26.

Las cetonas registradas desde "Nueva entrada" ya aparecen en el detalle del
ítem agrupado. Lo que **sigue abierto**: las cetonas del **acceso rápido**
(sin `entry_group_id`) no se muestran en ninguna parte — `getTimeline` no tiene
rama para ellas. Es el dato de triage de cetoacidosis.

**Trabajo:** agregar la rama de `vitals_events` sueltas a `getTimeline`, con su
propio `kind` de `TimelineItem`.

## Regla de proceso que sobrevive a los tres

Antes de agregar un campo a cualquiera de los formularios de comida, **primero**
se mira si va en `MacroFields` o en un componente compartido nuevo. Escribirlo
suelto en un modal es cómo llegamos a tener el mismo bloque seis veces.

## Fuera de foco pero pendiente

- Editar una entrada todavía no ofrece **foto ni re-análisis de IA** (lo único
  que quedó de la Fase 21). La capa de datos ya lo aguanta: es trabajo de UI.
- **Fase 22** — animación del swipe entre pantallas. JS puro, no necesita build.
- **Fase 20** — widget de pantalla de inicio. **Sí** necesita build (config
  plugin).
- Decisión pendiente de Verónica: qué tan agresiva debe ser la exclusión de
  episodios confundidos. Hoy se eximen los bolos atribuibles a una comida para
  que la pantalla no se vacíe; el criterio estricto se cambia en una línea.
