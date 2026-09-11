/**
 * Cuánta parte del rango elegido tiene datos de verdad.
 *
 * ## El bug que arregla
 *
 * La pantalla de Resumen solo mencionaba la cobertura cuando era **menor a 14
 * días**, que es el umbral clínico de confiabilidad de la HbA1c estimada. El
 * efecto secundario: eligiendo 30 o 90 días con, digamos, 22 días de datos, la
 * advertencia desaparecía y la pantalla decía "los últimos 90 días" sin nada
 * que la contradijera. Verónica lo notó justo así — a 7 y 14 días sí le
 * aparecía, a 30 y 90 no.
 *
 * Son **dos afirmaciones distintas** y por eso ahora se separan:
 *
 * 1. **Cuánto del rango está cubierto.** Descriptivo, y siempre relevante: un
 *    promedio sobre 22 de 90 días no es "los últimos 90 días", y presentarlo
 *    así deja creer que el número resume tres meses.
 * 2. **Si alcanza para que la HbA1c estimada sea confiable.** Clínico, con su
 *    umbral de consenso, y solo por debajo de él.
 *
 * ## Frontera
 *
 * Esto cuenta días, no evalúa control glucémico ni sugiere nada sobre una
 * dosis. Su único trabajo es impedir que un agregado se lea sobre más días de
 * los que realmente tiene.
 */

/**
 * Consenso ADA/ATTD: con menos de 14 días de datos, la HbA1c estimada y el
 * día promedio (AGP) son poco representativos. Ver `glucose-metrics.ts`.
 */
export const RELIABLE_COVERAGE_DAYS = 14;

export interface CoverageDescription {
  daysCovered: number;
  rangeDays: number;
  /** Hay menos días con datos que días en el rango elegido. */
  isPartial: boolean;
  /** Por debajo del umbral de consenso para la HbA1c estimada. */
  isBelowReliableThreshold: boolean;
  /** Siempre presente: "22 de 90 días con datos" / "90 de 90 días con datos". */
  text: string;
}

export function describeCoverage(input: {
  daysCovered: number;
  rangeDays: number;
}): CoverageDescription {
  // Un rango de 90 días con 90 días de datos es el techo: `daysCovered` no
  // puede superarlo, pero un rango mal pasado (0, negativo) no puede producir
  // un texto absurdo como "22 de 0 días".
  const rangeDays = Number.isFinite(input.rangeDays) && input.rangeDays > 0
    ? Math.round(input.rangeDays)
    : 0;
  const daysCovered = Number.isFinite(input.daysCovered) && input.daysCovered > 0
    ? Math.round(input.daysCovered)
    : 0;
  const capped = rangeDays === 0 ? daysCovered : Math.min(daysCovered, rangeDays);

  const text = rangeDays === 0
    ? `${capped} día${capped === 1 ? '' : 's'} con datos`
    : `${capped} de ${rangeDays} día${rangeDays === 1 ? '' : 's'} con datos`;

  return {
    daysCovered: capped,
    rangeDays,
    isPartial: rangeDays > 0 && capped < rangeDays,
    isBelowReliableThreshold: capped < RELIABLE_COVERAGE_DAYS,
    text,
  };
}
