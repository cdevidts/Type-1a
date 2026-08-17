import { describe, expect, it } from 'vitest';

import {
  mapMySugrRowToEvents,
  parseMySugrCsv,
  parseMySugrTimestamp,
  planMySugrImport,
  type MySugrCsvRow,
} from '../src/index.js';

const IMPORTED_AT = '2026-08-17T20:00:00.000Z';

function row(overrides: Partial<MySugrCsvRow>): MySugrCsvRow {
  return {
    fecha: '17 ago 2026',
    hora: '9:19:57 a.m.',
    etiquetas: '',
    glucoseMgDl: '',
    bolusPenUnits: '',
    basalUnits: '',
    bolusPumpUnits: '',
    mealInsulinUnits: '',
    correctionInsulinUnits: '',
    carbsG: '',
    mealDescription: '',
    activityDurationMinutes: '',
    activityIntensity: '',
    activityDescription: '',
    steps: '',
    note: '',
    bloodPressure: '',
    weightKg: '',
    hba1cPercent: '',
    ketones: '',
    timeZone: 'GMT-04:00',
    ...overrides,
  };
}

describe('parseMySugrTimestamp', () => {
  it('interprets GMT-04:00 wall-clock time as the equivalent UTC instant', () => {
    expect(parseMySugrTimestamp('17 ago 2026', '9:19:57 a.m.', 'GMT-04:00')).toBe('2026-08-17T13:19:57.000Z');
    expect(parseMySugrTimestamp('16 ago 2026', '2:37:31 p.m.', 'GMT-04:00')).toBe('2026-08-16T18:37:31.000Z');
  });

  it('handles 12am/12pm boundary correctly', () => {
    expect(parseMySugrTimestamp('1 ene 2026', '12:00:00 a.m.', 'GMT-04:00')).toBe('2026-01-01T04:00:00.000Z');
    expect(parseMySugrTimestamp('1 ene 2026', '12:00:00 p.m.', 'GMT-04:00')).toBe('2026-01-01T16:00:00.000Z');
  });

  it('returns undefined for unparseable date, time, or timezone', () => {
    expect(parseMySugrTimestamp('not a date', '9:19:57 a.m.', 'GMT-04:00')).toBeUndefined();
    expect(parseMySugrTimestamp('17 ago 2026', 'not a time', 'GMT-04:00')).toBeUndefined();
    expect(parseMySugrTimestamp('17 ago 2026', '9:19:57 a.m.', 'not a zone')).toBeUndefined();
  });
});

describe('parseMySugrCsv', () => {
  it('parses quoted CSV rows matching headers by text, not position', () => {
    const csv = [
      '"Fecha","Hora","Medición del azúcar en sangre (mg/dL)","Descripción de la comida"',
      '"17 ago 2026","9:19:57 a.m.","135","Con sangre"',
      '"16 ago 2026","8:31:31 p.m.","180","Pizza, ensalada"',
    ].join('\n');
    const rows = parseMySugrCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ fecha: '17 ago 2026', glucoseMgDl: '135', mealDescription: 'Con sangre' });
    // embedded comma inside quotes must not split the field
    expect(rows[1]?.mealDescription).toBe('Pizza, ensalada');
  });

  it('ignores unknown columns and returns an empty array for a header-only file', () => {
    expect(parseMySugrCsv('"Fecha","Hora"\n')).toEqual([]);
  });
});

describe('mapMySugrRowToEvents', () => {
  it('returns undefined when the timestamp cannot be parsed', () => {
    expect(mapMySugrRowToEvents(row({ fecha: 'bogus' }), IMPORTED_AT)).toBeUndefined();
  });

  it('maps a bare glucose reading with no other data', () => {
    const result = mapMySugrRowToEvents(row({ glucoseMgDl: '135' }), IMPORTED_AT);
    expect(result?.cgmReading).toMatchObject({ glucose: 135, origin: 'imported', unit: 'mg/dL' });
    expect(result?.insulinEvents).toEqual([]);
    expect(result?.carbEvent).toBeUndefined();
    expect(result?.mealEvent).toBeUndefined();
  });

  it('maps a row with basal + combined meal/correction bolus + carbs + description (like the real CSV row for "Pan con mayo...")', () => {
    const result = mapMySugrRowToEvents(
      row({ glucoseMgDl: '285', basalUnits: '40', mealInsulinUnits: '3', correctionInsulinUnits: '9', carbsG: '15', mealDescription: 'Pan con mayo y jamon y cebolla' }),
      IMPORTED_AT,
    );
    expect(result?.insulinEvents).toContainEqual(expect.objectContaining({ type: 'basal', units: 40 }));
    expect(result?.insulinEvents).toContainEqual(expect.objectContaining({ type: 'rapid', units: 12, purpose: 'combined' }));
    expect(result?.carbEvent).toMatchObject({ carbsG: 15, source: 'imported' });
    expect(result?.mealEvent).toMatchObject({ confirmedCarbsG: 15, note: 'Pan con mayo y jamon y cebolla' });
  });

  it('marks purpose as "correction" when only the correction portion is present (like a "Corrección"-tagged row)', () => {
    const result = mapMySugrRowToEvents(row({ etiquetas: 'Corrección', glucoseMgDl: '266', correctionInsulinUnits: '7' }), IMPORTED_AT);
    expect(result?.insulinEvents).toEqual([
      expect.objectContaining({ type: 'rapid', units: 7, purpose: 'correction' }),
    ]);
  });

  it('marks purpose as "meal" when only the meal portion is present, and still records carbs/meal', () => {
    const result = mapMySugrRowToEvents(row({ mealInsulinUnits: '17', carbsG: '155', mealDescription: 'Pizza' }), IMPORTED_AT);
    expect(result?.insulinEvents).toEqual([
      expect.objectContaining({ type: 'rapid', units: 17, purpose: 'meal' }),
    ]);
    expect(result?.mealEvent).toMatchObject({ confirmedCarbsG: 155, note: 'Pizza' });
  });

  it('prefers the pen/pump bolus total over the meal+correction breakdown when both are present', () => {
    const result = mapMySugrRowToEvents(row({ bolusPenUnits: '20', mealInsulinUnits: '3', correctionInsulinUnits: '9' }), IMPORTED_AT);
    expect(result?.insulinEvents).toEqual([
      expect.objectContaining({ type: 'rapid', units: 20, purpose: 'combined' }),
    ]);
  });

  it('creates a meal event even with no description, when carbs alone are logged', () => {
    const result = mapMySugrRowToEvents(row({ carbsG: '33' }), IMPORTED_AT);
    expect(result?.mealEvent).toMatchObject({ confirmedCarbsG: 33 });
    expect(result?.mealEvent?.note).toBeUndefined();
  });

  it('maps activity fields, clamping intensity to the 1-3 scale', () => {
    const valid = mapMySugrRowToEvents(row({ activityDurationMinutes: '30', activityIntensity: '2', activityDescription: 'Trote', steps: '4200' }), IMPORTED_AT);
    expect(valid?.activityEvent).toMatchObject({ durationMinutes: 30, intensity: 2, description: 'Trote', steps: 4200 });

    const invalidIntensity = mapMySugrRowToEvents(row({ activityIntensity: '7' }), IMPORTED_AT);
    expect(invalidIntensity?.activityEvent?.intensity).toBeUndefined();
  });

  it('maps a freestanding note (Apunte column)', () => {
    const result = mapMySugrRowToEvents(row({ note: 'Sensación de hipo antes de dormir' }), IMPORTED_AT);
    expect(result?.noteEvent).toMatchObject({ text: 'Sensación de hipo antes de dormir', source: 'imported' });
  });

  it('parses blood pressure as systolic/diastolic and maps vitals', () => {
    const result = mapMySugrRowToEvents(row({ weightKg: '70', bloodPressure: '120/80', ketones: '0.3' }), IMPORTED_AT);
    expect(result?.vitalsEvent).toMatchObject({ weightKg: 70, systolicBP: 120, diastolicBP: 80, ketonesMmolL: 0.3 });
  });

  it('maps a lab HbA1c reading', () => {
    const result = mapMySugrRowToEvents(row({ hba1cPercent: '7.2' }), IMPORTED_AT);
    expect(result?.hba1cResult).toMatchObject({ percentage: 7.2, source: 'imported' });
  });
});

describe('planMySugrImport', () => {
  it('skips unparseable rows without dropping valid ones, and reports both counts', () => {
    const csv = [
      '"Fecha","Hora","Zona horaria","Medición del azúcar en sangre (mg/dL)"',
      '"17 ago 2026","9:19:57 a.m.","GMT-04:00","135"',
      '"not a date","9:19:57 a.m.","GMT-04:00","135"',
      '"16 ago 2026","8:31:31 p.m.","GMT-04:00","180"',
    ].join('\n');
    const plan = planMySugrImport(csv, IMPORTED_AT);
    expect(plan.rowsTotal).toBe(3);
    expect(plan.rowsSkipped).toBe(1);
    expect(plan.events).toHaveLength(2);
  });
});
