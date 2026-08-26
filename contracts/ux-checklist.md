# Contrato — checklist de pantalla

> **Capa 1 · consumido por** `/ui-screen`, `/app-shell`
> Es lo que se **verifica**; el porqué (tipografía, escalas de espaciado,
> color) está en `memory-bank/reference/ux-rationale.md` y se lee solo al
> diseñar algo sin patrón previo, nunca para revisar una pantalla.

Antes de dar por buena una pantalla o modal, nuevo o modificado:

- [ ] La **acción primaria** es visualmente única — un botón dominante, no una
      entre tres del mismo peso.
- [ ] Todo elemento tocable mide **≥ 44×44 pt**, `hitSlop` incluido.
- [ ] El texto usa los tamaños de `theme.ts`; ningún `fontSize`, color hex ni
      padding inventado si ya hay token.
- [ ] **Ningún estado se comunica solo con color** — error, atrasado,
      sintético, importado, deshabilitado, banda de glucosa: todos llevan texto
      o icono además del color. Es regla de accesibilidad **y** frontera de
      seguridad de `AGENTS.md`.
- [ ] Hay **estado vacío** definido ("todavía no hay nada" + qué hacer), no solo
      el happy path.
- [ ] Los errores dicen **qué pasó y qué hacer**, y aclaran que los datos de la
      usuaria están intactos cuando solo falló la vista.
- [ ] Todo campo numérico muestra su **unidad junto al campo** (mg/dL, U, g),
      no solo en el label.
- [ ] El registro más frecuente se completa en pocos toques, sin pedir más de
      lo necesario para ese momento.
- [ ] Ninguna animación decorativa larga; se respeta **Reduce Motion**
      (`ModalShell` ya lee la preferencia).
- [ ] Un valor crítico pesa más visualmente que uno informativo, **sin gritar en
      cada pantalla** (fatiga de alarma).

## No negociable en esta app

- **Nada de navegación nueva.** Una pantalla es un `Modal` vía `ModalShell`.
  Sub-páginas = pestañas dentro del modal (ver `SummaryModal.tsx`), nunca una
  dependencia nueva.
- **Ningún componente calcula una métrica de salud.** Todo agregado (TIR,
  HbA1c estimada, percentiles, promedios, patrones) vive en `packages/domain`,
  es puro y tiene test. El `.tsx` elige rango, formatea y dibuja.
- **Iconos de Lucide por subpath**, nunca desde el barrel ni como glifo Unicode.

## Textos que tocan seguridad

Cuando la pantalla muestre algo derivado de glucosa o insulina, los strings son
superficie de seguridad, no decoración:

- Una HbA1c calculada se rotula **siempre** "estimada", y nunca queda junto a
  una de laboratorio sin distinguirlas.
- Una estadística de resultados se redacta como **descripción de lo que pasó**,
  nunca como evaluación de si una dosis fue adecuada ni sugerencia de cambiarla.
- Toda pantalla con estadísticas derivadas de insulina lleva visible que la app
  no calcula ni recomienda insulina.
- Si una métrica puede leerse como **nota de desempeño** al lado de una dosis,
  se descompone hasta que la inferencia equivocada sea imposible (bajo / en
  rango / alto por separado, no un solo "% en rango"). **Una nota al pie no
  arregla una visualización que invita a la lectura errónea.**
- Si otro componente ya resolvió una distinción de seguridad, **importa su
  predicado** en vez de escribir uno más laxo — ver `isNonSensorReading()`.
