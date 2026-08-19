import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createDecodeTally, decodeRow, decodeTherapyProfileRow, safeJsonParse, tallyParsed } from './rowDecode';

const Schema = z.object({ id: z.string().min(1), value: z.number().positive() });

function payload(value: unknown): string {
  return JSON.stringify(value);
}

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it('returns undefined instead of throwing on corrupt JSON', () => {
    // Ésta es la razón de existir del módulo: antes, un `JSON.parse` crudo acá
    // rechazaba la consulta entera y dejaba ilegible todo el rango.
    expect(safeJsonParse('{"a":1')).toBeUndefined();
    expect(safeJsonParse('')).toBeUndefined();
    expect(safeJsonParse('no soy json')).toBeUndefined();
  });
});

describe('decodeRow', () => {
  it('devuelve la fila cuando es válida', () => {
    expect(decodeRow(payload({ id: 'a', value: 5 }), Schema)).toEqual([{ id: 'a', value: 5 }]);
  });

  it('descarta una fila con JSON corrupto sin lanzar', () => {
    expect(() => decodeRow('{"id":"a"', Schema)).not.toThrow();
    expect(decodeRow('{"id":"a"', Schema)).toEqual([]);
  });

  it('descarta una fila que parsea pero no valida contra el schema', () => {
    expect(decodeRow(payload({ id: 'a', value: -1 }), Schema)).toEqual([]);
  });

  it('una fila mala no se lleva puestas a las buenas de la misma consulta', () => {
    // El comportamiento que motivó el cambio: antes, la fila del medio hacía
    // fallar la lectura completa en vez de perderse sola.
    const rows = [
      payload({ id: 'a', value: 1 }),
      '{"id":"roto"',
      payload({ id: 'c', value: 3 }),
    ];
    const decoded = rows.flatMap((row) => decodeRow(row, Schema));
    expect(decoded).toEqual([{ id: 'a', value: 1 }, { id: 'c', value: 3 }]);
  });
});

describe('DecodeTally', () => {
  it('cuenta cada descarte, sea por JSON o por schema', () => {
    const tally = createDecodeTally();
    const rows = [
      payload({ id: 'a', value: 1 }),
      '{"roto"',                        // JSON inválido
      payload({ id: 'c', value: -5 }),  // JSON válido, schema inválido
      payload({ id: 'd', value: 4 }),
    ];
    const decoded = rows.flatMap((row) => decodeRow(row, Schema, tally));
    expect(decoded).toHaveLength(2);
    expect(tally.unreadable).toBe(2);
  });

  it('no cuenta nada cuando todas las filas son legibles', () => {
    const tally = createDecodeTally();
    [payload({ id: 'a', value: 1 })].forEach((row) => decodeRow(row, Schema, tally));
    expect(tally.unreadable).toBe(0);
  });

  it('acumula entre varias consultas que comparten el mismo contador', () => {
    // Es como lo usa `loadSummary`: un solo contador para las cuatro
    // consultas, porque a la usuaria le importa "faltan N registros de este
    // rango", no cuál tabla los perdió.
    const tally = createDecodeTally();
    decodeRow('{"roto"', Schema, tally);
    decodeRow('tampoco', Schema, tally);
    expect(tally.unreadable).toBe(2);
  });

  it('es opcional: sin contador el descarte sigue funcionando', () => {
    expect(() => decodeRow('{"roto"', Schema)).not.toThrow();
  });
});

describe('tallyParsed', () => {
  it('cuenta un resultado ya parseado que no validó', () => {
    const tally = createDecodeTally();
    expect(tallyParsed(Schema.safeParse({ id: '', value: 1 }), tally)).toEqual([]);
    expect(tally.unreadable).toBe(1);
  });

  it('deja pasar un resultado válido sin contarlo', () => {
    const tally = createDecodeTally();
    expect(tallyParsed(Schema.safeParse({ id: 'a', value: 1 }), tally)).toEqual([{ id: 'a', value: 1 }]);
    expect(tally.unreadable).toBe(0);
  });
});

describe('decodeTherapyProfileRow', () => {
  const Profile = z.object({
    glucoseUnit: z.enum(['mg/dL', 'mmol/L']),
    targetGlucose: z.number().positive(),
    correctionFactor: z.number().positive(),
    doseIncrement: z.number().positive(),
  });
  const valid = { glucoseUnit: 'mg/dL' as const, targetGlucose: 110, correctionFactor: 45, doseIncrement: 0.5 };

  it('sin fila es "fresh" — instalación nueva, los placeholders son legítimos', () => {
    expect(decodeTherapyProfileRow(null, Profile)).toEqual({ kind: 'fresh' });
  });

  it('una fila válida devuelve el perfil', () => {
    expect(decodeTherapyProfileRow(JSON.stringify(valid), Profile)).toEqual({ kind: 'ok', profile: valid });
  });

  it('una fila con JSON corrupto es "unreadable", NUNCA "fresh"', () => {
    // Confundir los dos casos es el bug de seguridad que este tipo previene:
    // "fresh" habilita los placeholders, y con THERAPY_CONFIGURED_KEY todavía
    // en true la calculadora los presentaría como parámetros de la usuaria.
    expect(decodeTherapyProfileRow('{"targetGlucose"', Profile)).toEqual({ kind: 'unreadable' });
  });

  it('una fila que parsea pero no valida también es "unreadable"', () => {
    expect(decodeTherapyProfileRow(JSON.stringify({ ...valid, correctionFactor: -1 }), Profile))
      .toEqual({ kind: 'unreadable' });
  });

  it('nunca devuelve un perfil junto con "unreadable"', () => {
    const result = decodeTherapyProfileRow('roto', Profile);
    expect(result.kind).toBe('unreadable');
    expect('profile' in result).toBe(false);
  });
});
