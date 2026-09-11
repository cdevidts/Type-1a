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
- 2026-09-10/11 (builds de esta corrida): el chat abre desde la barra, el dictado
  por voz (`docs/adr/0009`; el parche de la dependencia le corta el log, y el
  intento con ProGuard **no borró nada del APK** — una regla no se verifica desde
  acá, un parche sí), y el backend de cuentas ya está versionado en git.
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

El chat se abre desde la posición 4 de la barra y desde el swipe, y dicta por voz
(`docs/adr/0009`). Trampa que costó un build: **un permiso que está en
`permissions` y a la vez en `blockedPermissions` desaparece del build sin ningún
error visible.**

**Verificado en vivo, no leído de un informe** (2026-09-10): los tres caminos de
`/v1/ai/chat` responden —rechazo en 0,7 s sin gastar modelo, respuesta con citas,
y **borrador de comida**, que DeepAgent no probó—. `/v1/auth/*` vivas,
`/v1/catalog/mine` 401, **ninguna ruta de datos de salud** (404).

⚠️ **El backend NO está redesplegado**: no manda `opens` ni tiene el prompt v2.
La app funciona igual por las capas 1 y 3; falta la 2 (que el modelo decida).

### 🔴→✅ El micrófono salió sin permiso, y el build no dijo nada (2026-09-11)
Ella instaló y reportó que en los ajustes del teléfono **no existe la opción de
micrófono**. Cierto: `RECORD_AUDIO` **no estaba en el manifiesto del APK**, pese a
`app.json` y pese al plugin de dictado. Causa: `expo-image-picker` con
`microphonePermission: false` llama a `withBlockedPermissions(['RECORD_AUDIO'])`
—*"to ensure no package can add them"*— y el bloqueo gana sobre todo. Se quitó;
el picker no la necesita (`mediaTypes: ['images']` en cada `launchCameraAsync`).
**Verificado en el manifiesto generado por `prebuild` ANTES de construir**, que
es lo que faltó. `microphonePermissionSurvives()` lo detiene.

### 🔴→✅ Un campo nuevo requerido rompió la app contra el servidor viejo (2026-09-11)
`opens` entró **requerido** en `AgentTurnSchema` y el servidor desplegado no lo
manda, así que el teléfono rechazaba **todas** las respuestas y le mostraba el
volcado de Zod donde esperaba una frase. **Regla: un campo nuevo que el cliente
LEE entra siempre con `.default()`.** Una app instalada siempre habla con un
servidor que puede ser más viejo que ella.

Dos más de la misma captura: el error mostraba `caught.message` crudo (un error
técnico no es una respuesta) y un `say` vacío no se veía. Y si el fallo es de red
**y** pedía una dosis, igual aparece el botón: la calculadora no usa internet.

### 🔴→✅ El ruteo por frases no cubría cómo habla (2026-09-11)
"Quiero hacerme una corregida" no lo tocaba ninguna frase listada. Ella lo dijo
completo: *"no puede ser que palabras clave determinen la respuesta, es el
contenido lo que importa"*, y describió la arquitectura: **su texto → el agente
determina qué palabras del ruteo corresponden → ruteo → respuesta, con la IA de
fallback para que nunca falte una respuesta coherente.**

Tres capas: (1) el teléfono normaliza —sin tildes, minúsculas— y reconoce
**raíces** (`correg|correcc|corrij` cubre corregirme/corregida/corrección),
instantáneo y sin red; (2) el modelo decide con `opens`; (3) todo rechazo lleva
botón. El test usa **las frases reales de sus capturas** + una invariante: todo
lo que abre una calculadora tiene que ser algo que el guardia rechazaría — cazó
una divergencia ("me pincho?").

### 🔴→✅ El guardia tampoco veía esas frases (2026-09-11)
Mismo origen, y no era comodidad: la pregunta **llegaba al modelo** (3,2 s contra
los 0,7 s del guardia), que existe para no depender de que el modelo se porte
bien. Ahora también va por raíz.

### ✅ Y antes: la IA no estaba tonta, estaba sin cablear (2026-09-11)
1. **La foto se descartaba** (`void imageBase64`) y el botón de cámara no hacía
   nada. Ahora va a `/v1/ai/meal-analysis` y vuelve como borrador.
2. **No había memoria**: no se mandaba `history`. Verificado en vivo: una
   pregunta de seguimiento se entiende, y **dice que no tiene el dato en vez de
   inventarlo**.
3. **Pedir una dosis era un callejón.** Ahora abre la calculadora; el modelo
   sigue sin dar números.

Al cablear (3) **introduje un riesgo clínico y lo cazó la revisión**: un `return`
temprano se comía el resto del mensaje, así que "me puse 4 de rápida, ¿cuánto me
pincho?" navegaba **tirando las 4 U** y la calculadora afirmaba "no hay eventos
registrados" sobre una dosis activa → propondría **más** corrección. Hoy el
borrador se muestra **antes**, y con algo que guardar o con foto **no se navega**:
aparece un botón. Los otros cinco hallazgos: el encuadre se pintaba en una
pantalla que se cerraba en el mismo render (viaja como aviso); decía "tu glucosa
del sensor" con `latestLiveReading`, que incluye manuales y sintéticas; sin
parámetros mandaba a tres campos en blanco (ahora a Ajustes); el texto sin
precarga negaba la lectura aunque ella la hubiera borrado; y se saltaba
`openQuickRoute`. El error de red además **mentía** ("lo que escribiste sigue
acá" con el cuadro vacío).

