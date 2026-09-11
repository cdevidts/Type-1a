# Progress

_Última actualización: 2026-09-10 (Fase 0 del agente)._

## Estado de validación

| | |
|---|---|
| `pnpm verify` | Verde (`verify:contracts`, lint, typecheck, test, `verify:bundle`). El wrapper de Windows conserva su fallo de rutas; CI Linux es la verificación integral |
| Tests | **1.025** — domain 671, mobile 273, ai 34, schemas 21, cgm 10, api 16 |
| Bundle de Metro | **1.379** hoy; el build `444a3ff3` salió con 1.373 |
| CI | `.github/workflows/verify.yml` en cada push y PR |

⚠️ `verify:contracts` ahora exige además que **toda** función exportada de `db.ts` esté clasificada para el agente.

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
- **Ni la UI ni `db.ts` tienen test de ejecución**: React no se monta y `db.ts`
  importa nativos de Expo; el cableado se lee del diff. Pesa más ahora: importar
  un respaldo escribe quince tablas, y el dictado abre un micrófono.
- `blockedPermissions` se borró entero (tenía solo `RECORD_AUDIO`): una
  dependencia futura que traiga un permiso por su cuenta ya no tiene qué la
  frene. Aceptado; la alternativa era dejar la clave con una lista vacía.
- El dictado **no se probó en un teléfono**, y un micrófono no se da por
  entregado sin oírlo. Tampoco el swipe hacia el chat.
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
micrófono**. Cierto: `RECORD_AUDIO` **no estaba en el manifiesto del APK** pese a
estar en `app.json` y pese a que el plugin de dictado también lo declara. Causa:
`expo-image-picker` con `microphonePermission: false` llama a
`withBlockedPermissions(['RECORD_AUDIO'])` — su comentario dice *"to ensure no
package can add them"* —, y el bloqueo gana sobre todo. Se quitó esa clave; el
picker no la necesita porque cada `launchCameraAsync` pasa `mediaTypes:
['images']`. **Verificado leyendo el manifiesto generado por `prebuild` ANTES de
construir**, que es lo que faltó. `microphonePermissionSurvives()` lo detiene.

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

### ✅ Cerrado: el dictado ya no escribe en el log de Android (2026-09-10)
`expo-speech-recognition` llamaba `Log.d` sin condición con la transcripción y
con las pistas —insulinas de ella y su catálogo—. Ella pidió averiguar si era
ilegal antes de aceptarlo y lo era: **Android lo clasifica como vulnerabilidad**
(MASVS-STORAGE) y Play Store exige tratar los datos de salud como sensibles. La
evaluación previa era **demasiado benigna**: Android advierte que en muchos
aparatos vienen apps de fábrica con `READ_LOGS`, así que no hace falta un cable.

**Primer intento fallido, y la lección:** se encendió la minificación con la
regla que Android recomienda, **se construyó el APK y no borró nada** — los
textos seguían adentro, con la configuración generada correcta. Una regla de
ProGuard **no se puede verificar desde acá**. Se reemplazó por un parche de la
dependencia (`patches/`, vía `pnpm.patchedDependencies`) que vacía `log()`: se
comprueba mirando el APK, y **desaparece el riesgo** de que comprimir rompa una
pantalla suelta días después. `speechLogPatchIsDeclared()` verifica que el
parche siga declarado y siga neutralizando; las dos formas de romperlo, probadas.

### ✅ Cerrado: el código del backend ya está en git (2026-09-10)
DeepAgent empujó su merge tras pedírselo. `apps/api/src/` ya tiene
`accounts-store.ts`, `personal-catalog-store.ts` y `catalog-photo-store.ts`, y
`pnpm verify` pasa con eso adentro. Lo que corre en producción vuelve a estar
versionado; antes vivía **solo** en su instancia.

Sin verificar (exigiría una cuenta real): que el 401 de login sea idéntico ante
contraseña mala y correo inexistente.
