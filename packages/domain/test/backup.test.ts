import { describe, expect, it } from 'vitest';

import type { BackupData, BackupFile } from '@type1a/schemas';

import {
  backupChecksum,
  buildBackup,
  canonicalJson,
  countBackupRecords,
  parseBackup,
  planBackupImport,
  serializeBackup,
  type ExistingBackupIds,
} from '../src/backup';

const EMPTY: BackupData = {
  therapyProfile: null,
  nutritionProfile: null,
  settings: {},
  glucose: [],
  insulin: [],
  carbs: [],
  meals: [],
  activity: [],
  water: [],
  notes: [],
  vitals: [],
  hba1c: [],
  recipes: [],
  foodCatalog: [],
  mealEpisodes: [],
};

const insulin = (id: string, units = 4) => ({
  id,
  timestamp: '2026-09-04T12:00:00.000Z',
  type: 'rapid' as const,
  units,
  source: 'manual' as const,
  createdAt: '2026-09-04T12:00:00.000Z',
});

const water = (id: string) => ({
  id,
  timestamp: '2026-09-04T13:00:00.000Z',
  ml: 250,
  source: 'quick' as const,
  createdAt: '2026-09-04T13:00:00.000Z',
});

const food = (key: string) => ({
  key,
  name: key,
  carbsPer100g: 28,
  proteinPer100g: 2.7,
  fatPer100g: 0.3,
  fiberPer100g: 0.4,
  kcalPer100g: 130,
  timesSeen: 3,
  lastSeenAt: '2026-09-04T12:00:00.000Z',
});

const nothingYet = (): ExistingBackupIds => ({
  eventIds: new Set(),
  foodKeys: new Set(),
  recipeKeys: new Set(),
  episodeIds: new Set(),
  hasTherapyProfile: false,
  hasNutritionProfile: false,
});

const sample = (): BackupData => ({
  ...EMPTY,
  insulin: [insulin('i1'), insulin('i2', 6)],
  water: [water('w1')],
  foodCatalog: [food('arroz')],
});

describe('JSON canónico', () => {
  it('da el mismo texto sin importar en qué orden se armó el objeto', () => {
    const a = { b: 1, a: 2, c: { z: 3, y: 4 } };
    const b = { c: { y: 4, z: 3 }, a: 2, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('conserva el orden de los arreglos, que sí significa algo', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('borra undefined pero conserva null: "no hay perfil" es un dato', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });
});

describe('huella de integridad', () => {
  it('cambia si cambia cualquier dato', () => {
    const before = backupChecksum(sample());
    const after = backupChecksum({ ...sample(), insulin: [insulin('i1'), insulin('i2', 6.5)] });
    expect(after).not.toBe(before);
  });

  it('NO cambia si solo cambia el orden de las claves', () => {
    const reordered = { water: [water('w1')], insulin: [insulin('i1'), insulin('i2', 6)] };
    const straight = { insulin: [insulin('i1'), insulin('i2', 6)], water: [water('w1')] };
    expect(backupChecksum(reordered)).toBe(backupChecksum(straight));
  });

  it('son 16 hexadecimales', () => {
    expect(backupChecksum(sample())).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('ida y vuelta', () => {
  const file = buildBackup({ data: sample(), exportedAt: '2026-09-04T20:00:00.000Z', appVersion: '0.1.0' });

  it('PROMESA 1 — exportar e importar no pierde nada', () => {
    const result = parseBackup(serializeBackup(file));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.data).toEqual(sample());
    expect(result.checksumOk).toBe(true);
  });

  it('un archivo vacío también va y vuelve', () => {
    const empty = buildBackup({ data: EMPTY, exportedAt: '2026-09-04T20:00:00.000Z' });
    const result = parseBackup(serializeBackup(empty));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(countBackupRecords(result.file.data)).toBe(0);
  });

  it('una sección que el archivo no trae llega vacía, no rompe', () => {
    const text = serializeBackup(file);
    const stripped = JSON.parse(text) as Record<string, unknown>;
    const data = stripped['data'] as Record<string, unknown>;
    delete data['notes'];
    // La huella se recalcula: acá se prueba tolerancia de versión, no corrupción.
    stripped['checksum'] = backupChecksum(data);
    const result = parseBackup(JSON.stringify(stripped));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.data.notes).toEqual([]);
  });
});

describe('rechazos', () => {
  it('un texto que no es JSON', () => {
    const result = parseBackup('no soy json {');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not_json');
  });

  it('un JSON que no es un respaldo nuestro', () => {
    const result = parseBackup('{"format":"otra-app","data":{}}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('not_a_backup');
  });

  it('un archivo de una versión futura, con un mensaje que lo dice', () => {
    const result = parseBackup('{"format":"type1a.backup","formatVersion":99,"data":{}}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'unsupported_version', found: 99 });
  });

  it('PROMESA — un archivo truncado se rechaza en vez de entrar a medias', () => {
    const file = buildBackup({ data: sample(), exportedAt: '2026-09-04T20:00:00.000Z' });
    const damaged = { ...file, data: { ...file.data, insulin: [insulin('i1')] } };
    const result = parseBackup(JSON.stringify(damaged));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('checksum_mismatch');
  });

  it('pero se puede rescatar a propósito si ella asume el riesgo', () => {
    const file = buildBackup({ data: sample(), exportedAt: '2026-09-04T20:00:00.000Z' });
    const damaged = { ...file, data: { ...file.data, insulin: [insulin('i1')] } };
    const result = parseBackup(JSON.stringify(damaged), { requireChecksum: false });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.checksumOk).toBe(false);
  });

  it('una dosis imposible no entra por venir en un archivo', () => {
    const file = buildBackup({ data: { ...EMPTY, insulin: [insulin('i1', 9999)] }, exportedAt: '2026-09-04T20:00:00.000Z' });
    const result = parseBackup(serializeBackup(file));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid');
  });
});

describe('plan de importación', () => {
  const file = buildBackup({ data: sample(), exportedAt: '2026-09-04T20:00:00.000Z' });

  it('en un teléfono vacío entra todo', () => {
    const plan = planBackupImport(file, nothingYet());
    expect(plan.totalToInsert).toBe(4); // 2 insulinas + 1 agua + 1 alimento
    expect(plan.nothingToDo).toBe(false);
  });

  it('PROMESA 3 — importar el mismo archivo dos veces no duplica nada', () => {
    const first = planBackupImport(file, nothingYet());
    const afterFirst: ExistingBackupIds = {
      ...nothingYet(),
      eventIds: new Set([...first.data.insulin, ...first.data.water].map((row) => row.id)),
      foodKeys: new Set(first.data.foodCatalog.map((row) => row.key)),
    };
    const second = planBackupImport(file, afterFirst);
    expect(second.totalToInsert).toBe(0);
    expect(second.nothingToDo).toBe(true);
    expect(second.sections.insulin.alreadyPresent).toBe(2);
  });

  it('un archivo que trae el mismo id dos veces tampoco duplica', () => {
    const doubled = buildBackup({
      data: { ...EMPTY, insulin: [insulin('i1'), insulin('i1')] },
      exportedAt: '2026-09-04T20:00:00.000Z',
    });
    const plan = planBackupImport(doubled, nothingYet());
    expect(plan.data.insulin).toHaveLength(1);
    expect(plan.sections.insulin.incoming).toBe(1);
  });

  it('lo que ya existe no se pisa: manda el teléfono, no el archivo', () => {
    const existing: ExistingBackupIds = { ...nothingYet(), eventIds: new Set(['i1']) };
    const plan = planBackupImport(file, existing);
    expect(plan.data.insulin.map((row) => row.id)).toEqual(['i2']);
    expect(plan.sections.insulin.alreadyPresent).toBe(1);
  });

  it('SEGURIDAD — un perfil de terapia ya configurado no lo reemplaza un archivo viejo', () => {
    const withProfile: BackupFile = {
      ...file,
      data: {
        ...file.data,
        therapyProfile: {
          targetGlucose: 100,
          correctionFactor: 50,
          carbRatio: 10,
          doseIncrement: 0.5,
          glucoseUnit: 'mg/dL',
        } as BackupData['therapyProfile'],
      },
    };
    const plan = planBackupImport(withProfile, { ...nothingYet(), hasTherapyProfile: true });
    expect(plan.data.therapyProfile).toBeNull();
    expect(plan.sections.therapyProfile.alreadyPresent).toBe(1);
  });

  it('pero en un teléfono nuevo el perfil sí entra', () => {
    const withProfile: BackupFile = {
      ...file,
      data: {
        ...file.data,
        therapyProfile: {
          targetGlucose: 100,
          correctionFactor: 50,
          carbRatio: 10,
          doseIncrement: 0.5,
          glucoseUnit: 'mg/dL',
        } as BackupData['therapyProfile'],
      },
    };
    const plan = planBackupImport(withProfile, nothingYet());
    expect(plan.data.therapyProfile).not.toBeNull();
  });

  it('los ajustes nunca pisan los del teléfono que recibe', () => {
    const withSettings: BackupFile = { ...file, data: { ...file.data, settings: { theme: 'dark' } } };
    const plan = planBackupImport(withSettings, nothingYet());
    expect(plan.data.settings).toEqual({});
  });
});
