import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { SQLiteDatabase } from 'expo-sqlite';
import { z } from 'zod';

import { applyCatalogEdit, blendCatalogEntry, convertGlucose, foodKey, isPlausibleCatalogEntry, planMySugrImport, type CatalogFood, type CatalogFoodEdit } from '@type1a/domain';
import {
  ActivityEventSchema,
  CGMReadingSchema,
  CarbEventSchema,
  GlucoseInsightSchema,
  HbA1cLabResultSchema,
  InsulinEventSchema,
  MealEpisodeMetricsSchema,
  MealEventSchema,
  NutritionProfileSchema,
  NoteEventSchema,
  TherapyProfileSchema,
  VitalsEventSchema,
  type ActivityEvent,
  type CGMReading,
  type CarbEvent,
  type GlucoseInsight,
  type HbA1cLabResult,
  type InsulinEvent,
  type MealEpisodeMetrics,
  type MealEvent,
  type NutritionProfile,
  type NoteEvent,
  type TherapyProfile,
  type VitalsEvent,
} from '@type1a/schemas';

import { hasMealContent, MEAL_FIELDS } from './mealFields';
import { decodeRow, decodeTherapyProfileRow, safeJsonParse, tallyParsed, type DecodeTally, type TherapyProfileRead } from './rowDecode';
import type { PendingInsulinAssociation, ReminderAlertStyle, StoredMealEpisode, TimelineItem } from './types';

const DATABASE_KEY_NAME = 'type1a.database-key.v1';

const DEFAULT_PROFILE: TherapyProfile = {
  glucoseUnit: 'mg/dL',
  targetGlucose: 110,
  correctionFactor: 45,
  doseIncrement: 0.5,
};

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// La decodificación tolerante de filas vive en `./rowDecode` (lógica pura,
// con test propio) — ver la cabecera de ese archivo para el porqué.
export { createDecodeTally, type DecodeTally, type TherapyProfileRead } from './rowDecode';

async function getDatabaseKey(): Promise<string> {
  const stored = await SecureStore.getItemAsync(DATABASE_KEY_NAME);
  if (stored !== null) return stored;
  const generated = bytesToHex(await Crypto.getRandomBytesAsync(32));
  await SecureStore.setItemAsync(DATABASE_KEY_NAME, generated, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return generated;
}

export async function initializeDatabase(db: SQLiteDatabase): Promise<void> {
  const key = await getDatabaseKey();
  await db.execAsync(`PRAGMA key = "x'${key}'";`);
  await db.execAsync('PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS therapy_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS insulin_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('rapid', 'basal')),
      units REAL NOT NULL CHECK (units > 0),
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS insulin_events_timestamp ON insulin_events(timestamp);
    CREATE TABLE IF NOT EXISTS carb_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      carbs_g REAL NOT NULL CHECK (carbs_g >= 0),
      source TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS carb_events_timestamp ON carb_events(timestamp);
    CREATE TABLE IF NOT EXISTS meal_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meal_episodes (
      id TEXT PRIMARY KEY,
      meal_id TEXT NOT NULL UNIQUE REFERENCES meal_events(id) ON DELETE CASCADE,
      meal_timestamp TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('collecting', 'complete', 'incomplete')),
      rapid_insulin_event_id TEXT REFERENCES insulin_events(id),
      insulin_context_confirmed INTEGER NOT NULL DEFAULT 0,
      metrics_json TEXT,
      insight_json TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS meal_episodes_status ON meal_episodes(status, meal_timestamp);
    CREATE TABLE IF NOT EXISTS cgm_readings (
      id TEXT PRIMARY KEY,
      source_timestamp TEXT NOT NULL,
      payload TEXT NOT NULL,
      ingested_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cgm_source_timestamp ON cgm_readings(source_timestamp);
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS activity_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS activity_events_timestamp ON activity_events(timestamp);
    CREATE TABLE IF NOT EXISTS note_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS note_events_timestamp ON note_events(timestamp);
    CREATE TABLE IF NOT EXISTS vitals_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS vitals_events_timestamp ON vitals_events(timestamp);
    CREATE TABLE IF NOT EXISTS hba1c_results (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS hba1c_results_timestamp ON hba1c_results(timestamp);

    -- Fase 15: catálogo de alimentos propio, construido con lo que la IA va
    -- identificando. Todo por 100 g para que una porción distinta escale sola
    -- (ver \`packages/domain/src/food-catalog.ts\`). \`key\` es el nombre
    -- normalizado, así que reconocer el mismo alimento otra vez actualiza la
    -- fila en vez de duplicarla.
    CREATE TABLE IF NOT EXISTS food_catalog (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      carbs_per_100g REAL NOT NULL,
      protein_per_100g REAL NOT NULL,
      fat_per_100g REAL NOT NULL,
      fiber_per_100g REAL NOT NULL,
      kcal_per_100g REAL NOT NULL,
      times_seen INTEGER NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS food_catalog_last_seen ON food_catalog(last_seen_at DESC);
  `);

  // Porción de referencia (Fase 18). Se agrega con ALTER y NO con un CREATE
  // nuevo: la tabla ya tiene datos reales en el teléfono de Verónica, y todo
  // el catálogo sigue guardándose por 100 g. Ausente = 100 g, así que las
  // filas viejas siguen comportándose exactamente igual.
  const catalogColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(food_catalog)');
  if (!catalogColumns.some((column) => column.name === 'serving_grams')) {
    await db.execAsync('ALTER TABLE food_catalog ADD COLUMN serving_grams REAL;');
  }
  if (!catalogColumns.some((column) => column.name === 'serving_label')) {
    await db.execAsync('ALTER TABLE food_catalog ADD COLUMN serving_label TEXT;');
  }

  const episodeColumns = await db.getAllAsync<{ name: string }>('PRAGMA table_info(meal_episodes)');
  if (!episodeColumns.some((column) => column.name === 'rapid_insulin_event_id')) {
    await db.execAsync('ALTER TABLE meal_episodes ADD COLUMN rapid_insulin_event_id TEXT REFERENCES insulin_events(id);');
  }
  if (!episodeColumns.some((column) => column.name === 'insulin_context_confirmed')) {
    await db.execAsync('ALTER TABLE meal_episodes ADD COLUMN insulin_context_confirmed INTEGER NOT NULL DEFAULT 0;');
  }

  // entry_group_id (nullable): ties together everything written by one
  // "Nueva entrada" save — glucose, the meal/carbs, rapid, basal, note —
  // so they can be shown and edited as one packaged thing instead of N
  // unrelated rows. NULL for anything written outside that flow (the
  // one-datum quick actions, MySugr imports) — those stay standalone
  // Timeline items exactly as before. See saveUnifiedEntry/getTimeline.
  // `vitals_events` se sumó el 2026-08-25, cuando "Nueva entrada" y el
  // editor ganaron el campo de cetonas: sin la columna, esa medición quedaba
  // suelta y editarla habría exigido emparejarla por timestamp — exactamente
  // el acoplamiento frágil que causó el bug de insulina↔comida de la Fase 21.
  for (const table of ['insulin_events', 'carb_events', 'cgm_readings', 'note_events', 'meal_events', 'vitals_events']) {
    const columns = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!columns.some((column) => column.name === 'entry_group_id')) {
      await db.execAsync(`ALTER TABLE ${table} ADD COLUMN entry_group_id TEXT;`);
      await db.execAsync(`CREATE INDEX IF NOT EXISTS ${table}_entry_group_id ON ${table}(entry_group_id);`);
    }
  }

  await db.runAsync(
    'INSERT OR IGNORE INTO therapy_profile (id, payload, updated_at) VALUES (1, ?, ?)',
    JSON.stringify(DEFAULT_PROFILE),
    new Date().toISOString(),
  );
}

export async function getTherapyProfile(db: SQLiteDatabase): Promise<TherapyProfileRead<TherapyProfile>> {
  const row = await db.getFirstAsync<{ payload: string }>('SELECT payload FROM therapy_profile WHERE id = 1');
  // La decisión de los tres casos vive en `rowDecode.ts` (pura, con test).
  // Acá deliberadamente NO se lanza ni se cae a `DEFAULT_PROFILE`: lanzar
  // desde el `Promise.all` de `loadLocalState` tumbaba la carga entera —
  // dejando la app en blanco sin avisar y, peor, haciendo que cada guardado
  // exitoso reportara "no se pudo guardar" (porque cada write termina con un
  // `loadLocalState()`), lo que llevaba a registrar la misma insulina dos
  // veces. Quien llama decide qué hacer con `unreadable`.
  return decodeTherapyProfileRow(row === null ? null : row.payload, TherapyProfileSchema);
}

/** Los placeholders que se muestran mientras no haya un perfil real cargado. */
export const PLACEHOLDER_THERAPY_PROFILE: TherapyProfile = DEFAULT_PROFILE;

/**
 * The row seeded by `initializeDatabase` holds placeholder numbers so the
 * app has something to render — they are NOT Verónica's therapy parameters
 * until she has actually entered them. This flag is what tells the two apart.
 * Any screen that turns these values into an insulin number must refuse to
 * calculate while it is false; showing a dose derived from a shipped default
 * would be inferring a therapy parameter, which AGENTS.md forbids.
 */
export const THERAPY_CONFIGURED_KEY = 'therapyConfiguredAt';

export async function isTherapyConfigured(db: SQLiteDatabase): Promise<boolean> {
  return (await getSetting(db, THERAPY_CONFIGURED_KEY)) !== null;
}

export async function saveTherapyProfile(
  db: SQLiteDatabase,
  profile: TherapyProfile,
  options: { markConfigured?: boolean } = {},
): Promise<void> {
  const parsed = TherapyProfileSchema.parse(profile);
  const now = new Date().toISOString();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'INSERT OR REPLACE INTO therapy_profile (id, payload, updated_at) VALUES (1, ?, ?)',
      JSON.stringify(parsed),
      now,
    );
    // Only an intentional trip to the therapy section counts as configuring.
    // The correction sheet also saves these values, but there saving is a
    // side effect of asking for a number ("Guardar parámetros y calcular") —
    // treating that as configuration would let one tap on pre-filled
    // defaults permanently vouch for numbers nobody chose.
    if (options.markConfigured === true) {
      await setSetting(db, THERAPY_CONFIGURED_KEY, now);
    }
  });
}

export async function saveInsulinEvent(
  db: SQLiteDatabase,
  event: InsulinEvent,
  entryGroupId?: string,
): Promise<void> {
  const parsed = InsulinEventSchema.parse(event);
  await db.runAsync(
    'INSERT OR IGNORE INTO insulin_events (id, timestamp, type, units, payload, created_at, entry_group_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    parsed.id,
    parsed.timestamp,
    parsed.type,
    parsed.units,
    JSON.stringify(parsed),
    parsed.createdAt,
    entryGroupId ?? null,
  );
}

export async function saveCarbEvent(
  db: SQLiteDatabase,
  input: { id: string; timestamp: string; carbsG: number; source: 'manual' | 'meal_confirmed' | 'imported'; createdAt: string },
  entryGroupId?: string,
): Promise<void> {
  // Validate explicitly rather than relying only on the SQL CHECK
  // constraint: now that this is INSERT OR IGNORE (for idempotent
  // imports), a constraint violation would otherwise be silently dropped
  // instead of surfacing to the caller.
  const parsed = CarbEventSchema.parse(input);
  await db.runAsync(
    'INSERT OR IGNORE INTO carb_events (id, timestamp, carbs_g, source, created_at, entry_group_id) VALUES (?, ?, ?, ?, ?, ?)',
    parsed.id,
    parsed.timestamp,
    parsed.carbsG,
    parsed.source,
    parsed.createdAt,
    entryGroupId ?? null,
  );
}

export async function updateInsulinEvent(
  db: SQLiteDatabase,
  id: string,
  updates: { type: 'rapid' | 'basal'; units: number; insulinName?: string },
): Promise<void> {
  const row = await db.getFirstAsync<{ payload: string }>('SELECT payload FROM insulin_events WHERE id = ?', id);
  if (row === null) return;
  const existing = InsulinEventSchema.parse(JSON.parse(row.payload));
  const next = InsulinEventSchema.parse({
    ...existing,
    type: updates.type,
    units: updates.units,
    // Assigned unconditionally, not conditionally spread: passing
    // `undefined` here must actually clear a previously-set name, not leave
    // `existing.insulinName` untouched.
    insulinName: updates.insulinName,
  });
  await db.runAsync(
    'UPDATE insulin_events SET type = ?, units = ?, payload = ? WHERE id = ?',
    next.type,
    next.units,
    JSON.stringify(next),
    id,
  );
}

export async function deleteInsulinEvent(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM insulin_events WHERE id = ?', id);
}

export async function updateCarbEvent(db: SQLiteDatabase, id: string, carbsG: number): Promise<void> {
  // Re-validate rather than trusting the caller — same reasoning as
  // saveCarbEvent: this bypasses the SQL CHECK constraint's ability to
  // surface a rejection since UPDATE, like INSERT OR IGNORE, doesn't throw
  // in a way the caller can rely on.
  CarbEventSchema.shape.carbsG.parse(carbsG);
  const row = await db.getFirstAsync<{ timestamp: string; source: string }>(
    'SELECT timestamp, source FROM carb_events WHERE id = ?',
    id,
  );
  await db.withTransactionAsync(async () => {
    await db.runAsync('UPDATE carb_events SET carbs_g = ? WHERE id = ?', carbsG, id);
    // A `meal_confirmed` row is a second copy of the same fact as
    // `meal_events.payload.confirmedCarbsG` (see writeMealWithEpisode) —
    // without this, editing this row would fork the two apart, and
    // everything else that reads "confirmed carbs" for the meal
    // (episode metrics, the AI insight, the insulin-association prompt,
    // the "Comida registrada" Timeline item) would keep showing the old
    // number while this one shows the correction.
    if (row !== null && row.source === 'meal_confirmed') {
      const meal = await db.getFirstAsync<{ id: string; payload: string }>(
        "SELECT id, payload FROM meal_events WHERE timestamp = ?",
        row.timestamp,
      );
      if (meal !== null) {
        const existing = MealEventSchema.parse(JSON.parse(meal.payload));
        const next = MealEventSchema.parse({ ...existing, confirmedCarbsG: carbsG });
        await db.runAsync('UPDATE meal_events SET payload = ? WHERE id = ?', JSON.stringify(next), meal.id);
      }
    }
  });
}

export async function deleteCarbEvent(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM carb_events WHERE id = ?', id);
}

/**
 * Actualiza `note` y `confirmedCarbsG` de una comida — para editar un grupo
 * de "Nueva entrada" empaquetado (`updateUnifiedEntryGroup`), where carbs
 * and note are meant to be edited together in one form, not through two
 * separate Timeline items. Propagates to the linked `carb_events` row
 * (`source: 'meal_confirmed'`, matched by timestamp — same convention
 * `deleteMealEvent` already uses) so the two copies of "confirmed carbs"
 * can't fork apart, same reasoning as `updateCarbEvent`'s propagation the
 * other direction.
 */
/** Non-transactional core — see `writeMealWithEpisode` for why this exists. */
async function updateMealCarbsAndNoteRows(
  db: SQLiteDatabase,
  id: string,
  updates: {
    confirmedCarbsG?: number | undefined;
    note?: string | undefined;
    /**
     * Macros (Fase 21). Se escriben **siempre**, incluso en `undefined`: el
     * formulario manda el estado completo, así que un campo vaciado tiene que
     * borrarse y no quedarse con el valor viejo. Un macro en blanco significa
     * "no lo anoté", que es distinto de "0 g" — la misma regla que rige en
     * `MealModal`.
     *
     * Lo demás del payload (foto, `aiEstimatedCarbsG`, `aiAnalysisId`) NO se
     * toca: sobrevive por el spread de `...existing`.
     */
    proteinG?: number | undefined;
    fatG?: number | undefined;
    fiberG?: number | undefined;
  },
): Promise<void> {
  const row = await db.getFirstAsync<{ payload: string }>('SELECT payload FROM meal_events WHERE id = ?', id);
  if (row === null) return;
  const existing = MealEventSchema.parse(JSON.parse(row.payload));
  const next = MealEventSchema.parse({
    ...existing,
    confirmedCarbsG: updates.confirmedCarbsG,
    note: updates.note,
    proteinG: updates.proteinG,
    fatG: updates.fatG,
    fiberG: updates.fiberG,
    // Procedencia de los macros. Corregido 2026-08-25 tras la revisión de
    // seguridad — la versión anterior mentía en las dos direcciones:
    //
    //  - `'user' → 'mixed'` decía que la IA los había precargado cuando ella
    //    los había pesado y escrito. Sub-reporta lo que de verdad midió.
    //  - `undefined → 'user'` era la peligrosa: una comida vieja de
    //    procedencia desconocida, con UN macro editado, quedaba etiquetada
    //    como si ella hubiera escrito los tres a mano. El comentario de
    //    `MealEventSchema` lo prohíbe explícitamente: ausente significa
    //    "procedencia desconocida" y **nunca se asume "confirmado por la
    //    usuaria"**.
    //
    // Regla: desconocido se queda desconocido; lo que era de ella sigue
    // siendo de ella; y solo lo que la IA precargó pasa a `'mixed'` al
    // corregirse. Misma lógica campo a campo que `MealEditModal`.
    ...(updates.proteinG === existing.proteinG
      && updates.fatG === existing.fatG
      && updates.fiberG === existing.fiberG
      ? {}
      : existing.macrosSource === undefined
        ? {}
        : { macrosSource: existing.macrosSource === 'user' ? 'user' : 'mixed' }),
  });
  await db.runAsync('UPDATE meal_events SET payload = ? WHERE id = ?', JSON.stringify(next), id);
  await syncConfirmedCarbRow(db, existing, next.confirmedCarbsG);
}

/**
 * Mantiene alineada la fila espejo de `carb_events` con los carbohidratos
 * confirmados de una comida.
 *
 * Los carbos confirmados viven **duplicados**: en el payload de la comida y
 * como su propia fila de `carb_events` con `source: 'meal_confirmed'`
 * (pareada por timestamp, la misma convención que usa `deleteMealEvent`). Si
 * un camino de edición actualiza uno y no el otro, las dos copias se
 * bifurcan y el Timeline muestra un número distinto del que ve el reporte.
 * Cualquier escritura nueva que toque `confirmedCarbsG` tiene que pasar por
 * acá.
 */
async function syncConfirmedCarbRow(
  db: SQLiteDatabase,
  existing: MealEvent,
  confirmedCarbsG: number | undefined,
): Promise<void> {
  const carbRow = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM carb_events WHERE timestamp = ? AND source = 'meal_confirmed'",
    existing.timestamp,
  );
  if (confirmedCarbsG === undefined) {
    if (carbRow !== null) await db.runAsync('DELETE FROM carb_events WHERE id = ?', carbRow.id);
  } else if (carbRow === null) {
    await saveCarbEvent(db, {
      id: Crypto.randomUUID(),
      timestamp: existing.timestamp,
      carbsG: confirmedCarbsG,
      source: 'meal_confirmed',
      createdAt: existing.createdAt,
    });
  } else {
    await db.runAsync('UPDATE carb_events SET carbs_g = ? WHERE id = ?', confirmedCarbsG, carbRow.id);
  }
}

export async function updateMealCarbsAndNote(
  db: SQLiteDatabase,
  id: string,
  updates: { confirmedCarbsG?: number | undefined; note?: string | undefined },
): Promise<void> {
  await db.withTransactionAsync(async () => {
    await updateMealCarbsAndNoteRows(db, id, updates);
  });
}

/**
 * Lo que la edición de una comida (Fase 17) puede cambiar.
 *
 * Un campo ausente **no se toca**; un campo presente en `null` se **borra**.
 * La distinción importa: "no lo anoté" y "0 g" son afirmaciones distintas en
 * toda esta app, y un formulario que deja un macro en blanco está diciendo lo
 * primero, no lo segundo.
 *
 * No hay campo de insulina acá, y no es un olvido: la dosis de una comida se
 * edita desde su propio ítem del Timeline. Una edición de comida —y menos una
 * asistida por IA— no puede alcanzarla.
 */
export interface MealEditPatch {
  confirmedCarbsG?: number | null;
  note?: string | null;
  proteinG?: number | null;
  fatG?: number | null;
  fiberG?: number | null;
  caloriesKcal?: number | null;
  imageUri?: string | null;
  macrosSource?: MealEvent['macrosSource'];
  /**
   * Análisis nuevo, cuando la edición pasó por la IA. `aiEstimatedCarbsG` y
   * `aiAnalysisId` se **reemplazan**, no se borran: son el registro de lo
   * último que la IA dijo sobre esta comida, y después de re-analizarla el
   * registro viejo ya no describe nada.
   */
  analysis?: { aiEstimatedCarbsG: number; aiAnalysisId: string };
}

/** Non-transactional core — see `writeMealWithEpisode` for why this exists. */
async function updateMealFromEditRows(
  db: SQLiteDatabase,
  id: string,
  patch: MealEditPatch,
): Promise<void> {
  const row = await db.getFirstAsync<{ payload: string }>('SELECT payload FROM meal_events WHERE id = ?', id);
  if (row === null) return;
  const existing = MealEventSchema.parse(JSON.parse(row.payload));

  // `undefined` = no se tocó, `null` = borrar. Sin esta distinción explícita
  // un spread convertiría los dos casos en el mismo.
  const apply = <T>(current: T | undefined, incoming: T | null | undefined): T | undefined =>
    incoming === undefined ? current : (incoming ?? undefined);

  const next = MealEventSchema.parse({
    ...existing,
    confirmedCarbsG: apply(existing.confirmedCarbsG, patch.confirmedCarbsG),
    note: apply(existing.note, patch.note),
    proteinG: apply(existing.proteinG, patch.proteinG),
    fatG: apply(existing.fatG, patch.fatG),
    fiberG: apply(existing.fiberG, patch.fiberG),
    caloriesKcal: apply(existing.caloriesKcal, patch.caloriesKcal),
    imageUri: apply(existing.imageUri, patch.imageUri),
    ...(patch.macrosSource === undefined ? {} : { macrosSource: patch.macrosSource }),
    ...(patch.analysis === undefined
      ? {}
      : {
          aiEstimatedCarbsG: patch.analysis.aiEstimatedCarbsG,
          aiAnalysisId: patch.analysis.aiAnalysisId,
        }),
  });
  await db.runAsync('UPDATE meal_events SET payload = ? WHERE id = ?', JSON.stringify(next), id);
  await syncConfirmedCarbRow(db, existing, next.confirmedCarbsG);

  // Si cambió algo que el episodio post-comida ya había congelado en sus
  // métricas, hay que recalcularlo.
  //
  // `processReadyEpisodes` solo mira episodios en estado 'collecting': una vez
  // que un episodio quedó 'complete', sus `metrics` (y el texto de IA que
  // describe esas métricas) son una foto del momento. Antes de la Fase 17 eso
  // era inofensivo, porque de una comida guardada solo se podía editar la
  // nota. Ahora se pueden corregir los carbohidratos confirmados y los
  // macros, así que sin esto el resumen post-comida seguiría diciendo "45 g"
  // después de que ella lo corrigió a 25 — y ese resumen es justamente el que
  // se lleva al médico.
  //
  // Se vuelve a 'collecting' en vez de recalcular acá: el cálculo necesita las
  // lecturas de CGM y la insulina asociada, que es exactamente lo que
  // `processReadyEpisodes` ya sabe juntar. Se limpia también el insight,
  // porque describía las métricas viejas.
  const metricsChanged = existing.confirmedCarbsG !== next.confirmedCarbsG
    || existing.proteinG !== next.proteinG
    || existing.fatG !== next.fatG;
  if (metricsChanged) {
    await db.runAsync(
      `UPDATE meal_episodes
       SET status = 'collecting', metrics_json = NULL, insight_json = NULL, updated_at = ?
       WHERE meal_id = ?`,
      new Date().toISOString(),
      id,
    );
  }
}

/**
 * Edición completa de una comida ya guardada (Fase 17).
 *
 * El camino anterior (`updateMealNote`) solo llegaba a la nota. Acá los
 * macros y los carbohidratos confirmados **sí** se pueden corregir: es exactamente el vacío que la fase
 * viene a llenar (guardaste solo los carbos y después quieres decir que era
 * un sándwich de queso). Lo que no cambia es quién decide: la IA propone y la
 * usuaria confirma antes de que esta función se llame.
 */
export async function updateMealFromEdit(
  db: SQLiteDatabase,
  id: string,
  patch: MealEditPatch,
): Promise<void> {
  await db.withTransactionAsync(async () => {
    await updateMealFromEditRows(db, id, patch);
  });
}

/** Non-transactional core — see `writeMealWithEpisode` for why this exists. */
async function deleteMealEventRows(db: SQLiteDatabase, id: string): Promise<void> {
  const row = await db.getFirstAsync<{ timestamp: string }>('SELECT timestamp FROM meal_events WHERE id = ?', id);
  // ON DELETE CASCADE on meal_episodes.meal_id takes care of the episode.
  await db.runAsync('DELETE FROM meal_events WHERE id = ?', id);
  if (row !== null) {
    // The carb_events row created alongside this meal (writeMealWithEpisode)
    // has no foreign key back to it — matched by timestamp + source
    // instead, since they're always written with the same timestamp.
    // Left behind, it would read as a standalone "Carbohidratos
    // confirmados" entry for a meal that no longer exists.
    await db.runAsync(
      "DELETE FROM carb_events WHERE timestamp = ? AND source = 'meal_confirmed'",
      row.timestamp,
    );
  }
}

export async function deleteMealEvent(db: SQLiteDatabase, id: string): Promise<void> {
  await db.withTransactionAsync(async () => {
    await deleteMealEventRows(db, id);
  });
}

export async function deleteMealEpisode(db: SQLiteDatabase, id: string): Promise<void> {
  // Deletes only the episode's tracking (status/metrics/insight) — the meal
  // event and its confirmed carbs stay. This is "stop following up on this
  // meal", not "undo logging it"; use deleteMealEvent for the latter.
  await db.runAsync('DELETE FROM meal_episodes WHERE id = ?', id);
}

export async function updateManualCGMReading(db: SQLiteDatabase, id: string, glucose: number): Promise<void> {
  const row = await db.getFirstAsync<{ payload: string }>('SELECT payload FROM cgm_readings WHERE id = ?', id);
  if (row === null) return;
  const existing = CGMReadingSchema.parse(JSON.parse(row.payload));
  // A sensor, imported, or synthetic reading is a record of what that
  // source actually reported — correcting it in place would misrepresent
  // history. Only a hand-typed value is the user's own data to fix.
  if (existing.origin !== 'manual') {
    throw new Error('Solo se pueden editar lecturas manuales.');
  }
  const next = CGMReadingSchema.parse({ ...existing, glucose });
  await db.runAsync('UPDATE cgm_readings SET payload = ? WHERE id = ?', JSON.stringify(next), id);
}

export async function deleteCGMReading(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM cgm_readings WHERE id = ?', id);
}

/**
 * The writes behind `saveMealWithEpisode`, without opening a transaction of
 * their own — SQLite has no nested transactions, so a caller that is already
 * inside one (`saveUnifiedEntry`) must use this and let the outer
 * transaction cover it.
 */
async function writeMealWithEpisode(db: SQLiteDatabase, meal: MealEvent, entryGroupId?: string): Promise<string> {
  const parsed = MealEventSchema.parse(meal);
  const episodeId = Crypto.randomUUID();
  await db.runAsync(
    'INSERT INTO meal_events (id, timestamp, payload, created_at, entry_group_id) VALUES (?, ?, ?, ?, ?)',
    parsed.id,
    parsed.timestamp,
    JSON.stringify(parsed),
    parsed.createdAt,
    entryGroupId ?? null,
  );
  await db.runAsync(
    `INSERT INTO meal_episodes
      (id, meal_id, meal_timestamp, status, updated_at)
     VALUES (?, ?, ?, 'collecting', ?)`,
    episodeId,
    parsed.id,
    parsed.timestamp,
    parsed.createdAt,
  );
  if (parsed.confirmedCarbsG !== undefined) {
    // El CarbEvent comparte timestamp con el MealEvent a propósito, y ese
    // timestamp compartido es load-bearing en tres lugares que emparejan
    // ambas filas por él: `updateCarbEvent`, `deleteMealEventRows` y
    // `buildNutritionInsights` (packages/domain), que lo usa para no contar
    // dos veces el mismo plato en el promedio de carbohidratos por franja.
    // Si alguna vez se permite editar la HORA de una comida, hay que mover
    // también su fila de carbohidratos o los tres se rompen juntos.
    await saveCarbEvent(db, {
      id: Crypto.randomUUID(),
      timestamp: parsed.timestamp,
      carbsG: parsed.confirmedCarbsG,
      source: 'meal_confirmed',
      createdAt: parsed.createdAt,
    }, entryGroupId);
  }
  return episodeId;
}

export async function saveMealWithEpisode(db: SQLiteDatabase, meal: MealEvent): Promise<string> {
  let episodeId = '';
  await db.withTransactionAsync(async () => {
    episodeId = await writeMealWithEpisode(db, meal);
  });
  return episodeId;
}

/**
 * Bounds mirrored from the event schemas in `@type1a/schemas`, checked
 * before any row is written so a combined entry can't land half-saved.
 */
const InsulinUnitsSchema = InsulinEventSchema.shape.units;
const CarbGramsSchema = CarbEventSchema.shape.carbsG;
/** Gramos de un macro, con el mismo límite que `MealEventSchema`. */
const MacroGramsSchema = MealEventSchema.shape.proteinG.unwrap();
const GlucoseValueSchema = CGMReadingSchema.shape.glucose;

export interface UnifiedEntryInput {
  manualGlucose?: number;
  description?: string;
  carbsG?: number;
  imageUri?: string;
  aiEstimatedCarbsG?: number;
  proteinG?: number;
  fatG?: number;
  fiberG?: number;
  caloriesKcal?: number;
  aiAnalysisId?: string;
  rapidUnits?: number;
  basalUnits?: number;
  note?: string;
  /**
   * When the entry happened, as shown to the user while filling the sheet.
   * Passed in rather than taken at write time so a sheet left open for
   * twenty minutes doesn't stamp everything — including the meal episode's
   * +60/+120/+180 window — twenty minutes after the header said.
   */
  timestamp: string;
  /** True when the rapid dose covers a correction as well as carbs. */
  rapidIncludesCorrection?: boolean;
  /**
   * Cetonas en sangre, mmol/L (2026-08-25).
   *
   * "Nueva entrada" tiene que poder guardar todo lo que guardan los accesos
   * rápidos — pedido explícito de Verónica. Se escribe como `VitalsEvent`,
   * que es donde ya viven, no como un campo nuevo: el acceso rápido de
   * cetonas y este campo terminan en la misma tabla y se leen igual.
   */
  ketonesMmolL?: number;
  /**
   * Procedencia de los macros: `'ai'`, `'user'` o `'mixed'`.
   *
   * **Se imprime en el reporte del control médico**, así que perderlo no es
   * cosmético: un macro estimado por IA que llega sin procedencia se lee como
   * "no registrada" en vez de "estimada por IA sin corregir".
   *
   * Faltaba en esta interfaz mientras `App.tsx` sí lo esparcía en la llamada,
   * así que se descartaba en silencio en cada creación desde "Nueva entrada".
   * TypeScript no lo atrapó: el chequeo de propiedades en exceso **no aplica a
   * un spread**, y por eso `pnpm verify` seguía en verde.
   */
  macrosSource?: MealEvent['macrosSource'];
}

/**
 * Chequeo de que `MEAL_FIELDS` sigue siendo un subconjunto de lo que una
 * entrada puede traer. Si alguien renombra un campo en `UnifiedEntryInput`, el
 * typecheck falla acá en vez de que el predicado empiece a devolver `false` en
 * silencio — y un `false` de más borra la comida.
 */
const _mealFieldsAreEntryFields: readonly (keyof UnifiedEntryInput)[] = MEAL_FIELDS;
void _mealFieldsAreEntryFields;

export interface UnifiedEntryOutcome {
  /** Set when the entry created a meal episode worth scheduling follow-ups for. */
  episodeId: string | null;
  savedGlucose: boolean;
  savedRapid: boolean;
  savedBasal: boolean;
  savedNote: boolean;
}

/**
 * Writes one MySugr-style combined entry: a hand-measured glucose, a meal
 * (with its confirmed carbs and any AI estimate kept separate), rapid and/or
 * long-acting insulin, and a free-text note — all sharing a single timestamp
 * so they read as one moment in the timeline instead of four unrelated rows.
 *
 * Each piece is optional; whatever the user left blank simply isn't written.
 * The insulin units stored are exactly what the user typed — never a
 * calculated suggestion, which the UI only ever offers as a value to copy.
 */
export async function saveUnifiedEntry(
  db: SQLiteDatabase,
  input: UnifiedEntryInput,
): Promise<UnifiedEntryOutcome> {
  const timestamp = input.timestamp;
  const outcome: UnifiedEntryOutcome = {
    episodeId: null,
    savedGlucose: false,
    savedRapid: false,
    savedBasal: false,
    savedNote: false,
  };

  // Validate every piece up front. Each write below is an independent
  // INSERT, so a schema rejection partway through would otherwise leave a
  // half-written entry the user can only "fix" by re-saving — duplicating
  // everything that already landed, since each retry mints new ids.
  if (input.rapidUnits !== undefined) InsulinUnitsSchema.parse(input.rapidUnits);
  if (input.basalUnits !== undefined) InsulinUnitsSchema.parse(input.basalUnits);
  if (input.carbsG !== undefined) CarbGramsSchema.parse(input.carbsG);
  if (input.manualGlucose !== undefined) GlucoseValueSchema.parse(input.manualGlucose);

  const hasMeal = hasMealContent(input);

  // Every row this save produces shares one id, so the pieces can be shown
  // and edited later as the single packaged thing they were entered as —
  // see getTimeline()'s grouping and updateUnifiedEntryGroup/
  // deleteUnifiedEntryGroup. A glucose-only save still gets a group id even
  // though there's nothing to group it WITH yet; if the entry is later
  // edited to add carbs or a dose, they join this same id instead of the
  // edit silently starting a second, disconnected group.
  const entryGroupId = Crypto.randomUUID();

  await db.withTransactionAsync(async () => {
    if (input.manualGlucose !== undefined) {
      // A value the user measured and typed. `origin: 'manual'` keeps it
      // distinguishable from sensor data everywhere it is displayed, and
      // sourceTimestamp/ingestedAt are both the entry time because the
      // measurement and its entry genuinely happened together.
      await writeCGMReading(db, {
        id: Crypto.randomUUID(),
        glucose: input.manualGlucose,
        unit: 'mg/dL',
        timestamp,
        trend: 'unknown',
        trendSource: 'unknown',
        source: 'entrada manual',
        origin: 'manual',
        sourceTimestamp: timestamp,
        ingestedAt: timestamp,
      }, entryGroupId);
      outcome.savedGlucose = true;
    }

    if (hasMeal) {
      outcome.episodeId = await writeMealWithEpisode(db, {
        id: Crypto.randomUUID(),
        timestamp,
        createdAt: timestamp,
        ...(input.carbsG === undefined ? {} : { confirmedCarbsG: input.carbsG }),
        ...(input.description === undefined ? {} : { note: input.description }),
        ...(input.imageUri === undefined ? {} : { imageUri: input.imageUri }),
        ...(input.aiEstimatedCarbsG === undefined ? {} : { aiEstimatedCarbsG: input.aiEstimatedCarbsG }),
        ...(input.proteinG === undefined ? {} : { proteinG: input.proteinG }),
        ...(input.fatG === undefined ? {} : { fatG: input.fatG }),
        ...(input.fiberG === undefined ? {} : { fiberG: input.fiberG }),
        ...(input.caloriesKcal === undefined ? {} : { caloriesKcal: input.caloriesKcal }),
        ...(input.aiAnalysisId === undefined ? {} : { aiAnalysisId: input.aiAnalysisId }),
        ...(input.macrosSource === undefined ? {} : { macrosSource: input.macrosSource }),
      }, entryGroupId);
    }

    if (input.rapidUnits !== undefined) {
      // Descriptive bookkeeping only — `purpose` never feeds a calculation.
      // It reflects what the dose actually covered, which is why it keys off
      // whether a correction was included rather than off where the glucose
      // value came from.
      const includesCorrection = input.rapidIncludesCorrection === true;
      await saveInsulinEvent(db, {
        id: Crypto.randomUUID(),
        timestamp,
        type: 'rapid',
        units: input.rapidUnits,
        source: 'manual',
        createdAt: timestamp,
        purpose: hasMeal ? (includesCorrection ? 'combined' : 'meal') : 'correction',
      }, entryGroupId);
      outcome.savedRapid = true;
    }

    if (input.basalUnits !== undefined) {
      await saveInsulinEvent(db, {
        id: Crypto.randomUUID(),
        timestamp,
        type: 'basal',
        units: input.basalUnits,
        source: 'manual',
        createdAt: timestamp,
      }, entryGroupId);
      outcome.savedBasal = true;
    }

    if (input.ketonesMmolL !== undefined) {
      await saveVitalsEvent(db, {
        id: Crypto.randomUUID(),
        timestamp,
        ketonesMmolL: input.ketonesMmolL,
        source: 'manual',
        createdAt: timestamp,
      }, entryGroupId);
    }

    if (input.note !== undefined) {
      await saveNoteEvent(db, {
        id: Crypto.randomUUID(),
        timestamp,
        text: input.note,
        source: 'manual',
        createdAt: timestamp,
      }, entryGroupId);
      outcome.savedNote = true;
    }
  });

  return outcome;
}

/**
 * Edits a packaged "Nueva entrada" group as one operation: whichever pieces
 * `input` supplies get updated in place (preserving their row/episode
 * identity — so editing a note doesn't reset an already-`complete` episode
 * back to `collecting`), whichever it omits get deleted, and whichever are
 * newly present (a field that was empty when the entry was first saved) get
 * created and tagged with this same `entryGroupId`. Mirrors
 * `saveUnifiedEntry`'s validation and `purpose` bookkeeping exactly, since
 * this is the same data shape mid-edit rather than freshly created.
 */
export async function updateUnifiedEntryGroup(
  db: SQLiteDatabase,
  entryGroupId: string,
  input: UnifiedEntryInput,
): Promise<UnifiedEntryOutcome> {
  const timestamp = input.timestamp;
  if (input.rapidUnits !== undefined) InsulinUnitsSchema.parse(input.rapidUnits);
  if (input.basalUnits !== undefined) InsulinUnitsSchema.parse(input.basalUnits);
  if (input.carbsG !== undefined) CarbGramsSchema.parse(input.carbsG);
  if (input.manualGlucose !== undefined) GlucoseValueSchema.parse(input.manualGlucose);
  // Los macros también se validan acá, como todo lo demás: `AGENTS.md` manda
  // validar toda entrada externa con Zod, y este era el único campo numérico
  // del grupo que llegaba a la base sin pasar por un esquema.
  for (const macro of [input.proteinG, input.fatG, input.fiberG]) {
    if (macro !== undefined) MacroGramsSchema.parse(macro);
  }

  // ⚠️ Cuando esto es falso, más abajo se **borra la fila de la comida
  // entera**, así que la lista de qué cuenta como comida es la misma que usa
  // el camino de creación — ver `MEAL_FIELDS`. Tenerla duplicada acá fue el
  // bug: vaciar los carbohidratos de una entrada keto se llevaba proteína,
  // grasa, nota y análisis de IA en silencio, y el formulario decía que había
  // guardado bien.
  const hasMeal = hasMealContent(input);
  const outcome: UnifiedEntryOutcome = {
    episodeId: null,
    savedGlucose: false,
    savedRapid: false,
    savedBasal: false,
    savedNote: false,
  };

  await db.withTransactionAsync(async () => {
    const existingGlucose = await db.getFirstAsync<{ id: string; payload: string }>(
      'SELECT id, payload FROM cgm_readings WHERE entry_group_id = ?',
      entryGroupId,
    );
    // A non-'manual' anchor is a real sensor/imported/synthetic reading this
    // entry was attached to after the fact (attachEntryToReading). It is a
    // record of what that source reported, never something this edit may
    // rewrite or delete — the edit form keeps it read-only, so
    // `input.manualGlucose` is undefined for these, and the delete-when-
    // omitted branch below must NOT fire against it.
    const anchorOrigin = existingGlucose === null
      ? null
      : CGMReadingSchema.parse(JSON.parse(existingGlucose.payload)).origin;
    const hasSensorAnchor = anchorOrigin !== null && anchorOrigin !== 'manual';
    if (hasSensorAnchor) {
      outcome.savedGlucose = true; // present and preserved, just untouched
    } else if (input.manualGlucose !== undefined) {
      if (existingGlucose === null) {
        await writeCGMReading(db, {
          id: Crypto.randomUUID(),
          glucose: input.manualGlucose,
          unit: 'mg/dL',
          timestamp,
          trend: 'unknown',
          trendSource: 'unknown',
          source: 'entrada manual',
          origin: 'manual',
          sourceTimestamp: timestamp,
          ingestedAt: timestamp,
        }, entryGroupId);
      } else {
        await updateManualCGMReading(db, existingGlucose.id, input.manualGlucose);
      }
      outcome.savedGlucose = true;
    } else if (existingGlucose !== null) {
      await deleteCGMReading(db, existingGlucose.id);
    }

    const existingMeal = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM meal_events WHERE entry_group_id = ?',
      entryGroupId,
    );
    if (hasMeal) {
      if (existingMeal === null) {
        outcome.episodeId = await writeMealWithEpisode(db, {
          id: Crypto.randomUUID(),
          timestamp,
          createdAt: timestamp,
          ...(input.carbsG === undefined ? {} : { confirmedCarbsG: input.carbsG }),
          ...(input.description === undefined ? {} : { note: input.description }),
          // Fase 21: los macros también al crear la comida desde una edición.
          // Sin esto, agregar carbohidratos y macros a una glucosa ya
          // guardada perdía los macros en silencio.
          ...(input.proteinG === undefined ? {} : { proteinG: input.proteinG }),
          ...(input.fatG === undefined ? {} : { fatG: input.fatG }),
          ...(input.fiberG === undefined ? {} : { fiberG: input.fiberG }),
          ...(input.proteinG === undefined && input.fatG === undefined && input.fiberG === undefined
            ? {}
            : { macrosSource: 'user' as const }),
        }, entryGroupId);
      } else {
        await updateMealCarbsAndNoteRows(db, existingMeal.id, {
          confirmedCarbsG: input.carbsG,
          note: input.description,
          proteinG: input.proteinG,
          fatG: input.fatG,
          fiberG: input.fiberG,
        });
      }
    } else if (existingMeal !== null) {
      await deleteMealEventRows(db, existingMeal.id);
    }

    // Cetonas del grupo (2026-08-25). Mismo contrato que el resto: el
    // formulario manda el estado completo, así que vaciarlo borra la fila en
    // vez de dejar el valor viejo.
    const existingVitals = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM vitals_events WHERE entry_group_id = ?',
      entryGroupId,
    );
    if (input.ketonesMmolL !== undefined) {
      if (existingVitals === null) {
        await saveVitalsEvent(db, {
          id: Crypto.randomUUID(),
          timestamp,
          ketonesMmolL: input.ketonesMmolL,
          source: 'manual',
          createdAt: timestamp,
        }, entryGroupId);
      } else {
        // Merge sobre el payload existente, no reemplazo. Hoy ningún camino
        // adjunta peso ni presión a un `entry_group_id`, así que es
        // inalcanzable — pero el día que exista, reescribir el objeto entero
        // borraría el peso en silencio al editar las cetonas.
        const row = await db.getFirstAsync<{ payload: string }>(
          'SELECT payload FROM vitals_events WHERE id = ?',
          existingVitals.id,
        );
        const previous = row === null ? {} : (safeJsonParse(row.payload) ?? {});
        await db.runAsync(
          'UPDATE vitals_events SET payload = ?, timestamp = ? WHERE id = ?',
          JSON.stringify(VitalsEventSchema.parse({
            ...(typeof previous === 'object' ? previous : {}),
            id: existingVitals.id,
            timestamp,
            ketonesMmolL: input.ketonesMmolL,
            source: 'manual',
            createdAt: timestamp,
          })),
          timestamp,
          existingVitals.id,
        );
      }
    } else if (existingVitals !== null) {
      await db.runAsync('DELETE FROM vitals_events WHERE id = ?', existingVitals.id);
    }

    const existingRapid = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM insulin_events WHERE entry_group_id = ? AND type = 'rapid'",
      entryGroupId,
    );
    if (input.rapidUnits !== undefined) {
      const includesCorrection = input.rapidIncludesCorrection === true;
      if (existingRapid === null) {
        await saveInsulinEvent(db, {
          id: Crypto.randomUUID(),
          timestamp,
          type: 'rapid',
          units: input.rapidUnits,
          source: 'manual',
          createdAt: timestamp,
          purpose: hasMeal ? (includesCorrection ? 'combined' : 'meal') : 'correction',
        }, entryGroupId);
      } else {
        await updateInsulinEvent(db, existingRapid.id, { type: 'rapid', units: input.rapidUnits });
      }
      outcome.savedRapid = true;
    } else if (existingRapid !== null) {
      await deleteInsulinEvent(db, existingRapid.id);
    }

    const existingBasal = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM insulin_events WHERE entry_group_id = ? AND type = 'basal'",
      entryGroupId,
    );
    if (input.basalUnits !== undefined) {
      if (existingBasal === null) {
        await saveInsulinEvent(db, {
          id: Crypto.randomUUID(),
          timestamp,
          type: 'basal',
          units: input.basalUnits,
          source: 'manual',
          createdAt: timestamp,
        }, entryGroupId);
      } else {
        await updateInsulinEvent(db, existingBasal.id, { type: 'basal', units: input.basalUnits });
      }
      outcome.savedBasal = true;
    } else if (existingBasal !== null) {
      await deleteInsulinEvent(db, existingBasal.id);
    }

    const existingNote = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM note_events WHERE entry_group_id = ?',
      entryGroupId,
    );
    if (input.note !== undefined) {
      if (existingNote === null) {
        await saveNoteEvent(db, {
          id: Crypto.randomUUID(),
          timestamp,
          text: input.note,
          source: 'manual',
          createdAt: timestamp,
        }, entryGroupId);
      } else {
        await updateNoteEvent(db, existingNote.id, input.note);
      }
      outcome.savedNote = true;
    } else if (existingNote !== null) {
      await deleteNoteEvent(db, existingNote.id);
    }

    // If a sensor-anchored entry has had every attachment removed, it's no
    // longer an "entry" — just the plain sensor reading again. Detach it
    // (clear the group id) rather than leave a one-item group that would
    // render as "Entrada registrada" wrapping a lone glucose value. The
    // reading itself is never deleted here.
    if (hasSensorAnchor && existingGlucose !== null
      && !hasMeal && input.rapidUnits === undefined && input.basalUnits === undefined && input.note === undefined) {
      await db.runAsync('UPDATE cgm_readings SET entry_group_id = NULL WHERE id = ?', existingGlucose.id);
    }
  });

  return outcome;
}

/**
 * Turns a standalone glucose reading into a packaged entry by attaching a
 * meal/carbs, insulin, and/or a note to it — Verónica logging what she ate
 * against an auto-saved sensor reading from the time she measured ("la hora
 * en que comí y me pinché"). The reading keeps its own value, origin, and
 * timestamp untouched; the attachments are written with the reading's
 * `sourceTimestamp` so they read as one moment, and tagged with a new group
 * id so the whole thing is edited together from then on.
 *
 * For a hand-typed 'manual' reading, `input.manualGlucose` may also correct
 * the value; for any other origin it's ignored (the value is a record of what
 * the sensor reported, never rewritten — same rule as updateManualCGMReading).
 */
export async function attachEntryToReading(
  db: SQLiteDatabase,
  readingId: string,
  input: Omit<UnifiedEntryInput, 'timestamp'>,
): Promise<UnifiedEntryOutcome> {
  const row = await db.getFirstAsync<{ payload: string; entry_group_id: string | null }>(
    'SELECT payload, entry_group_id FROM cgm_readings WHERE id = ?',
    readingId,
  );
  if (row === null) throw new Error('La lectura ya no existe.');
  if (row.entry_group_id !== null) {
    // Already part of a group — the caller should be editing it via
    // updateUnifiedEntryGroup, not re-attaching. Guarded so a double-tap
    // can't mint a second group id over the same reading.
    throw new Error('Esta lectura ya es parte de una entrada.');
  }
  const reading = CGMReadingSchema.parse(JSON.parse(row.payload));
  // Validate the attachments up front, before tagging the reading — the only
  // pre-write throw inside the delegated updateUnifiedEntryGroup is this same
  // validation, so doing it here first means a bad input can't leave the
  // reading tagged into a one-item group with nothing attached.
  if (input.rapidUnits !== undefined) InsulinUnitsSchema.parse(input.rapidUnits);
  if (input.basalUnits !== undefined) InsulinUnitsSchema.parse(input.basalUnits);
  if (input.carbsG !== undefined) CarbGramsSchema.parse(input.carbsG);
  if (input.manualGlucose !== undefined) GlucoseValueSchema.parse(input.manualGlucose);
  const entryGroupId = Crypto.randomUUID();
  await db.runAsync('UPDATE cgm_readings SET entry_group_id = ? WHERE id = ?', entryGroupId, readingId);
  // Delegate the attachment writes to the same in-place editor used for every
  // later edit, so there's one code path (and one set of safety rules) for a
  // group's contents. It preserves the now-anchored reading because its origin
  // isn't 'manual' — or, for a manual reading, applies `manualGlucose` if given.
  // The glucose value is only ever forwarded for a 'manual' reading; for any
  // other origin it's dropped entirely, never passed as undefined.
  const { manualGlucose, ...rest } = input;
  const glucoseOverride = reading.origin === 'manual' && manualGlucose !== undefined ? { manualGlucose } : {};
  return updateUnifiedEntryGroup(db, entryGroupId, {
    ...rest,
    ...glucoseOverride,
    timestamp: reading.sourceTimestamp,
  });
}

/**
 * Deletes a packaged entry. A hand-typed 'manual' anchor is part of the
 * entry and gets deleted with it; a sensor/imported/synthetic anchor is real
 * source data, so it is preserved and simply detached (its group id cleared)
 * while the attachments are removed — deleting the "entry" must never destroy
 * a real sensor reading.
 */
export async function deleteUnifiedEntryGroup(db: SQLiteDatabase, entryGroupId: string): Promise<void> {
  await db.withTransactionAsync(async () => {
    const meal = await db.getFirstAsync<{ id: string }>('SELECT id FROM meal_events WHERE entry_group_id = ?', entryGroupId);
    if (meal !== null) await deleteMealEventRows(db, meal.id); // cascades the episode, cleans up the linked carb_events row
    const glucose = await db.getFirstAsync<{ id: string; payload: string }>(
      'SELECT id, payload FROM cgm_readings WHERE entry_group_id = ?',
      entryGroupId,
    );
    if (glucose !== null) {
      const origin = CGMReadingSchema.parse(JSON.parse(glucose.payload)).origin;
      if (origin === 'manual') {
        await db.runAsync('DELETE FROM cgm_readings WHERE id = ?', glucose.id);
      } else {
        await db.runAsync('UPDATE cgm_readings SET entry_group_id = NULL WHERE id = ?', glucose.id);
      }
    }
    await db.runAsync('DELETE FROM insulin_events WHERE entry_group_id = ?', entryGroupId);
    await db.runAsync('DELETE FROM note_events WHERE entry_group_id = ?', entryGroupId);
    await db.runAsync('DELETE FROM vitals_events WHERE entry_group_id = ?', entryGroupId);
  });
}

/** Non-transactional core — see `writeMealWithEpisode` for why this exists. */
async function writeCGMReading(db: SQLiteDatabase, reading: CGMReading, entryGroupId?: string): Promise<void> {
  const parsed = CGMReadingSchema.parse(reading);
  await db.runAsync(
    `INSERT OR REPLACE INTO cgm_readings
      (id, source_timestamp, payload, ingested_at, entry_group_id) VALUES (?, ?, ?, ?, ?)`,
    parsed.id,
    parsed.sourceTimestamp,
    JSON.stringify(parsed),
    parsed.ingestedAt,
    entryGroupId ?? null,
  );
}

export async function upsertCGMReadings(db: SQLiteDatabase, readings: readonly CGMReading[]): Promise<void> {
  if (readings.length === 0) return;
  await db.withTransactionAsync(async () => {
    for (const reading of readings) {
      await writeCGMReading(db, reading);
    }
  });
}

export async function getCGMReadings(
  db: SQLiteDatabase,
  from: Date,
  to: Date,
  tally?: DecodeTally,
): Promise<CGMReading[]> {
  const rows = await db.getAllAsync<{ payload: string }>(
    `SELECT payload FROM cgm_readings
     WHERE source_timestamp BETWEEN ? AND ? ORDER BY source_timestamp ASC`,
    from.toISOString(),
    to.toISOString(),
  );
  return rows.flatMap((row) => decodeRow(row.payload, CGMReadingSchema, tally));
}

/**
 * Fase 9 (reportes): range getters for the three event tables that only had
 * "recent"/"around this meal" queries before (`getRecentRapidInsulin`,
 * `getInsulinEventsForMeal`) — a report needs every insulin dose, carb entry,
 * and meal in an arbitrary date range, same as `getCGMReadings` already does
 * for glucose. Same safe-parse-and-drop pattern as every other `get*` here.
 */
export async function getInsulinEvents(db: SQLiteDatabase, from: Date, to: Date, tally?: DecodeTally): Promise<InsulinEvent[]> {
  const rows = await db.getAllAsync<{ payload: string }>(
    'SELECT payload FROM insulin_events WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC',
    from.toISOString(),
    to.toISOString(),
  );
  return rows.flatMap((row) => decodeRow(row.payload, InsulinEventSchema, tally));
}

export async function getCarbEvents(db: SQLiteDatabase, from: Date, to: Date, tally?: DecodeTally): Promise<CarbEvent[]> {
  const rows = await db.getAllAsync<{ id: string; timestamp: string; carbs_g: number; source: CarbEvent['source']; created_at: string }>(
    'SELECT id, timestamp, carbs_g, source, created_at FROM carb_events WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC',
    from.toISOString(),
    to.toISOString(),
  );
  return rows.flatMap((row) => {
    const parsed = CarbEventSchema.safeParse({
      id: row.id,
      timestamp: row.timestamp,
      carbsG: row.carbs_g,
      source: row.source,
      createdAt: row.created_at,
    });
    return tallyParsed(parsed, tally);
  });
}

export async function getMealEvents(db: SQLiteDatabase, from: Date, to: Date, tally?: DecodeTally): Promise<MealEvent[]> {
  const rows = await db.getAllAsync<{ payload: string }>(
    'SELECT payload FROM meal_events WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC',
    from.toISOString(),
    to.toISOString(),
  );
  return rows.flatMap((row) => decodeRow(row.payload, MealEventSchema, tally));
}

export async function saveActivityEvent(db: SQLiteDatabase, event: ActivityEvent): Promise<void> {
  const parsed = ActivityEventSchema.parse(event);
  await db.runAsync(
    'INSERT OR IGNORE INTO activity_events (id, timestamp, payload, created_at) VALUES (?, ?, ?, ?)',
    parsed.id,
    parsed.timestamp,
    JSON.stringify(parsed),
    parsed.createdAt,
  );
}

export async function getActivityEvents(db: SQLiteDatabase, from: Date, to: Date): Promise<ActivityEvent[]> {
  const rows = await db.getAllAsync<{ payload: string }>(
    'SELECT payload FROM activity_events WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC',
    from.toISOString(),
    to.toISOString(),
  );
  return rows.flatMap((row) => decodeRow(row.payload, ActivityEventSchema));
}

export async function saveNoteEvent(db: SQLiteDatabase, note: NoteEvent, entryGroupId?: string): Promise<void> {
  const parsed = NoteEventSchema.parse(note);
  await db.runAsync(
    'INSERT OR IGNORE INTO note_events (id, timestamp, payload, created_at, entry_group_id) VALUES (?, ?, ?, ?, ?)',
    parsed.id,
    parsed.timestamp,
    JSON.stringify(parsed),
    parsed.createdAt,
    entryGroupId ?? null,
  );
}

export async function updateNoteEvent(db: SQLiteDatabase, id: string, text: string): Promise<void> {
  const row = await db.getFirstAsync<{ payload: string }>('SELECT payload FROM note_events WHERE id = ?', id);
  if (row === null) return;
  const existing = NoteEventSchema.parse(JSON.parse(row.payload));
  const next = NoteEventSchema.parse({ ...existing, text });
  await db.runAsync('UPDATE note_events SET payload = ? WHERE id = ?', JSON.stringify(next), id);
}

export async function deleteNoteEvent(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM note_events WHERE id = ?', id);
}

export async function getNoteEvents(db: SQLiteDatabase, from: Date, to: Date): Promise<NoteEvent[]> {
  const rows = await db.getAllAsync<{ payload: string }>(
    'SELECT payload FROM note_events WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC',
    from.toISOString(),
    to.toISOString(),
  );
  return rows.flatMap((row) => decodeRow(row.payload, NoteEventSchema));
}

export async function saveVitalsEvent(
  db: SQLiteDatabase,
  vitals: VitalsEvent,
  entryGroupId?: string,
): Promise<void> {
  const parsed = VitalsEventSchema.parse(vitals);
  await db.runAsync(
    'INSERT OR IGNORE INTO vitals_events (id, timestamp, payload, created_at, entry_group_id) VALUES (?, ?, ?, ?, ?)',
    parsed.id,
    parsed.timestamp,
    JSON.stringify(parsed),
    parsed.createdAt,
    entryGroupId ?? null,
  );
}

export async function getVitalsEvents(db: SQLiteDatabase, from: Date, to: Date): Promise<VitalsEvent[]> {
  const rows = await db.getAllAsync<{ payload: string }>(
    'SELECT payload FROM vitals_events WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC',
    from.toISOString(),
    to.toISOString(),
  );
  return rows.flatMap((row) => decodeRow(row.payload, VitalsEventSchema));
}

export async function saveHbA1cResult(db: SQLiteDatabase, result: HbA1cLabResult): Promise<void> {
  const parsed = HbA1cLabResultSchema.parse(result);
  await db.runAsync(
    'INSERT OR IGNORE INTO hba1c_results (id, timestamp, payload, created_at) VALUES (?, ?, ?, ?)',
    parsed.id,
    parsed.timestamp,
    JSON.stringify(parsed),
    parsed.createdAt,
  );
}

export async function getHbA1cResults(db: SQLiteDatabase, from: Date, to: Date): Promise<HbA1cLabResult[]> {
  const rows = await db.getAllAsync<{ payload: string }>(
    'SELECT payload FROM hba1c_results WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC',
    from.toISOString(),
    to.toISOString(),
  );
  return rows.flatMap((row) => decodeRow(row.payload, HbA1cLabResultSchema));
}

/**
 * Writes a meal event only — no `meal_episodes` row. Used by the MySugr
 * importer: episodes are a *live* workflow concept (wait for post-meal CGM
 * + insulin data, then compute metrics and optionally fetch an AI
 * insight), and every imported meal is already hours-to-months old, so
 * running them all through that pipeline on the next refresh would burst
 * dozens of AI calls at once for no benefit. Bulk historical data is for
 * the timeline/chart/summary, not the live episode tracker.
 */
export async function saveImportedMealEvent(db: SQLiteDatabase, meal: MealEvent): Promise<void> {
  const parsed = MealEventSchema.parse(meal);
  await db.runAsync(
    'INSERT OR IGNORE INTO meal_events (id, timestamp, payload, created_at) VALUES (?, ?, ?, ?)',
    parsed.id,
    parsed.timestamp,
    JSON.stringify(parsed),
    parsed.createdAt,
  );
}

export interface MySugrImportOutcome {
  rowsTotal: number;
  rowsSkipped: number;
  cgmReadings: number;
  insulinEvents: number;
  carbEvents: number;
  mealEvents: number;
  activityEvents: number;
  noteEvents: number;
  vitalsEvents: number;
  hba1cResults: number;
}

/**
 * Imports a MySugr CSV export into local history. Idempotent by design:
 * every event gets a deterministic ID derived from its timestamp and kind
 * (see packages/domain/src/mysugr-import.ts), and every write here uses
 * `INSERT OR IGNORE` (or, for CGM readings, the already-idempotent
 * `upsertCGMReadings`), so importing the same file twice is a safe no-op
 * rather than a duplicate-key error or duplicated data.
 */
export async function importMySugrCsv(db: SQLiteDatabase, csvText: string): Promise<MySugrImportOutcome> {
  const plan = planMySugrImport(csvText, new Date().toISOString());
  const outcome: MySugrImportOutcome = {
    rowsTotal: plan.rowsTotal,
    rowsSkipped: plan.rowsSkipped,
    cgmReadings: 0,
    insulinEvents: 0,
    carbEvents: 0,
    mealEvents: 0,
    activityEvents: 0,
    noteEvents: 0,
    vitalsEvents: 0,
    hba1cResults: 0,
  };

  const cgmReadings = plan.events.flatMap((event) => (event.cgmReading ? [event.cgmReading] : []));
  if (cgmReadings.length > 0) {
    await upsertCGMReadings(db, cgmReadings);
    outcome.cgmReadings = cgmReadings.length;
  }

  await db.withTransactionAsync(async () => {
    for (const event of plan.events) {
      for (const insulinEvent of event.insulinEvents) {
        await saveInsulinEvent(db, insulinEvent);
        outcome.insulinEvents += 1;
      }
      if (event.carbEvent !== undefined) {
        await saveCarbEvent(db, event.carbEvent);
        outcome.carbEvents += 1;
      }
      if (event.mealEvent !== undefined) {
        await saveImportedMealEvent(db, event.mealEvent);
        outcome.mealEvents += 1;
      }
      if (event.activityEvent !== undefined) {
        await saveActivityEvent(db, event.activityEvent);
        outcome.activityEvents += 1;
      }
      if (event.noteEvent !== undefined) {
        await saveNoteEvent(db, event.noteEvent);
        outcome.noteEvents += 1;
      }
      if (event.vitalsEvent !== undefined) {
        await saveVitalsEvent(db, event.vitalsEvent);
        outcome.vitalsEvents += 1;
      }
      if (event.hba1cResult !== undefined) {
        await saveHbA1cResult(db, event.hba1cResult);
        outcome.hba1cResults += 1;
      }
    }
  });

  return outcome;
}

export async function getRecentRapidInsulin(
  db: SQLiteDatabase,
  before = new Date(),
  lookbackHours = 6,
  tally?: DecodeTally,
): Promise<InsulinEvent[]> {
  const from = new Date(before.getTime() - lookbackHours * 60 * 60_000).toISOString();
  const rows = await db.getAllAsync<{ payload: string }>(
    `SELECT payload FROM insulin_events
     WHERE type = 'rapid' AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC`,
    from,
    before.toISOString(),
  );
  return rows.flatMap((row) => decodeRow(row.payload, InsulinEventSchema, tally));
}

export async function getInsulinEventsForMeal(
  db: SQLiteDatabase,
  mealTimestamp: string,
): Promise<InsulinEvent[]> {
  const mealMs = Date.parse(mealTimestamp);
  const from = new Date(mealMs - 90 * 60_000).toISOString();
  const to = new Date(mealMs + 60 * 60_000).toISOString();
  const rows = await db.getAllAsync<{ payload: string }>(
    `SELECT payload FROM insulin_events
     WHERE type = 'rapid' AND timestamp BETWEEN ? AND ? ORDER BY timestamp ASC`,
    from,
    to,
  );
  return rows.flatMap((row) => decodeRow(row.payload, InsulinEventSchema));
}

/**
 * Todo lo demás que se registró durante la ventana de un episodio (Fase 23).
 *
 * `getInsulinEventsForMeal` de arriba responde otra pregunta —"¿qué bolo era
 * de esta comida?"— y por eso mira solo rápidas en -90/+60 min. Esta mira
 * **hacia adelante** sobre todo el seguimiento, y trae toda clase de evento:
 * lo que le faltaba al episodio era saber que a los 90 minutos hubo una
 * corrección, o a las 2 h una colación.
 *
 * Devuelve las filas crudas; `collectEpisodeContext` (packages/domain) decide
 * cuáles caen dentro de la gracia y cuáles son contexto real.
 */
export async function getEventsDuringEpisode(
  db: SQLiteDatabase,
  mealTimestamp: string,
  windowMinutes: number,
): Promise<{
  insulin: InsulinEvent[];
  carbs: CarbEvent[];
  meals: MealEvent[];
  activity: ActivityEvent[];
  notes: NoteEvent[];
}> {
  const mealMs = Date.parse(mealTimestamp);
  if (!Number.isFinite(mealMs)) {
    return { insulin: [], carbs: [], meals: [], activity: [], notes: [] };
  }
  const from = new Date(mealMs);
  const to = new Date(mealMs + windowMinutes * 60_000);
  const [insulinRows, carbRows, mealRows, activityRows, noteRows] = await Promise.all([
    getInsulinEvents(db, from, to),
    getCarbEvents(db, from, to),
    getMealEvents(db, from, to),
    getActivityEvents(db, from, to),
    getNoteEvents(db, from, to),
  ]);
  return {
    insulin: insulinRows,
    carbs: carbRows,
    meals: mealRows,
    activity: activityRows,
    notes: noteRows,
  };
}

export async function getCollectingEpisodes(db: SQLiteDatabase): Promise<Array<{ episode: StoredMealEpisode; meal: MealEvent }>> {
  const rows = await db.getAllAsync<{
    id: string;
    meal_id: string;
    meal_timestamp: string;
    status: StoredMealEpisode['status'];
    rapid_insulin_event_id: string | null;
    insulin_context_confirmed: number;
    metrics_json: string | null;
    insight_json: string | null;
    meal_payload: string;
  }>(
    `SELECT e.*, m.payload AS meal_payload
     FROM meal_episodes e JOIN meal_events m ON m.id = e.meal_id
     WHERE e.status = 'collecting' ORDER BY e.meal_timestamp ASC`,
  );
  return rows.flatMap((row) => {
    const meal = MealEventSchema.safeParse(safeJsonParse(row.meal_payload));
    if (!meal.success) return [];
    return [{
      meal: meal.data,
      episode: {
        id: row.id,
        mealId: row.meal_id,
        mealTimestamp: row.meal_timestamp,
        status: row.status,
        insulinContextConfirmed: row.insulin_context_confirmed === 1,
        ...(row.rapid_insulin_event_id === null ? {} : { rapidInsulinEventId: row.rapid_insulin_event_id }),
        ...parseOptionalEpisodePayloads(row.metrics_json, row.insight_json),
      },
    }];
  });
}

export async function confirmEpisodeInsulinContext(
  db: SQLiteDatabase,
  episodeId: string,
  rapidInsulinEventId: string | null,
): Promise<void> {
  const episode = await db.getFirstAsync<{ meal_timestamp: string }>(
    'SELECT meal_timestamp FROM meal_episodes WHERE id = ?',
    episodeId,
  );
  if (episode === null) throw new Error('Meal episode not found.');
  if (rapidInsulinEventId !== null) {
    const candidates = await getInsulinEventsForMeal(db, episode.meal_timestamp);
    if (!candidates.some((event) => event.id === rapidInsulinEventId)) {
      throw new Error('Insulin event is outside the meal association window.');
    }
  }
  await db.runAsync(
    `UPDATE meal_episodes
     SET rapid_insulin_event_id = ?, insulin_context_confirmed = 1, updated_at = ?
     WHERE id = ?`,
    rapidInsulinEventId,
    new Date().toISOString(),
    episodeId,
  );
}

export async function getPendingInsulinAssociations(
  db: SQLiteDatabase,
  now = new Date(),
): Promise<PendingInsulinAssociation[]> {
  const collecting = await getCollectingEpisodes(db);
  const ready = collecting.filter(({ meal, episode }) =>
    !episode.insulinContextConfirmed
    && (now.getTime() - Date.parse(meal.timestamp)) / 60_000 >= 180,
  );
  return Promise.all(ready.map(async ({ meal, episode }) => ({
    episodeId: episode.id,
    mealTimestamp: meal.timestamp,
    confirmedCarbsG: meal.confirmedCarbsG ?? 0,
    candidates: await getInsulinEventsForMeal(db, meal.timestamp),
  })));
}

function parseOptionalEpisodePayloads(
  metricsJson: string | null,
  insightJson: string | null,
): Pick<StoredMealEpisode, 'metrics' | 'insight'> {
  const output: Pick<StoredMealEpisode, 'metrics' | 'insight'> = {};
  if (metricsJson !== null) {
    const metrics = MealEpisodeMetricsSchema.safeParse(JSON.parse(metricsJson));
    if (metrics.success) output.metrics = metrics.data;
  }
  if (insightJson !== null) {
    const insight = GlucoseInsightSchema.safeParse(JSON.parse(insightJson));
    if (insight.success) output.insight = insight.data;
  }
  return output;
}

export async function updateEpisode(
  db: SQLiteDatabase,
  episodeId: string,
  status: StoredMealEpisode['status'],
  metrics: MealEpisodeMetrics,
  insight?: GlucoseInsight,
): Promise<void> {
  await db.runAsync(
    `UPDATE meal_episodes
     SET status = ?, metrics_json = ?, insight_json = ?, updated_at = ? WHERE id = ?`,
    status,
    JSON.stringify(metrics),
    insight === undefined ? null : JSON.stringify(insight),
    new Date().toISOString(),
    episodeId,
  );
}

interface EntryGroupAccumulator {
  timestamp: string;
  glucose?: CGMReading;
  meal?: MealEvent;
  rapid?: InsulinEvent;
  basal?: InsulinEvent;
  note?: NoteEvent;
  vitals?: VitalsEvent;
}

/**
 * The provenance suffix shown after a glucose value everywhere in the
 * Timeline. A live sensor reading ('real') gets none — it's the baseline
 * everything else is distinguished FROM; anything else says what it is, so a
 * fingerstick, an import, or synthetic demo data never reads as live sensor
 * data (AGENTS.md).
 */
function glucoseOriginSuffix(origin: CGMReading['origin']): string {
  switch (origin) {
    case 'imported': return ' · importado';
    case 'synthetic': return ' · sintético';
    case 'manual': return ' · manual';
    default: return '';
  }
}

export async function getTimeline(db: SQLiteDatabase, limit = 80): Promise<TimelineItem[]> {
  const [insulinRows, carbRows, mealRows, episodeRows, glucoseRows, noteRows, vitalsRows] = await Promise.all([
    db.getAllAsync<{ payload: string; entry_group_id: string | null }>(
      'SELECT payload, entry_group_id FROM insulin_events ORDER BY timestamp DESC LIMIT ?',
      limit,
    ),
    db.getAllAsync<{ id: string; timestamp: string; carbs_g: number; source: 'manual' | 'meal_confirmed' | 'imported'; entry_group_id: string | null }>(
      'SELECT id, timestamp, carbs_g, source, entry_group_id FROM carb_events ORDER BY timestamp DESC LIMIT ?',
      limit,
    ),
    db.getAllAsync<{ payload: string; entry_group_id: string | null }>(
      'SELECT payload, entry_group_id FROM meal_events ORDER BY timestamp DESC LIMIT ?',
      limit,
    ),
    db.getAllAsync<{
      id: string;
      meal_timestamp: string;
      status: StoredMealEpisode['status'];
      metrics_json: string | null;
      insight_json: string | null;
    }>(
      `SELECT id, meal_timestamp, status, metrics_json, insight_json FROM meal_episodes
       WHERE status != 'collecting' ORDER BY meal_timestamp DESC LIMIT ?`,
      limit,
    ),
    // TODO(Fase 3): CGM readings are far denser than the other event types
    // (one every few minutes vs. a handful a day), so once real multi-day
    // history is common this LIMIT-then-merge-then-slice approach will let
    // glucose crowd out everything else in the combined list. Fine as an
    // interim fix to make imported/live glucose visible at all.
    db.getAllAsync<{ payload: string; entry_group_id: string | null }>(
      'SELECT payload, entry_group_id FROM cgm_readings ORDER BY source_timestamp DESC LIMIT ?',
      limit,
    ),
    db.getAllAsync<{ payload: string; entry_group_id: string | null }>(
      'SELECT payload, entry_group_id FROM note_events ORDER BY timestamp DESC LIMIT ?',
      limit,
    ),
    // Solo las que pertenecen a un grupo.
    //
    // ⚠️ Las cetonas SUELTAS (las del acceso rápido, sin `entry_group_id`)
    // **no se muestran en el timeline**, ni antes ni ahora: `getTimeline` no
    // tiene ninguna rama para ellas. Un comentario anterior afirmaba lo
    // contrario; se corrigió el 2026-08-26 para que la corrida siguiente no
    // confíe en una garantía que no existe. Queda pendiente mostrarlas.
    db.getAllAsync<{ payload: string; entry_group_id: string | null }>(
      'SELECT payload, entry_group_id FROM vitals_events WHERE entry_group_id IS NOT NULL ORDER BY timestamp DESC LIMIT ?',
      limit,
    ),
  ]);


  const items: TimelineItem[] = [];
  // Rows sharing a non-null entry_group_id all came from one "Nueva
  // entrada" save (see saveUnifiedEntry) and are shown/edited as one
  // packaged item instead of N separate ones — Verónica's explicit request:
  // "lo guardado en una misma instancia, tiene que quedar empaquetado
  // junto." Ungrouped rows (quick actions, MySugr imports, anything from
  // before this existed) keep showing individually, exactly as before.
  const groups = new Map<string, EntryGroupAccumulator>();
  function groupFor(entryGroupId: string, timestamp: string): EntryGroupAccumulator {
    const existing = groups.get(entryGroupId);
    if (existing !== undefined) return existing;
    const created: EntryGroupAccumulator = { timestamp };
    groups.set(entryGroupId, created);
    return created;
  }

  for (const row of vitalsRows) {
    if (row.entry_group_id === null) continue;
    const event = VitalsEventSchema.safeParse(safeJsonParse(row.payload));
    if (!event.success) continue;
    groupFor(row.entry_group_id, event.data.timestamp).vitals = event.data;
  }

  for (const row of insulinRows) {
    const event = InsulinEventSchema.safeParse(safeJsonParse(row.payload));
    if (!event.success) continue;
    if (row.entry_group_id !== null) {
      const group = groupFor(row.entry_group_id, event.data.timestamp);
      if (event.data.type === 'rapid') group.rapid = event.data; else group.basal = event.data;
      continue;
    }
    items.push({
      id: event.data.id,
      kind: 'insulin',
      timestamp: event.data.timestamp,
      title: event.data.type === 'rapid' ? 'Insulina rápida' : 'Insulina basal',
      detail: `${event.data.units} U`,
      tone: event.data.type === 'rapid' ? 'blue' : 'navy',
      raw: event.data,
    });
  }
  for (const row of carbRows) {
    // A `meal_confirmed` row belonging to a group is the same fact as its
    // group's meal.confirmedCarbsG (writeMealWithEpisode keeps them in
    // sync) — showing both would be exactly the un-packaged duplication
    // this feature exists to remove.
    if (row.entry_group_id !== null) continue;
    items.push({
      id: row.id,
      kind: 'carbs',
      timestamp: row.timestamp,
      title: row.source === 'meal_confirmed' ? 'Carbohidratos confirmados' : 'Carbohidratos',
      detail: `${row.carbs_g} g`,
      tone: 'orange',
      raw: { carbsG: row.carbs_g, source: row.source },
    });
  }
  for (const row of mealRows) {
    const meal = MealEventSchema.safeParse(safeJsonParse(row.payload));
    if (!meal.success) continue;
    if (row.entry_group_id !== null) {
      groupFor(row.entry_group_id, meal.data.timestamp).meal = meal.data;
      continue;
    }
    items.push({
      id: meal.data.id,
      kind: 'meal',
      timestamp: meal.data.timestamp,
      title: 'Comida registrada',
      detail: meal.data.confirmedCarbsG === undefined
        ? 'Sin carbohidratos confirmados'
        : `${meal.data.confirmedCarbsG} g confirmados`,
      tone: 'orange',
      raw: meal.data,
    });
  }
  for (const row of glucoseRows) {
    const reading = CGMReadingSchema.safeParse(safeJsonParse(row.payload));
    if (!reading.success) continue;
    if (row.entry_group_id !== null) {
      groupFor(row.entry_group_id, reading.data.sourceTimestamp).glucose = reading.data;
      continue;
    }
    // Anything that isn't real sensor data says so, in the list itself —
    // a manual fingerstick and a sensor reading must not look identical.
    items.push({
      id: reading.data.id,
      kind: 'glucose',
      timestamp: reading.data.sourceTimestamp,
      title: 'Glucosa',
      // Convertido a mg/dL antes de mostrarse: una lectura importada puede
      // venir en mmol/L (ej. un CSV de LibreView exportado en esa unidad),
      // y esta etiqueta siempre dijo "mg/dL" sin chequearlo.
      detail: `${convertGlucose(reading.data.glucose, reading.data.unit, 'mg/dL')} mg/dL${glucoseOriginSuffix(reading.data.origin)}`,
      tone: reading.data.origin === 'synthetic'
        ? 'warning'
        : reading.data.origin === 'imported' || reading.data.origin === 'manual'
          ? 'muted'
          : 'teal',
      raw: reading.data,
    });
  }
  for (const row of noteRows) {
    const note = NoteEventSchema.safeParse(safeJsonParse(row.payload));
    if (!note.success) continue;
    if (row.entry_group_id !== null) {
      groupFor(row.entry_group_id, note.data.timestamp).note = note.data;
      continue;
    }
    items.push({
      id: note.data.id,
      kind: 'note',
      timestamp: note.data.timestamp,
      title: 'Nota',
      detail: note.data.text,
      tone: 'navy',
      raw: note.data,
    });
  }
  for (const row of episodeRows) {
    const parsed = parseOptionalEpisodePayloads(row.metrics_json, row.insight_json);
    const peak = parsed.metrics?.peakGlucose;
    items.push({
      id: row.id,
      kind: 'episode',
      timestamp: row.meal_timestamp,
      title: row.status === 'complete' ? 'Episodio de comida listo' : 'Episodio incompleto',
      detail: peak === undefined ? 'Faltan lecturas CGM' : `Pico ${peak} mg/dL`,
      tone: row.status === 'complete' ? 'green' : 'navy',
      ...parsed,
    });
  }

  for (const [entryGroupId, group] of groups) {
    const parts = [
      // A grouped reading is usually a hand-typed 'manual' value, but can now
      // be an auto-saved sensor reading Verónica attached carbs/insulin to
      // after the fact — so the provenance suffix is derived from the reading,
      // never hardcoded, keeping every glucose display honest about its source.
      group.glucose === undefined ? null : `${convertGlucose(group.glucose.glucose, group.glucose.unit, 'mg/dL')} mg/dL${glucoseOriginSuffix(group.glucose.origin)}`,
      group.meal?.confirmedCarbsG === undefined ? null : `${group.meal.confirmedCarbsG} g`,
      group.rapid === undefined ? null : `${group.rapid.units} U rápida`,
      group.basal === undefined ? null : `${group.basal.units} U basal`,
      // Las cetonas van en el detalle, no solo dentro del editor (corregido
      // 2026-08-26 tras la revisión de seguridad). Es el dato de triage de
      // cetoacidosis: registrarlo en "Nueva entrada" y que el timeline
      // dijera "Entrada registrada · 280 mg/dL" —sin mención de las cetonas—
      // obligaba a abrir el modal para verlo. Y una entrada SOLO de cetonas,
      // que el formulario permite, aparecía literalmente como "Entrada
      // vacía".
      group.vitals?.ketonesMmolL === undefined ? null : `${group.vitals.ketonesMmolL} mmol/L cetonas`,
      group.note === undefined ? null : 'nota',
    ].filter((part): part is string => part !== null);
    items.push({
      id: entryGroupId,
      kind: 'entry',
      timestamp: group.timestamp,
      title: 'Entrada registrada',
      detail: parts.length === 0 ? 'Entrada vacía' : parts.join(' · '),
      tone: 'teal',
      raw: {
        entryGroupId,
        // Convertido a mg/dL acá también — TimelineDetailModal muestra
        // `raw.glucose` con la etiqueta "mg/dL" fija, sin volver a
        // convertir, así que el valor tiene que serlo ya en este punto.
        ...(group.glucose === undefined ? {} : { glucose: convertGlucose(group.glucose.glucose, group.glucose.unit, 'mg/dL'), glucoseOrigin: group.glucose.origin }),
        ...(group.meal?.note === undefined ? {} : { description: group.meal.note }),
        ...(group.meal?.confirmedCarbsG === undefined ? {} : { carbsG: group.meal.confirmedCarbsG }),
        ...(group.meal?.aiEstimatedCarbsG === undefined ? {} : { aiEstimatedCarbsG: group.meal.aiEstimatedCarbsG }),
        // Fase 21: sin leerlos de vuelta, el formulario de edición abría con
        // los macros en blanco y al guardar los borraba.
        ...(group.meal?.proteinG === undefined ? {} : { proteinG: group.meal.proteinG }),
        ...(group.meal?.fatG === undefined ? {} : { fatG: group.meal.fatG }),
        ...(group.meal?.fiberG === undefined ? {} : { fiberG: group.meal.fiberG }),
        ...(group.meal?.imageUri === undefined ? {} : { imageUri: group.meal.imageUri }),
        ...(group.rapid === undefined ? {} : { rapidUnits: group.rapid.units }),
        ...(group.basal === undefined ? {} : { basalUnits: group.basal.units }),
        ...(group.note === undefined ? {} : { note: group.note.text }),
        ...(group.vitals?.ketonesMmolL === undefined ? {} : { ketonesMmolL: group.vitals.ketonesMmolL }),
      },
    });
  }

  return items
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit);
}

/**
 * Resuelve **una sola vez** si esta instalación puede seguir usando la cuenta
 * global de LibreLinkUp del backend.
 *
 * Es `true` solo cuando, al momento de migrar, ya había lecturas reales
 * guardadas: eso significa que la instalación venía sincronizando contra el
 * backend desde antes de que existiera la conexión por usuaria, y quitarle el
 * sensor de golpe en una actualización sería romperle la app a quien ya la
 * usaba. Una instalación nueva tiene la tabla vacía y arranca en `false`, así
 * que **nunca ve el sensor de otra persona**.
 *
 * Se persiste para que la respuesta no cambie después: si se recalculara en
 * cada arranque, una instalación nueva que sincroniza una vez pasaría a
 * "heredada" para siempre.
 */
export async function resolveLegacyBackendSensor(db: SQLiteDatabase, key: string): Promise<boolean> {
  const stored = await getSetting(db, key);
  if (stored !== null) return stored === 'true';
  const row = await db.getFirstAsync<{ count: number }>(
    "SELECT COUNT(*) AS count FROM cgm_readings WHERE json_extract(payload, '$.origin') = 'real'",
  );
  const isLegacy = (row?.count ?? 0) > 0;
  await setSetting(db, key, String(isLegacy));
  return isLegacy;
}

/**
 * Borra las lecturas que vinieron de un sensor (`origin:'real'`), dejando
 * intactas las manuales y las importadas, que son datos que cargó la propia
 * usuaria.
 *
 * Se usa al cambiar de cuenta de sensor: sin esto, las lecturas de la cuenta
 * anterior siguen en SQLite y `loadLocalState()` las vuelve a leer justo
 * después de "limpiar" el estado en memoria, así que el timeline, el gráfico,
 * las métricas del Resumen y el reporte quedarían mezclando la glucosa de dos
 * personas — y `latestLiveReading` podría devolver la de la cuenta anterior
 * como "actual".
 */
export async function deleteSensorReadings(db: SQLiteDatabase): Promise<number> {
  const result = await db.runAsync(
    "DELETE FROM cgm_readings WHERE json_extract(payload, '$.origin') = 'real'",
  );
  return result.changes;
}

/**
 * Perfil de nutrición (Fase 14). Va en `app_settings` como JSON y no en su
 * propia tabla: es una preferencia, no un parámetro de terapia, y a diferencia
 * de `therapy_profile` no alimenta ningún cálculo de dosis. Si no decodifica
 * se devuelve `null` y la pantalla ofrece configurarlo de nuevo — acá sí es
 * seguro caer a "no configurado", porque no hay ningún placeholder que se
 * pueda confundir con un valor elegido por la usuaria.
 */
export const NUTRITION_PROFILE_KEY = 'nutritionProfile';

export async function getNutritionProfile(db: SQLiteDatabase): Promise<NutritionProfile | null> {
  const raw = await getSetting(db, NUTRITION_PROFILE_KEY);
  if (raw === null) return null;
  const parsed = NutritionProfileSchema.safeParse(safeJsonParse(raw));
  return parsed.success ? parsed.data : null;
}

export async function saveNutritionProfile(db: SQLiteDatabase, profile: NutritionProfile): Promise<void> {
  const parsed = NutritionProfileSchema.parse(profile);
  await setSetting(db, NUTRITION_PROFILE_KEY, JSON.stringify(parsed));
}

export async function clearNutritionProfile(db: SQLiteDatabase): Promise<void> {
  await db.runAsync('DELETE FROM app_settings WHERE key = ?', NUTRITION_PROFILE_KEY);
}

/**
 * Guarda los alimentos que la IA identificó en un análisis.
 *
 * Al reconocer un alimento ya conocido se **promedia** con lo que había,
 * ponderando por las veces vistas: dos estimaciones del mismo pan convergen en
 * vez de que la última pise a la anterior. Es lo que hace que el catálogo
 * mejore con el uso en lugar de oscilar.
 *
 * Nunca falla hacia afuera: el catálogo es una comodidad, y no poder
 * escribirlo no puede impedir que se guarde la comida.
 */
export async function recordCatalogFoods(
  db: SQLiteDatabase,
  entries: readonly Omit<CatalogFood, 'timesSeen'>[],
): Promise<void> {
  if (entries.length === 0) return;
  await db.withTransactionAsync(async () => {
    for (const entry of entries) {
      const row = await db.getFirstAsync<FoodCatalogRow>('SELECT * FROM food_catalog WHERE key = ?', entry.key);

      if (row === null) {
        await db.runAsync(
          `INSERT INTO food_catalog
             (key, name, carbs_per_100g, protein_per_100g, fat_per_100g, fiber_per_100g, kcal_per_100g, times_seen, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
          entry.key, entry.name,
          entry.carbsPer100g, entry.proteinPer100g, entry.fatPer100g, entry.fiberPer100g, entry.kcalPer100g,
          entry.lastSeenAt,
        );
        continue;
      }

      // La fusión vive en `packages/domain` (pura y con test): termina
      // sugiriendo carbohidratos, así que `AGENTS.md` pide que no sea lógica
      // suelta dentro de la capa de datos.
      const merged = blendCatalogEntry(rowToCatalogFood(row), entry);
      await db.runAsync(
        `UPDATE food_catalog SET
           name = ?, carbs_per_100g = ?, protein_per_100g = ?, fat_per_100g = ?,
           fiber_per_100g = ?, kcal_per_100g = ?, times_seen = ?, last_seen_at = ?,
           serving_grams = ?, serving_label = ?
         WHERE key = ?`,
        merged.name, merged.carbsPer100g, merged.proteinPer100g, merged.fatPer100g,
        merged.fiberPer100g, merged.kcalPer100g, merged.timesSeen, merged.lastSeenAt,
        merged.servingGrams ?? null, merged.servingLabel ?? null,
        merged.key,
      );
    }
  });
}

/** Borra un alimento del catálogo — la salida cuando una estimación quedó mal. */
export async function updateCatalogFood(
  db: SQLiteDatabase,
  key: string,
  edit: CatalogFoodEdit,
): Promise<CatalogFood> {
  const row = await db.getFirstAsync<FoodCatalogRow>('SELECT * FROM food_catalog WHERE key = ?', key);
  if (row === null) throw new Error('Ese alimento ya no está en el catálogo.');

  // Toda la construcción y validación vive en `packages/domain`
  // (`applyCatalogEdit`), pura y con test: es la puerta por la que pasa cada
  // escritura manual al catálogo, y lo que quede ahí sugiere carbohidratos en
  // cada comida futura que reuse el alimento.
  const next = applyCatalogEdit(rowToCatalogFood(row), edit);
  if (next === null) {
    throw new Error('Esos valores no son posibles. Revisa los macros y el tamaño de la porción.');
  }

  await db.runAsync(
    `UPDATE food_catalog SET
       name = ?, carbs_per_100g = ?, protein_per_100g = ?, fat_per_100g = ?,
       fiber_per_100g = ?, kcal_per_100g = ?, serving_grams = ?, serving_label = ?
     WHERE key = ?`,
    next.name, next.carbsPer100g, next.proteinPer100g, next.fatPer100g,
    next.fiberPer100g, next.kcalPer100g,
    next.servingGrams ?? null, next.servingLabel ?? null,
    key,
  );
  return next;
}

/**
 * Guarda una variante nueva a partir de otro alimento, dejando el original
 * intacto.
 *
 * Es la segunda salida de la pregunta de tres de la Fase 18: "el arroz que
 * comí hoy no es el arroz de siempre". Empieza con `timesSeen: 1` porque es
 * una estimación nueva, no la acumulación del alimento del que salió —
 * heredar el contador le daría una inercia que no se ganó.
 *
 * Si el nombre choca con un alimento existente, se le agrega un sufijo en vez
 * de pisarlo: perder el alimento que la usuaria quiso conservar sería
 * exactamente lo contrario de lo que pidió al elegir esta salida.
 */
export async function createCatalogFoodVariant(
  db: SQLiteDatabase,
  entry: Omit<CatalogFood, 'timesSeen' | 'key'> & { key?: string },
): Promise<CatalogFood> {
  const baseKey = foodKey(entry.name);
  if (baseKey === '') throw new Error('La variante necesita un nombre.');

  let key = baseKey;
  let suffix = 2;
  while (await db.getFirstAsync<{ key: string }>('SELECT key FROM food_catalog WHERE key = ?', key) !== null) {
    key = `${baseKey} ${suffix}`;
    suffix += 1;
    if (suffix > 50) throw new Error('Demasiadas variantes con ese nombre.');
  }

  const created: CatalogFood = { ...entry, key, timesSeen: 1 };
  if (!isPlausibleCatalogEntry(created)) {
    throw new Error('Esos valores no son posibles por 100 g. Revisa los macros.');
  }
  await db.runAsync(
    `INSERT INTO food_catalog
       (key, name, carbs_per_100g, protein_per_100g, fat_per_100g, fiber_per_100g, kcal_per_100g, times_seen, last_seen_at, serving_grams, serving_label)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    key, created.name,
    created.carbsPer100g, created.proteinPer100g, created.fatPer100g,
    created.fiberPer100g, created.kcalPer100g, created.lastSeenAt,
    created.servingGrams ?? null, created.servingLabel ?? null,
  );
  return created;
}

export async function deleteCatalogFood(db: SQLiteDatabase, key: string): Promise<void> {
  await db.runAsync('DELETE FROM food_catalog WHERE key = ?', key);
}

interface FoodCatalogRow {
  key: string; name: string; carbs_per_100g: number; protein_per_100g: number;
  fat_per_100g: number; fiber_per_100g: number; kcal_per_100g: number;
  times_seen: number; last_seen_at: string;
  serving_grams: number | null; serving_label: string | null;
}

function rowToCatalogFood(row: FoodCatalogRow): CatalogFood {
  return {
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
  };
}

/** Alimentos del catálogo, los más usados primero. */
/**
 * Alimentos del catálogo, los más asentados primero.
 *
 * `search` filtra por la **clave** y no por el nombre: la clave ya viene
 * normalizada (minúsculas, sin acentos, sin puntuación), así que buscar
 * "platano" encuentra "Plátano" sin que haya que normalizar de nuevo acá ni
 * pedirle a la usuaria que escriba los acentos.
 */
export async function getCatalogFoods(
  db: SQLiteDatabase,
  limit = 60,
  search?: string,
): Promise<CatalogFood[]> {
  const term = search === undefined ? '' : foodKey(search);
  if (term === '') {
    const rows = await db.getAllAsync<FoodCatalogRow>(
      'SELECT * FROM food_catalog ORDER BY times_seen DESC, last_seen_at DESC LIMIT ?',
      limit,
    );
    return rows.map(rowToCatalogFood);
  }
  const rows = await db.getAllAsync<FoodCatalogRow>(
    `SELECT * FROM food_catalog WHERE key LIKE ? ESCAPE '\\'
     ORDER BY times_seen DESC, last_seen_at DESC LIMIT ?`,
    // Se escapan los comodines de SQL: sin esto, buscar "100%" listaría todo.
    `%${term.replace(/[\\%_]/gu, (match) => `\\${match}`)}%`,
    limit,
  );
  return rows.map(rowToCatalogFood);
}

export async function getSetting(db: SQLiteDatabase, key: string): Promise<string | null> {
  const row = await db.getFirstAsync<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', key);
  return row?.value ?? null;
}

export async function setSetting(db: SQLiteDatabase, key: string, value: string): Promise<void> {
  await db.runAsync('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)', key, value);
}

const MEAL_ALARM_OFFSETS_KEY = 'mealAlarmOffsetsMinutes';
const CORRECTION_REMINDER_ENABLED_KEY = 'correctionReminderEnabled';
const CORRECTION_REMINDER_OFFSET_KEY = 'correctionReminderOffsetMinutes';

/** Matches the offsets `scheduleEpisodeNotifications` used before they were configurable. */
export const DEFAULT_MEAL_ALARM_OFFSETS_MINUTES = [60, 120, 180] as const;
export const DEFAULT_CORRECTION_REMINDER_OFFSET_MINUTES = 60;

const MinuteOffsetsSchema = z.array(z.number().int().min(1).max(720)).min(1);

export async function getMealAlarmOffsets(db: SQLiteDatabase): Promise<number[]> {
  const stored = await getSetting(db, MEAL_ALARM_OFFSETS_KEY);
  if (stored === null) return [...DEFAULT_MEAL_ALARM_OFFSETS_MINUTES];
  // A corrupted local setting must degrade to the known-good default, same
  // as AGENTS.md requires for a failed external provider — not throw and
  // take the rest of loadLocalState's Promise.all down with it. JSON.parse
  // itself can throw on malformed (not just wrongly-shaped) stored text, so
  // this needs a try/catch, not just safeParse on the parsed result.
  try {
    const parsed = MinuteOffsetsSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : [...DEFAULT_MEAL_ALARM_OFFSETS_MINUTES];
  } catch {
    return [...DEFAULT_MEAL_ALARM_OFFSETS_MINUTES];
  }
}

export async function saveMealAlarmOffsets(db: SQLiteDatabase, offsets: readonly number[]): Promise<void> {
  await setSetting(db, MEAL_ALARM_OFFSETS_KEY, JSON.stringify(MinuteOffsetsSchema.parse(offsets)));
}

export interface CorrectionReminderSettings {
  enabled: boolean;
  offsetMinutes: number;
}

export async function getCorrectionReminderSettings(db: SQLiteDatabase): Promise<CorrectionReminderSettings> {
  const [enabled, offset] = await Promise.all([
    getSetting(db, CORRECTION_REMINDER_ENABLED_KEY),
    getSetting(db, CORRECTION_REMINDER_OFFSET_KEY),
  ]);
  const parsedOffset = offset === null ? null : Number(offset);
  return {
    enabled: enabled === 'true',
    offsetMinutes: parsedOffset !== null && Number.isInteger(parsedOffset) && parsedOffset >= 1 && parsedOffset <= 720
      ? parsedOffset
      : DEFAULT_CORRECTION_REMINDER_OFFSET_MINUTES,
  };
}

export async function saveCorrectionReminderSettings(
  db: SQLiteDatabase,
  settings: CorrectionReminderSettings,
): Promise<void> {
  const offsetMinutes = z.number().int().min(1).max(720).parse(settings.offsetMinutes);
  await db.withTransactionAsync(async () => {
    await setSetting(db, CORRECTION_REMINDER_ENABLED_KEY, String(settings.enabled));
    await setSetting(db, CORRECTION_REMINDER_OFFSET_KEY, String(offsetMinutes));
  });
}

const REMINDER_ALERT_STYLE_KEY = 'reminderAlertStyle';
export const DEFAULT_REMINDER_ALERT_STYLE: ReminderAlertStyle = 'both';
const ReminderAlertStyleSchema = z.enum(['sound', 'vibrate', 'both', 'silent']);

export async function getReminderAlertStyle(db: SQLiteDatabase): Promise<ReminderAlertStyle> {
  const stored = await getSetting(db, REMINDER_ALERT_STYLE_KEY);
  const parsed = ReminderAlertStyleSchema.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_REMINDER_ALERT_STYLE;
}

export async function saveReminderAlertStyle(db: SQLiteDatabase, style: ReminderAlertStyle): Promise<void> {
  await setSetting(db, REMINDER_ALERT_STYLE_KEY, ReminderAlertStyleSchema.parse(style));
}

const CAPILLARY_REMINDER_KEY = 'capillaryReminderSettings';

export interface CapillaryReminderSettings {
  enabled: boolean;
  /** How many measurement reminders to spread across the awake window. */
  count: number;
  /** Start of the awake window, "HH:MM" (24 h). */
  wakeStart: string;
  /** End of the awake window, "HH:MM" (24 h). */
  wakeEnd: string;
}

export const DEFAULT_CAPILLARY_REMINDER_SETTINGS: CapillaryReminderSettings = {
  enabled: false,
  count: 4,
  wakeStart: '08:00',
  wakeEnd: '22:00',
};

const ClockStringSchema = z.string().regex(/^\d{1,2}:\d{2}$/u);
const CapillaryReminderSettingsSchema = z.object({
  enabled: z.boolean(),
  count: z.number().int().min(1).max(12),
  wakeStart: ClockStringSchema,
  wakeEnd: ClockStringSchema,
});

export async function getCapillaryReminderSettings(db: SQLiteDatabase): Promise<CapillaryReminderSettings> {
  const stored = await getSetting(db, CAPILLARY_REMINDER_KEY);
  if (stored === null) return { ...DEFAULT_CAPILLARY_REMINDER_SETTINGS };
  // Corrupted local setting degrades to the default rather than throwing and
  // taking loadLocalState's Promise.all down with it (same reasoning as
  // getMealAlarmOffsets). JSON.parse can throw on malformed text, so the
  // try/catch is not redundant with safeParse.
  try {
    const parsed = CapillaryReminderSettingsSchema.safeParse(JSON.parse(stored));
    return parsed.success ? parsed.data : { ...DEFAULT_CAPILLARY_REMINDER_SETTINGS };
  } catch {
    return { ...DEFAULT_CAPILLARY_REMINDER_SETTINGS };
  }
}

export async function saveCapillaryReminderSettings(
  db: SQLiteDatabase,
  settings: CapillaryReminderSettings,
): Promise<void> {
  await setSetting(db, CAPILLARY_REMINDER_KEY, JSON.stringify(CapillaryReminderSettingsSchema.parse(settings)));
}
