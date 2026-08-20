/**
 * Bandas de cetonas en sangre (mmol/L) y su lectura descriptiva.
 *
 * Son convenciones clínicas fijas y ampliamente publicadas para cetonas **en
 * sangre** (no en orina, que es otra escala y no sirve para lo mismo), del
 * mismo tipo que `HYPOGLYCEMIA_THRESHOLD` en `glucose-thresholds.ts`: sirven
 * para *describir* una medición que ya se hizo, y **nunca** para calcular ni
 * ajustar una dosis.
 *
 * Frontera de seguridad, importante acá más que en otros módulos: la
 * literatura sobre cetonas viene casi siempre acompañada de protocolos de
 * corrección con insulina. **Nada de eso entra en este archivo ni en ninguna
 * pantalla.** `AGENTS.md` prohíbe que la app calcule, infiera o recomiende
 * insulina, y una banda alta de cetonas es justamente el momento de más
 * riesgo para cruzar esa línea. Lo único que se dice es en qué banda cayó la
 * medición y que corresponde contactar al equipo clínico.
 */

export const KETONES_ELEVATED_MMOL_L = 0.6;
export const KETONES_HIGH_MMOL_L = 1.5;
export const KETONES_VERY_HIGH_MMOL_L = 3.0;

export type KetoneBand = 'normal' | 'elevated' | 'high' | 'veryHigh';

export interface KetoneAssessment {
  band: KetoneBand;
  /** Descripción de la banda. Nunca una instrucción de dosis. */
  label: string;
  /** true cuando la banda amerita contactar al equipo clínico sin esperar. */
  urgent: boolean;
}

export function assessKetones(mmolL: number): KetoneAssessment {
  if (!Number.isFinite(mmolL) || mmolL < 0) {
    throw new Error('Ketones must be a non-negative finite number.');
  }
  if (mmolL >= KETONES_VERY_HIGH_MMOL_L) {
    return {
      band: 'veryHigh',
      label: 'Muy altas — riesgo de cetoacidosis',
      urgent: true,
    };
  }
  if (mmolL >= KETONES_HIGH_MMOL_L) {
    return {
      band: 'high',
      label: 'Altas — riesgo de cetoacidosis',
      urgent: true,
    };
  }
  if (mmolL >= KETONES_ELEVATED_MMOL_L) {
    return {
      band: 'elevated',
      label: 'Elevadas',
      urgent: false,
    };
  }
  return { band: 'normal', label: 'Normales', urgent: false };
}
