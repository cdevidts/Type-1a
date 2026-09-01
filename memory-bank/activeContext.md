# Active Context

_Última actualización: 2026-09-01 (recetas, campos de IA y cobertura)._

## Lo que cambió el foco

El Modal Maestro dejó de ser una espina y pasó a ser **el** formulario. La
edición ya no es un conjunto de formularios inline por tipo dentro de
`TimelineDetailModal`: ese archivo solo lee, y su botón **Editar** abre el
mismo componente que monta "Nueva entrada".

La regla que lo ordena todo: **el foco decide qué se abre primero y nunca qué
se puede guardar.** Al crear manda el acceso rápido; al editar manda el
**contenido** (`masterSectionsFor`). El tipo con el que nació un registro no
limita lo que se le suma después.

## Ya entregado al teléfono (build del 2026-08-31, `a706510`)

Reglas que sobreviven; el detalle vive en los cuerpos de commit.

- **La edición retroactiva no tiene límite de tipo.** `promoteEventToEntryGroup`
  convierte un evento suelto en grupo con un `UPDATE` de una columna,
  conservando id, hora, `created_at`, `source` y procedencia. Promoción y
  edición van en **una** transacción (`entryGroupClaim.ts`).
- **Comida y carbohidratos son un solo hecho visible.** La fila espejo se
  esconde cuando su comida está a la vista; un espejo **huérfano** se muestra,
  porque es la única copia que queda de esos gramos.
- **`ingestedAt` y la hora de una lectura externa no se mueven nunca.**
- **Un blanco no es un cero.** Vitales, foto y análisis son parches.
- **El nombre de la insulina es configuración**, no un campo por registro.
- Carrito multi-alimento, Strip Calendar, fecha y hora editables, fibra, y
  `QuickNumericModal` para basal y cetonas.

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

**El grande: faltaba saber cuánto pesa una porción**, con dos síntomas
opuestos. Una Monster Zero no llegaba al catálogo —porque `toCatalogEntry`
exigía `estimatedGrams` y el prompt le pide devolverlo `null` cuando no puede
estimar la porción—; y todo lo demás quedaba con porción de 100 g.

Ahora la IA propone `servingGrams` y `servingLabel`, eso sirve de denominador
cuando no hay gramos del plato, y `CatalogServingModal` lo muestra para
confirmar antes de guardar. Lo rechazado se muestra **con su razón**: un
descarte silencioso es un dato perdido que nadie va a buscar.

Se confirma en vez de aplicarse solo porque la porción multiplica los cuatro
macros y alimenta los carbohidratos que se sugieren al reusar el alimento.
Confirmar lo vuelve dato de la usuaria (`servingSource: 'user'`) y
`blendCatalogEntry` protege eso: **solo otro `'user'` lo reemplaza.** Sin esa
regla, cada foto nueva le habría borrado su "una taza son 150 g"; una fila sin
`servingSource` se trata como suya, porque lo es.

Y tres huecos chicos: **la nota del botón rápido** —`TimelineDetailModal` ya la
dibujaba, faltaba escribirla; `mealNote.ts` respeta el techo de 300 del esquema,
donde pasarse hace que Zod rechace la comida entera—, **calorías en la tarjeta**
en chip neutro (un quinto hue categórico habría exigido revalidar la paleta), y
**fotos desde el editor del catálogo**, donde la imagen es solo representación y
no se adopta junto a un análisis.

⚠️ Nada de esto está en el teléfono todavía: falta un build `preview`.

## Los dos cuadros de texto de la IA, y la cobertura (2026-09-01)

`MealAiFields.tsx` separa lo que antes era un campo haciendo dos trabajos: la
**pista para la foto** (el rótulo cambia según haya imagen — ese cambio *es* el
arreglo, porque el campo mentía sobre lo que hacía) y la **corrección sobre lo
ya propuesto**, que `editMealWithInstruction` resolvía desde antes y **sin
reenviar la imagen**, pero solo se alcanzaba desde `MealEditModal`. Ahora está
en los tres. Quien adopta una propuesta invalida la dosis calculada: los
carbohidratos cambian, así que una dosis anterior deja de corresponder.

**La cobertura de días volvió a verse en 30 y 90.** Solo se mencionaba por
debajo del umbral clínico de 14 días, así que con datos suficientes para
pasarlo desaparecía y la pantalla se leía como si el promedio resumiera el
rango completo. `coverage.ts` separa las dos afirmaciones: cuánto está cubierto
(siempre, descriptivo) y si alcanza para la HbA1c estimada (clínico).

## Recetas, completas (2026-09-01)

Tablas `recipes` y `recipe_items`, **aditivas**: ninguna fila de `food_catalog`
se toca. Una receta **no guarda macros** — se derivan de sus componentes contra
el catálogo vivo, así que corregir el arroz corrige todas las recetas que lo
usan. Un componente ausente se declara en vez de sumar cero callado.

Al guardar una comida de varios alimentos, la pregunta de tres salidas: por
separado, como receta, o las dos. Con "solo receta" los alimentos igual se
escriben — sin ellos la suma no tendría sumandos; lo que cambia es que no se
listan sueltos.

Borrar un alimento que una receta usa lanza `FoodInUseByRecipesError`, que **no
es un error a reportar**: abre `RecipeFixModal`, donde se resuelve receta por
receta (cambiarlo conservando los gramos, sacarlo, o dejarla). **Todo o nada**:
si queda una sin resolver, el alimento no se borra. La IA propone el sustituto
—por nombre parecido o por macros cercanos, con la razón escrita— y nunca lo
aplica sola.

Los duplicados se marcan en la confirmación (`similarTo`) y jamás se fusionan
solos: emparejar mal mezcla macros de dos alimentos y eso sugiere carbohidratos
sin delatarse; un duplicado es feo y reversible.

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

1. **Reportes PDF más ricos**: legibilidad, **iconografía en los gráficos** y
   una síntesis clínica al cierre. Ojo con la frontera: una conclusión describe
   lo que pasó, **nunca** evalúa si una dosis fue adecuada ni sugiere cambiarla
   (`contracts/safety-acceptance.md`), y las marcas nuevas no pueden
   distinguirse solo por color. El Excel se rediseña junto con el reporte.
2. **Los tres hallazgos declarados del 2026-08-27** y **los cuatro vivos de la
   revisión repuntada**: ver `progress.md`. El del `source` de un carbohidrato
   importado necesita decisión de producto.
3. **Chat de IA**, sin construir. Antes hay que arreglar los imports `.js` de
   `@type1a/ai` (`progress.md` § Bomba): el día que `apps/mobile` dependa de ese
   paquete, el bundle rompe.

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
