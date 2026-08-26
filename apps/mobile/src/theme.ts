export const colors = {
  background: '#F4F7F8',
  surface: '#FFFFFF',
  ink: '#17212B',
  muted: '#667784',
  line: '#DCE5E9',
  teal: '#087E8B',
  tealSoft: '#DDF3F2',
  navy: '#173B57',
  blue: '#287BB5',
  orange: '#D96B27',
  orangeSoft: '#FFF0E5',
  red: '#B42318',
  redSoft: '#FDE8E7',
  green: '#19734B',
  greenSoft: '#DDF3E8',
  warning: '#9A6700',
  warningSoft: '#FFF2C7',
} as const;

/**
 * Bandas clínicas de glucosa (Time in Range). Son colores de **estado**, no
 * una paleta categórica: tres hues de estado (bajo / en rango / alto), y
 * dentro de bajo y alto un segundo paso más oscuro para el nivel severo,
 * formando una mini rampa secuencial monótona en luminosidad
 * (veryLow L.378 < low L.500; veryHigh L.456 < high L.648).
 *
 * Validados con el script de la skill `dataviz`
 * (`scripts/validate_palette.js`), no a ojo: los tres hues base pasan banda
 * de luminosidad, separación para daltonismo (peor par ΔE 14.1 protan) y
 * contraste ≥3:1 contra la superficie. Se acepta a conciencia un único
 * FAIL: el piso de croma del teal `#087E8B` — es el color de marca ya usado
 * en `GlucoseCard`/`GlucoseChart`, y cambiarlo solo para esta pantalla
 * rompería la consistencia de toda la app. Se compensa con la regla de
 * abajo.
 *
 * **Regla (HIG + `contracts/ux-checklist.md`): la identidad de una banda nunca
 * descansa solo en el color.** Cada banda se muestra siempre con su etiqueta
 * y su rango en mg/dL al lado.
 */
/**
 * Macronutrientes (Fase 14). Paleta **categórica** — tres cosas distintas,
 * no una escala — y deliberadamente separada de `glucoseBands`, que es de
 * **estado** clínico: reusar el color de una banda de glucosa para un macro
 * haría que una barra de proteína se leyera como "en rango".
 *
 * - `carbs` es el naranja de marca que la app ya usa para carbohidratos en
 *   los atajos de la pantalla principal; cambiarlo acá rompería la
 *   asociación que la usuaria ya tiene.
 * - `protein` y `fat` son hues nuevos, elegidos para no chocar con el azul
 *   (rápida) ni el navy (basal) de insulina.
 *
 * Validada con `scripts/validate_palette.js` de la skill `dataviz` contra la
 * superficie real de la app (#FFFFFF), no a ojo: **los cinco checks pasan**
 * (banda de luminosidad, piso de croma, separación para daltonismo — peor par
 * ΔE 8.4 protan —, piso de visión normal ΔE 23.1 y contraste ≥3:1). El par
 * más justo está apenas sobre el umbral de 8, así que **cada barra lleva
 * siempre su etiqueta y sus gramos**: la identidad nunca descansa solo en el
 * color. No cambiar sin volver a correr el validador.
 */
export const macroColors = {
  carbs: '#D96B27',
  protein: '#19734B',
  fat: '#7C4DA0',
} as const;

export const glucoseBands = {
  veryLow: '#7A1610',
  low: '#B42318',
  target: '#087E8B',
  high: '#D96B27',
  veryHigh: '#8A3D10',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 10,
  md: 16,
  lg: 24,
} as const;
