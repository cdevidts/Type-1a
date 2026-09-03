# Active Context

_Última actualización: 2026-09-02 (insulina activa y el desglose de cada dosis)._

## Insulina activa (IOB), que era el riesgo mayor (2026-09-02)

`AGENTS.md` prohibía IOB. Se levantó **a propósito** (`docs/adr/0005`) porque no
tenerlo era peor: una comida chica con corrección y otra comida cinco minutos
después producían **dos correcciones completas** por la misma glucosa alta. La
app proponía stacking con toda confianza. Lo encontró Verónica.

Cinco condiciones, todas en el código: modelo publicado y citado
(exponencial de LoopKit/OpenAPS, `iob.ts`), parámetros que ella configuró,
resta **solo de la mitad de corrección** —los carbohidratos llevan siempre su
dosis completa—, desglose entero en pantalla (`InsulinBreakdown.tsx`), y sin
insulina elegida **no hay estimación**: `undefined`, no cero.

Cada dosis **guarda de cuánto se compuso** (`mealUnits`, `correctionUnits`,
`iobUnits`) y lo muestra: en el detalle del evento, en el reporte del día y en el
Excel. Antes `purpose` decía para qué fue y nadie guardaba su composición.

**Duración por tramo horario.** `insulin-duration.ts` mide cuánto dura su
insulina en madrugada / mañana / tarde / noche (mediana, mínimo 3 episodios) y lo
propone en Resumen → Insulina. **Adoptar es de ella**, nunca automático.

Dos cosas salieron de la revisión clínica hecha a mano (el subagente se cortó
por límite de gasto de la cuenta):

- **La ventana de dosis no cubría el modelo.** La consulta traía 6 h fijas y la
  regular humana dura 8. Una dosis de hace 7 h quedaba fuera, el activo salía
  de menos, y el activo de menos **sube** la dosis propuesta. Ahora la ventana
  se deriva del modelo y el rótulo la dice.
- **Seis pantallas prometían que la app no calcula insulina activa.** Una vivía
  en la pantalla que ahora sí descuenta; otra iba impresa en el reporte al
  equipo clínico. Ninguna prueba lo detectó: una promesa vieja no rompe nada,
  solo miente. `safetyCopy.test.ts` es el test que faltaba.

**La pestaña salió vacía igual (2026-09-03).** El filtro pedía correcciones
aisladas sin otra rápida en 8 h: con múltiples dosis diarias esa ventana no
existe despierto, así que solo la madrugada podía calificar. Ahora cuenta toda
dosis rápida, la ventana se recorta en la siguiente, la bajada se mide desde el
máximo (un bolo de comida sube antes de bajar) y los carbohidratos son
covariable. **Comparar y adoptar son cifras distintas**: adoptar usa solo
episodios sin comida. Ver `reference/insulin-duration-method.md`.

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
catálogo y todo lo demás quedaba en 100 g. Ahora la IA propone `servingGrams`,
`CatalogServingModal` lo confirma, y lo rechazado se muestra con su razón.
Confirmar lo vuelve `'user'`, y solo otro `'user'` lo reemplaza. Además:
nota del botón rápido, calorías en chip neutro, fotos desde el editor.
`MealAiFields` separa la pista para la foto de la corrección sobre lo
propuesto, en los tres modales. Y la cobertura de días volvió a verse en 30 y
90 (`coverage.ts`).

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
