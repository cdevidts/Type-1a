# Active Context

_Última actualización: 2026-08-26 (Fases 0-3 de la migración de memoria agéntica)._

## Migración de memoria agéntica — Fases 0-3 cerradas

Rama `chore/memory-bank-migration`, **sin push** (política Branch-and-Propose).

Hecho: escáner de acoplamiento (`scripts/agentic-contracts.mjs`), cuatro
contratos de Capa 1 en `contracts/`, los cinco activos de `.claude/` repuntados
hacia ellos, y `verify:contracts` encadenado a `pnpm verify` y por lo tanto a
CI. `systemPatterns.md` se partió: el proceso de corrida se fue a `workflow.md`.

**Validación de comportamiento**: el `domain-safety-reviewer` repuntado se corrió
contra `d868ece` y `c4ca192` en worktrees a esos commits. Reencontró **todos**
los hallazgos graves de las revisiones originales (extrapolación sin centrar,
colinealidad carbos↔unidades, `confoundedCount > sampleSize`, β como factor de
corrección inferido; y en Fase 21 los cuatro de dosis). Además levantó siete
que la revisión original no vio, cuatro de ellos vivos hoy — ver `progress.md`.

## ⛔ Lo primero después de fusionar esta rama

**Crear `fix/macros-data-corruption` y arreglar los hallazgos 1 y 2 de
`progress.md`.** Antes que cualquier fase nueva, antes que los tres Pecados
Capitales de abajo.

Los dos corrompen datos **hoy, en cada uso**:

1. `macrosSource` se descarta en silencio al crear una entrada, así que los
   macros estimados por IA llegan al PDF del control médico sin procedencia.
2. Una entrada solo de macros se pierde entera mientras la pantalla dice
   "Entrada guardada".

Los dos son de una línea o dos. Ninguno lo atrapa `pnpm verify` —el primero
justamente porque TypeScript no chequea propiedades en exceso sobre un
spread—, así que el arreglo va **con test**, no solo con el cambio.

Esta rama es de infraestructura arquitectónica: no se tocan acá. Decisión
explícita de Verónica, 2026-08-26.

---

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
