# ADR 0005: Insulina activa (IOB) — se levanta la prohibición, con condiciones

status: Accepted (2026-09-02)

## Contexto

`AGENTS.md` prohibía IOB desde el principio: "Never implement insulin-on-board
or automatic dosing in the MVP". La razón era buena — estimar mal cuánta
insulina sigue actuando produce una dosis mal calculada que la usuaria puede
inyectarse confiando en la app.

Pero **no tenerlo resultó ser el riesgo mayor**, y lo encontró Verónica usando
la app. El caso concreto que reportó:

> Registro una comida chica y me calcula la insulina con corrección. Cinco
> minutos después registro otra comida más grande y me vuelve a calcular la
> insulina, con corrección. No tiene consideración de que hay insulina en el
> cuerpo.

Eso es *stacking*, y la app lo estaba proponiendo con toda confianza, dos veces
seguidas, por la misma glucosa alta. La prohibición no evitaba el daño: lo
producía en silencio y lo trasladaba entero a la usuaria, que tenía que hacer
la resta de cabeza justo en el momento de dosificarse.

El compromiso anterior —mostrar las dosis de las últimas 6 h como "contexto
informativo, no es una estimación de IOB"— reconocía el problema sin
resolverlo.

## Decisión

Se permite IOB, **solo** bajo estas cinco condiciones, todas verificables en
código:

1. **Modelo publicado y citado.** Curva exponencial de LoopKit/OpenAPS, el
   estándar de los sistemas de código abierto (Loop, AndroidAPS). No se
   inventa una curva ni se usa una recta, que sobreestima lo activo temprano y
   lo subestima tarde. La fórmula y su fuente están en `iob.ts`.
2. **Parámetros de la usuaria.** La duración sale de lo que ella configuró en
   Ajustes → Terapia. El pico viene de la ficha técnica de la insulina que
   ella eligió del catálogo.
3. **Sin configuración no hay IOB.** `rapidInsulinActionModel` devuelve
   `undefined`, no cero, y la calculadora se comporta exactamente como antes.
   "No lo sé" y "no queda nada actuando" son afirmaciones opuestas.
4. **La resta se muestra entera.** `InsulinBreakdown`, en los tres modales que
   calculan. Desde que hay un término que no se ve, un total que baja sin
   decir por qué se lee como un error de la app.
5. **Se descuenta solo de la corrección, nunca de la comida.** Los
   carbohidratos llevan su dosis completa aunque haya insulina activa;
   restarla ahí deja corta la cobertura del plato. Hay test.

Sigue prohibida la **dosificación automática**: la app propone un número que
ella revisa, edita y confirma. Nada se inyecta ni se registra solo.

Además, cada dosis calculada guarda su **desglose** (`mealUnits`,
`correctionUnits`, `iobUnits` en `InsulinEventSchema`). `purpose` ya decía
*para qué* fue la dosis; el desglose dice *de cuánto se compuso*, que es lo que
permite mirar después por qué la app propuso 4,4 U y no 5,5 — y analizar las
correcciones por separado de los bolos de comida.

## Consecuencias

- El número que propone la calculadora ya no se puede rehacer de cabeza con lo
  que hay en pantalla. Por eso la condición 4 no es cosmética: es la que
  mantiene el cálculo auditable por quien lo va a usar.
- Un `rapidInsulinDurationHours` mal configurado ahora **cambia una dosis**,
  no solo qué episodios entran a un promedio. La pantalla de duración
  observada por tramo (`insulin-duration.ts`) existe para que ese número se
  pueda contrastar con los datos reales en vez de quedar como un supuesto.
- `insulin-catalog.ts` decía "esto NO es IOB y no puede convertirse en eso".
  Esa nota se actualizó: sigue siendo cierto que *ese módulo* no calcula IOB,
  pero ya no es cierto que la app no lo haga.
- La estimación no es una medición. La absorción real varía por sitio de
  inyección, temperatura, ejercicio y persona. La interfaz lo dice donde
  muestra el número.
