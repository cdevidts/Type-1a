import { describe, expect, it } from 'vitest';

import type { BackupData, BackupFile } from '@type1a/schemas';

import {
  SETTINGS_NEVER_BACKED_UP,
  THERAPY_CONFIGURED_SETTING,
  backupChecksum,
  buildBackup,
  canonicalJson,
  countBackupRecords,
  parseBackup,
  planBackupImport,
  serializeBackup,
  settingsSafeToBackUp,
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
  photos: [],
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
  hasAnyData: false,
});

/** Un teléfono en uso: mismo shape, pero ya tiene historial propio. */
const phoneInUse = (): ExistingBackupIds => ({ ...nothingYet(), hasAnyData: true });

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

  it('los ajustes NO pisan los de un teléfono que ya tiene datos', () => {
    const withSettings: BackupFile = { ...file, data: { ...file.data, settings: { theme: 'dark' } } };
    const plan = planBackupImport(withSettings, phoneInUse());
    expect(plan.data.settings).toEqual({});
    expect(plan.sections.settings.alreadyPresent).toBe(1);
  });

  it('RESTAURAR: en un teléfono vacío los ajustes SÍ entran', () => {
    // Es el caso que importa de verdad: reinstaló la app. Si no entran, pierde
    // el nombre de su insulina, las alarmas y la unidad de glucosa.
    const withSettings: BackupFile = {
      ...file,
      data: { ...file.data, settings: { rapidInsulinId: 'lispro', glucoseUnit: 'mg/dL' } },
    };
    const plan = planBackupImport(withSettings, nothingYet());
    expect(plan.data.settings).toEqual({ rapidInsulinId: 'lispro', glucoseUnit: 'mg/dL' });
  });
});


describe('el agrupamiento de una entrada empaquetada', () => {
  // Regla 3b: lo que se guardó en un mismo acto comparte `entry_group_id`, y
  // volver a emparejar por hora está prohibido. Si el respaldo no lo lleva, un
  // desayuno restaurado se abre en cuatro filas sueltas para siempre.
  const grupo = 'grupo-desayuno-1';
  const desayuno = (): BackupData => ({
    ...EMPTY,
    meals: [{
      id: 'm1',
      timestamp: '2026-09-04T09:00:00.000Z',
      confirmedCarbsG: 62,
      createdAt: '2026-09-04T09:00:00.000Z',
      entryGroupId: grupo,
    }],
    carbs: [{ ...({ id: 'c1', timestamp: '2026-09-04T09:00:00.000Z', carbsG: 62, source: 'meal_confirmed' as const, createdAt: '2026-09-04T09:00:00.000Z' }), entryGroupId: grupo }],
    insulin: [{ ...insulin('i1', 6.7), entryGroupId: grupo }],
    glucose: [{
      id: 'g1',
      glucose: 168,
      unit: 'mg/dL' as const,
      timestamp: '2026-09-04T09:00:00.000Z',
      trend: 'unknown' as const,
      trendSource: 'unknown' as const,
      source: 'entrada manual',
      origin: 'manual' as const,
      sourceTimestamp: '2026-09-04T09:00:00.000Z',
      ingestedAt: '2026-09-04T09:00:00.000Z',
      entryGroupId: grupo,
    }],
  });

  it('LA PROMESA: las cuatro filas vuelven con el MISMO grupo', () => {
    const file = buildBackup({ data: desayuno(), exportedAt: '2026-09-04T20:00:00.000Z' });
    const result = parseBackup(serializeBackup(file));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const d = result.file.data;
    const grupos = [d.meals[0], d.carbs[0], d.insulin[0], d.glucose[0]].map((row) => row?.entryGroupId);
    expect(grupos).toEqual([grupo, grupo, grupo, grupo]);
  });

  it('y el plan de importación lo conserva', () => {
    const file = buildBackup({ data: desayuno(), exportedAt: '2026-09-04T20:00:00.000Z' });
    const plan = planBackupImport(file, nothingYet());
    expect(plan.data.insulin[0]?.entryGroupId).toBe(grupo);
    expect(plan.data.glucose[0]?.entryGroupId).toBe(grupo);
  });

  it('una fila suelta sigue sin grupo, y eso también se conserva', () => {
    const suelta: BackupData = { ...EMPTY, water: [water('w1')] };
    const file = buildBackup({ data: suelta, exportedAt: '2026-09-04T20:00:00.000Z' });
    const result = parseBackup(serializeBackup(file));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.data.water[0]?.entryGroupId).toBeUndefined();
  });
});

describe('la procedencia de cada glucosa', () => {
  const lectura = (id: string, origin: 'real' | 'manual' | 'imported') => ({
    id,
    glucose: 140,
    unit: 'mg/dL' as const,
    timestamp: '2026-09-04T09:00:00.000Z',
    trend: 'stable' as const,
    trendSource: 'provider' as const,
    source: origin === 'real' ? 'LibreLinkUp' : 'entrada manual',
    origin,
    sourceTimestamp: '2026-09-04T09:00:00.000Z',
    ingestedAt: '2026-09-04T09:02:00.000Z',
  });

  it('sensor, capilar e importado se distinguen después de ir y volver', () => {
    // Lo que ella pidió explícitamente: que no se pierda si un dato era del
    // sensor o del glucómetro. `AGENTS.md` lo exige aparte.
    const data: BackupData = {
      ...EMPTY,
      glucose: [lectura('g1', 'real'), lectura('g2', 'manual'), lectura('g3', 'imported')],
    };
    const file = buildBackup({ data, exportedAt: '2026-09-04T20:00:00.000Z' });
    const result = parseBackup(serializeBackup(file));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.data.glucose.map((r) => r.origin)).toEqual(['real', 'manual', 'imported']);
    // `sourceTimestamp` e `ingestedAt` son distintos y no se pueden confundir.
    expect(result.file.data.glucose[0]?.ingestedAt).toBe('2026-09-04T09:02:00.000Z');
    expect(result.file.data.glucose[0]?.sourceTimestamp).toBe('2026-09-04T09:00:00.000Z');
  });
});

describe('las fotos', () => {
  const foto = (uri: string) => ({ uri, data: 'QUJD', mimeType: 'image/jpeg' });
  const conFotos = (): BackupData => ({
    ...EMPTY,
    meals: [{ id: 'm1', timestamp: '2026-09-04T09:00:00.000Z', imageUri: 'file:///cache/a.jpg', createdAt: '2026-09-04T09:00:00.000Z' }],
    foodCatalog: [{ ...food('arroz'), imageUri: 'file:///cache/b.jpg' }],
    photos: [foto('file:///cache/a.jpg'), foto('file:///cache/b.jpg')],
  });

  it('viajan los bytes, no solo la ruta', () => {
    const file = buildBackup({ data: conFotos(), exportedAt: '2026-09-04T20:00:00.000Z' });
    const result = parseBackup(serializeBackup(file));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.data.photos).toHaveLength(2);
    expect(result.file.data.photos[0]?.data).toBe('QUJD');
  });

  it('solo se copian las fotos de lo que realmente se va a escribir', () => {
    const file = buildBackup({ data: conFotos(), exportedAt: '2026-09-04T20:00:00.000Z' });
    // El alimento ya existe: su foto son cientos de kB copiados para nada.
    const plan = planBackupImport(file, { ...nothingYet(), foodKeys: new Set(['arroz']) });
    expect(plan.data.photos.map((p) => p.uri)).toEqual(['file:///cache/a.jpg']);
    expect(plan.sections.photos.alreadyPresent).toBe(1);
  });

  it('una foto repetida dentro del archivo se escribe una sola vez', () => {
    const data = conFotos();
    const file = buildBackup({
      data: { ...data, photos: [...data.photos, foto('file:///cache/a.jpg')] },
      exportedAt: '2026-09-04T20:00:00.000Z',
    });
    const plan = planBackupImport(file, nothingYet());
    expect(plan.data.photos.filter((p) => p.uri === 'file:///cache/a.jpg')).toHaveLength(1);
  });

  it('sin fotos en el archivo, el plan no inventa ninguna', () => {
    const file = buildBackup({ data: sample(), exportedAt: '2026-09-04T20:00:00.000Z' });
    expect(planBackupImport(file, nothingYet()).data.photos).toEqual([]);
  });
});


describe('ajustes que NUNCA pueden viajar', () => {
  const perfil = {
    targetGlucose: 100,
    correctionFactor: 50,
    carbRatio: 10,
    doseIncrement: 0.5,
    glucoseUnit: 'mg/dL',
  } as unknown as BackupData['therapyProfile'];

  it('SEGURIDAD: `legacyBackendSensor` no sale del teléfono', () => {
    // Restaurarla en una instalación nueva le daría acceso a la cuenta global
    // del backend, y esa instalación mostraría el sensor de OTRA persona.
    const limpio = settingsSafeToBackUp({ legacyBackendSensor: 'true', mealAlarmOffsetsMinutes: '60,120' });
    expect(limpio).toEqual({ mealAlarmOffsetsMinutes: '60,120' });
  });

  it('tampoco la notificación persistente, que en otro teléfono no existe', () => {
    expect(settingsSafeToBackUp({ quickEntryNotificationEnabled: 'true' })).toEqual({});
  });

  it('las preferencias de verdad sí viajan', () => {
    const prefs = { mealAlarmOffsetsMinutes: '60,120', reminderAlertStyle: 'sound', showGlucoseOnLockScreen: 'false' };
    expect(settingsSafeToBackUp(prefs)).toEqual(prefs);
  });

  it('la lista no está vacía por accidente', () => {
    expect(SETTINGS_NEVER_BACKED_UP.length).toBeGreaterThan(0);
  });

  it('SEGURIDAD: la bandera que desbloquea las calculadoras NO entra sin su perfil', () => {
    // Sola, dejaría a la app calculando dosis sobre los parámetros placeholder
    // que trae de fábrica: parámetros que ella nunca eligió.
    const file = buildBackup({
      data: { ...EMPTY, therapyProfile: null, settings: { [THERAPY_CONFIGURED_SETTING]: '2026-01-01T00:00:00.000Z' } },
      exportedAt: '2026-09-09T20:00:00.000Z',
    });
    const plan = planBackupImport(file, nothingYet());
    expect(plan.data.settings[THERAPY_CONFIGURED_SETTING]).toBeUndefined();
    expect(plan.data.therapyProfile).toBeNull();
  });

  it('pero acompañada de su perfil sí entra, que es el caso de restaurar', () => {
    const file = buildBackup({
      data: { ...EMPTY, therapyProfile: perfil, settings: { [THERAPY_CONFIGURED_SETTING]: '2026-01-01T00:00:00.000Z' } },
      exportedAt: '2026-09-09T20:00:00.000Z',
    });
    const plan = planBackupImport(file, nothingYet());
    expect(plan.data.therapyProfile).not.toBeNull();
    expect(plan.data.settings[THERAPY_CONFIGURED_SETTING]).toBe('2026-01-01T00:00:00.000Z');
  });

  it('y si el teléfono YA tiene su perfil, no entra ninguna de las dos', () => {
    const file = buildBackup({
      data: { ...EMPTY, therapyProfile: perfil, settings: { [THERAPY_CONFIGURED_SETTING]: '2026-01-01T00:00:00.000Z' } },
      exportedAt: '2026-09-09T20:00:00.000Z',
    });
    const plan = planBackupImport(file, { ...phoneInUse(), hasTherapyProfile: true });
    expect(plan.data.therapyProfile).toBeNull();
    expect(plan.data.settings).toEqual({});
  });
});
