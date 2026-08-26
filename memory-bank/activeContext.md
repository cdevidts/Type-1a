# Active Context

_Última actualización: 2026-08-26 (Pecado Capital 1 cerrado)._

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

## ⛔ Siguiente: Pecado Capital 2 — componentes de formulario compartidos

Es el que más cuesta por corrida. Empezar por extraer **`MacroFields`**
(proteína/grasa/fibra con su validación y el copy "en blanco no es 0 g") y un
hook de parseo numérico que reemplace las 37 copias de `parseNonNegativeNumber`.
**No** unificar los cuatro modales en uno: son flujos distintos con la misma
materia prima.

Después, el Pecado 3: las cetonas del acceso rápido siguen invisibles en el
timeline.

## Los dos Pecados Capitales que quedan

Salieron de la misma auditoría del 2026-08-26. Son deuda de diseño que **ya
causó bugs que llegaron al dispositivo**, no limpieza estética.

### 2. Divergencia de los cuatro formularios de comida

**Estado:** abierto. **Daño confirmado:** la Fase 21 existió *entera* porque
"editar era más pobre que crear".

```
EntryModal.tsx            790  ┐
MealModal.tsx           1.146  │  3.506 líneas para
MealEditModal.tsx         708  │  "registrar o editar una comida"
TimelineDetailModal.tsx   862  ┘
```

Cada mejora hay que hacerla cuatro veces y siempre se olvida una: el catálogo se
alimentaba desde un camino y no del otro; los macros existían en uno solo; las
cetonas solo en su acceso rápido. El patrón `parseNonNegativeNumber` (la regla
"en blanco ≠ 0 g") está replicado **37 veces**.

**Trabajo:** extraer componentes compartidos — empezando por `MacroFields`
(proteína/grasa/fibra con su validación y su copy "en blanco no es 0 g") y un
hook de parseo numérico. **No** unificar los cuatro modales en uno: son flujos
distintos con la misma materia prima.

### 3. `vitals_events` sin grupo, invisibles en el timeline

**Estado:** parcialmente cerrado el 2026-08-26.

Las cetonas registradas desde "Nueva entrada" ya aparecen en el detalle del
ítem agrupado. Lo que **sigue abierto**: las cetonas del **acceso rápido**
(sin `entry_group_id`) no se muestran en ninguna parte — `getTimeline` no tiene
rama para ellas. Es el dato de triage de cetoacidosis.

**Trabajo:** agregar la rama de `vitals_events` sueltas a `getTimeline`, con su
propio `kind` de `TimelineItem`.

## Regla de proceso que acompaña a los dos

Antes de agregar un campo a cualquiera de los formularios de comida, **primero**
se extrae el componente compartido. Si no, el pecado 2 se agranda con cada
feature.

## Fuera de foco pero pendiente

- Editar una entrada todavía no ofrece **foto ni re-análisis de IA** (lo único
  que quedó de la Fase 21). La capa de datos ya lo aguanta: es trabajo de UI.
- **Fase 22** — animación del swipe entre pantallas. JS puro, no necesita build.
- **Fase 20** — widget de pantalla de inicio. **Sí** necesita build (config
  plugin).
- Decisión pendiente de Verónica: qué tan agresiva debe ser la exclusión de
  episodios confundidos. Hoy se eximen los bolos atribuibles a una comida para
  que la pantalla no se vacíe; el criterio estricto se cambia en una línea.
