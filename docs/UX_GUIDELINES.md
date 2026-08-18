# Guías de UX/UI — Type 1A

Este documento traduce las Apple Human Interface Guidelines (HIG) y las
mejores prácticas conocidas de apps de salud/diabetes (mySugr, apps de CGM,
literatura de usabilidad clínica) a reglas concretas y chequeables para
construir o revisar cualquier pantalla de `apps/mobile`. No es teoría de
diseño genérica: cada regla está pensada para aplicarse contra código real
de este repo, y varias apuntan a patrones que ya existen en
`src/components/`.

Type 1A es una app de salud usada varias veces al día por alguien que puede
estar cansado, con las manos ocupadas, en hipoglucemia, o simplemente
apurado. El estándar no es "se ve bien" — es "se puede usar rápido, sin
error, y sin generar ansiedad".

Los tokens de diseño reales del proyecto están en
[`apps/mobile/src/theme.ts`](../apps/mobile/src/theme.ts) (`colors`,
`spacing`, `radius`). Todas las reglas de abajo se expresan en términos de
esos tokens — no se propone un sistema paralelo.

## Checklist antes de construir o tocar una pantalla

Antes de dar por buena una pantalla o modal nuevo, o un cambio a uno
existente, repasa esto:

- [ ] ¿Cuál es la **acción primaria** de esta pantalla? Debe ser visualmente
      única (un botón dominante), no una entre 3-4 botones del mismo peso.
- [ ] ¿Todo elemento tocable mide **≥ 44×44 pt** de área tocable (incluyendo
      `hitSlop` si el visual es más chico)?
- [ ] ¿El texto usa los tamaños de `theme.ts` / la escala existente, o se
      inventó un `fontSize` nuevo sin motivo?
- [ ] ¿Algún estado (error, atrasado, sintético, deshabilitado) se comunica
      **solo con color**? Si sí, agrega texto o ícono.
- [ ] ¿Hay un **estado vacío** definido (sin lecturas, sin historial) y no
      solo el "happy path" con datos?
- [ ] ¿Los mensajes de error dicen **qué pasó y qué hacer**, no solo "algo
      salió mal"?
- [ ] Si hay un campo numérico, ¿la unidad (mg/dL, U, g) está **visible
      junto al campo**, no solo en el label?
- [ ] ¿El flujo de registro más frecuente (nueva entrada) se puede completar
      en pocos toques? ¿Se le está pidiendo al usuario más de lo necesario
      para ese momento?
- [ ] ¿Alguna animación o transición es puramente decorativa? Si es larga o
      llamativa, evalúa si un `Reduce Motion` la desactivaría bien.
- [ ] ¿Un valor crítico (glucosa alta/baja, dato atrasado) tiene **más peso
      visual** que uno informativo, sin gritar en cada pantalla (fatiga de
      alarma)?

---

## Touch targets y espaciado

- **44×44 pt mínimo** para cualquier elemento tocable (botón, ícono,
  chip, celda de lista) — es el estándar de Apple HIG, pensado para el
  tamaño promedio de un dedo y para reducir toques accidentales.
  `ModalShell` ya usa `hitSlop={10}` en el botón "Cerrar" para llegar a ese
  mínimo aunque el texto sea chico — es el patrón a repetir en botones de
  ícono pequeños.
- Usa los tokens de `spacing` (`xs:4, sm:8, md:12, lg:16, xl:24, xxl:32`)
  para todo padding/margin nuevo. No introduzcas números sueltos (`10`,
  `18`, `22`) salvo que sea un ajuste fino documentado (como el `paddingHorizontal: 9`
  de la badge en `GlucoseCard`, que ya es una excepción puntual, no un
  patrón a copiar).
- Separa grupos de contenido con `spacing.xl`/`xxl`, campos relacionados
  dentro de un grupo con `spacing.md`/`lg`. `EntryModal` ya sigue este
  patrón (`sectionTitle` con `marginTop: spacing.xl`, campos con
  `spacing.md`) — mantenlo al agregar secciones nuevas.
- Deja aire alrededor de botones primarios: nunca los pegues directo debajo
  de un bloque de texto largo sin al menos `spacing.lg` de separación.
- En listas (Timeline), la fila completa debe ser tocable si lleva a un
  detalle — no solo el ícono o el texto.

## Tipografía

- No inventes tamaños de fuente sueltos por pantalla. El repo ya tiene una
  escala implícita reconocible en los componentes existentes: valor
  hero (~68px, `GlucoseCard`), título de sección (~21px, `ModalShell`),
  subtítulo de sección (~17px), cuerpo/label (~14-15px), metadata/caption
  (~11-13px). Antes de escribir un `fontSize` nuevo, mapea qué rol cumple
  el texto (¿es el valor principal? ¿un label? ¿una nota al pie?) y usa el
  tamaño que ya cumple ese rol en otro componente.
- Evita texto por debajo de **11px** para cualquier cosa que el usuario deba
  poder leer sin esfuerzo — mensajes de seguridad, disclaimers médicos, no
  solo adorno. `GlucoseCard.disclaimer` usa `fontSize: 10` para "No sustituye
  las alarmas ni la app oficial de FreeStyle" — es exactamente el tipo de
  texto (aviso de seguridad) que Apple HIG desaconseja poner en el tamaño
  más chico de la escala. Es candidato a subir a 11-12px.
- El proyecto no usa actualmente ninguna forma de escalado por accesibilidad
  (Dynamic Type / `allowFontScaling`, `PixelRatio.getFontScale`). Todos los
  `fontSize` están fijos en píxeles. Si se prioriza este ítem, la regla HIG
  es: los textos deben responder al tamaño de letra del sistema en vez de
  quedar fijos — al menos no desactivar el `allowFontScaling` por defecto de
  RN en textos de body/label, y probar con "Texto grande" activado en el
  dispositivo antes de dar por cerrada una pantalla nueva.
- Jerarquía: en pantallas con un valor numérico protagonista (glucosa,
  dosis calculada), ese número debe ser claramente el elemento más grande
  de la pantalla — como ya hace `value` en `GlucoseCard` (68px) y
  `resultValue` en `CorrectionModal`/`EntryModal` (44-48px). No agregues
  otro elemento que compita en tamaño en la misma vista.

## Color y contraste

- Contraste mínimo **4.5:1** para texto normal y **3:1** para texto grande
  (≥18pt o ≥14pt bold), siguiendo WCAG/Apple HIG. Antes de introducir un
  color de texto nuevo sobre un fondo nuevo, verifícalo con una calculadora
  de contraste — no asumas que "se ve bien" en el simulador con luz de
  oficina.
- **Nunca comuniques un estado solo con color.** Es una regla explícita de
  Apple HIG ("don't rely solely on color to differentiate objects or
  communicate important information") y es doblemente crítica en una app de
  salud para personas daltónicas o con baja visión. `GlucoseCard` ya hace
  esto bien: la badge de estado (`EN LÍNEA`/`MANUAL`/`SINTÉTICO`/`ATRASADO`)
  siempre lleva texto, nunca es solo un punto de color. Mantén ese patrón en
  cualquier indicador de estado nuevo — no reduzcas una badge a un simple
  dot coloreado.
- Evita combinaciones problemáticas para daltonismo como único diferenciador:
  rojo/verde, rojo/negro, rojo o verde con gris. La app ya usa rojo para
  "alto riesgo/atrasado" y verde para "en línea/ok" (`colors.red`,
  `colors.green`) — está bien porque siempre va acompañado de texto y forma
  distinta (badge, ícono), pero si se agrega una nueva pareja rojo/verde sin
  texto, es una regresión de accesibilidad.
- Reserva `colors.red`/`colors.redSoft` para lo genuinamente urgente
  (hipoglucemia, dato atrasado, error de guardado). Usarlo para avisos
  menores le resta peso a las alertas que sí importan — ver "fatiga de
  alarma" más abajo.
- Los tokens `Soft` (`redSoft`, `greenSoft`, `warningSoft`, `tealSoft`,
  `orangeSoft`) ya dan un patrón de "fondo suave + texto saturado" para
  cajas de aviso (ver `warningBox`/`hypoBox` en `CorrectionModal`). Sigue
  ese patrón para cajas de estado nuevas en vez de inventar otro estilo de
  alerta.

## Movimiento y animación

- Las transiciones de modal ya usan `animationType="slide"` +
  `presentationStyle="pageSheet"` (`ModalShell`), que es el patrón nativo de
  iOS para hojas modales — correcto, mantenlo como estándar para modales
  nuevos en vez de introducir animaciones custom.
- Toda animación debe ser funcional (indicar progreso, dirección, relación
  causa-efecto), nunca decorativa. Si una animación es la única forma de
  comunicar algo importante, es un error — debe haber también un indicador
  estático (texto, ícono) para cuando el sistema tiene "Reducir movimiento"
  activado.
- Si en el futuro se agregan animaciones custom (transiciones de carta,
  gráficos animados), deben respetar la preferencia de accesibilidad
  "Reducir movimiento" del sistema (`AccessibilityInfo.isReduceMotionEnabled`
  en RN) y degradar a un cross-fade o corte directo.
- No agregues animaciones de "celebración" (confetti, bounces largos) en
  una app de salud: en este dominio la calma y la previsibilidad valen más
  que el deleite — un usuario registrando una hipoglucemia no debería ver
  una animación festiva.

## Formularios y entrada de datos

- **La unidad va pegada al campo**, no solo en el label. Ya es el patrón en
  el componente `Field` compartido de `CorrectionModal`/`EntryModal`
  (`fieldUnit` dentro de `fieldInputWrap`, al lado del input) — todo campo
  numérico nuevo debe usar ese mismo patrón, nunca un input pelado con la
  unidad solo en el texto de arriba.
- **`keyboardType="decimal-pad"`** para todo campo numérico (glucosa, carbs,
  unidades) — ya es consistente en el repo, mantenlo.
- **`selectTextOnFocus`** en campos que suelen reescribirse completos (ya
  usado en `Field`) — evita que el usuario tenga que borrar dígito por
  dígito un valor precargado.
- Precarga valores conocidos (glucosa del sensor) pero dejá clarísimo de
  dónde vienen y si siguen vigentes — el patrón de "Precargada desde el
  sensor / medición manual / SINTÉTICA" en `EntryModal`/`CorrectionModal` es
  el estándar a replicar para cualquier valor autocompletado nuevo: nunca
  autocompletar en silencio un dato médico sin decir su origen y frescura.
- Evita más de ~5-7 campos visibles simultáneamente en una sola pantalla sin
  agrupar. `EntryModal` ya agrupa con `sectionTitle` (Glucosa / Comida /
  Calculadora de dosis / Insulina / Nota) — es el patrón correcto para un
  formulario largo; si se agrega una sección nueva, agrúpala igual en vez de
  sumarla suelta al final.
- Un campo vacío no es un error: distingue "vacío" (`placeholder` gris) de
  "inválido" (mensaje de error explícito). Ya se hace bien con
  `placeholder="—"` + `placeholderTextColor: colors.muted`.
- Mensajes de validación deben decir qué corregir, no solo que algo falló
  — el repo ya tiene buenos ejemplos ("Escribe los carbohidratos entre 0 y
  500 g (o déjalo vacío)") que deberían ser el estándar para nuevos mensajes,
  en vez de genéricos tipo "Valor inválido".
- **Botón primario único y visualmente dominante por pantalla/sección.** Acá
  es donde `EntryModal` se aparta de la guía: en una sola hoja hay tres
  botones de acción con peso visual similar y colores distintos —
  "Calcular dosis sugerida" (teal), "Usar N U como rápida" (azul) y
  "Guardar entrada" (naranja) — más "Foto para estimar carbohidratos"
  (navy). Cada uno tiene su lugar en el flujo, pero al no haber una jerarquía
  de color clara entre ellos (4 colores de botón distintos en una pantalla),
  el ojo no tiene un solo lugar obvio donde ir. Si se retoca esta pantalla,
  vale la pena definir un color para "acción primaria de esta hoja" (p.ej.
  Guardar) y bajar el peso visual de las acciones secundarias (contorno en
  vez de relleno, o un tono más apagado) en vez de cuatro botones sólidos
  compitiendo.

## Navegación

- Máximo ~5 destinos en una barra de navegación inferior (si se agrega una
  en el futuro) — más que eso obliga a un menú "Más" que rompe la
  previsibilidad.
- Las hojas modales (`ModalShell`) deben tener siempre una forma obvia y
  consistente de cerrar (ya tiene "Cerrar" arriba a la derecha) — no
  dependas solo del gesto de swipe-down, que no todos descubren.
- No anides más de un modal sobre otro modal salvo que sea estrictamente
  necesario (p. ej. confirmación destructiva) — cada nivel de modal es una
  pérdida de contexto para alguien que puede estar interrumpido.
- El título del modal (`ModalShell title`) debe nombrar la acción, no el
  concepto genérico — "Corrección experimental", "Nueva entrada" ya siguen
  esto bien; evita títulos como "Detalle" o "Editar" sin más contexto.

## Estados vacíos y de error

- Todo estado vacío necesita texto explicativo + siguiente paso posible, no
  solo "sin datos". `GlucoseCard` ya lo hace bien
  ("Sin lecturas CGM" / "Puedes seguir registrando carbohidratos e insulina
  sin conexión.") — replica ese patrón (qué pasó + qué puedo hacer igual)
  en cualquier lista o pantalla que pueda estar vacía (Timeline sin
  eventos, historial sin importar, etc.).
- Los mensajes de error deben ser específicos y accionables (ver sección de
  formularios); evita mensajes genéricos de "algo salió mal" cuando se sabe
  la causa real (red, validación, permiso denegado). El manejo de permiso
  de cámara denegado en `EntryModal` ("No hay permiso de cámara. Puedes
  escribir los carbohidratos a mano.") es el estándar: explica la causa y
  ofrece la alternativa manual, coherente con la regla de AGENTS.md de que
  todo proveedor externo debe degradar a entrada manual.
- Un estado de "cargando" (`busy`) debe deshabilitar el botón y cambiar su
  texto (ya se hace: "Calculando…", "Guardando…") — no dejar el botón
  activo mientras hay una operación en curso, para evitar doble envío.
- Los `disabled` de botones deben tener una señal visual clara además de la
  opacidad (`styles.disabled: { opacity: 0.55 }` ya existe y es un buen
  mínimo) — mantenlo consistente al agregar botones nuevos.

## Patrones específicos de apps de salud/diabetes

- **Menos es más en la pantalla principal.** El valor de glucosa actual, su
  tendencia (flecha) y su frescura deben ser lo primero y más grande que se
  ve, como ya hace `GlucoseCard` (valor a 68px, flecha de tendencia al
  lado, timestamp relativo debajo). No agregues métricas secundarias que
  compitan visualmente con ese valor principal.
- **La procedencia y frescura del dato son información de seguridad, no
  decoración.** Este repo ya lo trata así (badges EN LÍNEA/MANUAL/SINTÉTICO/
  ATRASADO, mensajes de "la lectura dejó de estar vigente") — es exactamente
  el patrón que la literatura de usabilidad en apps de diabetes identifica
  como crítico: un usuario no debe poder confundir un dato de hace 3 horas
  con uno actual. Cualquier pantalla nueva que muestre un valor médico debe
  mostrar también su antigüedad.
- **El registro frecuente debe ser rápido.** Alguien con diabetes tipo 1
  registra glucosa/comida/insulina varias veces al día — cada campo extra
  o paso adicional en el flujo de "Nueva entrada" tiene un costo compuesto.
  Antes de agregar un campo nuevo a `EntryModal`, pregunta si de verdad se
  necesita en ese momento o si puede vivir en otro lado (ajustes, detalle
  posterior).
- **Evita la fatiga de alarma.** No todo dato atípico merece el mismo rojo
  urgente. Reserva el color/tono más alarmante para lo que requiere acción
  inmediata (hipoglucemia, sensor sin datos hace horas) y usa un tono
  intermedio (`warning`/`warningSoft`) para lo que es solo "atención, no
  emergencia" — la distinción entre `staleBadge` (rojo) y
  `syntheticBadge` (warning/ámbar) en `GlucoseCard` ya sigue este principio;
  no lo aplanes a "todo es rojo" al agregar estados nuevos.
- **Nunca presentes un cálculo como una recomendación.** Ya es una regla de
  `AGENTS.md`, pero tiene una cara de UX: `CorrectionModal`/`EntryModal` ya
  refuerzan esto visualmente con el label "RESULTADO DE LA FÓRMULA" en vez
  de "Dosis recomendada", y con el warningBox explícito arriba del cálculo.
  Cualquier pantalla nueva que muestre un número derivado de una fórmula
  debe mantener ese lenguaje neutro y mostrar la fórmula misma, no solo el
  resultado.
- **Construir confianza con transparencia, no con silencio.** Cuando el
  sistema tiene que degradarse (sin sensor, IA no disponible, dato
  sintético en modo demo), decirlo explícitamente en la UI — como ya hace
  la app — genera más confianza a largo plazo que ocultar el problema. No
  "arregles" un estado degradado escondiendo el aviso para que la pantalla
  se vea más prolija.

## Notificaciones y alertas

- (No implementadas aún en el MVP — estas son reglas para cuando se
  agreguen.) Toda alerta debe distinguir claramente **crítica** (requiere
  acción, ej. hipoglucemia detectada) de **informativa** (puede revisarse
  después, ej. "hace 3 días no registras insulina basal"). No uses el mismo
  estilo de notificación para ambas.
- No dupliques alarmas que el dispositivo/app oficial del sensor ya emite —
  el disclaimer existente ("No sustituye las alarmas ni la app oficial de
  FreeStyle") ya fija esa frontera; cualquier notificación nueva debe
  respetarla y no competir con el sistema de alarmas del fabricante del
  CGM.
- Agrupa notificaciones relacionadas en vez de enviar una por evento —
  mandar una notificación por cada lectura es la causa número uno de fatiga
  de alarma documentada en apps de salud.
- Toda notificación debe llevar a una acción concreta dentro de la app al
  tocarla, no solo informar.

---

## Fuentes

- [Apple HIG — Layout (Foundations)](https://developers.apple.com/design/human-interface-guidelines/foundations/layout/)
- [Apple HIG — Typography (Foundations)](https://developers.apple.com/design/human-interface-guidelines/foundations/typography/)
- [Apple HIG — Color and Contrast (Accessibility)](https://developers.apple.com/design/human-interface-guidelines/accessibility/overview/color-and-contrast/)
- [Apple HIG — Color (Foundations)](https://developers.apple.com/design/human-interface-guidelines/foundations/color/)
- [Apple HIG — Motion (Foundations)](https://developers.apple.com/design/human-interface-guidelines/foundations/motion)
- [Apple HIG — Accessibility (Foundations)](https://developers.apple.com/design/human-interface-guidelines/foundations/accessibility)
- [LukeW — Touch Target Sizes](https://www.lukew.com/ff/entry.asp?1085=)
- [A product designer's guide to Dynamic Type in iOS — Medium/Bootcamp](https://medium.com/design-bootcamp/a-product-designers-guide-to-dynamic-type-in-ios-a105dda39a95)
- [Usability Evaluation of Four Top-Rated Commercially Available Diabetes Apps for Adults With Type 2 Diabetes — PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7710160/)
- [Content Analysis: First-Time Patient User Challenges with Top-Rated Commercial Diabetes Apps — PMC](https://pmc.ncbi.nlm.nih.gov/articles/PMC8349717/)
- [mySugr — Diabetes Tracker Log (App Store)](https://apps.apple.com/us/app/mysugr-diabetes-tracker-log/id516509211)
- [mySugr App Overview — Accu-Chek/Roche](https://www.rochediabetescareme.com/training/cgm/mysugr/app-overview)
- [Designing Effective Medical Notifications to Counter Alert Fatigue — Invene](https://www.invene.com/blog/designing-experiences-to-counter-alert-fatigue)
- [Using mHealth to Reduce Alarm Fatigue and Improve Care Coordination — mHealthIntelligence](https://mhealthintelligence.com/news/using-mhealth-to-reduce-alarm-fatigue-and-improve-care-coordination)
- [Healthcare UX Design: Patient and Provider App Principles — Momentum](https://www.themomentum.ai/blog/healthcare-ux-design-principles-patient-provider-apps)
