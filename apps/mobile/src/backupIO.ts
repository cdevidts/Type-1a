/**
 * Leer y escribir el archivo de respaldo `.t1a.json` contra SQLite.
 *
 * `packages/domain/src/backup.ts` define el **formato** y decide qué entra al
 * importar; este archivo es el que toca la base. La división es la de siempre:
 * el dominio es puro y con test, esto es el cableado.
 *
 * ## Lo que costó descubrir, y no se puede volver a perder
 *
 * **`entry_group_id` viaja con cada fila.** Siete tablas lo tienen, y es lo
 * único que hace que un desayuno registrado de una vez se vea como una cosa.
 * Los `get*Events` de `db.ts` **no lo devuelven** —no lo necesitan para
 * dibujar—, así que acá se consulta crudo en vez de reusarlos. Restaurar sin
 * esa columna abre cada entrada empaquetada en filas sueltas, y la Regla 3b
 * prohíbe volver a emparejarlas por hora.
 *
 * **Las fotos son bytes, no rutas.** `imageUri` apunta a un archivo del
 * teléfono; copiar solo el texto deja la foto rota en una instalación nueva.
 */

import { File, Paths } from 'expo-file-system';
import type { SQLiteDatabase } from 'expo-sqlite';

import {
  ActivityEventSchema,
  BackupCGMReadingSchema,
  BackupCarbEventSchema,
  BackupCatalogFoodSchema,
  BackupInsulinEventSchema,
  BackupMealEpisodeSchema,
  BackupMealEventSchema,
  BackupNoteEventSchema,
  BackupRecipeSchema,
  BackupVitalsEventSchema,
  BackupWaterEventSchema,
  HbA1cLabResultSchema,
  NutritionProfileSchema,
  TherapyProfileSchema,
  type BackupData,
  type BackupFile,
  type BackupPhoto,
} from '@type1a/schemas';
import {
  buildBackup,
  settingsSafeToBackUp,
  type BackupImportPlan,
  type ExistingBackupIds,
} from '@type1a/domain';
import type { ZodType } from 'zod';

import { serializedTransaction } from './db';
import { safeJsonParse } from './rowDecode';

/** Dónde viven las fotos que sobreviven a un vaciado de caché. */
const PHOTO_DIR = 'type1a-fotos';

// ---------------------------------------------------------------------------
// Leer
// ---------------------------------------------------------------------------

interface PayloadRow {
  payload: string;
  entry_group_id: string | null;
}

/**
 * Decodifica filas `payload` + `entry_group_id`.
 *
 * Una fila que no valida **se descarta y se cuenta**, nunca se adivina: un
 * respaldo con un dato inventado es peor que uno que declara lo que no pudo
 * leer. El conteo sube a `skipped` y la pantalla lo muestra.
 */
function decodePayloadRows<T>(rows: readonly PayloadRow[], schema: ZodType<T>, skipped: { count: number }): T[] {
  const out: T[] = [];
  for (const row of rows) {
    const raw = safeJsonParse(row.payload);
    if (raw === undefined || raw === null || typeof raw !== 'object') {
      skipped.count += 1;
      continue;
    }
    const withGroup = row.entry_group_id === null
      ? raw
      : { ...(raw as Record<string, unknown>), entryGroupId: row.entry_group_id };
    const parsed = schema.safeParse(withGroup);
    if (parsed.success) out.push(parsed.data);
    else skipped.count += 1;
  }
  return out;
}

async function readPhoto(uri: string): Promise<BackupPhoto | null> {
  try {
    const file = new File(uri);
    if (!file.exists) return null;
    return { uri, data: await file.base64(), mimeType: 'image/jpeg' };
  } catch {
    // Una foto que Android ya se llevó de la caché no puede tumbar la
    // exportación entera: se declara faltante y el resto se respalda.
    return null;
  }
}

export interface CollectBackupResult {
  file: BackupFile;
  /** Filas que no se pudieron decodificar y quedaron fuera. */
  skippedRows: number;
  /** Fotos cuyo archivo ya no existe en el teléfono. */
  missingPhotos: number;
}

export interface CollectBackupOptions {
  exportedAt: string;
  appVersion?: string | undefined;
  timeZone?: string | undefined;
  /**
   * Con `false` el archivo sale sin fotos: mucho más liviano, y sirve para
   * mover datos entre teléfonos que ya comparten catálogo. El respaldo de
   * verdad va con fotos.
   */
  includePhotos?: boolean;
}

export async function collectBackup(db: SQLiteDatabase, options: CollectBackupOptions): Promise<CollectBackupResult> {
  const skipped = { count: 0 };
  const all = <T>(sql: string) => db.getAllAsync<T>(sql);

  const [insulinRows, mealRows, noteRows, vitalsRows, waterRows, activityRows, hba1cRows, cgmRows] = await Promise.all([
    all<PayloadRow>('SELECT payload, entry_group_id FROM insulin_events ORDER BY timestamp ASC'),
    all<PayloadRow>('SELECT payload, entry_group_id FROM meal_events ORDER BY timestamp ASC'),
    all<PayloadRow>('SELECT payload, entry_group_id FROM note_events ORDER BY timestamp ASC'),
    all<PayloadRow>('SELECT payload, entry_group_id FROM vitals_events ORDER BY timestamp ASC'),
    all<PayloadRow>('SELECT payload, entry_group_id FROM water_events ORDER BY timestamp ASC'),
    all<PayloadRow>("SELECT payload, NULL AS entry_group_id FROM activity_events ORDER BY timestamp ASC"),
    all<PayloadRow>("SELECT payload, NULL AS entry_group_id FROM hba1c_results ORDER BY timestamp ASC"),
    all<PayloadRow>('SELECT payload, entry_group_id FROM cgm_readings ORDER BY source_timestamp ASC'),
  ]);

  const carbRows = await all<{ id: string; timestamp: string; carbs_g: number; source: string; created_at: string; entry_group_id: string | null }>(
    'SELECT id, timestamp, carbs_g, source, created_at, entry_group_id FROM carb_events ORDER BY timestamp ASC',
  );
  const carbs = carbRows.flatMap((row) => {
    const parsed = BackupCarbEventSchema.safeParse({
      id: row.id,
      timestamp: row.timestamp,
      carbsG: row.carbs_g,
      source: row.source,
      createdAt: row.created_at,
      ...(row.entry_group_id === null ? {} : { entryGroupId: row.entry_group_id }),
    });
    if (!parsed.success) { skipped.count += 1; return []; }
    return [parsed.data];
  });

  const catalogRows = await all<{
    key: string; name: string; carbs_per_100g: number; protein_per_100g: number; fat_per_100g: number;
    fiber_per_100g: number; kcal_per_100g: number; times_seen: number; last_seen_at: string;
    serving_grams: number | null; serving_label: string | null; serving_source: string | null;
    image_uri: string | null; listed: number;
  }>('SELECT * FROM food_catalog ORDER BY key ASC');
  const foodCatalog = catalogRows.flatMap((row) => {
    const parsed = BackupCatalogFoodSchema.safeParse({
      key: row.key,
      name: row.name,
      carbsPer100g: row.carbs_per_100g,
      proteinPer100g: row.protein_per_100g,
      fatPer100g: row.fat_per_100g,
      fiberPer100g: row.fiber_per_100g,
      kcalPer100g: row.kcal_per_100g,
      timesSeen: row.times_seen,
      lastSeenAt: row.last_seen_at,
      ...(row.serving_grams === null ? {} : { servingGrams: row.serving_grams }),
      ...(row.serving_label === null ? {} : { servingLabel: row.serving_label }),
      ...(row.serving_source === null ? {} : { servingSource: row.serving_source }),
      ...(row.image_uri === null ? {} : { imageUri: row.image_uri }),
      listed: row.listed !== 0,
    });
    if (!parsed.success) { skipped.count += 1; return []; }
    return [parsed.data];
  });

  const recipeRows = await all<{ id: string; key: string; name: string; image_uri: string | null; times_seen: number; created_at: string; last_seen_at: string }>(
    'SELECT * FROM recipes ORDER BY key ASC',
  );
  const itemRows = await all<{ recipe_id: string; food_key: string; grams: number }>('SELECT * FROM recipe_items');
  const recipes = recipeRows.flatMap((row) => {
    const parsed = BackupRecipeSchema.safeParse({
      id: row.id,
      key: row.key,
      name: row.name,
      items: itemRows.filter((item) => item.recipe_id === row.id).map((item) => ({ foodKey: item.food_key, grams: item.grams })),
      ...(row.image_uri === null ? {} : { imageUri: row.image_uri }),
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      timesSeen: row.times_seen,
    });
    if (!parsed.success) { skipped.count += 1; return []; }
    return [parsed.data];
  });

  const episodeRows = await all<{
    id: string; meal_id: string; meal_timestamp: string; status: string;
    rapid_insulin_event_id: string | null; insulin_context_confirmed: number;
    metrics_json: string | null; insight_json: string | null;
  }>('SELECT * FROM meal_episodes ORDER BY meal_timestamp ASC');
  const mealEpisodes = episodeRows.flatMap((row) => {
    const parsed = BackupMealEpisodeSchema.safeParse({
      id: row.id,
      mealId: row.meal_id,
      mealTimestamp: row.meal_timestamp,
      status: row.status,
      insulinContextConfirmed: row.insulin_context_confirmed !== 0,
      ...(row.rapid_insulin_event_id === null ? {} : { rapidInsulinEventId: row.rapid_insulin_event_id }),
      ...(row.metrics_json === null ? {} : { metrics: safeJsonParse(row.metrics_json) }),
      ...(row.insight_json === null ? {} : { insight: safeJsonParse(row.insight_json) }),
    });
    if (!parsed.success) { skipped.count += 1; return []; }
    return [parsed.data];
  });

  const settingRows = await all<{ key: string; value: string }>('SELECT key, value FROM app_settings');
  const raw: Record<string, string> = {};
  for (const row of settingRows) raw[row.key] = row.value;
  // Se filtra al **exportar**, no al importar: así el archivo nunca llega a
  // contener una clave de instalación, ni siquiera si alguien lo abre a mano.
  const settings = settingsSafeToBackUp(raw);

  const profileRow = await db.getFirstAsync<{ payload: string }>('SELECT payload FROM therapy_profile WHERE id = 1');
  const therapyParsed = profileRow === null ? null : TherapyProfileSchema.safeParse(safeJsonParse(profileRow.payload));
  const nutritionRaw = settings['nutritionProfile'];
  const nutritionParsed = nutritionRaw === undefined ? null : NutritionProfileSchema.safeParse(safeJsonParse(nutritionRaw));

  const meals = decodePayloadRows(mealRows, BackupMealEventSchema, skipped);

  // Solo se leen las fotos que alguien reclama. Un archivo huérfano en el
  // directorio no es un dato: es basura de una edición que se deshizo.
  const photos: BackupPhoto[] = [];
  let missingPhotos = 0;
  if (options.includePhotos !== false) {
    const uris = new Set<string>();
    for (const meal of meals) if (meal.imageUri !== undefined) uris.add(meal.imageUri);
    for (const food of foodCatalog) if (food.imageUri !== undefined) uris.add(food.imageUri);
    for (const recipe of recipes) if (recipe.imageUri !== undefined) uris.add(recipe.imageUri);
    for (const uri of uris) {
      const photo = await readPhoto(uri);
      if (photo === null) missingPhotos += 1;
      else photos.push(photo);
    }
  }

  const data: BackupData = {
    therapyProfile: therapyParsed !== null && therapyParsed.success ? therapyParsed.data : null,
    nutritionProfile: nutritionParsed !== null && nutritionParsed.success ? nutritionParsed.data : null,
    settings,
    glucose: decodePayloadRows(cgmRows, BackupCGMReadingSchema, skipped),
    insulin: decodePayloadRows(insulinRows, BackupInsulinEventSchema, skipped),
    carbs,
    meals,
    activity: decodePayloadRows(activityRows, ActivityEventSchema, skipped),
    water: decodePayloadRows(waterRows, BackupWaterEventSchema, skipped),
    notes: decodePayloadRows(noteRows, BackupNoteEventSchema, skipped),
    vitals: decodePayloadRows(vitalsRows, BackupVitalsEventSchema, skipped),
    hba1c: decodePayloadRows(hba1cRows, HbA1cLabResultSchema, skipped),
    recipes,
    foodCatalog,
    mealEpisodes,
    photos,
  };

  return {
    file: buildBackup({
      data,
      exportedAt: options.exportedAt,
      ...(options.appVersion === undefined ? {} : { appVersion: options.appVersion }),
      ...(options.timeZone === undefined ? {} : { timeZone: options.timeZone }),
    }),
    skippedRows: skipped.count,
    missingPhotos,
  };
}

/** Qué hay ya en el teléfono, para que el dominio decida qué escribir. */
export async function backupSnapshotIds(db: SQLiteDatabase): Promise<ExistingBackupIds> {
  const ids = async (sql: string) => (await db.getAllAsync<{ id: string }>(sql)).map((row) => row.id);
  const eventIds = new Set([
    ...(await ids('SELECT id FROM insulin_events')),
    ...(await ids('SELECT id FROM carb_events')),
    ...(await ids('SELECT id FROM meal_events')),
    ...(await ids('SELECT id FROM cgm_readings')),
    ...(await ids('SELECT id FROM note_events')),
    ...(await ids('SELECT id FROM vitals_events')),
    ...(await ids('SELECT id FROM water_events')),
    ...(await ids('SELECT id FROM activity_events')),
    ...(await ids('SELECT id FROM hba1c_results')),
  ]);
  const keys = async (sql: string) => new Set((await db.getAllAsync<{ key: string }>(sql)).map((row) => row.key));
  const episodeIds = new Set(await ids('SELECT id FROM meal_episodes'));
  const therapy = await db.getFirstAsync<{ payload: string }>('SELECT payload FROM therapy_profile WHERE id = 1');
  const nutrition = await db.getFirstAsync<{ value: string }>("SELECT value FROM app_settings WHERE key = 'nutritionProfile'");

  return {
    eventIds,
    foodKeys: await keys('SELECT key FROM food_catalog'),
    recipeKeys: await keys('SELECT key FROM recipes'),
    episodeIds,
    // El perfil de terapia se auto-crea con valores por defecto al abrir la
    // base, así que "existe la fila" no significa "ella lo configuró". Lo que
    // decide es si hay historial: en una instalación nueva no lo hay.
    hasTherapyProfile: therapy !== null && eventIds.size > 0,
    hasNutritionProfile: nutrition !== null,
    hasAnyData: eventIds.size > 0,
  };
}

// ---------------------------------------------------------------------------
// Escribir
// ---------------------------------------------------------------------------

/**
 * Escribe las fotos del plan y devuelve el mapa `rutaVieja → rutaNueva`.
 *
 * Va **fuera** de la transacción a propósito: escribir archivos no es
 * transaccional, y dejar un `BEGIN` abierto mientras se copian decenas de
 * megabytes bloquearía cada escritura de la app. Si algo falla acá, lo peor que
 * queda son archivos sueltos, no filas a medio escribir.
 */
async function writePhotos(photos: readonly BackupPhoto[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (photos.length === 0) return map;
  for (const [index, photo] of photos.entries()) {
    try {
      const target = new File(Paths.document, `${PHOTO_DIR}/restaurada-${Date.now()}-${index}.jpg`);
      target.create({ intermediates: true, overwrite: true });
      target.write(Uint8Array.from(atob(photo.data), (char) => char.charCodeAt(0)));
      map.set(photo.uri, target.uri);
    } catch {
      // Una foto que no se pudo escribir deja su fila sin imagen, no sin fila.
    }
  }
  return map;
}

const remap = (uri: string | undefined, map: Map<string, string>): string | undefined =>
  uri === undefined ? undefined : (map.get(uri) ?? uri);

/**
 * Aplica el plan. **Todo en una transacción**: un respaldo que entra a medias
 * y deja el timeline inconsistente es peor que uno que no entra.
 */
export async function applyBackupImport(db: SQLiteDatabase, plan: BackupImportPlan): Promise<void> {
  const photoMap = await writePhotos(plan.data.photos);
  const d = plan.data;

  await serializedTransaction(db, async () => {
    const payload = async (table: string, rows: readonly { id: string; timestamp: string; createdAt: string; entryGroupId?: string | undefined }[]) => {
      for (const row of rows) {
        await db.runAsync(
          `INSERT OR IGNORE INTO ${table} (id, timestamp, payload, created_at, entry_group_id) VALUES (?, ?, ?, ?, ?)`,
          row.id, row.timestamp, JSON.stringify(row), row.createdAt, row.entryGroupId ?? null,
        );
      }
    };

    for (const row of d.insulin) {
      await db.runAsync(
        'INSERT OR IGNORE INTO insulin_events (id, timestamp, type, units, payload, created_at, entry_group_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
        row.id, row.timestamp, row.type, row.units, JSON.stringify(row), row.createdAt, row.entryGroupId ?? null,
      );
    }
    for (const row of d.carbs) {
      await db.runAsync(
        'INSERT OR IGNORE INTO carb_events (id, timestamp, carbs_g, source, created_at, entry_group_id) VALUES (?, ?, ?, ?, ?, ?)',
        row.id, row.timestamp, row.carbsG, row.source, row.createdAt, row.entryGroupId ?? null,
      );
    }
    for (const row of d.meals) {
      const fixed = { ...row, ...(remap(row.imageUri, photoMap) === undefined ? {} : { imageUri: remap(row.imageUri, photoMap) }) };
      await db.runAsync(
        'INSERT OR IGNORE INTO meal_events (id, timestamp, payload, created_at, entry_group_id) VALUES (?, ?, ?, ?, ?)',
        row.id, row.timestamp, JSON.stringify(fixed), row.createdAt, row.entryGroupId ?? null,
      );
    }
    for (const row of d.glucose) {
      await db.runAsync(
        'INSERT OR IGNORE INTO cgm_readings (id, source_timestamp, payload, ingested_at, entry_group_id) VALUES (?, ?, ?, ?, ?)',
        row.id, row.sourceTimestamp, JSON.stringify(row), row.ingestedAt, row.entryGroupId ?? null,
      );
    }
    await payload('note_events', d.notes);
    await payload('vitals_events', d.vitals);
    await payload('water_events', d.water);

    for (const row of d.activity) {
      await db.runAsync(
        'INSERT OR IGNORE INTO activity_events (id, timestamp, payload, created_at) VALUES (?, ?, ?, ?)',
        row.id, row.timestamp, JSON.stringify(row), row.createdAt,
      );
    }
    for (const row of d.hba1c) {
      await db.runAsync(
        'INSERT OR IGNORE INTO hba1c_results (id, timestamp, payload, created_at) VALUES (?, ?, ?, ?)',
        row.id, row.timestamp, JSON.stringify(row), row.createdAt,
      );
    }

    for (const food of d.foodCatalog) {
      const uri = remap(food.imageUri, photoMap);
      await db.runAsync(
        `INSERT OR IGNORE INTO food_catalog
          (key, name, carbs_per_100g, protein_per_100g, fat_per_100g, fiber_per_100g, kcal_per_100g,
           times_seen, last_seen_at, serving_grams, serving_label, serving_source, image_uri, listed)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        food.key, food.name, food.carbsPer100g, food.proteinPer100g, food.fatPer100g, food.fiberPer100g,
        food.kcalPer100g, food.timesSeen, food.lastSeenAt, food.servingGrams ?? null,
        food.servingLabel ?? null, food.servingSource ?? null, uri ?? null, food.listed === false ? 0 : 1,
      );
    }

    for (const recipe of d.recipes) {
      const uri = remap(recipe.imageUri, photoMap);
      await db.runAsync(
        'INSERT OR IGNORE INTO recipes (id, key, name, image_uri, times_seen, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        recipe.id, recipe.key, recipe.name, uri ?? null, recipe.timesSeen, recipe.createdAt, recipe.lastSeenAt,
      );
      for (const item of recipe.items) {
        await db.runAsync(
          'INSERT OR IGNORE INTO recipe_items (recipe_id, food_key, grams) VALUES (?, ?, ?)',
          recipe.id, item.foodKey, item.grams,
        );
      }
    }

    for (const episode of d.mealEpisodes) {
      await db.runAsync(
        `INSERT OR IGNORE INTO meal_episodes
          (id, meal_id, meal_timestamp, status, rapid_insulin_event_id, insulin_context_confirmed, metrics_json, insight_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        episode.id, episode.mealId, episode.mealTimestamp, episode.status,
        episode.rapidInsulinEventId ?? null, episode.insulinContextConfirmed ? 1 : 0,
        episode.metrics === undefined ? null : JSON.stringify(episode.metrics),
        episode.insight === undefined ? null : JSON.stringify(episode.insight),
        episode.mealTimestamp,
      );
    }

    if (d.therapyProfile !== null) {
      await db.runAsync(
        'INSERT OR REPLACE INTO therapy_profile (id, payload, updated_at) VALUES (1, ?, ?)',
        JSON.stringify(d.therapyProfile), new Date().toISOString(),
      );
    }
    if (d.nutritionProfile !== null) {
      await db.runAsync(
        "INSERT OR REPLACE INTO app_settings (key, value) VALUES ('nutritionProfile', ?)",
        JSON.stringify(d.nutritionProfile),
      );
    }
    for (const [key, value] of Object.entries(d.settings)) {
      await db.runAsync('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)', key, value);
    }
  });
}
