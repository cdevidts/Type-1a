# Los dos cuadros de texto de la IA de comida

_Escrito el 2026-09-01. **Construido el mismo día**: `MealAiFields.tsx`, montado en
los tres modales de comida._

## El problema

Hoy hay **un solo cuadro de texto** en los modales de comida y hace dos trabajos
distintos:

1. darle pistas a la IA sobre lo que hay **en la foto**, y
2. estimar **sin foto**, solo con la descripción.

El rótulo anuncia el segundo, así que nadie descubre el primero. Quien va a
sacar una foto no tiene por qué adivinar que escribir ahí ayuda al análisis de
la imagen — y esa ayuda es justo lo que más mejora una estimación por foto.

Y falta un tercer trabajo, que hoy no existe en dos de los tres modales:
**corregir sobre lo que la IA acaba de proponer** sin volver a empezar. Si el
borrador dice más arroz del que había, la única salida es sacar otra foto y
correr todo de cero.

## Lo que ya existe y no hay que construir

`editMealWithInstruction` (`api.ts`), `MealEditInputSchema` y
`mealEditSystemPrompt` **ya resuelven la corrección iterativa**: reciben la
composición actual más una instrucción en palabras y devuelven la composición
completa revisada —no un diff, que es donde se cuelan los errores—. Está
probado y en uso… pero **solo en `MealEditModal`**, y solo sobre una comida ya
guardada.

Detalle que ordena el diseño: esa llamada **no manda la imagen**. Trabaja sobre
la composición que ya está en pantalla. Es exactamente lo que pide el pedido
—"que trabaje sobre lo que acaba de hacer y no me haga tomar una imagen nueva"—
y significa que no hay que re-subir la foto ni pagar otro análisis de visión.

## El diseño

Separar en **dos campos con roles distintos**, y que el segundo cambie de
función según si ya hay una propuesta en pantalla.

### Campo 1 — "Qué comiste"

Un cuadro de texto, siempre visible. Dos usos según haya foto o no:

- **Con foto**: es la pista para el análisis de la imagen. Rótulo del tipo
  "Ayuda a la IA: qué hay en la foto, cómo está preparado". Viaja como
  `description` junto a la imagen, igual que hoy.
- **Sin foto**: es la descripción completa y habilita el botón de estimar solo
  con texto, como hoy.

El rótulo y el texto de ayuda cambian según haya imagen adjunta. Ese cambio de
rótulo **es** el arreglo del primer problema: hoy el campo miente sobre lo que
hace cuando hay foto.

### Campo 2 — "Corregir la propuesta"

Aparece **solo cuando ya hay un análisis en pantalla**, encima del resultado.
Manda `editMealWithInstruction` con la composición actual y deja el resultado
en el mismo lugar. "Creo que es menos arroz del que pensaste" y listo: sin foto
nueva, sin volver a empezar.

Es el mismo campo `instruction` que ya usa `MealEditModal`; lo que falta es
levantarlo a un componente compartido y montarlo en los otros dos.

## Tiene que llegar a los tres modales

Es requisito explícito del pedido, y además es la regla del repo: el mismo
bloque escrito tres veces es cómo se llegó a tener seis copias de `MacroFields`.

| Modal | Hoy | Después |
|---|---|---|
| `MealModal` (botón rápido) | un `description`; sin corrección | los dos campos |
| `UnifiedEntryModal` (maestro) | un `description`; sin corrección | los dos campos |
| `MealEditModal` (editor con IA) | tiene `description` **e** `instruction`, separados a mano | los mismos dos campos, ya compartidos |

**El componente se extrae primero y lo montan los tres.** `MealEditModal` es la
referencia de comportamiento: ahí la separación ya funciona.

## Reglas que el cambio no puede romper

- **Tocar el análisis invalida la dosis calculada.** Una corrección que baja el
  arroz cambia los carbohidratos, y una dosis calculada antes deja de
  corresponder. Ya existe esa invalidación (`rapidStale`,
  `doseNeedsReconfirm`): la corrección iterativa tiene que dispararla igual que
  un análisis nuevo. Es la regla que más fácil se pierde al mover este código.
- **Lo estimado por IA sigue separado de lo confirmado.** Corregir mueve
  `aiEstimatedCarbsG`, nunca `confirmedCarbsG`: pasar a confirmados sigue
  exigiendo el botón explícito.
- **Un macro que ella vació sigue vacío.** `clearedMacros` significa "no lo
  anoté", y una propuesta revisada no puede resucitarlo.
- **Nada nuevo viaja a la IA.** El payload de corrección es composición +
  instrucción; `MealSnapshotSchema` no declara insulina ni glucosa, y esa
  frontera es estructural, no de buenas intenciones.
- **La procedencia de los macros la resuelve quien sabe qué se precargó**
  (`resolveMacrosSource`), no el orquestador. Una composición revisada es un
  valor precargado nuevo, así que hay que recalcularla.
- Si la corrección falla, la propuesta anterior **queda como estaba** y se dice
  por qué. Degradar a manual siempre es una salida válida.

## Riesgo a vigilar

La corrección iterativa invita a encadenar instrucciones ("menos arroz", "y más
pollo", "y sin aceite"). Cada llamada devuelve la composición completa, así que
el error no se acumula por diff — pero sí puede derivar: la quinta revisión
puede alejarse de la foto original sin que nadie lo note. Vale la pena mostrar
que la propuesta en pantalla ya fue revisada N veces, o al menos ofrecer volver
al análisis original.
