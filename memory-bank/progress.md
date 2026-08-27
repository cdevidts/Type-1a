# Progress

_Última actualización: 2026-08-27._

## Estado de validación

| | |
|---|---|
| `pnpm verify` | Etapas verdes; el wrapper local de Windows conserva su fallo de rutas preexistente. CI Linux es la verificación integral |
| Tests | **612** — domain 334, mobile 230, ai 15, schemas 13, cgm 10, api 10 |
| Bundle de Metro | **1.351 módulos** (solo +1: `entryGroupClaim.ts`) |
| CI | `.github/workflows/verify.yml` en cada push y PR |

⚠️ La cifra que decía este archivo (**1.333**) estaba desactualizada: medida
antes de tocar nada, la rama base exportaba **1.341**. Los 9 que suma esta
corrida son iconos de Lucide por subpath y los módulos nuevos, ningún barrel.
Si vuelve a divergir, la medición manda sobre la tabla.

`pnpm verify` corre, en orden: `verify:contracts`, `lint`, `typecheck`, `test`,
`verify:bundle` (export real de Metro).

## Entregado y en el dispositivo

Build `preview` (`.apk`) del 2026-08-26 instalado: notificaciones por tipo con
canal propio (Fase 19), "Comida" bajo un mismo timestamp con sus tres decisiones
(Fase 21), el episodio capturando su ventana (Fase 23), catálogo de insulinas
con duración, Patrones ajustando por covariables, cetonas en las tres
superficies e iconos de Lucide. El detalle vive en los cuerpos de commit.

Lo del 2026-08-27 (Modal Maestro único, edición retroactiva, calendario,
carrito y fibra) **todavía no tiene build**.

## Cierre de auditoría posterior al PR (2026-08-27)

- Promoción y edición comparten una transacción SQLite serializada sobre la
  conexión SQLCipher ya autenticada; el fallo de
  la edición revierte también el `entry_group_id` y el espejo.
- La reclamación relee el grupo realmente escrito antes de usarlo. Doble toque
  y carrera tienen regresiones puras en `entryGroupClaim.test.ts`.
- Una rápida reclasificada como basal ya no conserva propósito de comida o
  corrección; una basal reclasificada a rápida recibe la etiqueta descriptiva
  que corresponde a la entrada.
- `report.ts` omite la fila `meal_confirmed` cuando ya muestra su comida y
  conserva un espejo huérfano. Nutrición y reporte aplican ahora la misma regla.
- Revisión independiente final: **0 críticos, 0 altos, 0 medios y 0 bajos**;
  lint, typecheck y los 612 tests confirmados también por el revisor.
- La promoción por sí sola solo escribe `entry_group_id`: conserva id, hora,
  `created_at`, source y payload. La conversión explícita de un carbohidrato a
  comida sigue convirtiendo esa misma fila en su espejo `meal_confirmed`; no es
  una inferencia de la promoción ni una recreación del evento.

## Deuda conocida

### 🔴 Bomba: imports `.js` en `@type1a/ai`

`packages/ai/src/abacus.ts:23` y `packages/ai/src/index.ts:1-2` usan extensión
`.js` en imports relativos — **la trampa de Metro que rompió dos builds**. Hoy
no explota solo porque `apps/mobile/package.json` no depende de `@type1a/ai`;
`domain`, `cgm` y `schemas`, que sí se bundlean, están limpios. El día que la
app dependa de ese paquete —el chat de IA es el candidato— el bundle rompe.
`verify:bundle` lo atraparía, pero la causa sigue ahí y cuesta tres líneas.

### 🔴 Cuatro hallazgos vivos de la revisión repuntada (2026-08-26)

Del `domain-safety-reviewer` contra `d868ece` y `c4ca192`. Los dos que
corrompían datos ya están cerrados; estos siguen abiertos:

1. **La basal es invisible al modelo y al aviso de ventana sucia**
   (`macro-glucose.ts:281-287`, sin rama para `basal_insulin`): 20 U de Tresiba
   no entran como covariable ni marcan `confoundedCount`, y la pantalla imprime
   "sin eventos".
2. **Cantidad ausente = "no pasó nada"** (`event.amount ?? 0` con `> 0`): una
   comida real sin carbos confirmados desaparece del conteo.
3. **Un fallo al registrar la insulina se pisa con "Comida guardada"**
   (`App.tsx:620` y `:636`): cierra la app creyendo que la dosis quedó.
4. **La insulina de la comida se escribe sin `entryGroupId`** (`App.tsx:608`):
   el timeline agrupa solo por esa columna, así que después vuelve a preguntar
   qué dosis fue con qué comida — lo que la Fase 21 dijo que eliminaba.

Menores del mismo lote: `MealModal` no recibe glucosa (su `isHypoglycemic`
nunca dispara); las unidades se descartan sin avisar al apagar "Registrarla como
comida de ahora"; la validación previa de `attachEntryToReading` no creció con
cetonas ni macros.

### 🟠 Hallazgos de la revisión de seguridad del 2026-08-27, no corregidos

El `domain-safety-reviewer` corrió contra `f9c12d5..f2e9e93`: **cero
críticos**, 5 altos, 3 medios, 3 bajos. Los cinco altos y cuatro de los seis
restantes se corrigieron en el mismo commit. Quedan tres, todos declarados a
propósito:

1. **Dos comidas SIN grupo a la misma hora exacta comparten espejo.**
   `syncConfirmedCarbRow`, `writeMirrorCarbRow` y `deleteMealEventRows` ahora
   acotan por `entry_group_id` cuando la comida lo tiene —todo lo editado—; sin
   grupo siguen emparejando por `timestamp + source`. El riesgo creció porque
   `combineDayAndTime` deja segundos y milisegundos en cero, así que dos comidas
   movidas a "13:00" colisionan. Cerrarlo pide una clave `meal_id` en
   `carb_events`: migración con backfill, en su propia corrida.
2. **La foto del catálogo es del plato, no del alimento.** Todos los alimentos
   de un análisis heredan la misma imagen, así que la foto de un sándwich queda
   como miniatura de "Pan", "Queso" y "Jamón". Se corrigió lo que **afirma** la
   interfaz (etiqueta accesible y editor dicen "la comida donde se identificó,
   puede incluir otros"), pero la imagen sigue siendo la misma: recortar por
   alimento exige coordenadas que la IA hoy no devuelve.
3. **Editar los gramos de un `carb_events` importado conserva
   `source: 'imported'`.** Lo sigue rotulando importado aunque el número ya no
   sea el del CSV. Es **anterior** a este cambio (`updateCarbEvent` hacía lo
   mismo) y arreglarlo es decisión de producto: relabelar a `'manual'` pierde el
   origen, dejarlo miente sobre el valor. Va a Verónica.

### 🟡 Menores

- **Ni la UI ni `db.ts` tienen test de ejecución**: el repo no monta React y
  `db.ts` importa nativos de Expo. Cada decisión se extrajo a un módulo puro con
  test (`masterModal.ts`, `entryTime.ts`, `mealCarbMirror.ts`, `mealFields.ts`,
  `meal-cart.ts`) — la salida que pide `AGENTS.md` —, pero el cableado hasta la
  pantalla y el comportamiento transaccional se comprobaron leyendo el diff.
- `README.md` sigue en pie (63 líneas). La purga que lo iba a borrar se abortó;
  la decisión tomada es **reescribirlo a ~30 líneas** como puerta de entrada del
  repo en GitHub, no eliminarlo. Pendiente para la Fase 4.

## Historial de fallos que definieron las reglas

Cada uno costó un build, una corrida o un número falso en un reporte médico. El
detalle vive en `git log --format=full`, la bitácora real.

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

## Redeploy del backend

`apps/api` no se tocó desde el último despliegue salvo `prompts.ts` (insight a
`glucose-insight.v5`). El desplegado sigue con el prompt anterior: bajo riesgo y
no urgente. Cada redeploy consume créditos de Abacus, así que se agrupa.
