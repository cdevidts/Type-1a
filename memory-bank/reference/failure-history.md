# Historial de fallos que definieron las reglas

> Salió de `progress.md` el 2026-09-10, cuando ese archivo llevaba varias
> corridas contra su techo de 150 líneas obligando a picar contenido bueno.
> Esto no es "estado": es el respaldo de por qué existe cada regla, y se lee
> cuando alguien va a discutir una — no cada corrida.
>
> Las reglas mismas viven en `systemPatterns.md` y `techContext.md`.

Cada uno costó un build o un número falso; detalle en `git log`.

| Fallo | Regla |
|---|---|
| `.js` en imports relativos rompió 2 builds con verify en verde | `verify:bundle` obligatorio |
| Barrel de Lucide: 1.263 → 3.088 módulos | subpath obligatorio, canario de bundle |
| Filas sueltas emparejadas por timestamp | `entry_group_id` (Regla 3b) |
| `macrosSource` en 4 capas → 3 bugs | Regla 1 |
| Prompt con dosis habilitó afirmar IOB sin disparar el filtro | Regla 2 hermana |
| Promedio "ajustado" publicaba +57 donde la verdad era +10, con 372 tests verdes | test contra verdad sembrada |
| Exclusión binaria vació la pantalla de Patrones | truncar y ajustar, nunca obviar |
| `.positive()` en un esquema rompió un caso legítimo una corrida después | Regla 3, hermana |
| `eas-cli` desde la raíz dejó `app.json`/`eas.json` basura (2 veces) | correr desde `apps/mobile/` |
| Una purga de docs dejó ciegos a 5 de 7 activos de `.claude/` sin un solo error | `verify:contracts` |
| Un documento de arquitectura abandonado en el código indujo a error a varias corridas | ADR en la misma corrida que el cambio (0004) |
| El inventario de esa purga solo miraba `.claude/`: el código citaba 17 docs más | el guard escanea **todo** el repo, código incluido |
| Dos booleanos `hasMeal` divergentes borraron y descartaron comidas | una sola lista (`mealFields.ts`), pura y con test |
| Precargar los macros de la IA volvió `'mixed'` toda comida analizada: "el campo tiene valor" dejó de significar "ella lo escribió" | la procedencia se compara contra el valor precargado, no contra la ausencia |
| El mismo bloque de macros escrito seis veces; los campos del editor quedaron en ~32 pt de área tocable | `MacroFields` compartido, con `minHeight: 44` explícito |
| Un `WHERE entry_group_id IS NOT NULL` escondió las cetonas del acceso rápido: se guardaban bien y no se veían | el filtro de una consulta es una decisión de producto, no un detalle de SQL |
| Quitar ese `WHERE` a secas puso a competir agrupadas y sueltas por el mismo `LIMIT`, y una fila caída de la ventana se borraba al editar la entrada | una ventana de visualización **nunca** puede destruir un dato guardado; el borrado exige señal explícita, no una ausencia |
| Un `accessibilityLabel` explícito reemplaza el texto de los hijos: TalkBack anunciaba el título y no el valor ni la banda | la etiqueta lleva detalle y hora, o el color queda como único diferenciador |
| `XLSX.write(…, { type: 'array' })` devuelve un **`ArrayBuffer`** y un `as Uint8Array` lo disfrazó: el Excel nunca se escribía, y los tests no lo vieron porque devolvían el resultado a `XLSX.read`, que acepta ambos | un `as` sobre el retorno de una librería es una afirmación sin verificar, y un round-trip por esa misma librería no valida el contrato con quien consume el dato |
| Un modal por combinación (basal, cetonas, entrada) trajo tres copias del mismo formulario | la variante es **qué sección arranca abierta**, no qué componente se monta |
| `kind === 'meal'` dejaba a una comida empaquetada fuera de su propio editor con IA | las herramientas aparecen por **contenido**, no por tipo del ítem |
| Un formulario de edición por tipo codificaba "una insulina solo edita unidades" | hay **un** payload de edición; lo que decide el tipo es dónde aterriza (`masterTargetOf`), no qué se puede guardar |
| `updateInsulinEvent` asignaba `insulinName` incondicionalmente y cada guardado del grupo lo borraba | el nombre es configuración, y quién lo resuelve es una función de dominio con test, no el llamador de turno |
| Editar un carbohidrato suelto lo convertía en comida —con episodio y tres alarmas— solo por guardarlo | los gramos son comida al **crear**; al **editar**, se vuelve comida cuando se agrega algo que solo una comida tiene |
| Promover un evento a grupo lo dibujaba como "Entrada registrada" aunque siguiera siendo una sola cosa | un grupo de una pieza se emite con su tipo nativo: agrupar es una decisión de datos, "entrada" es una de presentación |
| Mover la hora de una comida sumaba tres alarmas nuevas a las tres viejas | cancelar va **antes** de programar, siempre; al revés la cancelación se lleva lo recién creado |
| La advertencia de la calculadora histórica cubría solo el modo edición; registrar en el pasado llegaba a la misma superficie sin ella | una guarda que protege dos caminos se escribe una vez, pura y con test |
| "Se transcribieron 62 g" mientras el campo de confirmados seguía en 20, y la fórmula leía los 20 | una pantalla que afirma un valor distinto del que usa la fórmula es peor que una que no afirma nada |
| Los macros del carrito se guardaban `'user'`: la procedencia se comparaba solo contra `analysis` | la resuelve quien sabe qué precargó la estimación —foto, texto **o catálogo**—, no el orquestador |
| Una comida sin grupo se veía dos veces —su tarjeta y su fila espejo—, y borrar los gramos de un carbo suelto para darle descripción los resucitaba contándolos dos veces | el duplicado se empareja con el **hecho**, no con el `entry_group_id`; un espejo huérfano sí se muestra porque es la única copia; y al crear la comida la fila suelta se **consume** siempre |
| Un spread llevó `macrosSource` y después `estimatedCarbsG` hacia interfaces que no los declaraban, con verify en verde las dos veces | el chequeo de propiedades en exceso **no aplica a un spread**: el campo se declara o se pierde |
| La tarea de fondo recibía **la misma conexión nativa** que la pantalla (Android cachea por ruta+opciones) y le corría un `BEGIN` encima; el `BEGIN` de Expo va dentro del `try`, así que el `ROLLBACK` de una cerraba la transacción de la otra, que seguía escribiendo suelta | una conexión por dueño (`useNewConnection`) y **una sola** cola FIFO por conexión (`dbWriteQueue.ts`); dos colas contra una conexión anidan igual |
| Un alimento sin `estimatedGrams` —lo que el prompt pide devolver cuando no puede estimar la porción— se descartaba del catálogo **sin un solo aviso**, y la pantalla decía "guardado" | lo que no se puede guardar se muestra **con su razón**; un filtro silencioso es un dato perdido que nadie va a buscar |
| El catálogo caía siempre a 100 g porque la IA no podía proponer porción, y el `INSERT` del alta ni siquiera escribía las columnas de porción | la porción la propone la IA y la **confirma** la usuaria: multiplica los cuatro macros, así que un número que nadie miró no entra por esa puerta |
| La huella del respaldo se verificaba contra los datos **ya normalizados por Zod**, así que un archivo viejo al que le falta una sección —justo lo que los `.default()` existen para admitir— nunca habría podido cuadrar | una huella de integridad protege **los bytes que alguien escribió**, no el objeto que salió de validarlos |
| Una foto de arroz con pollo dejaba dos alimentos sueltos y **los dos con la foto del plato entero** | el contenedor que faltaba es la receta: guarda la foto del plato y cada componente queda libre de tener la suya |
| La cobertura de días solo se mostraba bajo el umbral clínico de 14, así que a 30 y 90 días desaparecía y el promedio se leía como si cubriera el rango entero | "cuánto está cubierto" y "alcanza para la métrica" son dos afirmaciones distintas: la primera va siempre |
| El catálogo se guarda por 100 g y la tarjeta lo mostraba así: una cucharada de aceite aparecía con 100 g de grasa | cómo se **guarda** un número no es cómo se **lee** |
| El resumen post-comida citaba "empezó a las 21:30" para una comida de las 17:30: la app guarda UTC, el timeline formatea local y las métricas viajaban a la IA en UTC crudo | lo que sale a un tercero lleva su zona escrita; y el desfase se pide **por marca**, porque el horario de verano existe |
| Una meta de fibra copiada del molde de las otras habría dicho "te pasaste" | una referencia es un piso o un techo, y el texto tiene que saber cuál |
| Mandar la hora **local** al modelo no agregó un campo, pero sí volvió citable un dato sobre su vida: con UTC no podía juzgar a qué hora cenaba, con hora de pared sí | el filtro crece cuando crece lo que el modelo **puede decir**, no solo cuando crece el payload |
| El aviso de éxito corría siempre y pisaba al de "no se pudo registrar la insulina": se cerraba la app creyendo que la dosis había quedado | un `catch` que solo escribe un mensaje no arregla nada si el camino feliz lo reemplaza después; el fallo se lleva a la decisión final, no a un `setState` intermedio |
| Tres veces la misma: el catálogo vivía dentro de `MealModal` y "Nueva entrada" no podía reusar un alimento; el texto del botón rápido alimentaba a la IA y se tiraba sin guardar la nota; y ese mismo botón escribía comida y dosis **sin `entryGroupId`**, que es lo único por lo que el timeline agrupa | una facultad que el maestro tiene y el acceso rápido no es una **asimetría**, no una simplificación: se extrae a un módulo compartido y la montan los dos |
| "Solo receta" y "las dos cosas" escribían exactamente lo mismo: la elección existía en la pantalla y en ningún dato | una opción que no cambia ninguna fila es una mentira con botón; si se ofrece, hay una columna que la recuerda |
| La confirmación decía "se fusiona con ese" y guardaba con su propia clave | el texto de una pantalla se verifica contra lo que **escribe** |
| `rapidInsulinName` solo se leía: ninguna pantalla lo escribía, así que decía "sin configurar" con la insulina ya elegida y las dosis quedaban sin marca | un campo que nadie escribe es un campo muerto; el que se muestra se deriva del que sí se guarda |
| `purpose` decía para qué fue una dosis y nadie guardaba de cuánto se compuso | etiquetar no es desglosar |
| El "502 sobre 8 KB" no era el proxy: `route-llm` reparte por tamaño y las fotos grandes iban a Gemini, cuyo validador rechaza `exclusiveMinimum`. Un `z.number().positive()` nuevo rompió TODAS las fotos mientras el texto seguía bien | un umbral de tamaño puede ser un cambio de modelo disfrazado; se prueba el mismo payload contra cada modelo antes de culpar a la capa de red |
| La lista de palabras que el saneado filtra tenía **cuatro de las cinco** que importaban, y nada lo delataba | se enumera lo que **sobrevive** contra una lista blanca, no lo que se filtra: así una palabra nueva falla en el test y no en el teléfono |
| Seis pantallas prometían "Type 1A no calcula insulina activa" el día que empezó a calcularla; una en la pantalla que descuenta, otra impresa en el reporte clínico | una promesa vieja no rompe nada, solo miente: la copia de seguridad se afirma en un test (`safetyCopy.test.ts`) igual que el saneado |
| El IOB se restaba sin tope, así que el sobrante se comía la cobertura de carbohidratos: 20 g nuevos con 9 U activas proponían **0 U**. El test que debía impedirlo **afirmaba el bug** | el corolario de la Regla 1 otra vez: un test escrito junto al código confirma el código, no la verdad. Un invariante ("el total nunca baja de `mealUnits`") se barre sobre un rango, no se ejemplifica |
| La consulta de dosis recientes traía 6 h fijas; la regular humana dura 8, así que el activo salía **de menos** — y el activo de menos sube la dosis propuesta | una ventana que alimenta un cálculo se deriva del modelo, nunca de una constante escrita al lado |
| La pestaña de Insulina salió VACÍA: pedía correcciones aisladas sin otra rápida en 8 h, ventana que con múltiples dosis diarias no existe despierto. Segunda vez que se comete el mismo error, después de Patrones | truncar y ajustar, nunca obviar — y la prueba de que un filtro no es demasiado estricto es un test con **un día normal** adentro, no con el caso ideal |
| `RECORD_AUDIO` estaba a la vez en `permissions` y en `blockedPermissions`: el bloqueo gana y el permiso se elimina del build | un permiso nuevo se revisa contra `blockedPermissions`; la función habría fallado sin ningún error visible |
| El resultado final del dictado llegaba después de `stop()` y pisaba la corrección hecha a mano, o rellenaba el cuadro ya enviado | el evento se ignora salvo entre el `start` y el `end` **del reconocedor**, no del estado de la UI |
| Se avisaba dónde se transcribe la voz **mientras** el micrófono ya grababa | un consentimiento se pide antes del acto, no durante |
| Se escribieron reglas de ProGuard sin encender la minificación que las ejecuta, y se dieron por buenas | una mitad de un arreglo es peor que ninguna: parece hecho |
| Encendida la minificación, la regla **tampoco borró nada del APK**, con la configuración generada correcta | un arreglo cuyo efecto no se puede mirar no es un arreglo: se parcheó el origen, que sí se comprueba en el archivo instalable |
| Se le dijo a Verónica que el log del sistema "solo se ve con un cable", sin verificarlo | una evaluación de exposición se comprueba en la fuente; Android dice que hay apps de fábrica con `READ_LOGS` |
