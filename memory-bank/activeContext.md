# Active Context

_Última actualización: 2026-08-27 (edición retroactiva completa, calendario y nutrición)._

## Lo que cambió el foco

El Modal Maestro dejó de ser una espina y pasó a ser **el** formulario. La
edición ya no es un conjunto de formularios inline por tipo dentro de
`TimelineDetailModal`: ese archivo solo lee, y su botón **Editar** abre el
mismo componente que monta "Nueva entrada".

La regla que lo ordena todo: **el foco decide qué se abre primero y nunca qué
se puede guardar.** Al crear manda el acceso rápido; al editar manda el
**contenido** (`masterSectionsFor`). El tipo con el que nació un registro no
limita lo que se le suma después.

## Cerrado en esta corrida

- **Edición retroactiva sin límite de tipo.** `promoteEventToEntryGroup`
  convierte un evento suelto en grupo con un `UPDATE` de una columna:
  idempotente, sin borrar ni recrear, conservando id, timestamp, `created_at`,
  `source` y procedencia. Desde una insulina, una nota o unos carbohidratos se
  llega a todo lo demás.
- **Comida y carbohidratos son un solo hecho visible.** La fila espejo
  (`source: 'meal_confirmed'`) se sigue guardando porque el dominio y el
  borrado dependen de ella, pero `partitionCarbRows` la esconde cuando su
  comida está a la vista. Un espejo **huérfano** sí se muestra: es la única
  copia que queda de esos gramos.
- **Foto, IA, catálogo y carrito al añadir una comida a una glucosa.** Era el
  hueco central: el editor de comidas ya tenía IA; lo que faltaba era poder
  crear una comida completa desde la edición de una glucosa de anteayer.
- **Carrito multi-alimento** (`packages/domain/src/meal-cart.ts`), en los tres
  caminos de comida. Su total es estimación; pasar a confirmados exige el botón
  "Usar N g", y tocar el carrito invalida cualquier dosis calculada antes.
- **Fecha y hora editables**, como una transacción única que arrastra el
  episodio, la fila espejo y todas las filas del grupo. `ingestedAt` y la hora
  de una lectura externa **no se mueven nunca**.
- **Strip Calendar en Nutrición** y el "+" contextual: registrar en el pasado
  hereda la fecha y **exige la hora**, con señal textual en la barra.
- **Cetonas y vitales editables por parche**: corregir una cetona no borra el
  peso ni la presión de la misma fila.
- **El nombre de la insulina salió de los formularios.** Es configuración
  (`insulinNameForType` / `resolveInsulinNameForEdit` en dominio), se estampa al
  crear y se reestampa solo al cambiar rápida ↔ basal. Un importado conserva el
  de su fuente.
- **Fibra como métrica de primera clase**: en Nutrición con su total y su
  completitud, por comida, y en las tarjetas de catálogo y carrito.
- **Basal y Cetonas vuelven a tener modal dedicado** (`QuickNumericModal`), uno
  solo parametrizado y sin lógica clínica propia.

## Reglas de proceso que sobreviven

1. Antes de agregar un campo a un formulario de comida, se mira si va en
   `MacroFields` o en un componente compartido. Escribirlo suelto en un modal
   es cómo llegamos a tener el mismo bloque seis veces.
2. **Una decisión de datos no se verifica a ojo.** Todo lo que decide qué se
   guarda, qué se ve o qué es un hecho vive en un módulo puro con test:
   `masterModal.ts`, `mealCarbMirror.ts`, `entryTime.ts`, `mealFields.ts`,
   `meal-cart.ts`.
3. Un dato que el formulario **no ve** es un dato que el guardado borra. Por
   eso `TimelineEntryGroupRaw` lee de vuelta el nombre de la insulina, las
   calorías, el peso y la presión aunque la fila del timeline no los muestre.

## Backlog de producto priorizado

### 1. Reportes PDF más ricos

Legibilidad, **iconografía en los gráficos** para identificar de un vistazo qué
evento es cada marca, y una síntesis clínica al cierre. Ojo con la frontera:
una conclusión describe lo que pasó, **nunca** evalúa si una dosis fue adecuada
ni sugiere cambiarla (`contracts/safety-acceptance.md`). Las marcas nuevas no
pueden distinguirse solo por color. La estructura del Excel sigue sin tocarse a
propósito: se rediseña junto con el reporte.

### 1b. Los tres hallazgos declarados de la revisión del 2026-08-27

Espejo compartido entre comidas sin grupo a la misma hora exacta, foto de
catálogo que es del plato, y el `source` de un carbohidrato importado editado.
Ver `progress.md` § Hallazgos no corregidos. El tercero necesita una decisión
de producto.

### 2. Los cuatro hallazgos vivos de la revisión repuntada

Siguen abiertos y son anteriores a esta corrida. Ver `progress.md` § Deuda.

### 3. Chat de IA

Sin construir. Antes hay que arreglar los imports `.js` de `@type1a/ai`
(`progress.md` § Bomba): el día que `apps/mobile` dependa de ese paquete, el
bundle rompe.

## Fuera de foco pero pendiente

- **Fase 22** — animación del swipe entre pantallas. JS puro, no necesita build.
- **Fase 20** — widget de pantalla de inicio. **Sí** necesita build.
- Decisión pendiente de Verónica: qué tan agresiva debe ser la exclusión de
  episodios confundidos. Hoy se eximen los bolos atribuibles a una comida para
  que la pantalla no se vacíe; el criterio estricto se cambia en una línea.
- Decisión pendiente de Verónica: si el producto quiere una **meta de fibra**.
  Hoy se muestra el total registrado y su completitud, sin denominador: una
  barra de progreso exige una meta, e inventarla convertiría un número
  descriptivo en un objetivo clínico que nadie definió.
