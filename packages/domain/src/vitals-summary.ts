import { assessKetones } from './ketones';

import type { VitalsEvent } from '@type1a/schemas';

/**
 * Cómo se lee un registro de vitales en una lista.
 *
 * Vive en dominio y no en un `.tsx` porque **la banda de cetonas es una
 * decisión clínica**: `assessKetones` separa normal / elevadas / altas / muy
 * altas, y "altas" es el umbral en que corresponde contactar al equipo
 * clínico. Un componente elige el color y dibuja; no decide qué es urgente.
 *
 * `urgent` es lo único que el color puede reflejar, y **nunca va solo**: el
 * texto siempre nombra la banda. Es regla de accesibilidad y frontera de
 * `AGENTS.md` — un estado no se comunica solo con color.
 */
export interface VitalsSummary {
  /** Qué es, en una línea. */
  title: string;
  /** Los valores, ya formateados con su unidad. */
  detail: string;
  /** La banda de cetonas pide contactar al equipo clínico. */
  urgent: boolean;
}

export function summarizeVitals(event: VitalsEvent): VitalsSummary {
  const parts: string[] = [];
  let urgent = false;
  let title = 'Registro';

  if (event.ketonesMmolL !== undefined) {
    const assessment = assessKetones(event.ketonesMmolL);
    // La etiqueta de la banda va en el texto, no solo en el tono: es el dato
    // de triage de cetoacidosis y tiene que leerse sin distinguir colores.
    parts.push(`${event.ketonesMmolL} mmol/L · ${assessment.label}`);
    urgent = assessment.urgent;
    title = 'Cetonas';
  }
  if (event.weightKg !== undefined) {
    parts.push(`${event.weightKg} kg`);
    if (title === 'Registro') title = 'Peso';
  }
  if (event.systolicBP !== undefined && event.diastolicBP !== undefined) {
    parts.push(`${event.systolicBP}/${event.diastolicBP} mmHg`);
    if (title === 'Registro') title = 'Presión';
  }

  // Un dato importado no puede leerse igual que uno que ella acaba de medir.
  // Es el mismo motivo por el que la glucosa arrastra su `origin` en la fila
  // del timeline (`glucoseOriginSuffix`), y vale doble acá: la importación de
  // MySugr toma su columna de cetonas al pie de la letra, sin verificar
  // unidad, mientras las bandas de `assessKetones` son de cetonas en sangre.
  // Se cuenta ANTES de agregar el origen: el sufijo no es una medida, y
  // contarlo convertía unas cetonas importadas en "Cetonas y otros".
  const measurements = parts.length;
  if (event.source === 'imported') parts.push('importado');

  return {
    // Un evento con varias medidas se nombra por la más grave: las cetonas
    // mandan sobre el peso, no al revés.
    title: measurements > 1 && event.ketonesMmolL !== undefined ? 'Cetonas y otros' : title,
    detail: parts.join(' · '),
    urgent,
  };
}
