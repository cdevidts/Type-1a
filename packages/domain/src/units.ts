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
