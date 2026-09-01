# Recetas en el catálogo — diseño pendiente

_Escrito el 2026-09-01, a pedido de Verónica, para la corrida que lo implemente.
**Nada de esto está construido.** Lo que sí se construyó ese día —porción
propuesta por la IA y confirmada, y el rescate de los alimentos sin gramos—
está en `activeContext.md`._

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

## Lo que hay que decidir antes de escribir código

- **Qué es una receta en la base.** Una fila propia (`recipes` +
  `recipe_items`) que referencia `food_catalog.key`, o un `food_catalog` con
  una columna de "hijos". La primera conserva la identidad de cada alimento y
  permite que un mismo `arroz` pertenezca a varias recetas; es la que
  recomiendo, y es una migración con backfill, en su propia corrida.
- **Qué pasa al editar un componente.** Si se corrigen los macros de `arroz`,
  ¿cambian los totales de todas las recetas que lo contienen? Si los totales se
  guardan copiados, divergen; si se derivan, cambia el historial. **Recomiendo
  derivarlos siempre y no guardar totales**: el número que se muestra es una
  suma, no un dato aparte.
- **Cómo se reusa una receta.** El carrito hoy es de alimentos
  (`meal-cart.ts`). Una receta debería entrar al carrito como una línea que se
  expande a sus componentes, para que la porción siga siendo por alimento.
- **Porciones.** Una receta necesita su propia porción ("un plato"), y sus
  componentes ya tienen la suya desde el 2026-09-01. Ojo con la regla de
  procedencia (`servingSource`): lo que la usuaria confirma no lo pisa un
  análisis.

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

### 4. Que la IA no proponga duplicados _(pendiente)_

Si ya existe la receta `arroz con pollo` y se fotografía lo mismo, la app
debería ofrecer **usar la del catálogo** en vez de crear otra. Y si existen
`arroz` y `pollo` sueltos, ofrecer **armar la receta con esos**, no con copias
nuevas.

La base está: `foodKey` normaliza el nombre y `buildCatalogProposals` ya recibe
el catálogo actual (`existingByKey`) y marca cada propuesta como alta o fusión.
Lo que falta es el emparejamiento **por similitud**, no por igualdad exacta —
`foodKey` a propósito no lematiza ni quita plurales, así que "manzana" y
"manzanas" son dos claves distintas. Cualquier heurística que se agregue tiene
que ser pura, vivir en `packages/domain` y tener test: emparejar mal mezcla los
macros de dos alimentos distintos, que es peor que tener dos entradas
parecidas.

## Fronteras que no cambian

- Una receta suma **gramos de alimento**. Nada de esto calcula, infiere ni
  sugiere insulina.
- Los macros estimados por IA siguen separados de los confirmados por la
  usuaria, receta incluida.
- Las fotos son **representación**, nunca evidencia de macros: no se generan,
  no se recortan solas y nada se re-analiza al leer el catálogo.
- Hay historial clínico local sin respaldo en la nube: la migración de recetas
  no puede perder ni invalidar una fila de `food_catalog` existente.
