# Active Context

_Última actualización: 2026-09-01 (porción confirmada, nota, calorías y fotos)._

## Lo que cambió el foco

El Modal Maestro dejó de ser una espina y pasó a ser **el** formulario. La
edición ya no es un conjunto de formularios inline por tipo dentro de
`TimelineDetailModal`: ese archivo solo lee, y su botón **Editar** abre el
mismo componente que monta "Nueva entrada".

La regla que lo ordena todo: **el foco decide qué se abre primero y nunca qué
se puede guardar.** Al crear manda el acceso rápido; al editar manda el
**contenido** (`masterSectionsFor`). El tipo con el que nació un registro no
limita lo que se le suma después.

## Ya entregado al teléfono (build del 2026-08-31, commit `a706510`)

El detalle vive en los cuerpos de commit; acá solo las reglas que sobreviven.

- **La edición retroactiva no tiene límite de tipo.** `promoteEventToEntryGroup`
  convierte un evento suelto en grupo con un `UPDATE` de una columna:
  idempotente, sin borrar ni recrear, conservando id, hora, `created_at`,
  `source` y procedencia. Promoción y edición van en **una** transacción
  serializada (`entryGroupClaim.ts`), así que un fallo revierte las dos.
- **Comida y carbohidratos son un solo hecho visible.** La fila espejo
  (`meal_confirmed`) se sigue guardando —dominio, reporte y borrado dependen de
  ella— pero se esconde cuando su comida está a la vista. Un espejo **huérfano**
  sí se muestra: es la única copia que queda de esos gramos.
- **`ingestedAt` y la hora de una lectura externa no se mueven nunca**, ni
  siquiera al mover un grupo entero de hora.
- **Un blanco no es un cero.** Vitales, foto y análisis son parches: corregir
  una cetona no borra el peso de la misma fila.
- **El nombre de la insulina es configuración**, no un campo por registro
  (`insulinNameForType` / `resolveInsulinNameForEdit`, en dominio).
- Carrito multi-alimento, Strip Calendar, fecha y hora editables, fibra de
  primera clase, y `QuickNumericModal` para basal y cetonas.

## Las transacciones SQLite, cerradas (2026-08-28)

El "no se puede guardar" tenía dos causas sumadas: la tarea de fondo recibía la
**misma conexión nativa** que la pantalla (Android cachea por ruta+opciones) y
le corría `initializeDatabase` y un `BEGIN` encima cada ~15 min; y `refresh()`
escribe lecturas CGM en cada vuelta a primer plano, así que dos escrituras de la
app también se anidaban. No fallaba limpio porque `expo-sqlite` pone el `BEGIN`
**dentro** del `try`: la segunda falla al abrir y su `catch` ejecuta un
`ROLLBACK` **ajeno**, y la primera sigue escribiendo suelta. Hoy el fondo abre
con `useNewConnection` y **toda** transacción de `db.ts` pasa por una sola cola
FIFO (`dbWriteQueue.ts`) — dos colas contra una conexión se anidan igual.

## El catálogo, cerrado en cuatro frentes (2026-09-01)

**El grande: faltaba saber cuánto pesa una porción**, y eso producía dos
síntomas opuestos. Una Monster Zero no llegaba nunca al catálogo —no por la
confianza ni por los ceros, sino porque `toCatalogEntry` exigía
`estimatedGrams` y el prompt le pide al modelo devolverlo `null` cuando no
puede estimar la porción—; y todo lo demás quedaba con porción de 100 g.

Ahora la IA propone `servingGrams` y `servingLabel`, eso sirve de denominador
cuando no hay gramos del plato, y `CatalogServingModal` lo muestra para
confirmar antes de guardar. Lo rechazado se muestra **con su razón**: un
descarte silencioso es un dato perdido que nadie va a buscar.

Se confirma en vez de aplicarse solo porque la porción multiplica los cuatro
macros y termina alimentando los carbohidratos que se sugieren al reusar el
alimento. Confirmar lo vuelve dato de la usuaria (`servingSource: 'user'`), y
`blendCatalogEntry` protege eso: **solo otro `'user'` lo reemplaza.** Esa regla
antes no existía y no hacía falta —la IA no podía mandar el campo—; sin
escribirla, cada foto nueva le habría borrado su "una taza son 150 g". Una fila
sin `servingSource` se trata como suya, porque lo es. De paso: el `INSERT` de
`recordCatalogFoods` omitía las columnas de porción, así que un alimento nuevo
la perdía en su primer guardado.

Y tres huecos chicos:

- **La nota del botón rápido.** `TimelineDetailModal` ya dibujaba `Nota` para
  una comida; faltaba que el acceso rápido la escribiera —usaba su cuadro de
  texto solo para llamar a la IA y lo tiraba—. `mealNote.ts` (puro, con test)
  decide el texto y respeta el techo de 300 del esquema: pasarse no trunca,
  hace que Zod rechace **la comida entera**.
- **Calorías en la tarjeta de alimento**, en un chip **neutro y sin hue
  propio**: la energía no es un macro. Un quinto color categórico habría
  exigido revalidar la paleta completa.
- **Fotos desde el editor del catálogo** (cámara y galería). Acá la foto es solo
  representación: a diferencia de una comida, no se adopta junto a un análisis.

⚠️ Nada de esto está en el teléfono todavía: falta un build `preview`.

## Diseñado y sin construir

- `reference/catalog-recipes.md` — guardar "arroz con pollo" como **receta**
  con sus componentes y fotos independientes, y que la IA no proponga
  duplicados de lo que ya está en el catálogo.
- `reference/meal-ai-text-fields.md` — separar el cuadro de texto en dos: la
  **pista para la foto** y la **corrección sobre lo ya propuesto**. Hallazgo
  que ordena esa corrida: `editMealWithInstruction` ya resuelve lo segundo y
  **no manda la imagen** —trabaja sobre la composición en pantalla—, pero solo
  se alcanza desde `MealEditModal`. Tiene que llegar a los tres modales.

## Reglas de proceso que sobreviven

1. Antes de agregar un campo a un formulario de comida, se mira si va en
   `MacroFields` o en un componente compartido. Escribirlo suelto en un modal
   es cómo llegamos a tener el mismo bloque seis veces.
2. **Una decisión de datos no se verifica a ojo.** Todo lo que decide qué se
   guarda, qué se ve o qué es un hecho vive en un módulo puro con test:
   `masterModal.ts`, `mealCarbMirror.ts`, `entryTime.ts`, `mealFields.ts`,
   `meal-cart.ts`, `entryGroupClaim.ts`, `dbWriteQueue.ts`, `mealNote.ts`.
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

### 1b. Los tres hallazgos declarados del 2026-08-27

Espejo compartido entre comidas sin grupo a la misma hora, foto de catálogo que
es del plato, y el `source` de un carbohidrato importado editado. Ver
`progress.md`; el tercero necesita decisión de producto.

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
