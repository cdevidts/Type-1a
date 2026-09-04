# Recetas en el catálogo — diseño, y qué quedó construido

_Escrito el 2026-09-01 a pedido de Verónica. **Construido el 2026-09-01 y
terminado el 2026-09-02** tras probar el primer build: faltaban el detalle, que
"solo receta" hiciera algo, la fusión a mano y el reuso en el carrito._

## El problema que lo origina

Una foto de arroz con pollo produce hoy **dos alimentos sueltos** en el
catálogo, `arroz` y `pollo`, y **los dos heredan la misma foto del plato
completo**. Queda un "arroz" cuya miniatura es un plato de arroz con pollo. Ya
se corrigió lo que la interfaz *afirma* (la etiqueta accesible dice "la comida
donde se identificó, puede incluir otros"), pero el dato sigue mal.

## La propuesta

Cuando una comida se compone de varios alimentos, poder guardarla como
**receta**: un contenedor con nombre propio que agrupa a sus componentes.

- **En la grilla del catálogo** la receta se ve como una tarjeta más, con sus
  macros **sumados** y sus calorías.
- **Al abrirla** hay una vista con sus macros y la lista de sus componentes,
  cada uno con su propia tarjeta, tal como se guardan hoy.
- **Las fotos son independientes**: la receta conserva la foto original del
  plato; dentro, cada componente puede recibir la suya. Eso es lo que arregla
  el "arroz con foto de arroz con pollo".

Al guardar una comida de varios alimentos, la interfaz pregunta —**tres
salidas, como la pregunta de la Fase 18**—:

1. los componentes por separado,
2. como receta,
3. las dos cosas.

No todo tiene que ser una receta: la pregunta aparece solo cuando el análisis
devolvió más de un alimento.

## Decisiones tomadas (Verónica, 2026-09-01)

1. **Los totales se DERIVAN, nunca se guardan.** Una receta no tiene macros
   propios: son la suma de sus componentes, calculada al leer. Corregir el
   `arroz` corrige todas las recetas que lo usan. Se acepta la consecuencia —el
   número de una receta puede cambiar con el tiempo— porque cambia cuando
   mejora la estimación de un componente, y no toca ninguna comida ya
   registrada: una comida guarda sus propios gramos, no una referencia.
2. **Borrar un alimento usado por una receta se BLOQUEA**, con la lista de
   cuáles. Ni cascada (cambia recetas a espaldas de la usuaria) ni congelar
   totales (deja una suma que no se puede verificar). Y no es un callejón: hay
   una pantalla de ayuda para resolverlo receta por receta — ver abajo.
3. **Los duplicados solo se proponen, nunca se fusionan solos.** Emparejar mal
   mezcla macros de dos alimentos distintos y eso después sugiere
   carbohidratos sin que nada lo delate; un duplicado es feo y reversible.

**Ya construido** (`packages/domain`, 32 tests): `recipe.ts` —totales
derivados, `recipesUsingFood`, `replaceRecipeItem`, `applyRecipeFixPlan`— y
`catalog-similarity.ts` —`findSimilarFood`, `matchAnalysedFoods`—.

Invariante fijado con test: **el mismo plato da el mismo número como receta que
como carrito**. Los dos suman valores ya redondeados por `scaleCatalogFood`;
redondear distinto habría dado dos verdades para el mismo arroz con pollo.

## La pantalla de ayuda al borrar

Aparece al intentar borrar un alimento que alguna receta usa. Una tarjeta por
receta afectada, y en cada una tres salidas:

- **Cambiarlo por otro** del catálogo, **conservando los gramos** — los gramos
  son del plato, no del alimento, así que sustituir arroz blanco por integral
  no cambia cuánto hay. Si la receta ya contenía al reemplazo, las dos líneas
  se funden. Acá entra la IA: proponer el sustituto más razonable con el
  catálogo existente, siempre como propuesta.
- **Sacarlo del plato.** Si era el último componente, la receta se borra con la
  misma acción — una receta vacía se leería como "este plato no tiene nada".
- **Dejar esta receta como está.**

Regla dura, ya implementada en `applyRecipeFixPlan`: **es todo o nada**. Si
queda una sola receta en "dejar como está", el alimento no se borra. Dejar una
receta usándolo y borrarlo igual es cómo se llega a un total que nadie puede
reproducir. Una receta sin decisión explícita se conserva.

## Construido (✅ 2026-09-02)

- Tablas `recipes` y `recipe_items` + CRUD; tarjeta en el catálogo; la
  pregunta de tres salidas; `RecipeFixModal` al borrar.
- **"Solo receta" ahora hace algo**: `food_catalog.listed`. Antes escribía lo
  mismo que "las dos cosas". Un componente oculto vive y muere con sus
  recetas y se muestra desde el detalle.
- `RecipeDetail.tsx`: componentes con gramos editables, agregar/quitar, foto,
  nombre, borrar, y "Usar en una comida" → `recipeToCartLines`, una línea por
  componente. "Un plato" es la suma de sus gramos; `servings` lo escala.
- Con receta, los componentes **no** heredan la foto del plato.

## Temas relacionados, de la misma conversación

Están listados por costo creciente. Los tres primeros son independientes de las
recetas y se pueden hacer antes.

### 1. La nota no se guarda desde el botón rápido — ✅ **resuelto el 2026-09-01**

**Causa confirmada.** `confirmMeal` en `App.tsx` arma el `MealEvent` con su
`description` y llama a `saveMealWithEpisode`, pero **nunca escribe una fila en
`note_events`**. El Modal Maestro sí: su payload lleva `note` y
`saveUnifiedEntry` la persiste. Por eso una comida registrada desde el maestro
muestra al tocarla lo que se comió, y la misma comida por el botón rápido no.

Resuelto: `mealNote.ts` (puro, con test) decide el texto —lo que ella escribió,
si no los alimentos que identificó la IA, si no el del catálogo que reusó— y
`confirmMeal` lo escribe en `MealEvent.note`, que `TimelineDetailModal` ya
dibujaba. No se inventa una nota cuando no hay nada que decir.

### 2. Las calorías no se ven en el catálogo — ✅ **resuelto el 2026-09-01**

Resuelto: `FoodCard` dibuja un quinto chip con las calorías, **neutro y sin hue
propio**. No es un macro y no compite con los cuatro: agregarle un color
categórico habría exigido revalidar la paleta entera (ver `theme.ts`).

### 3. Fotos a un alimento desde el editor del catálogo — ✅ **resuelto el 2026-09-01**

Resuelto: cámara y galería en `CatalogModal`, con el mismo redimensionado y
compresión que los modales de comida. Acá la foto es **solo representación**, así
que —a diferencia de una comida— no se adopta junto a un análisis: nada se
re-estima a partir de ella. Una foto elegida gana sobre "quitar foto".

### 4. Que la IA no proponga duplicados — ✅ **en dos mitades (2026-09-02)**

"Pata de pollo" al lado de "Muslo de pollo" mostró el límite de la heurística:
solo plural/singular y mismas palabras, a propósito — cada heurística nueva
amplía la superficie de un error silencioso. Lo que se hizo:

- **Fusión a mano** en `CatalogServingModal` (`mergeInto`): ella busca en su
  catálogo y elige; la entrada hereda clave y nombre del existente con los
  macros de la propuesta. El parecido por nombre viene preseleccionado y
  visible, con "es otro" al lado. Antes el texto prometía la fusión y la
  entrada se guardaba con su propia clave.
- **`knownFoodNames`** viaja con los tres modos de análisis: solo nombres,
  máx. 300, los más vistos. El modelo reusa el exacto cuando es el mismo
  alimento y el prompt (v3) lleva el freno: otro corte, preparación, variedad
  o marca es otro alimento. Necesita redeploy. Es un dato personal nuevo que
  sale del teléfono, dicho como costo aceptado en `knownFoods.ts`.

## Fronteras que no cambian

- Una receta suma **gramos de alimento**. Nada de esto calcula, infiere ni
  sugiere insulina.
- Los macros estimados por IA siguen separados de los confirmados por la
  usuaria, receta incluida.
- Las fotos son **representación**, nunca evidencia de macros: no se generan,
  no se recortan solas y nada se re-analiza al leer el catálogo.
- Hay historial clínico local sin respaldo en la nube: la migración de recetas
  no puede perder ni invalidar una fila de `food_catalog` existente.
