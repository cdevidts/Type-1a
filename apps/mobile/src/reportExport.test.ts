import type { CGMReading, InsulinEvent } from '@type1a/schemas';
import type { ReportRow } from '@type1a/domain';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';

import { reportHtml, reportWorkbookBytes } from './reportExport';
import type { ReportExport } from './types';

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

function labRow(): ReportRow {
  return {
    timestamp: '2026-08-15T09:00:00.000Z',
    kind: 'hba1c',
    kindLabel: 'HbA1c (laboratorio)',
    detail: '7.1%',
    provenance: 'Manual',
  };
}

function circleCount(svgHtml: string): number {
  return (svgHtml.match(/<circle /g) ?? []).length;
}

describe('reportHtml', () => {
  it('never draws a chart point for a synthetic reading', () => {
    const readings: CGMReading[] = [
      reading({ id: 'real-1', origin: 'real', glucose: 110 }),
      reading({ id: 'synthetic-1', origin: 'synthetic', glucose: 250 }),
    ];
    const data: ReportExport = { readings, rows: [], insulin: [], carbs: [], meals: [] };
    const html = reportHtml(data, '7 días');
    expect(circleCount(html)).toBe(1);
    expect(html).toContain('Se excluyeron 1 lectura(s) sintética(s)');
  });

  it('shows the empty-summary message when every reading is synthetic', () => {
    const data: ReportExport = { readings: [reading({ origin: 'synthetic' })], rows: [], insulin: [], carbs: [], meals: [] };
    const html = reportHtml(data, '7 días');
    expect(html).toContain('no se puede calcular un resumen');
    expect(circleCount(html)).toBe(0);
  });

  it('marks non-sensor readings (imported/manual) apart from sensor ones, line included', () => {
    const readings: CGMReading[] = [
      reading({ id: 'real-1', origin: 'real', sourceTimestamp: '2026-08-18T08:00:00.000Z' }),
      reading({ id: 'imported-1', origin: 'imported', sourceTimestamp: '2026-08-18T09:00:00.000Z' }),
      reading({ id: 'imported-2', origin: 'imported', sourceTimestamp: '2026-08-18T10:00:00.000Z' }),
      reading({ id: 'manual-1', origin: 'manual', sourceTimestamp: '2026-08-18T11:00:00.000Z' }),
    ];
    const html = reportHtml({ readings, rows: [], insulin: [], carbs: [], meals: [] }, '7 días');
    // El punto importado se dibuja hueco (relleno blanco + borde), y su
    // tramo de línea va punteado — no puede verse igual que uno del sensor.
    expect(html).toContain('fill="#FFFFFF"');
    expect(html).toContain('stroke-dasharray="3,3"');
    expect(html).toContain('incluye manual/importado');
  });

  it('labels the estimated HbA1c distinctly from a lab HbA1c result', () => {
    const readings: CGMReading[] = [reading({})];
    const html = reportHtml({ readings, rows: [labRow()], insulin: [], carbs: [], meals: [] }, '7 días');
    expect(html).toContain('HbA1c estimada (GMI)');
    expect(html).toContain('HbA1c (laboratorio)');
    expect(html).toContain('No reemplaza una medición de laboratorio');
  });

  it('adds the AGP profile and the per-window pattern table', () => {
    const readings: CGMReading[] = [
      reading({ id: '1', sourceTimestamp: '2026-08-17T12:00:00.000Z' }),
      reading({ id: '2', sourceTimestamp: '2026-08-18T12:00:00.000Z' }),
    ];
    const insulin: InsulinEvent[] = [
      {
        id: 'i1',
        timestamp: '2026-08-18T12:00:00.000Z',
        type: 'rapid',
        units: 4,
        source: 'manual',
        createdAt: '2026-08-18T12:00:00.000Z',
      },
    ];
    const html = reportHtml({ readings, rows: [], insulin, carbs: [], meals: [] }, '7 días');
    expect(html).toContain('Día promedio (perfil ambulatorio)');
    expect(html).toContain('Patrones por franja horaria');
    expect(html).toContain('Type 1A nunca calcula ni recomienda insulina.');
  });

  it('falls back to an empty-state line when there is no food or insulin', () => {
    const html = reportHtml({ readings: [], rows: [], insulin: [], carbs: [], meals: [] }, '7 días');
    expect(html).toContain('Sin comidas ni insulina registradas en este rango.');
  });

  it('excludes glucose rows from the event table (charts replace them)', () => {
    const glucoseRow: ReportRow = {
      timestamp: '2026-08-18T10:00:00.000Z',
      kind: 'glucose',
      kindLabel: 'Glucosa',
      detail: '120 mg/dL',
      provenance: 'Sensor',
    };
    const html = reportHtml({ readings: [], rows: [glucoseRow, labRow()], insulin: [], carbs: [], meals: [] }, '7 días');
    expect(html).not.toContain('120 mg/dL');
    expect(html).toContain('7.1%');
  });
});

describe('reportWorkbookBytes', () => {
  it('writes a Resumen sheet with the GMI estimate, distinct from lab HbA1c rows in Reporte', () => {
    const readings: CGMReading[] = [
      reading({ id: 'real-1', origin: 'real', glucose: 110 }),
      reading({ id: 'synthetic-1', origin: 'synthetic', glucose: 250 }),
    ];
    const bytes = reportWorkbookBytes({ readings, rows: [labRow()], insulin: [], carbs: [], meals: [] });
    const workbook = XLSX.read(bytes, { type: 'array' });
    expect(workbook.SheetNames).toEqual(['Resumen', 'Patrones', 'Reporte']);

    const resumenRows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets.Resumen!, { header: 1 });
    const resumenText = resumenRows.flat().join(' | ');
    expect(resumenText).toContain('HbA1c estimada (GMI)*');
    expect(resumenText).toContain('Lecturas sintéticas excluidas');

    const reporteRows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets.Reporte!, { header: 1 });
    const reporteText = reporteRows.flat().join(' | ');
    expect(reporteText).toContain('HbA1c (laboratorio)');
  });

  it('carries the descriptive-only caveat into the Patrones sheet', () => {
    const bytes = reportWorkbookBytes({ readings: [], rows: [], insulin: [], carbs: [], meals: [] });
    const workbook = XLSX.read(bytes, { type: 'array' });
    const text = XLSX.utils
      .sheet_to_json<string[]>(workbook.Sheets.Patrones!, { header: 1 })
      .flat()
      .join(' | ');
    expect(text).toContain('Type 1A nunca calcula ni recomienda insulina.');
    expect(text).toContain('Glucosa a 1 h');
  });

  it('notes when there is no glucose to summarize', () => {
    const bytes = reportWorkbookBytes({ readings: [reading({ origin: 'synthetic' })], rows: [], insulin: [], carbs: [], meals: [] });
    const workbook = XLSX.read(bytes, { type: 'array' });
    const resumenRows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets.Resumen!, { header: 1 });
    expect(resumenRows.flat().join(' | ')).toContain('Sin lecturas de glucosa');
  });
});
