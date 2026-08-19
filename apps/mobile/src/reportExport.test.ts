import type { CGMReading } from '@type1a/schemas';
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
    const data: ReportExport = { readings, rows: [] };
    const html = reportHtml(data, '7 días');
    expect(circleCount(html)).toBe(1);
    expect(html).toContain('Se excluyeron 1 lectura(s) sintética(s)');
  });

  it('shows the empty-summary message when every reading is synthetic', () => {
    const data: ReportExport = { readings: [reading({ origin: 'synthetic' })], rows: [] };
    const html = reportHtml(data, '7 días');
    expect(html).toContain('no se puede calcular un resumen');
    expect(circleCount(html)).toBe(0);
  });

  it('dampens imported points but not real/manual ones', () => {
    const readings: CGMReading[] = [
      reading({ id: 'real-1', origin: 'real', sourceTimestamp: '2026-08-18T08:00:00.000Z' }),
      reading({ id: 'imported-1', origin: 'imported', sourceTimestamp: '2026-08-18T09:00:00.000Z' }),
    ];
    const html = reportHtml({ readings, rows: [] }, '7 días');
    expect(html).toContain('opacity="0.5"');
    expect(html).toContain('incluye historial importado');
  });

  it('labels the estimated HbA1c distinctly from a lab HbA1c result', () => {
    const readings: CGMReading[] = [reading({})];
    const html = reportHtml({ readings, rows: [labRow()] }, '7 días');
    expect(html).toContain('HbA1c estimada (GMI)');
    expect(html).toContain('HbA1c (laboratorio)');
    expect(html).toContain('No reemplaza una medición de laboratorio');
  });

  it('excludes glucose rows from the event table (charts replace them)', () => {
    const glucoseRow: ReportRow = {
      timestamp: '2026-08-18T10:00:00.000Z',
      kind: 'glucose',
      kindLabel: 'Glucosa',
      detail: '120 mg/dL',
      provenance: 'Sensor',
    };
    const html = reportHtml({ readings: [], rows: [glucoseRow, labRow()] }, '7 días');
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
    const bytes = reportWorkbookBytes({ readings, rows: [labRow()] });
    const workbook = XLSX.read(bytes, { type: 'array' });
    expect(workbook.SheetNames).toEqual(['Resumen', 'Reporte']);

    const resumenRows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets.Resumen!, { header: 1 });
    const resumenText = resumenRows.flat().join(' | ');
    expect(resumenText).toContain('HbA1c estimada (GMI)*');
    expect(resumenText).toContain('Lecturas sintéticas excluidas');

    const reporteRows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets.Reporte!, { header: 1 });
    const reporteText = reporteRows.flat().join(' | ');
    expect(reporteText).toContain('HbA1c (laboratorio)');
  });

  it('notes when there is no glucose to summarize', () => {
    const bytes = reportWorkbookBytes({ readings: [reading({ origin: 'synthetic' })], rows: [] });
    const workbook = XLSX.read(bytes, { type: 'array' });
    const resumenRows = XLSX.utils.sheet_to_json<string[]>(workbook.Sheets.Resumen!, { header: 1 });
    expect(resumenRows.flat().join(' | ')).toContain('Sin lecturas de glucosa');
  });
});
