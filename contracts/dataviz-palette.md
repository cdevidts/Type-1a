# Contrato — gráficos y visualización de datos

> **Capa 1 · consumido por** `/ui-screen` (junto con la skill global `dataviz`)
> Es cómo el método de la skill `dataviz` quedó instanciado en este repo:
> **no lo re-derives cada vez.** El porqué está en
> `memory-bank/reference/ux-rationale.md`.

## Motor

`react-native-svg` en la app (`GlucoseChart`, `SummaryCharts`), SVG inline en el
PDF (`src/reportExport.ts`). **No se agrega una librería de gráficos.**

## Reglas de forma

- [ ] **Un solo eje Y.** Dos medidas de escala distinta son dos gráficos.
- [ ] Grilla y ejes **recesivos** (`colors.line`, `colors.muted`, trazos de 1px);
      el peso visual es del dato.
- [ ] Etiquetas del eje Y **solo en los umbrales que importan clínicamente**
      (70/180/250), no una escala completa: más marcas es ruido en 390 pt.
- [ ] **Leyenda siempre que haya más de una serie.** Una sola no la necesita —
      el título ya la nombra.
- [ ] El texto lleva **tokens de texto**, nunca el color de la serie. El color
      vive en la marca (punto, franja, swatch) que va al lado.

## Reglas de seguridad

- [ ] **La identidad nunca descansa solo en el color.** Vale doble acá: es
      accesibilidad **y** frontera de `AGENTS.md`. Una banda de glucosa muestra
      siempre su etiqueta y su rango en mg/dL; un dato importado o sintético se
      distingue por algo más que el tono (opacidad + texto, o no se grafica).
- [ ] **Los umbrales vienen de `packages/domain`**
      (`glucose-thresholds.ts`: 54/70/180/250 mg/dL). Ningún componente los
      redeclara.
- [ ] **Formato clínico estándar antes que uno propio.** Para un perfil
      multi-día se usa AGP (mediana + p25–p75 + p05–p95 sobre 24 h), que es lo
      que ya leen LibreView y Dexcom Clarity. Inventar una visualización para
      algo que ya tiene estándar clínico le cuesta al equipo médico traducirla
      en la consulta.
- [ ] **La paleta se valida, no se elige a ojo.** `glucoseBands` en `theme.ts`
      pasó por `scripts/validate_palette.js` de la skill `dataviz` (luminosidad,
      daltonismo, contraste). El único FAIL aceptado a conciencia está
      documentado en `theme.ts` con su razón. Si cambias esos colores, **vuelve
      a correr el validador** y actualiza ese comentario.
- [ ] Si otro componente ya resolvió una distinción de seguridad, **copia su
      predicado** en vez de escribir uno más laxo (`isNonSensorReading()`).
- [ ] Toda cifra agregada muestra su **n**, y si el número está ajustado por
      covariables lo declara. Un promedio ajustado y uno crudo no significan lo
      mismo.
