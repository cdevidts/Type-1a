# UX — el porqué

**Esto no se lee para revisar una pantalla.** Para eso está
`contracts/ux-checklist.md`, que es lo que se verifica. Esto se lee cuando vas a
diseñar algo **sin patrón previo** en la app y necesitas saber de dónde salió
cada número. Las fuentes están en `reference/clinical-sources.md`.

## Escala tipográfica

No hay tokens de `fontSize`: hay una escala implícita, reconocible en los
componentes existentes. Antes de escribir un tamaño nuevo, mapea **qué rol
cumple el texto** y usa el que ya cumple ese rol:

| Rol | px | Dónde ya vive |
|---|---|---|
| valor hero | ~68 | `GlucoseCard.value` |
| resultado de fórmula | 44-48 | `CorrectionModal`, `EntryModal` |
| título de sección | ~21 | `ModalShell` |
| subtítulo | ~17 | |
| cuerpo / label | 14-15 | |
| metadata / caption | 11-13 | |

**Nada legible por debajo de 11 px.** `GlucoseCard.disclaimer` está en 10 y es
justamente un aviso de seguridad ("No sustituye las alarmas ni la app oficial de
FreeStyle") — deuda conocida, candidato a subir a 11-12.

En una pantalla con un número protagonista (glucosa, dosis calculada), ese
número es **claramente** el elemento más grande. Nada compite con él.

**Sin escalado por accesibilidad todavía.** Todos los `fontSize` están fijos en
píxeles; la app no usa Dynamic Type ni `PixelRatio.getFontScale`. Si esto se
prioriza, la regla es no desactivar el `allowFontScaling` por defecto de RN en
body/label y probar con "Texto grande" antes de cerrar una pantalla.

## Espaciado

Tokens: `xs:4, sm:8, md:12, lg:16, xl:24, xxl:32`. Grupos de contenido se
separan con `xl`/`xxl`; campos dentro de un grupo con `md`/`lg`. Un botón
primario nunca va pegado bajo un bloque de texto largo: mínimo `lg`.

Números sueltos (`10`, `18`, `22`) solo como ajuste fino documentado — el
`paddingHorizontal: 9` de la badge de `GlucoseCard` es una excepción puntual, no
un patrón a copiar.

### Dos bugs de layout que definieron reglas

**El padding lo posee un solo nivel.** `ModalShell` aplicaba
`padding: spacing.lg` en su `content` aunque el hijo (`SummaryModal`,
`scroll={false}`) ya traía su propio `ScrollView` con su propio padding — dos
capas de inset horizontal, mientras el ancho de gráfico calculado restaba una
sola. Los gráficos se dibujaban más anchos que el espacio real. Si el hijo trae
su propio scroll/padding, el padre no agrega el suyo, y cualquier `width`
calculado resta **exactamente** las capas que existen, ni una más ni una menos.

**`flexShrink: 1` en un solo lado de un `space-between` no alcanza.** Un
encabezado con título (`flexShrink: 1`) y meta larga (sin límite de ancho) en la
misma fila comprimía el título hasta partirlo letra por letra. Con dos textos de
largo variable: o los dos llevan `flexShrink`/`maxWidth`, o se apilan en columna.

## Color y contraste

Mínimo **4.5:1** para texto normal, **3:1** para texto grande (≥18 pt, o ≥14 pt
bold). Se verifica con calculadora, no a ojo en el simulador.

Rojo/verde nunca como único diferenciador — la app usa rojo para "alto riesgo /
atrasado" y verde para "en línea", y funciona **porque siempre va con texto y
forma distinta**. Una pareja rojo/verde nueva sin texto es una regresión.

`colors.red`/`redSoft` se reservan para lo genuinamente urgente: hipoglucemia,
dato atrasado, error de guardado. Usarlo para avisos menores le resta peso a las
alertas que sí importan. El escalón intermedio es `warning`/`warningSoft` — la
distinción entre `staleBadge` (rojo) y `syntheticBadge` (ámbar) en `GlucoseCard`
ya sigue ese principio; no lo aplanes a "todo rojo".

Los tokens `Soft` dan el patrón "fondo suave + texto saturado" para cajas de
aviso (`warningBox`/`hypoBox` en `CorrectionModal`). Se sigue ese, no se inventa
otro estilo de alerta.

## Movimiento

`animationType="slide"` + `presentationStyle="pageSheet"` es el estándar de
modales (`ModalShell`). Toda animación es funcional — progreso, dirección,
causa-efecto — nunca decorativa, y nunca la única forma de comunicar algo: tiene
que haber un indicador estático para cuando "Reducir movimiento" está activo.

**Nada de celebración.** Ni confetti ni bounces largos: en este dominio la calma
y la previsibilidad valen más que el deleite. Alguien registrando una
hipoglucemia no debería ver una animación festiva.

## Formularios

- La unidad va **pegada al campo** (patrón `fieldUnit` dentro de
  `fieldInputWrap`), nunca solo en el label de arriba.
- `keyboardType="decimal-pad"` en todo campo numérico; `selectTextOnFocus` en
  los que se reescriben completos.
- Precargar un valor conocido está bien, **decir de dónde viene y si sigue
  vigente es obligatorio** ("Precargada desde el sensor / manual / SINTÉTICA").
  Nunca autocompletar en silencio un dato médico.
- Máximo ~5-7 campos visibles sin agrupar. `EntryModal` agrupa con
  `sectionTitle`; una sección nueva se agrupa igual, no se suma suelta al final.
- Vacío ≠ inválido: `placeholder="—"` gris para lo primero, mensaje explícito
  para lo segundo. El mensaje dice **qué corregir** ("Escribe los carbohidratos
  entre 0 y 500 g (o déjalo vacío)"), no "Valor inválido".

**Deuda conocida:** `EntryModal` tiene cuatro botones sólidos de colores
distintos compitiendo por la atención. Si se retoca esa pantalla, definir un
color de "acción primaria de esta hoja" y bajar las secundarias a contorno.

## Navegación

`SafeAreaView` viene de `react-native-safe-area-context`, **nunca** de
`react-native`: el de RN es iOS-only y en Android no aplica ningún inset. Con
edge-to-edge obligatorio desde Expo SDK 54 eso dejó el botón "Cerrar" tapado por
la hora y la batería, en todos los modales a la vez.

Máximo ~5 destinos en la barra inferior. Un modal siempre tiene forma visible de
cerrarse (no solo swipe-down). No se anidan modales salvo confirmación
destructiva. El título nombra la acción ("Nueva entrada"), no el concepto
("Detalle").

## Salud y diabetes

- **Menos es más en la principal.** Valor actual, tendencia y frescura primero y
  más grande. Nada secundario compite.
- **Procedencia y frescura son información de seguridad.** Nadie puede confundir
  un dato de hace tres horas con uno actual.
- **El registro frecuente es rápido.** Se registra varias veces al día: cada
  campo extra tiene costo compuesto. Antes de agregar uno, preguntar si de
  verdad hace falta *en ese momento* o si vive en ajustes o en el detalle.
- **Un cálculo nunca se presenta como recomendación.** "RESULTADO DE LA FÓRMULA",
  no "Dosis recomendada", y se muestra la fórmula, no solo el resultado.
- **Transparencia antes que silencio.** Un estado degradado se dice; no se
  "arregla" escondiendo el aviso para que la pantalla se vea prolija.

## Notificaciones

Crítica (requiere acción) e informativa no comparten estilo. No se duplican las
alarmas que ya emite la app oficial del sensor — esa frontera la fija el
disclaimer. Se agrupan las relacionadas: una notificación por lectura es la
causa número uno de fatiga de alarma documentada. Toda notificación lleva a una
acción concreta al tocarla.
