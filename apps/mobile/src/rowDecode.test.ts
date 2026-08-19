import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createDecodeTally, decodeRow, safeJsonParse, tallyParsed } from './rowDecode';

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
