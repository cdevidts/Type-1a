import { assessKetones } from './ketones';
import type {
  ActivityEvent,
  CarbEvent,
  CGMReading,
  HbA1cLabResult,
  InsulinEvent,
  MealEvent,
  NoteEvent,
  VitalsEvent,
} from '@type1a/schemas';

/**
 * Fase 9 — exportar el historial local a un reporte tabular (PDF/Excel) para
 * compartir con el equipo médico. Este módulo es puro y determinístico
 * (sin IA, sin red, sin agregación clínica): solo normaliza los eventos ya
 * guardados en SQLite a filas de texto listas para imprimir/tabular, uno por
 * evento, en el mismo orden cronológico que el Timeline. No calcula Time in
 * Range, HbA1c estimada, ni ninguna otra métrica agregada — eso es la Fase
 * 11 ("Resumen"), y mezclarlo acá arriesgaría presentar un cálculo propio
 * junto a datos crudos sin la distinción que exige AGENTS.md entre
 * "medido"/"registrado" y "calculado por la app".
 */

export type ReportRowKind =
  | 'glucose'
  | 'insulin'
  | 'carbs'
  | 'meal'
  | 'activity'
  | 'note'
  | 'vitals'
  | 'hba1c';

export interface ReportRow {
  timestamp: string;
  kind: ReportRowKind;
  kindLabel: string;
  detail: string;
  /**
   * De dónde salió el dato ('Sensor', 'Manual', 'Importado', 'Sintético',
   * '') — nunca vacío para una lectura de glucosa que no sea del sensor,
   * por la misma regla de procedencia que ya aplica `glucoseOriginSuffix`
   * en `apps/mobile/src/db.ts` (AGENTS.md: nunca presentar dato
   * sintético/importado/manual como si viniera del sensor).
   */
  provenance: string;
}

export interface ReportInput {
  readings: CGMReading[];
  insulin: InsulinEvent[];
  carbs: CarbEvent[];
  meals: MealEvent[];
  activities: ActivityEvent[];
  notes: NoteEvent[];
  vitals: VitalsEvent[];
  hba1c: HbA1cLabResult[];
}

function glucoseProvenance(origin: CGMReading['origin']): string {
  switch (origin) {
    case 'real': return 'Sensor';
    case 'manual': return 'Manual';
    case 'imported': return 'Importado';
    case 'synthetic': return 'Sintético';
  }
}

function eventProvenance(source: 'manual' | 'imported' | 'meal_confirmed'): string {
  switch (source) {
    case 'manual': return 'Manual';
    case 'imported': return 'Importado';
    case 'meal_confirmed': return 'Confirmado en comida';
  }
}

const INSULIN_TYPE_LABEL: Record<InsulinEvent['type'], string> = {
  rapid: 'Rápida',
  basal: 'Basal',
};

const INSULIN_PURPOSE_LABEL: Record<NonNullable<InsulinEvent['purpose']>, string> = {
  meal: 'comida',
  correction: 'corrección',
  combined: 'comida + corrección',
};

const ACTIVITY_INTENSITY_LABEL: Record<NonNullable<ActivityEvent['intensity']>, string> = {
  1: 'cómoda',
  2: 'normal',
  3: 'exigente',
};

export function buildReportRows(input: ReportInput): ReportRow[] {
  const rows: ReportRow[] = [];

  for (const reading of input.readings) {
    rows.push({
      timestamp: reading.sourceTimestamp,
      kind: 'glucose',
      kindLabel: 'Glucosa',
      detail: `${reading.glucose} ${reading.unit}`,
      provenance: glucoseProvenance(reading.origin),
    });
  }

  for (const dose of input.insulin) {
    const parts = [`${dose.units} U`, INSULIN_TYPE_LABEL[dose.type]];
    if (dose.purpose !== undefined) parts.push(INSULIN_PURPOSE_LABEL[dose.purpose]);
    if (dose.insulinName !== undefined) parts.push(dose.insulinName);
    rows.push({
      timestamp: dose.timestamp,
      kind: 'insulin',
      kindLabel: 'Insulina',
      detail: parts.join(' · '),
      provenance: eventProvenance(dose.source),
    });
  }

  for (const carb of input.carbs) {
    rows.push({
      timestamp: carb.timestamp,
      kind: 'carbs',
      kindLabel: 'Carbohidratos',
      detail: `${carb.carbsG} g`,
      provenance: eventProvenance(carb.source),
    });
  }

  for (const meal of input.meals) {
    // Regla no negociable: la estimación de IA y lo confirmado por el
    // usuario nunca se colapsan en un solo número (AGENTS.md).
    const parts: string[] = [];
    if (meal.confirmedCarbsG !== undefined) parts.push(`${meal.confirmedCarbsG} g confirmados`);
    if (meal.aiEstimatedCarbsG !== undefined) parts.push(`${meal.aiEstimatedCarbsG} g estimados por IA`);
    if (meal.note !== undefined && meal.note.length > 0) parts.push(meal.note);
    rows.push({
      timestamp: meal.timestamp,
      kind: 'meal',
      kindLabel: 'Comida',
      detail: parts.length > 0 ? parts.join(' · ') : '(sin detalle)',
      provenance: '',
    });
  }

  for (const activity of input.activities) {
    const parts: string[] = [];
    if (activity.durationMinutes !== undefined) parts.push(`${activity.durationMinutes} min`);
    if (activity.intensity !== undefined) parts.push(ACTIVITY_INTENSITY_LABEL[activity.intensity]);
    if (activity.steps !== undefined) parts.push(`${activity.steps} pasos`);
    if (activity.description !== undefined && activity.description.length > 0) parts.push(activity.description);
    rows.push({
      timestamp: activity.timestamp,
      kind: 'activity',
      kindLabel: 'Actividad',
      detail: parts.length > 0 ? parts.join(' · ') : '(sin detalle)',
      provenance: eventProvenance(activity.source),
    });
  }

  for (const note of input.notes) {
    rows.push({
      timestamp: note.timestamp,
      kind: 'note',
      kindLabel: 'Nota',
      detail: note.text,
      provenance: eventProvenance(note.source),
    });
  }

  for (const vitals of input.vitals) {
    const parts: string[] = [];
    if (vitals.weightKg !== undefined) parts.push(`${vitals.weightKg} kg`);
    if (vitals.systolicBP !== undefined && vitals.diastolicBP !== undefined) {
      parts.push(`${vitals.systolicBP}/${vitals.diastolicBP} mmHg`);
    }
    if (vitals.ketonesMmolL !== undefined) {
      // Con la banda, no solo el número: en una tabla larga es lo que permite
      // a un equipo clínico ubicar de un vistazo una medición de riesgo.
      // Descriptivo — `assessKetones` nunca menciona insulina ni una dosis.
      parts.push(`Cetonas ${vitals.ketonesMmolL} mmol/L (${assessKetones(vitals.ketonesMmolL).label})`);
    }
    rows.push({
      timestamp: vitals.timestamp,
      kind: 'vitals',
      kindLabel: 'Vitales',
      detail: parts.length > 0 ? parts.join(' · ') : '(sin detalle)',
      // Rótulo explícito: nunca puede leerse como una HbA1c estimada por la
      // app (AGENTS.md; el mapeo MySugr, en el tag archive/pre-memory-bank).
      provenance: eventProvenance(vitals.source),
    });
  }

  for (const lab of input.hba1c) {
    rows.push({
      timestamp: lab.timestamp,
      kind: 'hba1c',
      kindLabel: 'HbA1c (laboratorio)',
      detail: `${lab.percentage}%`,
      provenance: eventProvenance(lab.source),
    });
  }

  return rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}
