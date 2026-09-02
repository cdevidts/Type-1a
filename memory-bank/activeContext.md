# Active Context

_Última actualización: 2026-09-01 (porción, fibra y la hora del resumen)._

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

El "no se puede guardar" sumaba dos causas: la tarea de fondo recibía la **misma
conexión nativa** que la pantalla (Android cachea por ruta+opciones) y le corría
un `BEGIN` encima cada ~15 min, y `refresh()` escribe CGM en cada vuelta a
primer plano. No fallaba limpio porque `expo-sqlite` pone el `BEGIN` **dentro**
del `try`: la segunda falla al abrir y su `catch` hace un `ROLLBACK` **ajeno**
mientras la primera sigue escribiendo suelta. Hoy el fondo abre con
`useNewConnection` y **toda** transacción pasa por una sola cola FIFO
(`dbWriteQueue.ts`): dos colas contra una conexión se anidan igual.

## El catálogo, cerrado en cuatro frentes (2026-09-01)

**El grande: faltaba saber cuánto pesa una porción**, con dos síntomas opuestos.
Una Monster Zero no llegaba al catálogo —`toCatalogEntry` exigía
`estimatedGrams` y el prompt le pide devolverlo `null` cuando no puede estimar
la porción— y todo lo demás quedaba en 100 g. Ahora la IA propone `servingGrams`
y `servingLabel`, y `CatalogServingModal` lo muestra para confirmar. Lo
rechazado se muestra **con su razón**: un descarte silencioso es un dato perdido
que nadie va a buscar.

Se confirma porque la porción multiplica los cuatro macros. Confirmar la vuelve
dato de la usuaria (`servingSource: 'user'`) y `blendCatalogEntry` protege eso:
**solo otro `'user'` lo reemplaza**, o cada foto nueva le borraría su "una taza
son 150 g". Una fila sin `servingSource` se trata como suya, porque lo es.

Y tres huecos chicos: **la nota del botón rápido** (`mealNote.ts` respeta el
techo de 300 del esquema, donde pasarse hace que Zod rechace la comida entera),
**calorías en chip neutro** y **fotos desde el editor del catálogo**.

## Los dos cuadros de texto de la IA, y la cobertura (2026-09-01)

`MealAiFields.tsx` separa lo que era un campo haciendo dos trabajos: la **pista
para la foto** (el rótulo cambia según haya imagen — ese cambio *es* el arreglo,
porque el campo mentía) y la **corrección sobre lo ya propuesto**, que
`editMealWithInstruction` resolvía **sin reenviar la imagen** pero solo se
alcanzaba desde `MealEditModal`. Adoptar una propuesta invalida la dosis: los
carbohidratos cambian.

**La cobertura de días volvió a verse en 30 y 90.** Solo se mencionaba bajo el
umbral clínico de 14 días, así que con datos suficientes desaparecía y el
promedio se leía como si cubriera el rango entero. `coverage.ts` separa cuánto
está cubierto (siempre) de si alcanza para la HbA1c estimada (clínico).

## Recetas, completas (2026-09-01)

Tablas `recipes` y `recipe_items`, **aditivas**. Una receta **no guarda macros**:
se derivan de sus componentes contra el catálogo vivo, así que corregir el arroz
corrige todas las recetas que lo usan. Un componente ausente se declara en vez
de sumar cero callado. Al guardar una comida de varios alimentos, la pregunta de
tres salidas: por separado, como receta, o las dos. Con "solo receta" los
alimentos igual se escriben —sin ellos la suma no tendría sumandos—; lo que
cambia es que no se listan sueltos.

Borrar un alimento que una receta usa lanza `FoodInUseByRecipesError`, que **no
es un error a reportar**: abre `RecipeFixModal`, donde se resuelve receta por
receta. **Todo o nada**: si queda una sin resolver, el alimento no se borra. La
IA propone el sustituto —con la razón escrita— y nunca lo aplica sola. Los
duplicados se marcan (`similarTo`) y jamás se fusionan solos: emparejar mal
mezcla macros de dos alimentos y eso sugiere carbohidratos sin delatarse.

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

✅ En el teléfono (build `03fb5c6d`, huella verificada contra el APK). La hora del resumen espera además el redeploy.

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
