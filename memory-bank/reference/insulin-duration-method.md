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

