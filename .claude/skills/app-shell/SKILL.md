---
name: app-shell
description: Construir o modificar la navegación de Type 1A — la barra inferior fija, el gesto de swipe entre secciones, los insets de sistema (barra de estado arriba, barra de navegación de Android abajo) y el manejo de modales a pantalla completa. Úsala SIEMPRE que toques la barra inferior, agregues o muevas una sección de nivel superior, o cambies cómo se navega entre pantallas.
---

Cómo se navega en Type 1A, y por qué está hecho así.

## Regla que gobierna todo: no hay librería de navegación

La app **no** usa react-navigation ni expo-router, y no se agrega una. Cada
pantalla de nivel superior es un `Modal` a través de
`apps/mobile/src/components/ModalShell.tsx`, y la pantalla principal (glucosa)
es el `ScrollView` de `App.tsx`.

Esto es una decisión, no una deuda: la app tiene cinco destinos fijos y
conocidos. Una librería de navegación agregaría peso de bundle, una capa de
estado y una fuente nueva de bugs de safe-area, a cambio de nada que estos
cinco destinos necesiten.

**Si necesitas sub-páginas dentro de una sección, usa una barra de pestañas
dentro del modal** — el patrón ya está en `SummaryModal.tsx`,
`SettingsModal.tsx` y `NutritionModal.tsx`. Cópialo, no inventes otro.

## La barra inferior

Cinco destinos, en este orden fijo:

| Posición | Destino | Notas |
|---|---|---|
| 1 (izq) | Nutrición | `NutritionModal` |
| 2 | Catálogo de comidas | `FoodCatalogModal` |
| 3 (centro) | **Nueva entrada** | Más grande que los otros cuatro; es la acción primaria de la app |
| 4 | Chat de IA | Reservado; su icono es **el logo de la app** |
| 5 (der) | Resumen | `SummaryModal` |

Reglas:

- **La barra es fija (`position: 'absolute'`, `bottom: 0`) y sobrevive al
  scroll.** El contenido de la pantalla principal necesita
  `paddingBottom` suficiente para que la barra no tape la última tarjeta.
- **El botón central es la acción primaria** y tiene que verse único — más
  grande, con fondo de color. Los otros cuatro son iconos recesivos. Esto es
  la regla de "una acción dominante" de `docs/UX_GUIDELINES.md`.
- **44×44 pt mínimo** de área tocable en los cinco, `hitSlop` incluido.
- **Ningún destino se comunica solo con color**: el estado activo lleva
  además un cambio de peso/opacidad o una etiqueta.
- Ajustes **no** va en la barra inferior: se queda arriba a la derecha. Es
  configuración, no navegación frecuente.

## Los insets: el error que más caro sale acá

Android dibuja su propia barra de navegación (los tres botones, o la barra de
gestos) **encima** de tu contenido cuando hay edge-to-edge, que es obligatorio
desde Expo SDK 54. Una barra inferior a `bottom: 0` sin inset queda **debajo**
de los botones del sistema y es intocable.

- Usa `useSafeAreaInsets()` de **`react-native-safe-area-context`** y súmale
  `insets.bottom` al padding inferior de la barra.
- **`SafeAreaView` de `react-native` es iOS-only** y en Android no aplica
  ningún inset. Este bug ya nos costó una corrida entera: dejaba el botón
  "Cerrar" de todos los modales tapado por la hora y la batería. Ver
  `docs/ROADMAP_V0.2.md` § Fase 13, ítem 3.
- No intentes ocultar la barra del sistema. Esconderla y reaparecerla con el
  scroll es un patrón que pelea con el gesto de volver atrás de Android y que
  los usuarios no esperan. Convivir con ella (respetando su inset) es lo
  correcto y lo que hacen las apps nativas.

## Swipe entre secciones

Se navega tanto tocando un botón como deslizando lateralmente.

- El gesto usa el `PanResponder` de React Native, no una librería nueva.

### Los dos errores que ya cometimos acá (2026-08-21)

La primera versión del swipe **no navegaba a ninguna parte**, y pasó
inadvertida una corrida entera porque `pnpm verify` y el bundle de Metro no
dicen nada sobre si un gesto llega a dispararse. Los dos errores son fáciles
de repetir:

1. **Nunca pongas los `panHandlers` encima de un `ScrollView`.** Un
   `ScrollView` es un componente nativo que maneja el arrastre él mismo; los
   props del sistema de responders de JS puestos ahí no llegan a decidir
   nada y el gesto no se dispara jamás. Van en un **`View` que envuelve** al
   `ScrollView`, reclamando en **fase de captura**
   (`onMoveShouldSetPanResponderCapture`), que es la forma documentada de que
   un padre le gane un arrastre a un hijo que scrollea.
2. **Un destino que no lleva a ninguna parte no va en el recorrido.** El
   orden incluía `entry` (que abre un formulario) y `chat` (que era un aviso
   de "todavía no está"), y son justo los vecinos de la pantalla principal:
   aun con el gesto arreglado, deslizar nunca habría llegado a una sección
   real. El recorrido del gesto **no tiene por qué ser idéntico al de la
   barra**: salta lo que no es un destino navegable, y la pantalla principal
   es una posición más (deslizar de vuelta al centro cierra el modal).

### El resto de las reglas

- **Un swipe horizontal no puede robarle el gesto a un `ScrollView`
  vertical ni a un gráfico que scrollea horizontalmente.** `GlucoseChart` es
  precisamente un `ScrollView` horizontal. Reclamar en captura le ganaría
  también a él, así que hay un árbitro compartido (`src/swipeGuard.ts`): si el
  toque empezó dentro de un scroller horizontal, el reconocedor no reclama
  nada durante ese toque. Un scroller horizontal nuevo tiene que pegarse
  `horizontalScrollerGuardHandlers`.
- El orden del swipe respeta la izquierda/derecha de la barra, para que el
  gesto y la posición del botón cuenten la misma historia.
- **La lógica del recorrido va en un módulo puro y con test**
  (`src/swipeOrder.ts`): un orden se verifica sin teléfono, y fue la mitad del
  bug.
- Los modales que son **destinos** reciben el gesto vía la prop
  `swipeHandlers` de `ModalShell`. Los que son **formularios** (Ajustes, Nueva
  entrada, editar comida) no: deslizar dentro de un formulario a medio llenar
  y que la pantalla se vaya a otra sección sería perder lo escrito.
- Respeta "Reduce Motion": `ModalShell` lee la preferencia y pasa
  `animationType="none"` cuando está activa.

### Antes de decir que un gesto quedó listo

Un gesto **no se puede dar por entregado sin probarlo en el dispositivo**.
Si la corrida no puede probarlo, dilo explícitamente al entregar en vez de
darlo por hecho — eso fue lo que dejó pasar el bug una corrida entera.

## Antes de dar por terminado

1. Checklist de `docs/UX_GUIDELINES.md`.
2. Probar con la barra de navegación de Android **visible** (tres botones) y
   en modo gestos: son dos insets distintos.
3. `pnpm verify`.
4. Actualizar `docs/CODE_MAP.md` si agregaste un componente.
