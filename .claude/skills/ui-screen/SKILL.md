---
name: ui-screen
description: Design or review any Type 1A mobile screen, modal, or chart so it matches the app's real design system instead of inventing a parallel one. Use whenever building or changing ANY file under apps/mobile/src/components, App.tsx, or any .tsx with JSX — even when the run's main task isn't UI-focused (a data fix, a backend-adjacent task) but incidentally touches a component. Also use when adding a chart or data visualization, choosing colors for glucose/insulin/carb data, or when the user asks for a screen to look "professional", "clear", "comfortable", or "like MySugr/Clarity".
---

Construir o revisar una pantalla de `apps/mobile` sin reinventar el sistema de
diseño ni la paleta.

**Prioridad (2026-08-19, pedido explícito de Verónica): esta skill no es
exclusiva de tareas de UI declaradas.** Si el cambio toca un `.tsx` con JSX
por cualquier motivo, se invoca esta skill antes de escribir el cambio —
aunque el pedido de la corrida haya sido otra cosa (un fix de datos, algo
de backend que de paso roza un modal). No hay una skill de terceros más
específica para React Native disponible en el marketplace (se buscó
explícitamente); esta y `dataviz` son lo más afinado que hay, así que la
disciplina está en invocarlas siempre que corresponda, no en sumar más
herramientas.

## 0. Antes de escribir una línea de UI

Lee, en este orden, y no de memoria:

1. [`docs/UX_GUIDELINES.md`](../../../docs/UX_GUIDELINES.md) — el checklist del
   inicio es obligatorio para cualquier pantalla nueva o revisada. Traduce las
   Apple HIG y prácticas de apps de salud a reglas contra el código real.
2. [`apps/mobile/src/theme.ts`](../../../apps/mobile/src/theme.ts) — los tokens
   reales: `colors`, `spacing`, `radius`, `glucoseBands`. **No inventes un
   `fontSize`, un color hex ni un padding suelto** si ya hay un token.
3. Un componente existente parecido a lo que vas a construir
   (`SummaryModal.tsx` para una pantalla con pestañas, `EntryModal.tsx` para un
   formulario, `SettingsModal.tsx` para secciones de ajustes). Copia el patrón
   antes de crear uno nuevo.

## 1. Reglas no negociables de esta app

- **Nada de navegación nueva.** La app no tiene librería de navegación: una
  pantalla es un `Modal` a través de `ModalShell`. Si necesitas sub-páginas,
  usa una barra de pestañas dentro del modal (ver `SummaryModal.tsx`), no una
  dependencia nueva.
- **44×44 pt mínimo** de área tocable en todo lo presionable, `hitSlop`
  incluido.
- **Ningún estado se comunica solo con color.** Sintético, importado,
  atrasado, error, banda de glucosa: todos llevan texto o ícono además del
  color. Es regla de HIG *y* frontera de seguridad de `AGENTS.md`
  (dato sintético/importado nunca puede leerse como dato de sensor en vivo).
- **Estado vacío obligatorio.** Toda pantalla que muestre datos necesita el
  caso "todavía no hay nada", con qué hacer para que aparezca algo. No basta
  el happy path.
- **Los errores dicen qué pasó y qué hacer**, y aclaran que los datos del
  usuario están intactos cuando solo falló la vista.
- **La acción primaria es visualmente única.** Un botón dominante, no tres del
  mismo peso.

## 2. Gráficos y visualización de datos

Antes de escribir código de gráfico, **carga la skill global `dataviz`** — trae
el método completo (elegir la forma, asignar color por su trabajo, validar,
especificaciones de marca, anti-patrones). Lo que sigue es cómo ese método ya
quedó instanciado en este repo; no lo re-derives:

- **Motor**: `react-native-svg` en la app, SVG inline en el PDF
  (`src/reportExport.ts`). No agregues una librería de gráficos.
- **Paleta de bandas de glucosa**: `glucoseBands` en `theme.ts`. Ya está
  validada con `scripts/validate_palette.js` de la skill `dataviz`; está
  documentada ahí cuál es el único FAIL aceptado a conciencia y por qué. **No
  la cambies sin volver a correr el validador** y actualizar ese comentario.
- **Un solo eje.** Nunca dos escalas Y en el mismo gráfico. Dos medidas de
  escala distinta = dos gráficos.
- **Grilla y ejes recesivos** (`colors.line`, `colors.muted`), marcas finas, y
  el dato con el peso visual.
- **Leyenda siempre que haya más de una serie**; una sola serie no necesita
  caja de leyenda (el título la nombra).
- **Umbrales clínicos vienen de `packages/domain`**
  (`glucose-thresholds.ts`: 54/70/180/250 mg/dL). Nunca los redeclares en un
  componente.
- **Formato clínico estándar antes que uno propio.** Para perfiles de glucosa
  usa el formato AGP (mediana + p25–p75 + p05–p95 sobre 24 h), que es lo que
  ya leen LibreView, Dexcom Clarity y un equipo médico. Ver
  `packages/domain/src/agp.ts`.

## 3. Dónde vive el cálculo

**Ningún componente calcula una métrica de salud.** Todo agregado
(Time in Range, HbA1c estimada, percentiles, promedios, patrones) vive en
`packages/domain`, es puro, determinístico y tiene test. El componente elige
rango, formatea y dibuja. Si te descubres promediando glucosa dentro de un
`.tsx`, el cálculo va a `packages/domain`.

## 4. Textos que tocan seguridad

Cuando la pantalla muestre cualquier cosa derivada de glucosa o insulina, los
strings visibles son parte de la superficie de seguridad, no decoración:

- Una HbA1c calculada por la app se rotula **siempre** "estimada", y nunca
  queda junto a una de laboratorio sin distinguirlas.
- Una estadística de resultados (ej. "% en rango después de una dosis") se
  redacta como descripción de lo que pasó, **nunca** como evaluación de si una
  dosis fue adecuada ni como sugerencia de cambiarla.
- Toda pantalla con estadísticas derivadas de insulina lleva visible que la app
  no calcula ni recomienda insulina, y que los cambios se deciden con el equipo
  clínico.
- Si una métrica derivada puede leerse como una **nota de desempeño** al lado
  de una dosis, descompónla hasta que la inferencia equivocada sea imposible
  (ej. bajo / en rango / alto por separado, no un solo "% en rango"). Una
  nota al pie no arregla una visualización que invita a la lectura errónea.
- Si otro componente ya resolvió una distinción de seguridad
  (sensor vs. manual/importado, en vivo vs. atrasado), **importa su predicado
  en vez de escribir uno nuevo más laxo** — ver `isNonSensorReading()` en
  `SummaryCharts.tsx`.
- Una meta de consenso poblacional (ej. ">70% en rango") se muestra como
  contexto de lectura, aclarando que el objetivo personal lo define el equipo
  clínico — nunca como si la app se lo hubiera fijado al usuario.

## 5. Antes de dar por terminado

1. Repasa el checklist de `docs/UX_GUIDELINES.md` contra tu pantalla.
2. `pnpm verify`.
3. Si tocaste `packages/domain` o cualquier texto que hable de dosis, corre el
   subagente `domain-safety-reviewer`.
4. Actualiza `docs/CODE_MAP.md` con el componente nuevo, y
   `docs/AI_CHAT_ARCHITECTURE.md` si agregaste una capacidad que el chat futuro
   debería poder alcanzar.
