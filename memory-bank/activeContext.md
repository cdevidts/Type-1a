# Active Context

_Última actualización: 2026-09-03 (el tope del IOB, la curva de efecto y el agua)._

## Insulina activa (IOB), que era el riesgo mayor (2026-09-02)

`AGENTS.md` prohibía IOB. Se levantó **a propósito** (`docs/adr/0005`) porque no
tenerlo era peor: una comida chica con corrección y otra cinco minutos después
producían **dos correcciones completas** por la misma glucosa. Lo encontró ella.

Cinco condiciones, en el código: modelo publicado y citado (exponencial de
LoopKit/OpenAPS, `iob.ts`), parámetros que ella configuró, resta **solo de la
mitad de corrección**, desglose entero en pantalla, y sin insulina elegida **no
hay estimación**: `undefined`, no cero. Cada dosis guarda de cuánto se compuso
(`mealUnits`/`correctionUnits`/`iobUnits`) y lo muestra en el detalle, el reporte
y el Excel. La duración por tramo (`insulin-duration.ts`) se propone en Resumen →
Insulina; **adoptar es de ella**.

Tres cosas salieron de revisar a mano (el subagente se cortó por límite de gasto):

- **La ventana de dosis no cubría el modelo**: 6 h fijas contra una regular de
  8 h. El activo salía de menos, y de menos **sube** la dosis propuesta. Ahora
  se deriva del modelo y el rótulo la dice.
- **Seis pantallas prometían que la app no calcula insulina activa.** Una en la
  pantalla que ahora descuenta; otra impresa en el reporte clínico. Ninguna
  prueba lo detectó: una promesa vieja no rompe nada, solo miente.
  `safetyCopy.test.ts` es el test que faltaba.
- **La pestaña salió vacía igual**: el filtro pedía correcciones aisladas sin
  otra rápida en 8 h, ventana que con múltiples dosis diarias no existe
  despierto. Ahora cuenta toda dosis rápida, recorta en la siguiente, mide desde
  el máximo y usa los carbohidratos como covariable. **Comparar y adoptar son
  cifras distintas.** Ver `reference/insulin-duration-method.md`.

## El IOB se comía la comida, y el agua entró a Nutrición (2026-09-03)

**El bug.** `bolus.ts` restaba el IOB sin tope, así que el sobrante se comía la
cobertura de carbohidratos: comió y se corrigió hace 10 min, quiere comer 20 g
más, la app proponía **0 U**. El comentario del archivo decía "solo de la
corrección" y el código hacía otra cosa; los tests **afirmaban el bug**. Ahora
el descuento se detiene en 0 y el desglose declara el activo que no se usó.
Regla de Verónica, que es la del código: **carbos nuevos = siempre te pinchas;
corrección nueva = no necesariamente.** Ver `docs/adr/0006`.

Decidido en el mismo ADR: el IOB **sí** incluye la insulina de comida. Es la
práctica estándar de las bombas y es la que protege de la hipo; sin modelar COB
—que sería inferir absorción— lo seguro es contarla entera.

**La curva de efecto.** Ella dudó del resumen: "me inyecto a las 6 y recién me
baja a las 10-11, pero dice que en la tarde me dura más". El tramo nunca estuvo
mal (siempre fue por hora de inyección), pero la **duración observada sufre
censura**: su ventana se corta en la dosis siguiente, y de noche no llega
ninguna. `insulin-effect-curve.ts` no tiene ese sesgo — mide el mismo instante en
todos los episodios (1..8 h) y cada punto lleva su `n`.

**Agua.** Meta diaria (IOM, override de ella), barra en Nutrición, sección en el
maestro, campo en Comida, acceso rápido, ítem de timeline, y la IA la propone
desde foto o texto. **Solo agua**: un jugo es comida, con su dosis — el prompt
enumera las bebidas que no cuentan en vez de confiar en que se entienda.

## Lo que cambió el foco

El Modal Maestro es **el** formulario: `TimelineDetailModal` solo lee, y su botón
**Editar** abre el mismo componente que monta "Nueva entrada". La regla que lo
ordena todo: **el foco decide qué se abre primero y nunca qué se puede guardar.**
Al crear manda el acceso rápido; al editar manda el **contenido**. El tipo con el
que nació un registro no limita lo que se le suma después.

## Ya entregado al teléfono (`a706510`) — el detalle, en los cuerpos de commit

- **La edición retroactiva no tiene límite de tipo.** `promoteEventToEntryGroup`
  conserva id, hora, `created_at`, `source` y procedencia; promoción y edición
  van en **una** transacción.
- **Comida y carbohidratos son un solo hecho visible.** El espejo se esconde
  cuando su comida está a la vista; uno **huérfano** se muestra.
- **`ingestedAt` y la hora de una lectura externa no se mueven nunca.**
- **Un blanco no es un cero.** Vitales, foto y análisis son parches.
- **El nombre de la insulina es configuración**, no un campo por registro.
- Carrito, Strip Calendar, fecha y hora editables, fibra, y `QuickNumericModal`.

## Las transacciones SQLite, cerradas (2026-08-28)

La tarea de fondo recibía la **misma conexión nativa** que la pantalla y le corría
un `BEGIN` encima; `expo-sqlite` lo pone dentro del `try`, así que la segunda hacía
un `ROLLBACK` ajeno y la primera escribía suelta. Hoy el fondo abre con
`useNewConnection` y **toda** transacción pasa por una cola FIFO.

## El catálogo y los campos de IA (2026-09-01)

**Faltaba saber cuánto pesa una porción**: una Monster Zero no llegaba al catálogo
y todo lo demás quedaba en 100 g. Ahora la IA propone `servingGrams`,
`CatalogServingModal` lo confirma, y lo rechazado se muestra con su razón.
Confirmar lo vuelve `'user'`. Además: nota del botón rápido, calorías en chip
neutro, fotos desde el editor, `MealAiFields` en los tres modales, y la cobertura
de días de vuelta en 30 y 90 (`coverage.ts`).

## Porción, fibra y la hora del resumen (2026-09-01)

**Los macros del catálogo se muestran por porción.** Se siguen guardando por 100 g,
pero mostrarlos así inflaba cada tarjeta: una cucharada de aceite aparecía con
100 g de grasa. La leyenda dice el denominador.

**La fibra tiene meta**: 14 g por cada 1000 kcal (IOM, respaldada por la ADA). Es
un **piso, no un techo**, y **no se descuenta de los carbohidratos**.

**El resumen post-comida citaba la hora en UTC**: una comida de las 17:30 se
resumía como "empezó a las 21:30". Ahora cada marca sale con desfase local
explícito (`localizeEpisodeMetrics`, **por marca**, porque el horario de verano
existe) y lo guardado en SQLite sigue siendo UTC canónico.

Lo que crece con eso es **lo que el modelo puede decir**: una hora local sí
significa algo sobre su vida, así que el mismo cambio le prohíbe juzgar o
aconsejar la hora de comer, y `ai-safety.ts` lo respalda en estructura.

**Y dos bugs viejos del botón rápido.** La dosis se escribía sin `entryGroupId`
—el timeline agrupa solo por esa columna—, y si esa escritura fallaba el aviso de
éxito la pisaba: se cerraba la app creyendo que la dosis había quedado.

✅ En el teléfono (builds `03fb5c6d` y `e93ce4a2`, huella verificada en el APK).

## Reglas de proceso que sobreviven

1. Antes de agregar un campo a un formulario de comida, se mira si va en
   `MacroFields` o en otro compartido: suelto en un modal es cómo llegamos a tener
   el mismo bloque seis veces.
2. **Una decisión de datos no se verifica a ojo.** Lo que decide qué se guarda,
   qué se ve o qué es un hecho vive en un módulo puro con test: `masterModal`,
   `mealCarbMirror`, `entryTime`, `mealFields`, `meal-cart`, `entryGroupClaim`,
   `dbWriteQueue`, `mealNote`, `episode-local-time`, `nutrition-targets`.
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
3. **Chat de IA**, sin construir: no hay endpoint ni tool calling, y falta
   confirmar si RouteLLM lo soporta.

## Fuera de foco pero pendiente

- **Fase 22** — swipe animado. JS puro, sin build. **Fase 20** — widget de
  pantalla de inicio, sí necesita build.
- Decisión pendiente de Verónica: qué tan agresiva debe ser la exclusión de
  episodios confundidos en Patrones. El criterio estricto se cambia en una línea.
