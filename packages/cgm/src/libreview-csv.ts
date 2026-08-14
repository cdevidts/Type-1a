import { convertGlucose } from '@type1a/domain';
import type { CGMReading, GlucoseUnit } from '@type1a/schemas';
import { fromZonedTime } from 'date-fns-tz';

import { addDerivedTrends } from './trend.js';

export interface LibreViewCsvParseResult {
  readings: CGMReading[];
  skippedRows: number;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === ',' && !quoted) {
      values.push(value.trim());
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values;
}

function parseLocalTimestamp(value: string, timeZone: string): string | null {
  const direct = Date.parse(value);
  if (!Number.isNaN(direct) && /(?:Z|[+-]\d{2}:?\d{2})$/u.test(value)) {
    return new Date(direct).toISOString();
  }
  try {
    return fromZonedTime(value, timeZone).toISOString();
  } catch {
    return null;
  }
}

export function parseLibreViewCsv(
  csv: string,
  options: { userTimeZone: string; ingestedAt?: string },
): LibreViewCsvParseResult {
  const lines = csv.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  const headerIndex = lines.findIndex((line) => /device timestamp|marca de tiempo del dispositivo/iu.test(line));
  if (headerIndex < 0) throw new Error('LibreView CSV header was not found.');

  const headers = parseCsvLine(lines[headerIndex]!).map((header) => header.toLowerCase());
  const timestampIndex = headers.findIndex((header) => /device timestamp|marca de tiempo/iu.test(header));
  const glucoseIndexes = headers
    .map((header, index) => ({ header, index }))
    .filter(({ header }) => /glucose|glucosa/iu.test(header) && /mg\/dl|mmol\/l/iu.test(header));
  if (timestampIndex < 0 || glucoseIndexes.length === 0) {
    throw new Error('LibreView CSV does not contain timestamp and glucose columns.');
  }

  const ingestedAt = options.ingestedAt ?? new Date().toISOString();
  let skippedRows = 0;
  const readings: CGMReading[] = [];

  for (const line of lines.slice(headerIndex + 1)) {
    const fields = parseCsvLine(line);
    const timestampValue = fields[timestampIndex];
    const glucoseField = glucoseIndexes
      .map(({ header, index }) => ({ header, value: fields[index] }))
      .find(({ value }) => value !== undefined && value !== '');
    if (timestampValue === undefined || glucoseField?.value === undefined) {
      skippedRows += 1;
      continue;
    }

    const sourceTimestamp = parseLocalTimestamp(timestampValue, options.userTimeZone);
    const rawGlucose = Number(glucoseField.value.replace(',', '.'));
    if (sourceTimestamp === null || !Number.isFinite(rawGlucose) || rawGlucose <= 0) {
      skippedRows += 1;
      continue;
    }

    const unit: GlucoseUnit = /mmol\/l/iu.test(glucoseField.header) ? 'mmol/L' : 'mg/dL';
    const glucose = convertGlucose(rawGlucose, unit, 'mg/dL');
    readings.push({
      id: `libreview-csv:${sourceTimestamp}:${glucose}`,
      glucose,
      unit: 'mg/dL',
      timestamp: sourceTimestamp,
      trend: 'unknown',
      trendSource: 'unknown',
      source: 'libreview-csv',
      origin: 'imported',
      sourceTimestamp,
      ingestedAt,
    });
  }

  const deduplicated = [...new Map(readings.map((reading) => [reading.id, reading])).values()];
  return { readings: addDerivedTrends(deduplicated), skippedRows };
}
