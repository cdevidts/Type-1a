# Active Context

_Última actualización: 2026-08-26 (migración a Memory Bank)._

## Foco inmediato: los tres Pecados Capitales

Salieron de la auditoría arquitectónica del 2026-08-26. Los tres son deuda de
diseño que **ya causó bugs reales que llegaron al dispositivo**, no limpieza
estética. En orden de daño.

### 1. `macrosSource` reimplementado en 4 capas

**Estado:** abierto. **Daño confirmado:** 3 bugs, uno por camino.

La misma decisión de dominio vive en `MealModal.tsx`, `MealEditModal.tsx`,
`db.ts` y `App.tsx` (`macrosSourceFor`), con reglas distintas en cada una. Se
imprime en el reporte médico.

**Trabajo:** extraer `resolveMacrosSource()` a `packages/domain`, con test que
cubra los tres casos que ya fallaron:
- lo que escribe la usuaria gana sobre lo de la IA;
- `undefined` (procedencia desconocida) **nunca** se convierte en `'user'`;
- `'user'` no degrada a `'mixed'` al editar.

Después, los cuatro sitios llaman a esa función y ninguno decide por su cuenta.
Ver Regla 1 en `systemPatterns.md`.

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

## Regla de proceso que acompaña a los tres

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
