# Active Context

_Última actualización: 2026-09-02 (recetas de verdad, duplicados, el 502)._

## Lo que cambió el foco

El Modal Maestro es **el** formulario: `TimelineDetailModal` solo lee, y su
botón **Editar** abre el mismo componente que monta "Nueva entrada". La regla
que lo ordena todo: **el foco decide qué se abre primero y nunca qué se puede
guardar.** Al crear manda el acceso rápido; al editar manda el **contenido**
(`masterSectionsFor`). El tipo con el que nació un registro no limita lo que se
le suma después.

## Ya entregado al teléfono (`a706510`) — el detalle, en los cuerpos de commit

- **La edición retroactiva no tiene límite de tipo.** `promoteEventToEntryGroup`
  convierte un evento suelto en grupo conservando id, hora, `created_at`,
  `source` y procedencia; promoción y edición van en **una** transacción.
- **Comida y carbohidratos son un solo hecho visible.** El espejo se esconde
  cuando su comida está a la vista; uno **huérfano** se muestra, porque es la
  única copia que queda de esos gramos.
- **`ingestedAt` y la hora de una lectura externa no se mueven nunca.**
- **Un blanco no es un cero.** Vitales, foto y análisis son parches.
- **El nombre de la insulina es configuración**, no un campo por registro.
- Carrito, Strip Calendar, fecha y hora editables, fibra, y `QuickNumericModal`.

## Las transacciones SQLite, cerradas (2026-08-28)

La tarea de fondo recibía la **misma conexión nativa** que la pantalla y le
corría un `BEGIN` encima; `expo-sqlite` pone el `BEGIN` dentro del `try`, así
que la segunda hacía un `ROLLBACK` ajeno y la primera seguía escribiendo
suelta. Hoy el fondo abre con `useNewConnection` y **toda** transacción pasa
por una sola cola FIFO (`dbWriteQueue.ts`).

## El catálogo y los campos de IA (2026-09-01)

**Faltaba saber cuánto pesa una porción**: una Monster Zero no llegaba al
catálogo (`toCatalogEntry` exigía `estimatedGrams`, que el prompt devuelve
`null` cuando no puede estimar) y todo lo demás quedaba en 100 g. Ahora la IA
propone `servingGrams`/`servingLabel`, `CatalogServingModal` lo confirma y lo
rechazado se muestra **con su razón**. Confirmar lo vuelve `'user'`, y solo
otro `'user'` lo reemplaza. Además: nota del botón rápido (`mealNote.ts`,
techo 300), calorías en chip neutro, fotos desde el editor del catálogo.

`MealAiFields.tsx` separa la **pista para la foto** de la **corrección sobre
lo ya propuesto** (sin reenviar la imagen), en los tres modales. Adoptar una
propuesta invalida la dosis. Y la cobertura de días volvió a verse en 30 y 90:
`coverage.ts` separa "cuánto está cubierto" de "alcanza para la HbA1c".

## Recetas, ahora sí completas (2026-09-02)

Verónica probó el build y encontró que "completas" era generoso. Cuatro cosas:

**"Solo receta" listaba los alimentos igual.** La elección escribía las filas
—una receta no guarda macros, los deriva— pero nada las distinguía de "las dos
cosas". Ahora `food_catalog.listed` (ausente = visible): un componente oculto
no aparece en la grilla ni en el buscador, sale a la luz desde el detalle de
la receta, `blendCatalogEntry` hace OR (visible gana) y `deleteRecipe` borra
los ocultos que ninguna otra receta use, porque nadie más podría.

**Duplicados: "pata de pollo" al lado de "muslo de pollo".** La heurística no
puede saberlo y no debe adivinarlo. Dos mitades: ella **fusiona a mano** desde
la confirmación (`mergeInto`: hereda clave y nombre del existente, macros de
la propuesta; el parecido por nombre viene preseleccionado y visible — antes
el texto prometía la fusión y no la hacía), y la IA recibe `knownFoodNames`
—solo nombres, máx. 300— para reusar el exacto cuando es el mismo alimento,
con el freno escrito: otro corte o preparación es otro alimento. Esa mitad
espera redeploy (prompts de comida v3).

**El detalle de una receta no existía.** `RecipeDetail.tsx`, en lugar de la
lista y no encima: totales con la misma fila de chips de la tarjeta, cada
componente con sus gramos **en este plato** editables, agregar y quitar, foto,
nombre, borrar, y "Usar en una comida", que la expande al carrito **una línea
por componente** (`recipeToCartLines`) para que la porción siga siendo por
alimento. El carrito también la encuentra al buscar.

**Los componentes ya no heredan la foto del plato** cuando hay receta: era el
bug que originó todo el módulo.

⚠️ **Las fotos daban 502 y no era el proxy.** `route-llm` reparte por tamaño
—las chicas a un GPT, las grandes a Gemini— y el validador de Gemini habla
OpenAPI 3.0, donde `exclusiveMinimum` no existe suelto. El
`z.number().positive()` de `servingGrams` bastó para romper todas las fotos. La
lista de palabras filtradas tenía cuatro de cinco; ahora un test enumera lo que
**sobrevive**, y encontró `default` antes de que llegara al teléfono.

## Porción, fibra y la hora del resumen (2026-09-01)

**Los macros del catálogo se muestran por porción.** Se siguen guardando por
100 g —eso no cambia— pero mostrarlos así inflaba cada tarjeta: una cucharada de
aceite aparecía con 100 g de grasa, y son esos números los que después sugieren
carbohidratos. La leyenda dice el denominador.

**La fibra tiene meta**, la decisión que faltaba: 14 g por cada 1000 kcal (IOM,
respaldada por la ADA en diabetes). Es un **piso, no un techo** —su barra dice
"por sobre la referencia", no "te pasaste"— y **no se descuenta de los
carbohidratos**: los "netos" los define el equipo tratante.

**El resumen post-comida citaba la hora en UTC.** El timeline siempre estuvo
bien porque formatea en la zona del teléfono; las métricas viajaban al modelo en
UTC crudo, así que una comida de las 17:30 se resumía como "empezó a las 21:30".
Ahora cada marca sale con desfase local explícito (`localizeEpisodeMetrics`,
pedido **por marca** porque el horario de verano existe), el prompt prohíbe
convertir, y lo guardado en SQLite sigue siendo UTC canónico.

Lo que crece con eso es **lo que el modelo puede decir**: una hora en UTC no
significaba nada sobre su vida y una local sí, así que el mismo cambio le
prohíbe juzgar o aconsejar la hora de comer y `ai-safety.ts` lo respalda en
estructura. Describir cuándo pasó algo sigue pasando; "cena más temprano", no.

**Y dos bugs viejos del botón rápido.** La dosis se escribía sin
`entryGroupId` —el timeline agrupa solo por esa columna, así que la app volvía
a preguntar qué dosis fue con qué comida—, y si esa escritura fallaba el aviso
de éxito la pisaba: se cerraba la app creyendo que la dosis había quedado.

✅ En el teléfono (builds `03fb5c6d` y `e93ce4a2`, huella verificada en el APK).

## Reglas de proceso que sobreviven

1. Antes de agregar un campo a un formulario de comida, se mira si va en
   `MacroFields` o en otro compartido: suelto en un modal es cómo llegamos a
   tener el mismo bloque seis veces.
2. **Una decisión de datos no se verifica a ojo.** Lo que decide qué se guarda,
   qué se ve o qué es un hecho vive en un módulo puro con test: `masterModal`,
   `mealCarbMirror`, `entryTime`, `mealFields`, `meal-cart`, `entryGroupClaim`,
   `dbWriteQueue`, `mealNote`, `episode-local-time`.
3. Un dato que el formulario **no ve** es un dato que el guardado borra: por eso
   `TimelineEntryGroupRaw` relee insulina, calorías, peso y presión aunque la
   fila del timeline no los muestre.

## Backlog de producto priorizado

1. **Reportes PDF más ricos**: legibilidad, **iconografía** y una síntesis
   clínica al cierre. Una conclusión describe lo que pasó, **nunca** evalúa una
   dosis (`contracts/safety-acceptance.md`), y las marcas nuevas no pueden
   distinguirse solo por color. El Excel va en el mismo cambio.
2. **Los tres hallazgos declarados del 2026-08-27** y **los cuatro vivos de la
   repuntada**: ver `progress.md`. El del `source` de un carbohidrato importado
   necesita decisión de producto.
3. **Chat de IA**, sin construir. No hay endpoint ni tool calling, y falta
   confirmar si RouteLLM lo soporta — preguntado a DeepAgent junto al redeploy.

## Fuera de foco pero pendiente

- **Fase 22** — swipe animado. JS puro, sin build. **Fase 20** — widget de
  pantalla de inicio, sí necesita build.
- Decisión pendiente de Verónica: qué tan agresiva debe ser la exclusión de
  episodios confundidos. Hoy se eximen los bolos atribuibles a una comida para
  que Patrones no se vacíe; el criterio estricto se cambia en una línea.
