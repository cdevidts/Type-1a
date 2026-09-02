# Fuentes — de dónde sale cada constante

Se lee al **cambiar una constante clínica**, no en cada corrida. Si vas a mover
un umbral, una duración de insulina o una meta, la cita que lo respalda está
acá; si no está, no se cambia el número.

## Duración de acción de las insulinas

Respaldan `packages/domain/src/insulin-catalog.ts`. Sirven para higiene de datos
—si una dosis anterior podía estar actuando dentro de un episodio— y, desde el
2026-09-02, alimentan la curva de insulina activa (abajo). Nunca fijan una dosis
sola: lo que calculan se resta de la corrección y se muestra desglosado.

- [Cleveland Clinic — Injectable insulin medications](https://my.clevelandclinic.org/health/drugs/13902-injectable-insulin-medications):
  inicio/pico/duración por insulina. De ahí salen lispro (Humalog), aspart
  (NovoRapid/NovoLog) y glulisina (Apidra), las tres 3-5 h; regular humana
  5-8 h; NPH 14-24 h; detemir (Levemir) y glargina U-100 (Lantus/Basaglar)
  hasta 24 h; glargina U-300 (Toujeo) hasta 36 h; degludec (Tresiba) hasta 42 h.
- [Fiasp — Primary Care Notebook](https://primarycarenotebook.com/pages/diabetes-and-endocrinology/fast-acting-insulin-aspart-fiasp)
  y el [meta-análisis de aspart rápida vs. aspart (PMC9925142)](https://pmc.ncbi.nlm.nih.gov/articles/PMC9925142/):
  Fiasp adelanta el inicio ~5 min y el fin de exposición ~12 min respecto de
  aspart, con ~10 min menos al pico. **La duración total se queda en el mismo
  rango de 3-5 h**, por eso el catálogo le da las mismas 5 h que a NovoRapid en
  vez de un número menor. Lyumjev recibe el mismo trato dentro de la familia de
  lispro.

**Por qué el extremo alto del rango** (5 h y no 4, 42 h y no 40): para marcar un
episodio como confundido conviene errar por exceso. Marcar de más cuesta precisión
—y el `n` se muestra en pantalla y en el reporte—; marcar de menos publica como
patrón un promedio contaminado, que es el daño que esto existe para evitar.

**Y por qué las elige la usuaria y no la app**: `AGENTS.md` prohíbe inferir
parámetros de terapia. Estos números son el dato del fabricante, no una
estimación de la app sobre esa persona, y se sobrescriben con lo que haya
indicado su equipo clínico.

## Insulina activa (IOB) — curva exponencial

`packages/domain/src/iob.ts`. Modelo de LoopKit/OpenAPS, el estándar de los
sistemas de código abierto. Con `td` = duración y `tp` = pico:
`τ = tp(1 − tp/td)/(1 − 2tp/td)`, `a = 2τ/td`, `S = 1/(1 − a + (1+a)e^(−td/τ))`,
`restante(t) = 1 − S(1−a)((t²/(τ·td(1−a)) − t/τ − 1)e^(−t/τ) + 1)`.
Picos (presets de Loop): análogas rápidas 75 min, aceleradas 55, regular 150.
[OpenAPS](https://openaps.readthedocs.io/en/latest/docs/While%20You%20Wait%20For%20Gear/understanding-insulin-on-board-calculations.html)

Se eligió sobre la lineal porque la insulina no se agota a ritmo constante: una
recta sobreestima lo activo temprano y lo subestima tarde. Las cinco condiciones
bajo las que la app puede usarlo están en `docs/adr/0005`.

## Umbrales de glucosa

54 / 70 / 180 / 250 mg/dL en `packages/domain/src/glucose-thresholds.ts`, y el
formato AGP (mediana + p25–p75 + p05–p95 sobre 24 h) en `agp.ts`. Son el
consenso que ya leen LibreView y Dexcom Clarity, que es el punto: inventar una
visualización para algo que ya tiene estándar clínico le cuesta al equipo médico
traducirla en la consulta.

- [Understanding the Ambulatory Glucose Profile — Accu-Chek](https://www.accu-cheklatam.com/en/training/cgm/agp-report)
- [The AGP for Diabetes — novoMEDLINK](https://www.novomedlink.com/diabetes/hcp-education/clinical/time-in-range/clinical-use/understand-ambulatory-glucose-profile.html)
- [Acciones más allá del AGP: recomendaciones de expertos latinoamericanos (PMC12060294)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12060294/)

Una meta poblacional (ej. ">70% en rango") se muestra como contexto de lectura,
aclarando que el objetivo personal lo define el equipo clínico — nunca como si
la app se lo hubiera fijado a la usuaria.

## Meta de fibra — 14 g por cada 1000 kcal

`FIBER_G_PER_1000_KCAL` en `nutrition-targets.ts`: la Ingesta Adecuada del IOM
(DRI 2005), que la ADA recomienda también en diabetes. Se escala con la energía.

- [Dietary Reference Intakes, cap. 7 (IOM)](https://nap.nationalacademies.org/read/10490/chapter/9)
- [ADA Standards of Care — nutrición](https://diabetesjournals.org/care/article/48/Supplement_1/S86/157558)

Tres cosas que la implementación fija: es un **piso, no un techo** (la barra lo
dice en positivo); **no se descuenta de los carbohidratos** —los "netos" los
define el equipo tratante y `AGENTS.md` prohíbe inferirlo—; y **no entra en el
reparto 4/4/9**, porque ya está contada dentro de los carbohidratos.
## Respuesta post-prandial con comidas solapadas

Respaldan el rediseño de `macro-glucose.ts` y `nutrition-insights.ts`. Verónica
pidió investigarlo explícitamente después de que la pantalla de Patrones le
quedara vacía: *"esperaría que buscaras en internet para dar con fórmulas
matemáticas que permitieran solucionar este tema, no que decidieras obviar
cualquier dato que no venga en formato fácil"*.

**El estándar de la literatura CGM no es descartar: es truncar y ajustar.**

- [Determination of Postprandial Glycemic Responses by CGM in a Real-World Setting](https://pubmed.ncbi.nlm.nih.gov/31569815/)
  e [Imprecision nutrition? (medRxiv)](https://www.medrxiv.org/content/10.1101/2023.06.14.23291406v2.full):
  la respuesta se cuantifica como **iAUC** por regla del trapecio sobre una
  ventana fija desde la comida, con la basal tomada inmediatamente antes. Para
  comidas solapadas, **el iAUC de la primera va desde su inicio hasta el fin de
  su ventana y el tramo solapado se excluye de la siguiente** — se recorta, para
  contar cada excursión una sola vez. Nunca se tira la comida entera.
- [Indiscriminate adjustment for confounders is worse than you think (PMC11715647)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC11715647/)
  y [Confounder adjustment in observational studies (BMC Medicine)](https://link.springer.com/article/10.1186/s12916-025-03957-8):
  la respuesta estándar a un confusor **medido** es ajustar por él, no eliminar
  la observación. Eliminar solo vale si la pérdida es aleatoria — y acá no lo
  es: las comidas altas en grasa y proteína son justo las que más se corrigen
  tarde, así que la muestra que sobrevivía a la exclusión era la que se había
  portado bien. Sesgo de selección, no limpieza. Las mismas fuentes advierten
  que ajustar por todo tampoco es gratis: las covariables se eligen a mano y son
  tres —carbohidratos, insulina rápida y actividad dentro de la ventana.
- [Assessing Covariate Balance with Small Sample Sizes (PMC11071580)](https://pmc.ncbi.nlm.nih.gov/articles/PMC11071580/):
  con muestras chicas el ajuste se vuelve inestable. De ahí
  `MIN_OBSERVATIONS_FOR_ADJUSTMENT = 8`, y que `fitOls` devuelva `null` ante una
  covariable constante o un sistema mal condicionado: **cuando el ajuste no se
  sostiene se muestra el promedio crudo y se declara.**

| Pantalla | Salida | Qué pasa con un episodio confundido |
|---|---|---|
| Patrones (grasa+proteína) | promedio mg/dL | se **conserva** y se le descuenta por OLS el aporte de los confusores; se declara `n`, cuántos traían eventos, y si está ajustado |
| Comidas (% en rango) | porcentaje | un porcentaje no se residualiza, así que se **cuenta y se declara** (`confoundedCount`) junto al número |

Lo único que saca un episodio del cálculo es **no tener lecturas de glucosa**.

## CGM — LibreLinkUp, LibreView, Junction

Contexto de `docs/adr/0004-cgm-provider-librelinkup.md`.

- [Junction — Abbott LibreView provider guide](https://docs.junction.com/wearables/guides/abbott-libreview)
- [LibreView patient quick-start](https://pat.libreview.com/articles/qsg/)
- [Abbott — What is LibreLinkUp?](https://www.support.freestyle.abbott/hc/en-us/articles/36332326812433-What-is-the-LibreLinkUp-app):
  uso previsto para familia/cuidadores, y su limitación explícita para dosificar.
- [Abbott — límite de conexiones de LibreLinkUp](https://www.support.freestyle.abbott/hc/en-us/articles/36336282993937-How-many-people-can-I-follow-with-my-LibreLinkUp-app)
- Referencia comunitaria de la API no oficial:
  `timoschlueter/nightscout-librelink-up`.

## UX y fatiga de alarma

Respaldan `reference/ux-rationale.md` y `contracts/ux-checklist.md`.

- Apple HIG — [Layout](https://developers.apple.com/design/human-interface-guidelines/foundations/layout/),
  [Typography](https://developers.apple.com/design/human-interface-guidelines/foundations/typography/),
  [Color and Contrast](https://developers.apple.com/design/human-interface-guidelines/accessibility/overview/color-and-contrast/),
  [Motion](https://developers.apple.com/design/human-interface-guidelines/foundations/motion)
- [LukeW — Touch Target Sizes](https://www.lukew.com/ff/entry.asp?1085=)
- [Usability Evaluation of Four Top-Rated Diabetes Apps (PMC7710160)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7710160/)
  y [First-Time Patient User Challenges (PMC8349717)](https://pmc.ncbi.nlm.nih.gov/articles/PMC8349717/)
- [Designing Effective Medical Notifications to Counter Alert Fatigue — Invene](https://www.invene.com/blog/designing-experiences-to-counter-alert-fatigue)

## Plataforma

Solo documentación exacta de **Expo SDK 57** para la app móvil:
[SQLite](https://docs.expo.dev/versions/v57.0.0/sdk/sqlite/) ·
[Notifications](https://docs.expo.dev/versions/v57.0.0/sdk/notifications/) ·
[Image Picker](https://docs.expo.dev/versions/v57.0.0/sdk/imagepicker/) ·
[Image Manipulator](https://docs.expo.dev/versions/v57.0.0/sdk/imagemanipulator/).
Abacus RouteLLM: [referencia de API](https://abacus.ai/help/developer-platform/route-llm/)
y [Chat Completions](https://abacus.ai/help/developer-platform/route-llm/chat-completions/).
