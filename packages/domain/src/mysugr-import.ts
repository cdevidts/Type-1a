import type {
  ActivityEvent,
  CGMReading,
  CarbEvent,
  HbA1cLabResult,
  InsulinEvent,
  MealEvent,
  NoteEvent,
  VitalsEvent,
} from '@type1a/schemas';

/**
 * Column headers exactly as MySugr's CSV export writes them (Spanish, one
 * install's locale). Matched by header text, not position — a reordered or
 * unrelated extra column doesn't break parsing.
 */
const HEADER_TO_FIELD: Record<string, keyof MySugrCsvRow> = {
  Fecha: 'fecha',
  Hora: 'hora',
  Etiquetas: 'etiquetas',
  'Medición del azúcar en sangre (mg/dL)': 'glucoseMgDl',
  'Unidades de inyección de bolo (pen)': 'bolusPenUnits',
  'Unidades de inyección basal': 'basalUnits',
  'Unidades de inyección de bolo (bomba)': 'bolusPumpUnits',
  'Insulina (alimento)': 'mealInsulinUnits',
  'Insulina (corrección)': 'correctionInsulinUnits',
  'Hidratos de carbono de la comida (Gramos, factor 1)': 'carbsG',
  'Descripción de la comida': 'mealDescription',
  'Duración de la actividad (minutos)': 'activityDurationMinutes',
  'Intensidad de la actividad (1: cómoda, 2: normal, 3: exigente)': 'activityIntensity',
  'Descripción de la actividad': 'activityDescription',
  Pasos: 'steps',
  Apunte: 'note',
  'Tensión arterial': 'bloodPressure',
  'Peso (kg)': 'weightKg',
  'HbA1c (Porcentaje)': 'hba1cPercent',
  Cetonas: 'ketones',
  'Zona horaria': 'timeZone',
  // Deliberately not imported (see tag archive/pre-memory-bank): "Porcentaje de
  // basal temporal" / "Duración de basal temporal" (pump-only, this MVP
  // models pen injections), "Lugar"/"Latitud"/"Longitud" (no geolocation,
  // by privacy choice), "Tipo de alimento", "Medicamento".
};

export interface MySugrCsvRow {
  fecha: string;
  hora: string;
  etiquetas: string;
  glucoseMgDl: string;
  bolusPenUnits: string;
  basalUnits: string;
  bolusPumpUnits: string;
  mealInsulinUnits: string;
  correctionInsulinUnits: string;
  carbsG: string;
  mealDescription: string;
  activityDurationMinutes: string;
  activityIntensity: string;
  activityDescription: string;
  steps: string;
  note: string;
  bloodPressure: string;
  weightKg: string;
  hba1cPercent: string;
  ketones: string;
  timeZone: string;
}

const EMPTY_ROW: MySugrCsvRow = {
  fecha: '', hora: '', etiquetas: '', glucoseMgDl: '', bolusPenUnits: '', basalUnits: '',
  bolusPumpUnits: '', mealInsulinUnits: '', correctionInsulinUnits: '', carbsG: '',
  mealDescription: '', activityDurationMinutes: '', activityIntensity: '', activityDescription: '',
  steps: '', note: '', bloodPressure: '', weightKg: '', hba1cPercent: '', ketones: '', timeZone: '',
};

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (line[i + 1] === '"') { current += '"'; i += 1; } else { inQuotes = false; }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      fields.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

export function parseMySugrCsv(csvText: string): MySugrCsvRow[] {
  const lines = csvText.split(/\r\n|\n|\r/u).filter((line) => line.trim() !== '');
  if (lines.length === 0) return [];
  const headers = parseCsvLine(lines[0]!).map((header) => header.trim());
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    const row: MySugrCsvRow = { ...EMPTY_ROW };
    headers.forEach((header, index) => {
      const field = HEADER_TO_FIELD[header];
      if (field !== undefined) row[field] = cells[index] ?? '';
    });
    return row;
  });
}

const SPANISH_MONTHS: Record<string, number> = {
  ene: 0, feb: 1, mar: 2, abr: 3, may: 4, jun: 5, jul: 6, ago: 7, sep: 8, oct: 9, nov: 10, dic: 11,
};

/**
 * MySugr's "Fecha"/"Hora" columns have no timezone marker of their own —
 * the offset lives in the separate "Zona horaria" column (e.g.
 * "GMT-04:00"). Parsed explicitly rather than via `new Date(string)`,
 * which would silently assume the runtime's own timezone instead.
 */
export function parseMySugrTimestamp(fecha: string, hora: string, timeZone: string): string | undefined {
  const dateMatch = /^(\d{1,2})\s+([a-záéíóúñ]{3})\.?\s+(\d{4})$/iu.exec(fecha.trim().toLowerCase());
  if (!dateMatch) return undefined;
  const [, dayStr, monthAbbr, yearStr] = dateMatch;
  const month = SPANISH_MONTHS[monthAbbr!];
  if (month === undefined) return undefined;

  const timeMatch = /^(\d{1,2}):(\d{2}):(\d{2})\s*(a\.?\s*m\.?|p\.?\s*m\.?)$/iu.exec(hora.trim().toLowerCase());
  if (!timeMatch) return undefined;
  const [, hourStr, minuteStr, secondStr, meridiemRaw] = timeMatch;
  const isPm = meridiemRaw!.replace(/[.\s]/gu, '') === 'pm';
  let hour = Number(hourStr) % 12;
  if (isPm) hour += 12;

  const offsetMatch = /^GMT([+-])(\d{2}):(\d{2})$/u.exec(timeZone.trim());
  if (!offsetMatch) return undefined;
  const offsetSign = offsetMatch[1] === '-' ? -1 : 1;
  const offsetTotalMinutes = offsetSign * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3]));

  const utcMillis = Date.UTC(Number(yearStr), month, Number(dayStr), hour, Number(minuteStr), Number(secondStr))
    - offsetTotalMinutes * 60_000;
  if (!Number.isFinite(utcMillis)) return undefined;
  return new Date(utcMillis).toISOString();
}

function parseOptionalNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface MySugrRowEvents {
  timestamp: string;
  cgmReading?: CGMReading;
  insulinEvents: InsulinEvent[];
  carbEvent?: CarbEvent;
  mealEvent?: MealEvent;
  activityEvent?: ActivityEvent;
  noteEvent?: NoteEvent;
  vitalsEvent?: VitalsEvent;
  hba1cResult?: HbA1cLabResult;
}

/**
 * Maps one MySugr CSV row to our event types. Returns `undefined` if the
 * row's date/time/timezone can't be parsed at all (the row is unusable —
 * every event needs a timestamp). IDs are deterministic (derived from the
 * timestamp and event kind, not random), so importing the same CSV twice
 * produces the same IDs and callers can treat re-imports as safe no-ops.
 */
export function mapMySugrRowToEvents(row: MySugrCsvRow, importedAt: string): MySugrRowEvents | undefined {
  const timestamp = parseMySugrTimestamp(row.fecha, row.hora, row.timeZone);
  if (timestamp === undefined) return undefined;

  const result: MySugrRowEvents = { timestamp, insulinEvents: [] };

  const glucose = parseOptionalNumber(row.glucoseMgDl);
  if (glucose !== undefined && glucose > 0) {
    result.cgmReading = {
      id: `mysugr-cgm:${timestamp}:${glucose}`,
      glucose,
      unit: 'mg/dL',
      timestamp,
      trend: 'unknown',
      trendSource: 'unknown',
      source: 'mysugr-import',
      origin: 'imported',
      sourceTimestamp: timestamp,
      ingestedAt: importedAt,
    };
  }

  const basalUnits = parseOptionalNumber(row.basalUnits);
  if (basalUnits !== undefined && basalUnits > 0) {
    result.insulinEvents.push({
      id: `mysugr-basal:${timestamp}`,
      timestamp,
      type: 'basal',
      units: basalUnits,
      source: 'imported',
      createdAt: importedAt,
    });
  }

  const pumpOrPenTotal = parseOptionalNumber(row.bolusPenUnits) ?? parseOptionalNumber(row.bolusPumpUnits);
  const mealPortion = parseOptionalNumber(row.mealInsulinUnits);
  const correctionPortion = parseOptionalNumber(row.correctionInsulinUnits);
  const rapidUnits = pumpOrPenTotal
    ?? (mealPortion !== undefined || correctionPortion !== undefined
      ? (mealPortion ?? 0) + (correctionPortion ?? 0)
      : undefined);
  if (rapidUnits !== undefined && rapidUnits > 0) {
    const purpose = mealPortion !== undefined && correctionPortion !== undefined
      ? 'combined' as const
      : mealPortion !== undefined
        ? 'meal' as const
        : correctionPortion !== undefined
          ? 'correction' as const
          : undefined;
    result.insulinEvents.push({
      id: `mysugr-rapid:${timestamp}`,
      timestamp,
      type: 'rapid',
      units: rapidUnits,
      ...(purpose === undefined ? {} : { purpose }),
      source: 'imported',
      createdAt: importedAt,
    });
  }

  const carbsG = parseOptionalNumber(row.carbsG);
  if (carbsG !== undefined && carbsG >= 0) {
    result.carbEvent = { id: `mysugr-carb:${timestamp}`, timestamp, carbsG, source: 'imported', createdAt: importedAt };
  }

  const mealDescription = row.mealDescription.trim().slice(0, 300);
  if (mealDescription !== '' || carbsG !== undefined) {
    result.mealEvent = {
      id: `mysugr-meal:${timestamp}`,
      timestamp,
      ...(carbsG === undefined ? {} : { confirmedCarbsG: carbsG }),
      ...(mealDescription === '' ? {} : { note: mealDescription }),
      createdAt: importedAt,
    };
  }

  const activityDuration = parseOptionalNumber(row.activityDurationMinutes);
  const activityIntensityRaw = parseOptionalNumber(row.activityIntensity);
  const activityIntensity = activityIntensityRaw === 1 || activityIntensityRaw === 2 || activityIntensityRaw === 3
    ? activityIntensityRaw
    : undefined;
  const activityDescription = row.activityDescription.trim().slice(0, 300);
  const stepsRaw = parseOptionalNumber(row.steps);
  const steps = stepsRaw === undefined ? undefined : Math.max(0, Math.round(stepsRaw));
  if (activityDuration !== undefined || activityIntensity !== undefined || activityDescription !== '' || steps !== undefined) {
    result.activityEvent = {
      id: `mysugr-activity:${timestamp}`,
      timestamp,
      ...(activityDuration === undefined ? {} : { durationMinutes: activityDuration }),
      ...(activityIntensity === undefined ? {} : { intensity: activityIntensity }),
      ...(activityDescription === '' ? {} : { description: activityDescription }),
      ...(steps === undefined ? {} : { steps }),
      source: 'imported',
      createdAt: importedAt,
    };
  }

  const noteText = row.note.trim().slice(0, 500);
  if (noteText !== '') {
    result.noteEvent = { id: `mysugr-note:${timestamp}`, timestamp, text: noteText, source: 'imported', createdAt: importedAt };
  }

  const weightKg = parseOptionalNumber(row.weightKg);
  const ketonesMmolL = parseOptionalNumber(row.ketones);
  const bpMatch = /^(\d{1,3})\s*\/\s*(\d{1,3})$/u.exec(row.bloodPressure.trim());
  const systolicBP = bpMatch ? Number(bpMatch[1]) : undefined;
  const diastolicBP = bpMatch ? Number(bpMatch[2]) : undefined;
  if (weightKg !== undefined || ketonesMmolL !== undefined || systolicBP !== undefined) {
    result.vitalsEvent = {
      id: `mysugr-vitals:${timestamp}`,
      timestamp,
      ...(weightKg === undefined ? {} : { weightKg }),
      ...(systolicBP === undefined ? {} : { systolicBP }),
      ...(diastolicBP === undefined ? {} : { diastolicBP }),
      ...(ketonesMmolL === undefined ? {} : { ketonesMmolL }),
      source: 'imported',
      createdAt: importedAt,
    };
  }

  const hba1c = parseOptionalNumber(row.hba1cPercent);
  if (hba1c !== undefined && hba1c > 0) {
    result.hba1cResult = { id: `mysugr-hba1c:${timestamp}`, timestamp, percentage: hba1c, source: 'imported', createdAt: importedAt };
  }

  return result;
}

export interface MySugrImportPlan {
  rowsTotal: number;
  rowsSkipped: number;
  events: MySugrRowEvents[];
}

/** Pure, no I/O: parses the CSV and maps every row. Callers write the results. */
export function planMySugrImport(csvText: string, importedAt: string): MySugrImportPlan {
  const rows = parseMySugrCsv(csvText);
  const events: MySugrRowEvents[] = [];
  let rowsSkipped = 0;
  for (const row of rows) {
    const mapped = mapMySugrRowToEvents(row, importedAt);
    if (mapped === undefined) { rowsSkipped += 1; continue; }
    events.push(mapped);
  }
  return { rowsTotal: rows.length, rowsSkipped, events };
}
