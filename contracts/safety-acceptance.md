# Contrato — criterios de aceptación de seguridad

> **Capa 1 · consumido por** `domain-safety-reviewer`, `/safety-audit`
> Extraído de `docs/MVP_IMPLEMENTATION_BRIEF.md` §Safety acceptance criteria.
> Imperativo, sin historia. El porqué de cada regla vive en `AGENTS.md`.

Un cambio que viole cualquiera de estos puntos es un **hallazgo de seguridad
del paciente**, no una observación de estilo.

## Dosis y parámetros de terapia

- [ ] Insulina y carbohidratos **rechazan valores negativos**.
- [ ] Factor de corrección e incremento de pluma son **estrictamente positivos**.
- [ ] Objetivo, factor de corrección e incremento vienen de **entrada explícita
      de la usuaria**: nunca calculados ni derivados de otros datos.
- [ ] Ninguna pantalla que convierta esos valores en un número de insulina
      calcula mientras `therapyConfigured` es falso. Mostrar una dosis derivada
      de los placeholder de fábrica **es** inferir un parámetro de terapia.
- [ ] **No hay insulina activa (IOB) ni dosificación automática.** Se muestra
      contexto de insulina reciente; no se estima cuánta sigue actuando, no se
      multiplica duración × unidades, no se resta de ninguna dosis.
- [ ] Un número calculado llega a un campo que la usuaria puede **revisar y
      sobrescribir antes de guardar**, y se invalida si cambian sus insumos.

## CGM

- [ ] Un valor atrasado **nunca** se usa ni se muestra como actual sin marcarlo:
      todo camino que lea un CGM pasa por `assessFreshness` / `sourceTimestamp`
      (`packages/domain/src/freshness.ts`).
- [ ] Los datos sintéticos, importados y manuales quedan **visiblemente
      rotulados** y no pueden leerse como sensor en vivo.

## IA

- [ ] Los carbohidratos estimados por IA **nunca** se confirman en silencio:
      quedan separados de los confirmados por la usuaria.
- [ ] Toda salida de IA que llegue a la usuaria pasa por
      `containsTherapyRecommendation` (`packages/domain/src/ai-safety.ts`).
      Una llamada nueva cuyo resultado esquive ese filtro es un hallazgo.
- [ ] **Al agregar un campo al payload que va al modelo**, en el mismo cambio se
      amplía la prohibición del prompt, se agregan patrones y tests al filtro, y
      se mueve la versión del prompt. Al crecer lo que el modelo puede decir,
      crece el filtro.
- [ ] Un fallo de IA o de CGM **degrada a registro manual** y lo dice.

## Secretos y privacidad

- [ ] Ninguna clave `ABACUS_*`, `JUNCTION_*` ni material de firma aparece en
      `apps/mobile`, en logs, ni en cuerpos de request.
- [ ] No se loguean cuerpos con glucosa, insulina, comida, imágenes ni
      parámetros de terapia.

## Cobertura

- [ ] Un cambio a lógica sensible de `packages/domain` o `packages/ai` **sin
      test nuevo o actualizado** es en sí mismo un hallazgo (`AGENTS.md`
      §Completion).
- [ ] Si el cálculo produce un número que se lee como patrón clínico, el test
      **compara contra una verdad independiente**, no contra lo que la
      implementación devuelve hoy.
