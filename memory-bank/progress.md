# Progress

_Última actualización: 2026-09-10 (Fase 0 del agente)._

## Estado de validación

| | |
|---|---|
| `pnpm verify` | Verde. El wrapper de Windows conserva su fallo de rutas; CI Linux es la verificación integral |
| Tests | **1.055** — domain 700, mobile 274, ai 34, schemas 21, cgm 10, api 16 |
| Bundle de Metro | **1.388** (el dictado sumó 9); CI en cada push y PR |

⚠️ `verify:contracts` exige además: toda función de `db.ts` clasificada para el agente, el parche del dictado declarado, y el permiso de micrófono sin bloquear.

## Entregado y en el dispositivo

- 2026-08-26 → 08-31 (`a706510`): notificaciones por tipo, episodio con ventana,
  catálogo de insulinas, Patrones, Lucide, Modal Maestro, calendario, carrito,
  fibra y las transacciones SQLite.
- 2026-09-01/02 (`6f1c2cd`→`e85c760`, builds `9bdc3d95`, `03fb5c6d`, `e93ce4a2`):
  porción confirmada, calorías, fotos desde el editor, recetas de verdad, campos
  de IA, cobertura de días, macros por porción, meta de fibra y hora local.
- 2026-09-04 (build `7122edf9`): el tope del IOB, la curva de efecto por tramo,
  el agua entera en Nutrición y las 5 correcciones de la auditoría. Huella
  verificada (`3D:42:7A:…:62:33`).
- 2026-09-09 (sin build todavía): el respaldo `.t1a.json` cableado entero —
  exportar e importar desde Ajustes, con `entry_group_id`, fotos y procedencia—
  y las fotos fuera de la caché, con migración de las que ya estaban.

## Deuda conocida

### 🔴 D1–D4: la curva de efecto mide mal, y D2 alcanza al IOB (2026-09-09)
Cuatro defectos verificados leyendo el código, con detalle en
`reference/insulin-duration-method.md`. ⚠️ **D2 sesga el número que "adoptar" mete
al IOB: no adoptar ninguna duración hasta cerrarlo.**

### 🟡 Supabase sin uso previsto (2026-09-04)
`kvhlttcvjamgybwlamcu`, sin tablas. ADR 0007 descartó sincronizar salud; queda
para cuentas de suscripción. Pausarlo si no se usa.

### 🔴 Dos hallazgos vivos de la revisión repuntada (2026-08-26)
Los dos en `macro-glucose.ts`: la basal no entra como covariable (sin rama para
`basal_insulin`), y `event.amount ?? 0` con `> 0` borra del conteo a una comida
sin carbos confirmados. Menor: `MealModal` no recibe glucosa.

### 🟠 Hallazgos de la revisión de seguridad del 2026-08-27, no corregidos

Contra `f9c12d5..f2e9e93`: **cero críticos**, 5 altos, 3 medios, 3 bajos. Los
altos y cuatro de los seis restantes se cerraron en el mismo commit; quedan tres,
declarados a propósito:

1. **Dos comidas SIN grupo a la misma hora exacta comparten espejo**: emparejan
   por `timestamp + source`. Cerrarlo pide `meal_id` en `carb_events`.
2. **La foto de un alimento suelto es del plato.** Con receta ya no; sin ella la
   etiqueta lo dice, y recortar exige coordenadas que la IA no da.
3. **Editar un `carb_events` importado conserva `source: 'imported'`.** Decisión
   de producto: relabelar pierde el origen, dejarlo miente. Va a Verónica.

### 🟡 Menores
- 🔴 **Ni la UI ni `db.ts` tienen test de ejecución**, y el 2026-09-11 eso dejó
  pasar un riesgo clínico: el `return` temprano del chat tiraba una dosis recién
  declarada y la calculadora la daba por inexistente. Lo cazó una revisión leyendo
  el diff, no la suite. Todo lo puro tiene test; **el cableado no tiene ninguno**.
- El dictado y el swipe al chat **no se probaron en un teléfono**.
- Una escritura **suelta** (`runAsync` fuera de transacción) puede caer dentro
  de la de otro y volver atrás con ella. Daño bajo: ajustes, no historial.
- `README.md` sigue en pie (63 líneas). Se **reescribe a ~30**, no se elimina.
- Un alimento `listed = 0` fuera de toda receta queda invisible. No suma nada.

## Backend (2026-09-10)

El chat se abre desde la posición 4 de la barra y desde el swipe, y dicta por
voz (`docs/adr/0009`). ⚠️ **Nada de eso llega al teléfono hasta un build nuevo**:
el dictado es un módulo nativo.

Trampa que casi cuesta un build: **un permiso que está en `permissions` y a la
vez en `blockedPermissions` se elimina del build, y la función falla sin ningún
error visible.** `RECORD_AUDIO` estaba bloqueado desde la Fase 13 por higiene de
la ficha de Play Store.

Bundle 1.379 → **1.388** módulos (el módulo nativo + dos iconos, sin barrel).
`pnpm verify` en verde.

**Verificado en vivo, no leído de un informe** (2026-09-10): los tres caminos de
`/v1/ai/chat` responden —rechazo de insulina en 0,7 s sin gastar modelo, respuesta
con citas, y **borrador de comida**, que DeepAgent no probó—; tres formas
indirectas de pedir insulina rechazadas, dos por el modelo mismo. `/v1/auth/*`
vivas, `/v1/catalog/mine` 401, **ninguna ruta de datos de salud** (404).

### 🔴→✅ El micrófono salió sin permiso, y el build no dijo nada (2026-09-11)
Ella instaló y reportó que en los ajustes del teléfono **no existe la opción de
micrófono**. Cierto: `RECORD_AUDIO` **no estaba en el manifiesto del APK**, pese a
`app.json` y pese al plugin de dictado. Causa: `expo-image-picker` con
`microphonePermission: false` llama a `withBlockedPermissions(['RECORD_AUDIO'])`
—*"to ensure no package can add them"*— y el bloqueo gana sobre todo. Se quitó;
el picker no la necesita (`mediaTypes: ['images']` en cada `launchCameraAsync`).
**Verificado en el manifiesto generado por `prebuild` ANTES de construir**, que
es lo que faltó. `microphonePermissionSurvives()` lo detiene.

### ✅ El chat dejaba de ser tonto por tres cosas concretas (2026-09-11)
Ella: *"la IA está bastante tonta"*. Las tres causas, todas cableado ausente:
1. **La foto se descartaba**: `askAgentTurn` tenía `void imageBase64`. El botón
   de cámara del chat no hacía nada. Ahora va a `/v1/ai/meal-analysis`, el mismo
   endpoint probado que usa el resto de la app, y vuelve como borrador.
2. **No había memoria de conversación**: no se mandaba `history` aunque el
   contrato lo acepta. Verificado en vivo: "¿y cuántas fueron las bajas?" ahora
   se entiende como seguimiento, y **dice que no tiene el dato en vez de
   inventarlo**.
3. **Pedir una dosis era un callejón.** Se negaba con palabras y ya. Ahora abre
   la calculadora (`agent-routing.ts`): corrección por defecto, comida si la
   frase habla de comer. La prohibición no se tocó — el modelo sigue sin dar
   números; lo que cambió es que después de negarse **hace algo**.
   `insulinQuestionOpensCalculator` reusa `requestsInsulinAdvice` a propósito:
   un detector paralelo habría divergido del guardia del servidor.

Además, el error de red **mentía**: decía "lo que escribiste sigue acá" con el
cuadro ya vaciado por `setInput('')`. Ahora devuelve el texto de verdad.

**Al cablear eso introduje un riesgo clínico real, y lo cazó la revisión.** Un
`return` temprano se comía el resto del mensaje: "me puse 4 de rápida, ¿cuánto me
pincho?" navegaba **tirando las 4 U**, y la calculadora afirmaba "no hay eventos
registrados" sobre una dosis activa → propondría **más** corrección de la que
corresponde. Hoy se parsea y se muestra el borrador **antes**, y con algo que
guardar o con foto **no se navega**: aparece un botón y decide ella. Los otros
cinco: el encuadre se pintaba en una pantalla que se cerraba en el mismo render
(viaja como aviso); decía "tu glucosa del sensor" cuando `latestLiveReading`
incluye manuales y sintéticas; sin parámetros mandaba a tres campos en blanco
(ahora a Ajustes); el texto sin precarga negaba la lectura aunque ella la hubiera
borrado; y se saltaba `openQuickRoute`. **Además el gatillo se estrechó**:
`requestsInsulinAdvice` acepta falsos positivos porque "el costo es un mensaje",
y navegar cuesta más — ancho para negarse, estrecho para navegar.

### ✅ Cerrado: el dictado ya no escribe en el log de Android (2026-09-10)
Detalle entero en `docs/adr/0009`. Resumen: `expo-speech-recognition` llamaba
`Log.d` con la transcripción y con los nombres de sus insulinas; Android lo
clasifica como vulnerabilidad y Play Store exige tratar la salud como sensible.
**Primer intento fallido y la lección:** se encendió la minificación con la regla
que Android recomienda, se construyó el APK y **no borró nada**. Una regla de
ProGuard no se puede verificar desde acá; un parche de la dependencia sí — y
además no cambia cómo se arma la app. `speechLogPatchIsDeclared()` lo vigila.

### ✅ Cerrado: el backend ya está en git (2026-09-10)
DeepAgent empujó su merge tras pedírselo; `apps/api/src/` ya trae cuentas,
catálogo personal y fotos, y `pnpm verify` pasa con eso adentro. Antes lo que
corría en producción vivía **solo** en su instancia.

Sin verificar (exigiría una cuenta real): que el 401 de login sea idéntico ante
contraseña mala y correo inexistente.
