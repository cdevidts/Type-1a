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
import { describe, expect, it } from 'vitest';

import { buildReportRows, type ReportInput } from '../src/index.js';

const EMPTY_INPUT: ReportInput = {
  readings: [],
  insulin: [],
  carbs: [],
  meals: [],
  activities: [],
  notes: [],
  vitals: [],
  hba1c: [],
};

function reading(overrides: Partial<CGMReading>): CGMReading {
  return {
    id: 'r1',
    glucose: 120,
    unit: 'mg/dL',
    timestamp: '2026-08-18T10:00:00.000Z',
    trend: 'stable',
    trendSource: 'provider',
    source: 'freestyle_libre',
    origin: 'real',
    sourceTimestamp: '2026-08-18T10:00:00.000Z',
    ingestedAt: '2026-08-18T10:00:05.000Z',
    ...overrides,
  };
}

function insulin(overrides: Partial<InsulinEvent>): InsulinEvent {
  return {
    id: 'i1',
    timestamp: '2026-08-18T10:05:00.000Z',
    type: 'rapid',
    units: 2,
    source: 'manual',
    createdAt: '2026-08-18T10:05:00.000Z',
    ...overrides,
  };
}

describe('buildReportRows', () => {
  it('returns nothing for an empty range', () => {
    expect(buildReportRows(EMPTY_INPUT)).toEqual([]);
  });

  it('sorts every event kind into one chronological list', () => {
    const rows = buildReportRows({
      ...EMPTY_INPUT,
      readings: [reading({ timestamp: '2026-08-18T12:00:00.000Z', sourceTimestamp: '2026-08-18T12:00:00.000Z' })],
      insulin: [insulin({ timestamp: '2026-08-18T09:00:00.000Z' })],
      carbs: [{ id: 'c1', timestamp: '2026-08-18T11:00:00.000Z', carbsG: 40, source: 'manual', createdAt: '2026-08-18T11:00:00.000Z' } satisfies CarbEvent],
    });
    expect(rows.map((row) => row.kind)).toEqual(['insulin', 'carbs', 'glucose']);
  });

  it('labels glucose provenance without ever claiming a non-sensor reading is the sensor', () => {
    const rows = buildReportRows({
      ...EMPTY_INPUT,
      readings: [
        reading({ id: 'a', origin: 'real', sourceTimestamp: '2026-08-18T10:00:00.000Z' }),
        reading({ id: 'b', origin: 'manual', sourceTimestamp: '2026-08-18T11:00:00.000Z' }),
        reading({ id: 'c', origin: 'imported', sourceTimestamp: '2026-08-18T12:00:00.000Z' }),
        reading({ id: 'd', origin: 'synthetic', sourceTimestamp: '2026-08-18T13:00:00.000Z' }),
      ],
    });
    expect(rows.map((row) => row.provenance)).toEqual(['Sensor', 'Manual', 'Importado', 'Sintético']);
  });

  it('never collapses AI-estimated carbs into confirmed carbs on a meal row', () => {
    const meal: MealEvent = {
      id: 'm1',
      timestamp: '2026-08-18T13:00:00.000Z',
      confirmedCarbsG: 45,
      aiEstimatedCarbsG: 38,
      createdAt: '2026-08-18T13:00:00.000Z',
    };
    const [row] = buildReportRows({ ...EMPTY_INPUT, meals: [meal] });
    expect(row!.detail).toContain('45 g confirmados');
    expect(row!.detail).toContain('38 g estimados por IA');
  });

  it('does not report a meal and its confirmed-carb mirror as two consumptions', () => {
    const timestamp = '2026-08-18T13:00:00.000Z';
    const meal: MealEvent = {
      id: 'm1', timestamp, confirmedCarbsG: 45, createdAt: timestamp,
    };
    const mirror: CarbEvent = {
      id: 'c1', timestamp, carbsG: 45, source: 'meal_confirmed', createdAt: timestamp,
    };

    const rows = buildReportRows({ ...EMPTY_INPUT, meals: [meal], carbs: [mirror] });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('meal');
  });

  it('keeps an orphan confirmed-carb mirror visible rather than hiding data', () => {
    const timestamp = '2026-08-18T13:00:00.000Z';
    const mirror: CarbEvent = {
      id: 'c1', timestamp, carbsG: 45, source: 'meal_confirmed', createdAt: timestamp,
    };

    const rows = buildReportRows({ ...EMPTY_INPUT, carbs: [mirror] });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe('carbs');
  });

  it('does not hide an orphan mirror behind another meal at the same time', () => {
    const timestamp = '2026-08-18T13:00:00.000Z';
    const mealWithoutCarbs: MealEvent = { id: 'm1', timestamp, createdAt: timestamp };
    const orphanMirror: CarbEvent = {
      id: 'c1', timestamp, carbsG: 45, source: 'meal_confirmed', createdAt: timestamp,
    };

    const rows = buildReportRows({
      ...EMPTY_INPUT,
      meals: [mealWithoutCarbs],
      carbs: [orphanMirror],
    });

    expect(rows.map((row) => row.kind).sort()).toEqual(['carbs', 'meal']);
  });

  it('pairs mirrors one-to-one when duplicate timestamps collide', () => {
    const timestamp = '2026-08-18T13:00:00.000Z';
    const meal: MealEvent = { id: 'm1', timestamp, confirmedCarbsG: 45, createdAt: timestamp };
    const mirrors: CarbEvent[] = ['c1', 'c2'].map((id) => ({
      id, timestamp, carbsG: 45, source: 'meal_confirmed', createdAt: timestamp,
    }));

    const rows = buildReportRows({ ...EMPTY_INPUT, meals: [meal], carbs: mirrors });

    expect(rows.map((row) => row.kind).sort()).toEqual(['carbs', 'meal']);
  });

  it('describes an insulin dose without ever implying the purpose fed a calculation', () => {
    const [row] = buildReportRows({
      ...EMPTY_INPUT,
      insulin: [insulin({ purpose: 'combined', insulinName: 'Fiasp' })],
    });
    expect(row!.detail).toBe('2 U · Rápida · comida + corrección · Fiasp');
  });

  it('includes lab HbA1c as its own kind, distinct from any app-computed estimate', () => {
    const lab: HbA1cLabResult = {
      id: 'h1',
      timestamp: '2026-08-18T09:00:00.000Z',
      percentage: 7.1,
      source: 'manual',
      createdAt: '2026-08-18T09:00:00.000Z',
    };
    const [row] = buildReportRows({ ...EMPTY_INPUT, hba1c: [lab] });
    expect(row!.kindLabel).toBe('HbA1c (laboratorio)');
    expect(row!.detail).toBe('7.1%');
  });

  it('covers activity, notes, and vitals rows', () => {
    const activity: ActivityEvent = {
      id: 'act1',
      timestamp: '2026-08-18T08:00:00.000Z',
      durationMinutes: 30,
      intensity: 2,
      source: 'manual',
      createdAt: '2026-08-18T08:00:00.000Z',
    };
    const note: NoteEvent = {
      id: 'n1',
      timestamp: '2026-08-18T08:30:00.000Z',
      text: 'Sensor cambiado',
      source: 'manual',
      createdAt: '2026-08-18T08:30:00.000Z',
    };
    const vitals: VitalsEvent = {
      id: 'v1',
      timestamp: '2026-08-18T08:45:00.000Z',
      weightKg: 62,
      source: 'manual',
      createdAt: '2026-08-18T08:45:00.000Z',
    };
    const rows = buildReportRows({ ...EMPTY_INPUT, activities: [activity], notes: [note], vitals: [vitals] });
    expect(rows.map((row) => row.kind)).toEqual(['activity', 'note', 'vitals']);
    expect(rows[0]!.detail).toBe('30 min · normal');
    expect(rows[1]!.detail).toBe('Sensor cambiado');
    expect(rows[2]!.detail).toBe('62 kg');
  });
});

describe('cetonas en el reporte (Fase 13, ítem 8)', () => {
  function vitals(ketonesMmolL: number): VitalsEvent {
    return {
      id: `v-${ketonesMmolL}`,
      timestamp: '2026-08-18T10:00:00.000Z',
      ketonesMmolL,
      source: 'manual',
      createdAt: '2026-08-18T10:00:00.000Z',
    };
  }

  function detailFor(ketonesMmolL: number): string {
    const rows = buildReportRows({
      readings: [], insulin: [], carbs: [], meals: [],
      activities: [], notes: [], vitals: [vitals(ketonesMmolL)], hba1c: [],
    });
    return rows.find((row) => row.detail.includes('Cetonas'))!.detail;
  }

  it('incluye el valor y la banda', () => {
    expect(detailFor(0.2)).toContain('0.2 mmol/L');
    expect(detailFor(0.2)).toContain('Normales');
    expect(detailFor(2)).toContain('riesgo de cetoacidosis');
  });

  it('no sugiere ninguna acción con insulina', () => {
    for (const value of [0.2, 0.9, 2, 4]) {
      expect(detailFor(value).toLowerCase())
        .not.toMatch(/\b(insulina|unidades?|dosis|corrige|corregir|ponte|inyecta)\b/u);
    }
  });
});
