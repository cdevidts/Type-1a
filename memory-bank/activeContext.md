# Active Context

_Última actualización: 2026-08-26 (los tres Pecados Capitales cerrados)._

## Cerrado y fusionado (2026-08-26)

Cuatro hitos, todos en `main`. El detalle vive en los cuerpos de commit
(`git log --format=full`), que son la bitácora real; acá queda solo lo que la
corrida siguiente necesita saber.

- **Migración de memoria agéntica.** Cuatro capas con presupuesto verificado y
  `verify:contracts` en `pnpm verify`. El árbol viejo, en el commit `af6c865`.
- **Corrupción de datos de macros.** `macrosSource` se descartaba en un spread
  sobre un tipo que no lo declaraba; una entrada de solo macros se perdía
  entera diciendo "Entrada guardada". Los dos cerrados, con `mealFields.ts`
  como única lista de qué es una comida.
- **Pecado Capital 1.** `resolveMacrosSource()` en `packages/domain`; los
  cuatro sitios que decidían procedencia por su cuenta la consumen.
- **Pecado Capital 2.** `MacroFields.tsx` reemplazó seis copias del trío de
  macros, y los `parseBlankAs*` de `format.ts`, 53 chequeos del blanco a mano.

## Pecado Capital 3 — cerrado

Las cetonas del acceso rápido ya se ven en el timeline. `getTimeline`
consultaba `vitals_events WHERE entry_group_id IS NOT NULL` y no tenía rama
para las sueltas: se guardaban bien y desaparecían. Es el dato de triage de
cetoacidosis, así que la app aceptaba el gesto de anotarlo y después no estaba.

- La banda clínica la decide `summarizeVitals` en `packages/domain` — es
  `assessKetones`, no una decisión de pantalla.
- El mapeo fila → ítem vive en `src/timelineVitals.ts`, puro y con test,
  porque es exactamente donde estaba el hueco y `db.ts` no se puede verificar
  sin teléfono.
- **La banda va escrita en el texto**, no solo en el tono rojo.
- Se agregó `deleteVitalsEvent`: un ítem que se ve y no se puede quitar es un
  callejón sin salida. Solo alcanza a los que no tienen grupo.

**Lo que quedó abierto:** editarlas. El formulario de `TimelineDetailModal` no
tiene campo de cetonas, así que por ahora se ven y se borran. Editarlas es
trabajo del **Modal Maestro** (`projectbrief.md`), no un parche a ese
formulario.

## Regla de proceso que sobrevive a los tres

Antes de agregar un campo a cualquiera de los formularios de comida, **primero**
se mira si va en `MacroFields` o en un componente compartido nuevo. Escribirlo
suelto en un modal es cómo llegamos a tener el mismo bloque seis veces.

## Backlog de producto priorizado

Notas directas de los fundadores (2026-08-26). Con los tres Pecados
Capitales cerrados, **esto es el foco**. En este orden.

### 1. ✅ El informe en Excel — reparado

`XLSX.write(…, { type: 'array' })` devuelve un `ArrayBuffer`, no un
`Uint8Array`, y un `as Uint8Array` se lo ocultaba a TypeScript. `File.write()`
de `expo-file-system` declara `string | Uint8Array`. Los tests no podían verlo
porque pasaban el resultado a `XLSX.read`, que acepta los dos.

Reparado en tres capas: el tipo, un test que comprueba el envase y la firma
`PK\x03\x04`, y la verificación de que lo escrito en disco pesa lo que debía
antes de compartirlo. El mensaje de error ahora lleva la causa real.

**Sin tocar datos ni columnas**, a propósito: la estructura cambia con el Modal
Maestro y rediseñarla ahora sería trabajo tirado.

### 2. Catálogo multi-porción con foto

Hoy se agrega un alimento a la vez. Debe poder:
- guardar **fotos** de los alimentos del catálogo;
- elegirlos con un **dropdown con búsqueda**, no la lista de chips actual;
- **agregar varias comidas/porciones de una vez**, con macros y carbohidratos
  tentativos **sumándose en vivo** antes de confirmar.

Se integra al **Modal Maestro** (`projectbrief.md`), no como pantalla aparte.
Los carbohidratos tentativos siguen siendo estimación: se sugieren, no se
guardan como confirmados sin que ella confirme.

### 3. Reportes PDF más ricos

Legibilidad, **iconografía en los gráficos** para identificar de un vistazo qué
evento es cada marca, y una síntesis clínica al cierre. Ojo con la frontera:
una conclusión describe lo que pasó, **nunca** evalúa si una dosis fue adecuada
ni sugiere cambiarla (`contracts/safety-acceptance.md`). Y las marcas nuevas no
pueden distinguirse solo por color.

## Fuera de foco pero pendiente

- Editar una entrada todavía no ofrece **foto ni re-análisis de IA** (lo único
  que quedó de la Fase 21). La capa de datos ya lo aguanta: es trabajo de UI, y
  es parte del Modal Maestro.
- **Fase 22** — animación del swipe entre pantallas. JS puro, no necesita build.
- **Fase 20** — widget de pantalla de inicio. **Sí** necesita build (config
  plugin).
- Decisión pendiente de Verónica: qué tan agresiva debe ser la exclusión de
  episodios confundidos. Hoy se eximen los bolos atribuibles a una comida para
  que la pantalla no se vacíe; el criterio estricto se cambia en una línea.
