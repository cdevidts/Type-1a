# Cómo se mide la duración de la insulina en sus datos

Se lee al tocar `packages/domain/src/insulin-duration.ts` o la pestaña
Resumen → Insulina. Para las constantes clínicas generales, `clinical-sources.md`.

`packages/domain/src/insulin-duration.ts`. La primera versión no mostró nada
nunca, por pedir correcciones aisladas sin otra dosis en 8 h — una ventana que
quien usa múltiples dosis diarias no tiene despierto. El método actual:

- **Toda dosis rápida cuenta**, y la bajada se mide desde el **máximo** de la
  ventana, no desde el instante de la dosis: en un bolo de comida la glucosa
  sube antes de bajar.
- **La ventana se recorta en la dosis siguiente** (fin exclusivo) en vez de
  descartar el episodio — el mismo truncado de la literatura de CGM con
  comidas solapadas, arriba.
- **2 h de ventana mínima**, que es el punto de control del test de factor de
  corrección de manual ("revisa 2-3 h después"), no las 8 h del final teórico.
- **Los carbohidratos son covariable**, no criterio de exclusión (OLS centrado
  de `regression.ts`). El ajuste conserva las diferencias entre tramos **y el
  nivel promedio**, así que la mediana ajustada sirve para comparar pero
  **no** para adoptar: adoptar usa solo episodios sin comida.
- Tramos 6-12 / 12-18 / 18-24, el corte de la ISF diurna y de las bombas.

- [Diurnal Variation of Real-Life Insulin Sensitivity Factor (PMC8957904)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC8957904/):
  ISF por franja horaria con esos mismos cortes y control a las 2 h.
- [OpenAPS Autosens](https://openaps.readthedocs.io/en/latest/docs/Customize-Iterate/autosens.html)
  y [Autotune](https://openaps.readthedocs.io/en/latest/docs/Customize-Iterate/autotune.html):
  el estándar de facto abierto trabaja con **desviaciones** sobre todos los
  datos y excluye solo el tramo con carbohidratos absorbiéndose, no el
  episodio entero.
- [Correction factor test — Diabetesnet](https://www.diabetesnet.com/diabetes-tools/insulin-dose-guide/correction-factor/):
  el protocolo de manual (4 h sin comer antes y después, control a las 2-3 h)
  es un **test provocado**; observar pasivamente exigiendo lo mismo produce
  una muestra vacía, no una muestra limpia.

## D1–D4: cuatro defectos abiertos de la curva de efecto (2026-09-09)

Verificados leyendo el código, no supuestos. Los detectó Verónica desde su
experiencia: *"en la mañana la insulina no me hace efecto hasta pasadas las 2 h"*
mientras el gráfico mostraba una bajada limpia desde la hora 1.

**D1 — "sin comida" está mal contado.** `insulin-effect-curve.ts` filtra las
interrupciones con `ms > startMs`, estrictamente mayor. Pero `saveUnifiedEntry`
guarda comida, carbohidratos y dosis **con el mismo `timestamp`** —es como la app
registra un desayuno con su bolo—, así que la comida no pasa el filtro y **casi
todo bolo de comida se cuenta como "sin comida"**. `insulin-duration.ts` lo hace
bien (`>= doseMs - CARB_LOOKBACK_MINUTES`, mira hacia atrás e incluye el empate).
Por eso las dos pantallas publican cifras incompatibles para las mismas mañanas:
8 episodios con 1 limpio contra 23 con 16 limpios.

**D2 — línea base de glucómetro contra puntos de sensor.** Una glucosa tecleada se
guarda como lectura de CGM con `origin: 'manual'` en el instante exacto de la
dosis; la curva solo excluye `'synthetic'`, así que a distancia 0 gana siempre
como línea base. Dos problemas encima: mezcla dos sistemas de medición para
calcular una diferencia, y trae **sesgo de selección** —se mide porque sospecha
que está alta—, de modo que todo punto posterior parece más bajo por regresión a
la media. Basta para fabricar la bajada monótona que ella no reconoce.

⚠️ **D2 alcanza al IOB.** `observeCorrectionEpisode` busca el **máximo** de la
ventana, y ese pinchazo alto es candidato natural a serlo: cambia qué episodios
superan `MIN_DROP_MG_DL`, cuánto se midió que bajaron y a qué minuto. Es el número
que el botón "adoptar" mete al IOB, que después descuenta unidades de cada
corrección. **No se adopta ninguna duración hasta cerrar D2.**

**D3 — la línea no es una trayectoria.** Los `n` por hora van 23, 21, **26**, 23,
20, 24, 25, 22: más episodios a las 3 h que a la 1 h es imposible en una cohorte
real. Cada punto es la mediana de los días que casualmente tenían lectura a ±15
min de esa hora — ocho subconjuntos distintos unidos por una línea que afirma
"así se ve un día tuyo".

**D4 — se promedian formas opuestas.** `clean` se reporta en pantalla pero **no
filtra**: la mediana mezcla episodios con comida (suben y después bajan) con
episodios sin comida (bajan). La mediana de una mezcla bimodal no centra nada.

### El límite de fondo, que ningún arreglo levanta

Con comida en la ventana **la acción de la insulina no es identificable desde
CGM**. Es la razón de que el estándar de oro sea el clamp euglucémico: infundir
glucosa y medir cuánta hizo falta es la única forma de aislarla. Lo que ella
percibe como "recién me hace efecto" no es el inicio de la insulina —un análogo
rápido arranca a los 10-20 min y pica entre 30 y 90— sino **cuándo la insulina le
gana al desayuno**, con el fenómeno del alba en contra y el retraso intersticial
del sensor encima.

### El gráfico de velocidad (backlog, decisión del 2026-09-09)

Se **agrega** a Resumen → Insulina, no reemplaza a los otros dos. Grafica mg/dL
por hora en pasos de 30 min hasta las 4 h. Al ser una derivada **no usa línea
base**, así que es inmune a D2; dice dónde cruza el cero (empieza a bajar), dónde
está el mínimo (pega más fuerte) y dónde vuelve a cero (se acaba). No levanta el
límite de arriba: describe la suma de comida e insulina, no la insulina sola.
