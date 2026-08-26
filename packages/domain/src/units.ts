import type { GlucoseUnit } from '@type1a/schemas';

const MG_DL_PER_MMOL_L = 18.0182;

export function convertGlucose(value: number, from: GlucoseUnit, to: GlucoseUnit): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('Glucose must be a positive finite number.');
  }
  if (from === to) return value;
  return from === 'mmol/L'
    ? Number((value * MG_DL_PER_MMOL_L).toFixed(0))
    : Number((value / MG_DL_PER_MMOL_L).toFixed(1));
}

/**
 * Formatea un valor **que ya está en mg/dL** para mostrarlo en la unidad que
 * eligió la usuaria.
 *
 * **Todavía no lo usa ninguna pantalla, a propósito.** Es la pieza base —
 * pura y con test — de la preferencia mmol/L pendiente (Fase 13, ítem 10b).
 * Esa preferencia no se pudo activar en la corrida que escribió esto porque
 * `TherapyProfile.targetGlucose` y `correctionFactor` no llevan unidad: son
 * mg/dL implícito, y un factor de corrección en mmol/L/U es un número
 * distinto (45 mg/dL/U = 2,5 mmol/L/U), no el mismo valor reformateado.
 * Mostrar mmol/L sin migrar antes esos parámetros dejaría la calculadora de
 * dosis en una unidad y el resto de la app en otra. Ver
 * el tag `archive/pre-memory-bank`, § Fase 13, ítem 10b.
 *
 * La app calcula siempre en mg/dL: los umbrales clínicos
 * (`glucose-thresholds.ts`), el GMI y el AGP están definidos en mg/dL en la
 * literatura, y tenerlos en una sola unidad internamente es lo que evita la
 * clase de bug de la Fase 13 ítem 11. mmol/L es una decisión de
 * **presentación**, y se aplica en el último momento — acá.
 *
 * La cantidad de decimales no es cosmética: mg/dL se lee como entero
 * (110) y mmol/L con un decimal (6.1), que es la convención clínica de cada
 * escala. Mostrar "6" o "110.4" se ve mal a un ojo entrenado.
 */
export function formatGlucose(mgDl: number, unit: GlucoseUnit): string {
  const value = convertGlucose(mgDl, 'mg/dL', unit);
  return unit === 'mmol/L' ? value.toFixed(1) : String(Math.round(value));
}

/** `formatGlucose` con la unidad pegada, para textos corridos. */
export function formatGlucoseWithUnit(mgDl: number, unit: GlucoseUnit): string {
  return `${formatGlucose(mgDl, unit)} ${unit}`;
}
