# Research sources

Verified on 2026-08-12. Product requirements and safety boundaries come first from the supplied `Type1A_Contexto_Maestro_v0.1(1).md`.

## FreeStyle and Junction

- [Junction — Abbott LibreView provider guide](https://docs.junction.com/wearables/guides/abbott-libreview): current provider slugs, practice-based `freestyle_libre` flow, supported regions, practice names, Link API, and floating-time warning.
- [LibreView patient quick-start](https://pat.libreview.com/articles/qsg/): official practice sharing flow and Practice ID behavior.
- [Abbott — What is LibreLinkUp?](https://www.support.freestyle.abbott/hc/en-us/articles/36332326812433-What-is-the-LibreLinkUp-app): intended family/friend/caregiver use, data transfer requirements, and dosing limitation.
- [Abbott — LibreLinkUp connection limit](https://www.support.freestyle.abbott/hc/en-us/articles/36336282993937-How-many-people-can-I-follow-with-my-LibreLinkUp-app): up to 20 connections and internet requirement.

The screenshot supplied with the project is the source for the current in-app wording of Libre Data Share as a temporary, healthcare-team access mechanism.

## Abacus RouteLLM

- [Abacus.AI — RouteLLM API reference](https://abacus.ai/help/developer-platform/route-llm/): base URL, bearer authentication, and `route-llm` routing model.
- [Abacus.AI — Chat Completions](https://abacus.ai/help/developer-platform/route-llm/chat-completions/): OpenAI-compatible endpoint, multimodal inputs, and structured outputs.

## Expo SDK 57

- [Expo SQLite](https://docs.expo.dev/versions/v57.0.0/sdk/sqlite/)
- [Expo Notifications](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/)
- [Expo Image Picker](https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/)
- [Expo Image Manipulator](https://docs.expo.dev/versions/v57.0.0/sdk/imagemanipulator/)

Only exact SDK 57 documentation was used for the mobile implementation.

## Duración de acción de las insulinas (2026-08-25)

Fuentes de los valores de `packages/domain/src/insulin-catalog.ts`. Se usan
**solo para higiene de datos** (decidir si una dosis anterior todavía podía
estar actuando dentro de la ventana de un episodio), nunca para estimar
insulina activa ni para ningún cálculo de dosis — ver la cabecera de ese
módulo y `AGENTS.md`.

- [Cleveland Clinic — Injectable insulin medications](https://my.clevelandclinic.org/health/drugs/13902-injectable-insulin-medications):
  tabla de inicio/pico/duración por insulina. De acá salen los valores de
  lispro (Humalog), aspart (NovoRapid/NovoLog) y glulisina (Apidra), todas
  3-5 h; regular humana 5-8 h; NPH 14-24 h; detemir (Levemir) y glargina
  U-100 (Lantus/Basaglar) hasta 24 h; glargina U-300 (Toujeo) hasta 36 h;
  degludec (Tresiba) hasta 42 h.
- [Fiasp — fast-acting insulin aspart, Primary Care Notebook](https://primarycarenotebook.com/pages/diabetes-and-endocrinology/fast-acting-insulin-aspart-fiasp)
  y el meta-análisis de [aspart rápida vs. aspart en bomba (PMC9925142)](https://pmc.ncbi.nlm.nih.gov/articles/PMC9925142/):
  Fiasp adelanta el inicio ~5 min y adelanta el fin de exposición ~12 min
  respecto de aspart, con ~10 min menos de tiempo al pico. **La duración
  total se queda en el mismo rango de 3-5 h**, por eso el catálogo le asigna
  las mismas 5 h que a NovoRapid en vez de un número menor. Lyumjev es el
  equivalente dentro de la familia de lispro y recibe el mismo trato.

**Por qué se toma el extremo alto del rango** (5 h y no 4, 42 h y no 40):
para excluir un episodio confundido conviene errar por exceso. Excluir de
más cuesta muestra —y el `n` se muestra en pantalla y en el reporte—;
excluir de menos publica como patrón un promedio contaminado, que es el daño
que esta exclusión existe para evitar.

**Y por qué las elige la usuaria y no la app**: `AGENTS.md` prohíbe inferir
parámetros de terapia. Estos números son el dato del fabricante, no una
estimación de la app sobre esa persona, y se pueden sobrescribir con lo que
haya indicado su equipo clínico.

## Cómo se mide una respuesta post-prandial cuando las comidas se solapan (2026-08-26)

Fuentes del rediseño de `macro-glucose.ts` y `nutrition-insights.ts`. Verónica
pidió explícitamente investigar esto después de que la pantalla de Patrones le
quedara vacía: *"esperaría que buscaras en internet para dar con fórmulas
matemáticas que permitieran solucionar este tema, no que decidieras obviar
cualquier dato que no venga en formato fácil"*.

**El estándar de la literatura CGM no es descartar: es truncar y ajustar.**

- [Determination of Postprandial Glycemic Responses by CGM in a Real-World Setting (PubMed)](https://pubmed.ncbi.nlm.nih.gov/31569815/)
  y [Imprecision nutrition? (AJCN / medRxiv)](https://www.medrxiv.org/content/10.1101/2023.06.14.23291406v2.full):
  la respuesta post-prandial se cuantifica como **iAUC** por regla del
  trapecio sobre una ventana fija desde la comida, con la glucosa basal
  tomada inmediatamente antes. **Para comidas solapadas, el iAUC de la
  primera se calcula desde su inicio hasta el fin de su ventana y el tramo
  solapado se excluye de la comida siguiente** — se *recorta*, para que cada
  excursión se cuente una sola vez. Nunca se tira la comida entera.
- [Indiscriminate adjustment for confounders is worse than you think (PMC11715647)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11715647/)
  y [Confounder adjustment in observational studies (BMC Medicine)](https://link.springer.com/article/10.1186/s12916-025-03957-8):
  la respuesta estándar a un confusor **medido** es **ajustar por él**, no
  eliminar la observación. Eliminar solo es válido si la pérdida es aleatoria
  — y acá no lo es: las comidas altas en grasa y proteína son justo las que
  más se corrigen tarde, así que la muestra que sobrevivía a la exclusión era
  la que se había portado bien. Sesgo de selección, no limpieza.
  Estas mismas fuentes advierten que ajustar por todo tampoco es gratis, así
  que las covariables se eligen a mano y son tres: carbohidratos, insulina
  rápida y actividad dentro de la ventana.
- [Assessing Covariate Balance with Small Sample Sizes (PMC11071580)](https://pmc.ncbi.nlm.nih.gov/articles/PMC11071580/):
  con muestras chicas el ajuste se vuelve inestable. De ahí
  `MIN_OBSERVATIONS_FOR_ADJUSTMENT = 8` y el que `fitOls` devuelva `null`
  ante una covariable constante o un sistema mal condicionado: **cuando el
  ajuste no se sostiene se muestra el promedio crudo y se declara**, en vez
  de mostrar un número ajustado que no aguanta.

**Cómo quedó aplicado:**

| Pantalla | Salida | Qué se hace con un episodio confundido |
|---|---|---|
| Patrones (grasa+proteína) | promedio de mg/dL | Se **conserva** y se le descuenta por OLS el aporte de los confusores. Se declara `n`, cuántos traían eventos, y si el promedio está ajustado. |
| Comidas (% en rango) | porcentaje | Un porcentaje no se puede residualizar, así que se **cuenta y se declara** (`confoundedCount`) junto al número. |

Lo único que sigue sacando un episodio del cálculo es **no tener lecturas de
glucosa**: sin glucosa no hay observación que ajustar.
