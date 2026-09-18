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

### 🔴→✅ La auditoría de insulina activa: 12 hallazgos (2026-09-18)
Pedida por ella tras la captura del 0 U. El peor **lo introduje ese mismo día**:
un solo `minutesAgo` retrofechaba **todo** el registro, así que "me puse 6 de
rápida, comí hace 3 horas" hundía el activo de ~5,4 U a ~1 U y la corrección
siguiente proponía **~4 U apiladas** sobre una dosis actuando entera — la
inversión del bug original, y del lado grave. Cerrado por **adyacencia**: con
insulina en juego, el "hace N" solo aplica si va pegado a la dosis.

Los otros nueve, con archivo y línea, en `reference/failure-history.md`.

### 🔴→✅ La app preguntaba lo que ya sabía (2026-09-18)
*"Siempre me pregunta si tal insulina era de tal comida. El 99% de los casos la
guardo junto a la comida."* Cierto: "Nueva entrada" las escribe con el **mismo
`entry_group_id`** y nadie lo consultaba — el candidato se buscaba por cercanía
de timestamp (−90/+60), que es la causa raíz documentada del bug insulina↔comida
de la Fase 21. `linkInsulinSavedWithItsMeal` lo resuelve al leer los pendientes,
así que **repara también lo ya guardado**.

### 🔴→✅ La sincronización pedía 4 h fijas y perdía los huecos (2026-09-18)
*"A veces no guarda hasta que yo la abra, y ahí se pierden muchas cosas."* La
ventana era fija: dormida 9 h, lo ocurrido entre la hora 9 y la 4 **no se pedía
nunca**. `syncWindowFrom` arranca en la última lectura guardada, con piso de 4 h
y tope de 24 h.

### ⚠️ ABIERTO Y DE ELLA: ¿la insulina de comida cuenta como activa?
Ella sostiene que no: *"era solo por la comida, no había NADA que descontar."*
`docs/adr/0006` decidió que **sí**, y su objeción está ahí escrita como "la
objeción legítima": los dos errores no cuestan lo mismo — contarla de más da una
corrección menor, reevaluable en una hora; no contarla da una de más, y eso se
descubre en una hipo. **Lo que cambió**: hoy cada dosis guarda su desglose
comida/corrección, así que "sin COB, lo seguro es el IOB completo" ya no es la
única opción técnica. **No se toca sin que ella decida**; si cambia, va con ADR.

### 🔴→✅ Dos pantallas decían distinta insulina activa (2026-09-18)
La corrección decía **5,98 U** y la comida **2 U**, mismas dosis y mismo minuto.
No era el cálculo: la etiqueta "Insulina todavía activa" mostraba `applied` —lo
descontado, topado por la corrección—, así que valía dos cantidades. Hoy el
activo se muestra **entero** y el descuento va en su propia fila.

Y una dosis de hace horas se registraba como recién puesta: `new Date()` siempre,
y "hace/rato/horas" eran **palabras de relleno** del parser. Infla el activo → la
calculadora resta de más → el **0 U con 171 mg/dL** de su captura. Hoy se entiende
con número y **no se inventa** sin él, y la tarjeta muestra con qué hora guarda.
⚠️ `local-intent` **no tenía ningún test** hasta ese día. El ruteo tampoco
secuestra ya la pantalla: para abrirse solo, el mensaje tiene que ser eso y nada
más.

### ✅ Cerradas el 2026-09-11 — detalle en `reference/failure-history.md`
Micrófono sin permiso por otro plugin; campo nuevo requerido que rompió la app
contra el servidor viejo; ruteo por frases que no cubría cómo habla; y la IA que
parecía tonta y estaba sin cablear.

