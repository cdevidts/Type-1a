# 0006 — El IOB incluye la insulina de comida, pero nunca toca la cobertura de carbohidratos

Fecha: 2026-09-03 · Estado: aceptado

## La pregunta

Verónica, después de probar el IOB del ADR 0005:

> Si yo como algo nuevo después de haberme pinchado y corregido, el IOB se le
> resta al cálculo nuevo de comida, y el IOB solo se le debería restar al
> cálculo de la corrección. (…) Nuevos carbos = siempre pincharse. Nueva
> corrección = no necesariamente.
>
> ¿El IOB de la insulina inyectada por comida es realmente necesario?

Son dos preguntas y tienen respuestas opuestas.

## Lo que estaba mal (y era un bug, no una decisión)

`bolus.ts` calculaba `mealUnits + (correcciónUnits − IOB)` **sin tope**. El
comentario del archivo decía "el IOB sale solo de la corrección" y el código
hacía otra cosa: cuando el IOB superaba a la corrección, el sobrante seguía
viaje y se descontaba de la comida.

Su caso: comió y se corrigió hace diez minutos, le quedan ~9 U activas, quiere
comer 20 g más. `2 + (0 − 9) = −7`, con piso en 0. **La app proponía 0 U.** Los
20 g de carbohidratos quedaban sin cubrir y la glucosa se iba arriba sin que
nada en pantalla lo explicara.

Es exactamente lo que el ADR 0005 prohibía en palabras. Los tests que existían
lo daban por bueno: uno se llamaba *"LA REGLA DURA: el IOB sale de la
corrección, NUNCA de la comida"* y afirmaba `correctionAfterActiveUnits === -10`,
que es el sobrante comiéndose la comida. Es el corolario de la Regla 1 en carne
propia — un test que confirma lo que la implementación devuelve hoy no prueba
nada.

**Arreglado:** el descuento se detiene cuando la corrección llega a 0.

```
aplicado = corrección ≤ 0 ? 0 : min(IOB, corrección)
total    = max(0, comida + (corrección − aplicado))
```

Lo que sí puede seguir bajando el total es una **glucosa bajo objetivo**. Esa es
otra razón, se calcula antes de mirar el IOB, y se conserva: estar en 70 sí es
motivo para poner menos de lo que pide el plato.

## Lo que se decidió NO cambiar: el IOB sigue contando la insulina de comida

La pregunta de fondo era si el bolo de comida debería entrar al IOB. La
respuesta es **sí**, y no es una preferencia:

- **Es la práctica estándar.** Los calculadores de bolo de bomba cuentan
  carbohidratos y corrección juntos como *bolus on board*; la excepción
  documentada son los Omnipod de 2012 y anteriores, que excluían los bolos de
  comida. Ese es el consenso de la industria, no un detalle de implementación.
- **Es el que protege de la hipoglucemia.** Si te pusiste 7 U por una comida
  hace diez minutos, esas 7 U **van a bajar tu glucosa**. Una glucosa de 250
  ahora todavía no refleja lo que van a hacer. Corregir sin contarlas es
  apilar, que es el daño que el ADR 0005 vino a evitar.
- **Los dos errores no cuestan lo mismo.** Contarlas de más produce una
  corrección menor, que se puede volver a evaluar en una hora. No contarlas
  produce una corrección de más, y eso se descubre en una hipo.

La objeción legítima es que la insulina de comida está "comprometida" con
carbohidratos que también siguen absorbiéndose, así que contarla entera es
conservador justo después de comer. Los sistemas de asa cerrada resuelven eso
modelando **COB** (carbohidratos activos) además del IOB y prediciendo la
glucosa. Type 1A **no modela COB** y no va a hacerlo: sería estimar la
absorción de una comida, que es inferir un parámetro de terapia. Sin COB, lo
seguro es el IOB completo.

## La regla, en una línea

**Comer siempre pide insulina; corregir no siempre.** El IOB puede llevar la
corrección a cero y ahí se detiene.

## Consecuencias

- `MealBolusResult` expone `activeInsulinAppliedUnits` y
  `activeInsulinUnusedUnits`. La pantalla los necesita: sin ellos el desglose
  mostraba "− 9 U" sobre un total que solo había bajado 3, y unos números que
  no suman en una calculadora de dosis se leen como un error de la app.
- `InsulinBreakdown` muestra la línea "No se descontó (tu comida no se toca)"
  cuando sobra activo.
- El invariante queda fijado por un test que barre glucosas, IOB y
  carbohidratos y comprueba que el total nunca baja de `mealUnits` mientras la
  glucosa esté en objetivo o por encima.
- Si algún día se agrega COB, este ADR se revisa entero: el argumento de arriba
  depende de no tenerlo.

## Addendum (2026-09-18): se reafirma, y se agrega el caso que faltaba

Verónica lo cuestionó con un caso real: subió una foto al Modal Maestro, **su
glucosa no alcanzó a cargar**, así que calculó 6 U **solo por los
carbohidratos**; un minuto después abrió la corrección y esas 6 U aparecieron
como activas, dándole **0 U con 171 mg/dL**. Su argumento: *"era solo por la
comida, no había NADA que descontar."*

**Tenía razón sobre el hecho y la decisión no cambia.** Se le presentaron las
dos opciones con su costo y eligió mantener la regla: contar la insulina de
comida de más da una corrección menor, reevaluable en una hora; no contarla da
una corrección de más, y eso se descubre en una hipoglucemia.

Lo que el ADR no había previsto es que **el acto quedara partido en dos**. Con
la glucosa cargada, un solo cálculo le habría dado 8 U (6 de comida + 2,37 de
corrección) — verificado con `calculateMealBolus`. El error no fue la resta:
fue que una calculadora de comida y una de corrección, separadas por un minuto,
se leen como dos dosis cuando son una.

Se agrega `meal-only-dose.ts`: si la dosis reciente tenía `correctionUnits === 0`
y `mealUnits > 0` —el desglose está guardado por dosis desde la Fase 24— la
corrección **lo dice en pantalla** y le ofrece el número para **sumar a esa
dosis**, descontando solo la insulina de *otras* dosis. Sumar a una dosis que
aún no terminó de definirse no es apilar: es completar el mismo acto.

**Ausente sigue significando "no se sabe", nunca cero**: una dosis escrita a
mano o importada no califica, porque sin desglose no se puede afirmar que no
traía corrección.

La causa de raíz —que su glucosa llegara tarde— se atacó aparte:
`syncWindowFrom` reemplaza la ventana fija de 4 h, que dejaba sin pedir todo lo
ocurrido durante un sueño más largo que eso.
