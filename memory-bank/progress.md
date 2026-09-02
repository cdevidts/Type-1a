# Progress

_Última actualización: 2026-09-02._

## Estado de validación

| | |
|---|---|
| `pnpm verify` | Verde; el wrapper local de Windows conserva su fallo de rutas preexistente. CI Linux es la verificación integral |
| Tests | **818** — domain 500, mobile 260, ai 25, schemas 13, cgm 10, api 10 |
| Bundle de Metro | **1.367 módulos** medidos (+3: `iob`, `insulin-duration`, `InsulinBreakdown`) |
| CI | `.github/workflows/verify.yml` en cada push y PR |

⚠️ La base del último build es **1.367**; si vuelve a divergir, **la medición
manda sobre la tabla**. `pnpm verify` corre, en orden: `verify:contracts`,
`lint`, `typecheck`, `test`, `verify:bundle` (Metro real).

## Entregado y en el dispositivo

- 2026-08-26: notificaciones por tipo, "Comida" bajo un timestamp, el episodio
  con su ventana, catálogo de insulinas, Patrones e iconos de Lucide.
- 2026-08-31 (`a706510`): Modal Maestro, calendario, carrito, fibra y el
  arreglo de las transacciones SQLite.
- 2026-09-01 (`6f1c2cd`, build `9bdc3d95`): porción confirmada, nota del botón
  rápido, calorías, fotos desde el editor y recetas.
- 2026-09-02 (`4a660b8`, build `03fb5c6d`): campos de IA, cobertura de días,
  macros por porción, meta de fibra, hora local y el grupo de la comida rápida.
- 2026-09-02 (`e85c760`, build `e93ce4a2`): recetas de verdad — "solo receta",
  detalle, fusión a mano, reuso en el carrito. Huella verificada en el APK.

**Backend**: `9f5251e` desplegado (v3 y `knownFoodNames` ✓). El 502 de las fotos
**no era el proxy**: `route-llm` manda las grandes a Gemini, que rechaza
`exclusiveMinimum`. Arreglado en el saneado; espera un redeploy más.

## Deuda conocida

### 🔴 Bomba: imports `.js` en `@type1a/ai`

`packages/ai/src/abacus.ts:23` y `packages/ai/src/index.ts:1-2` usan extensión
`.js` en imports relativos — **la trampa de Metro que rompió dos builds**. No
explota solo porque `apps/mobile/package.json` no depende de `@type1a/ai`; el día
que dependa —el chat de IA— el bundle rompe. Cuesta tres líneas.

### 🔴 Dos hallazgos vivos de la revisión repuntada (2026-08-26)

Del `domain-safety-reviewer` contra `d868ece` y `c4ca192`. Cerrados los que
corrompían datos y los del guardado de comida; siguen abiertos los dos de
`macro-glucose.ts`:

1. **La basal es invisible al modelo** (`macro-glucose.ts:281-287`, sin rama
   para `basal_insulin`): 20 U de Tresiba no entran como covariable.
2. **Cantidad ausente = "no pasó nada"** (`event.amount ?? 0` con `> 0`): una
   comida real sin carbos confirmados desaparece del conteo.

Cerrados el 2026-09-01: la insulina que se pisaba con "Comida guardada", y la
dosis del botón rápido sin `entryGroupId`. Menores: `MealModal` no recibe
glucosa (`isHypoglycemic` nunca dispara); `attachEntryToReading` no valida macros.

### 🟠 Hallazgos de la revisión de seguridad del 2026-08-27, no corregidos

El `domain-safety-reviewer` contra `f9c12d5..f2e9e93`: **cero críticos**, 5
altos, 3 medios, 3 bajos. Los altos y cuatro de los seis restantes se cerraron
en el mismo commit; quedan tres, declarados a propósito:

1. **Dos comidas SIN grupo a la misma hora exacta comparten espejo.** Sin
   grupo siguen emparejando por `timestamp + source`, y `combineDayAndTime`
   deja segundos en cero, así que dos comidas movidas a "13:00" colisionan.
   Cerrarlo pide una clave `meal_id` en `carb_events`: migración con backfill.
2. **La foto de un alimento suelto es del plato.** Con receta ya no; sin ella,
   la etiqueta lo dice y recortar exige coordenadas que la IA no da.
3. **Editar un `carb_events` importado conserva `source: 'imported'`.**
   Decisión de producto: relabelar pierde el origen, dejarlo miente. Va a Verónica.

### 🟡 Menores

- **Ni la UI ni `db.ts` tienen test de ejecución**: React no se monta y `db.ts`
  importa nativos de Expo. El cableado se comprobó leyendo el diff.
- Una escritura **suelta** (`runAsync` fuera de transacción) puede caer dentro
  de la de otro y volver atrás con ella. Daño bajo: ajustes, no historial.
- `README.md` sigue en pie (63 líneas). Se **reescribe a ~30**, no se elimina.
- Un alimento `listed = 0` fuera de toda receta queda invisible (`deleteRecipe`
  solo limpia los de su receta). No suma en ningún total.

## Historial de fallos que definieron las reglas

Cada uno costó un build, una corrida o un número falso; detalle en `git log`.

| Fallo | Regla que produjo |
|---|---|
| `.js` en imports relativos rompió 2 builds con verify en verde | `verify:bundle` obligatorio |
| Barrel de Lucide: 1.263 → 3.088 módulos | subpath obligatorio, canario de bundle |
| Filas sueltas emparejadas por timestamp | `entry_group_id` (Regla 3b) |
| `macrosSource` en 4 capas → 3 bugs | Regla 1 |
| Prompt con dosis habilitó afirmar IOB sin disparar el filtro | Regla 2 hermana |
| Promedio "ajustado" publicaba +57 donde la verdad era +10, con 372 tests en verde | test contra verdad sembrada |
| Exclusión binaria vació la pantalla de Patrones | truncar y ajustar, nunca obviar |
| `.positive()` en un esquema rompió un caso legítimo una corrida después | Regla 3, hermana |
| `eas-cli` desde la raíz dejó `app.json`/`eas.json` basura (2 veces) | correr desde `apps/mobile/` |
| Una purga de docs dejó ciegos a 5 de 7 activos de `.claude/` sin un solo error | `verify:contracts` |
| Un documento de arquitectura abandonado en el código indujo a error a varias corridas | ADR en la misma corrida que el cambio (0004) |
| El inventario de esa purga solo miraba `.claude/`: el código citaba 17 docs más | el guard escanea **todo** el repo, código incluido |
| `macrosSource` se caía en un spread sobre un tipo que no lo declaraba, con verify en verde | el chequeo de propiedades en exceso **no aplica a un spread**: el campo se declara o se pierde |
| Dos booleanos `hasMeal` divergentes borraron y descartaron comidas | una sola lista (`mealFields.ts`), pura y con test |
| Precargar los macros de la IA volvió `'mixed'` toda comida analizada: "el campo tiene valor" dejó de significar "ella lo escribió" | la procedencia se compara contra el valor precargado, no contra la ausencia |
| El mismo bloque de macros escrito seis veces; los campos del editor quedaron en ~32 pt de área tocable | `MacroFields` compartido, con `minHeight: 44` explícito |
| Un `WHERE entry_group_id IS NOT NULL` escondió las cetonas del acceso rápido: se guardaban bien y no se veían | el filtro de una consulta es una decisión de producto, no un detalle de SQL |
| Quitar ese `WHERE` a secas puso a competir agrupadas y sueltas por el mismo `LIMIT`, y una fila caída de la ventana se borraba al editar la entrada | una ventana de visualización **nunca** puede destruir un dato guardado; el borrado exige señal explícita, no una ausencia |
| Un `accessibilityLabel` explícito reemplaza el texto de los hijos: TalkBack anunciaba el título y no el valor ni la banda | la etiqueta lleva detalle y hora, o el color queda como único diferenciador |
| `XLSX.write(…, { type: 'array' })` devuelve un **`ArrayBuffer`**, y un `as Uint8Array` lo disfrazó: el Excel nunca se escribía | un `as` sobre el retorno de una librería es una afirmación sin verificar; el test comprueba el envase, no solo el contenido |
| Los tests del Excel pasaban el resultado a `XLSX.read`, que acepta ambos tipos | un round-trip por la misma librería no valida el contrato con quien consume el dato |
| Un modal por combinación (basal, cetonas, entrada) trajo tres copias del mismo formulario | la variante es **qué sección arranca abierta**, no qué componente se monta |
| `kind === 'meal'` dejaba a una comida empaquetada fuera de su propio editor con IA | las herramientas aparecen por **contenido**, no por tipo del ítem |
| El catálogo vivía dentro de `MealModal`, así que "Nueva entrada" no podía reusar un alimento guardado | una facultad que solo tiene un camino es una asimetría, no una simplificación: se extrae y la montan los dos |
| Una comida sin grupo se veía dos veces: su tarjeta y la de su fila espejo de carbohidratos | el filtro de duplicados se empareja con el hecho, no con el `entry_group_id`; y un espejo huérfano se muestra, porque es la única copia que queda |
| Un formulario de edición por tipo codificaba "una insulina solo edita unidades" | hay **un** payload de edición; lo que decide el tipo es dónde aterriza (`masterTargetOf`), no qué se puede guardar |
| `updateInsulinEvent` asignaba `insulinName` incondicionalmente y cada guardado del grupo lo borraba | el nombre es configuración, y quién lo resuelve es una función de dominio con test, no el llamador de turno |
| Editar un carbohidrato suelto lo convertía en comida —con episodio y tres alarmas— solo por guardarlo | los gramos son comida al **crear**; al **editar**, se vuelve comida cuando se agrega algo que solo una comida tiene |
| Promover un evento a grupo lo dibujaba como "Entrada registrada" aunque siguiera siendo una sola cosa | un grupo de una pieza se emite con su tipo nativo: agrupar es una decisión de datos, "entrada" es una de presentación |
| Mover la hora de una comida sumaba tres alarmas nuevas a las tres viejas | cancelar va **antes** de programar, siempre; al revés la cancelación se lleva lo recién creado |
| La advertencia de la calculadora histórica cubría solo el modo edición; registrar en el pasado llegaba a la misma superficie sin ella | una guarda que protege dos caminos se escribe una vez, pura y con test |
| "Se transcribieron 62 g" mientras el campo de confirmados seguía en 20, y la fórmula leía los 20 | una pantalla que afirma un valor distinto del que usa la fórmula es peor que una que no afirma nada |
| Los macros del carrito se guardaban `'user'`: la procedencia se comparaba solo contra `analysis` | la resuelve quien sabe qué precargó la estimación —foto, texto **o catálogo**—, no el orquestador |
| Borrar los gramos de un carbo suelto y darle descripción los resucitaba y terminaba contándolos dos veces | al crear la comida, la fila suelta se **consume** siempre: se adopta como espejo o se borra |
| `estimatedCarbsG` viajó en un spread hacia una interfaz que no lo declaraba | segunda vez que muerde: el campo se declara o se pierde |
| La tarea de fondo recibía **la misma conexión nativa** que la pantalla (Android cachea por ruta+opciones) y le corría `initializeDatabase` y un `BEGIN` encima cada ~15 min | una conexión por dueño: la tarea de fondo abre con `useNewConnection` y la concurrencia real la absorben WAL y `busy_timeout` |
| `withTransactionAsync` de Expo tiene el `BEGIN` dentro del `try`: el `ROLLBACK` de la que fallaba cerraba la transacción de la otra, que seguía escribiendo suelta y terminaba en "no se pudo guardar" con filas ya aplicadas | **una sola** cola FIFO por conexión (`dbWriteQueue.ts`); dos colas contra una conexión anidan igual |
| Un alimento sin `estimatedGrams` —lo que el prompt pide devolver cuando no puede estimar la porción— se descartaba del catálogo **sin un solo aviso**, y la pantalla decía "guardado" | lo que no se puede guardar se muestra **con su razón**; un filtro silencioso es un dato perdido que nadie va a buscar |
| El catálogo caía siempre a 100 g porque la IA no podía proponer porción, y el `INSERT` del alta ni siquiera escribía las columnas de porción | la porción la propone la IA y la **confirma** la usuaria: multiplica los cuatro macros, así que un número que nadie miró no entra por esa puerta |
| El cuadro de texto del botón rápido alimentaba a la IA y se tiraba, así que la comida quedaba sin nota mientras el maestro sí la guardaba | una capacidad que solo tiene un camino es una asimetría: el texto que describe la comida se escribe venga de donde venga |
| Una foto de arroz con pollo dejaba dos alimentos sueltos y **los dos con la foto del plato entero** | el contenedor que faltaba es la receta: guarda la foto del plato y cada componente queda libre de tener la suya |
| La cobertura de días solo se mostraba bajo el umbral clínico de 14, así que a 30 y 90 días desaparecía y el promedio se leía como si cubriera el rango entero | "cuánto está cubierto" y "alcanza para la métrica" son dos afirmaciones distintas: la primera va siempre |
| El catálogo se guarda por 100 g y la tarjeta lo mostraba así: una cucharada de aceite aparecía con 100 g de grasa | cómo se **guarda** un número no es cómo se **lee** |
| El resumen post-comida citaba "empezó a las 21:30" para una comida de las 17:30: la app guarda UTC, el timeline formatea local y las métricas viajaban a la IA en UTC crudo | lo que sale a un tercero lleva su zona escrita; y el desfase se pide **por marca**, porque el horario de verano existe |
| Una meta de fibra copiada del molde de las otras habría dicho "te pasaste" | una referencia es un piso o un techo, y el texto tiene que saber cuál |
| Mandar la hora **local** al modelo no agregó un campo, pero sí volvió citable un dato sobre su vida: con UTC no podía juzgar a qué hora cenaba, con hora de pared sí | el filtro crece cuando crece lo que el modelo **puede decir**, no solo cuando crece el payload |
| El aviso de éxito corría siempre y pisaba al de "no se pudo registrar la insulina": se cerraba la app creyendo que la dosis había quedado | un `catch` que solo escribe un mensaje no arregla nada si el camino feliz lo reemplaza después; el fallo se lleva a la decisión final, no a un `setState` intermedio |
| El botón rápido guardaba la comida y su dosis **sin `entryGroupId`**, y el timeline agrupa solo por esa columna | una facultad que el maestro tiene y el acceso rápido no es una asimetría, no una simplificación — tercera vez que muerde |
| "Solo receta" y "las dos cosas" escribían exactamente lo mismo: la elección existía en la pantalla y en ningún dato | una opción que no cambia ninguna fila es una mentira con botón; si se ofrece, hay una columna que la recuerda |
| La confirmación decía "se fusiona con ese" y guardaba con su propia clave | el texto de una pantalla se verifica contra lo que **escribe** |
| `rapidInsulinName` solo se leía: ninguna pantalla lo escribía, así que decía "sin configurar" con la insulina ya elegida y las dosis quedaban sin marca | un campo que nadie escribe es un campo muerto; el que se muestra se deriva del que sí se guarda |
| `purpose` decía para qué fue una dosis y nadie guardaba de cuánto se compuso | etiquetar no es desglosar |
| El "502 sobre 8 KB" no era el proxy: `route-llm` reparte por tamaño y las fotos grandes iban a Gemini, cuyo validador rechaza `exclusiveMinimum`. Un `z.number().positive()` nuevo rompió TODAS las fotos mientras el texto seguía bien | un umbral de tamaño puede ser un cambio de modelo disfrazado; se prueba el mismo payload contra cada modelo antes de culpar a la capa de red |
| La lista de palabras que el saneado filtra tenía **cuatro de las cinco** que importaban, y nada lo delataba | se enumera lo que **sobrevive** contra una lista blanca, no lo que se filtra: así una palabra nueva falla en el test y no en el teléfono |
| Seis pantallas prometían "Type 1A no calcula insulina activa" el día que empezó a calcularla; una en la pantalla que descuenta, otra impresa en el reporte clínico | una promesa vieja no rompe nada, solo miente: la copia de seguridad se afirma en un test (`safetyCopy.test.ts`) igual que el saneado |
| La consulta de dosis recientes traía 6 h fijas; la regular humana dura 8, así que el activo salía **de menos** — y el activo de menos sube la dosis propuesta | una ventana que alimenta un cálculo se deriva del modelo, nunca de una constante escrita al lado |

## Redeploy del backend
`30a87fa` está desplegado. **Falta desplegar `fd3ad1a`**: sin él las fotos
siguen dando 502 (`exclusiveMinimum`). También lleva `knownFoodNames`. Prompt
en `docs/DEEPAGENT_REDEPLOY_PROMPT.md`.
