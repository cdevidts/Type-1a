import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { SQLiteDatabase } from 'expo-sqlite';
import { z } from 'zod';

import { planMySugrImport } from '@type1a/domain';
import {
  ActivityEventSchema,
  CGMReadingSchema,
  CarbEventSchema,
  GlucoseInsightSchema,
  HbA1cLabResultSchema,
  InsulinEventSchema,
  MealEpisodeMetricsSchema,
  MealEventSchema,
  NoteEventSchema,
  TherapyProfileSchema,
  VitalsEventSchema,
  type ActivityEvent,
  type CGMReading,
  type GlucoseInsight,
  type HbA1cLabResult,
  type InsulinEvent,
  type MealEpisodeMetrics,
  type MealEvent,
  type NoteEvent,
  type TherapyProfile,
  type VitalsEvent,
} from '@type1a/schemas';

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
  `);

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
  for (const table of ['insulin_events', 'carb_events', 'cgm_readings', 'note_events', 'meal_events']) {
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

export async function getTherapyProfile(db: SQLiteDatabase): Promise<TherapyProfile> {
  const row = await db.getFirstAsync<{ payload: string }>('SELECT payload FROM therapy_profile WHERE id = 1');
  if (row === null) return DEFAULT_PROFILE;
  const parsed = TherapyProfileSchema.safeParse(JSON.parse(row.payload));
  return parsed.success ? parsed.data : DEFAULT_PROFILE;
}

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

export async function updateMealNote(db: SQLiteDatabase, id: string, note: string): Promise<void> {
  // Only the note is editable here. `confirmedCarbsG` is intentionally NOT
  // touched from this path — it's shown on this same Timeline item, but it
  // lives as its own carb_events row (see writeMealWithEpisode) with its own
  // id, and that row is what the separate "Carbohidratos confirmados"
  // Timeline item edits. Editing carbs from two different places against
  // the same underlying row would need a sync step this schema doesn't
  // support cleanly; keeping one editable path per row avoids it entirely.
  // AI-estimated fields (aiEstimatedCarbsG, macros) stay immutable — they
  // are a record of what the AI actually said, not a value to correct.
  const row = await db.getFirstAsync<{ payload: string }>('SELECT payload FROM meal_events WHERE id = ?', id);
  if (row === null) return;
  const existing = MealEventSchema.parse(JSON.parse(row.payload));
  const next = MealEventSchema.parse({ ...existing, note });
  await db.runAsync('UPDATE meal_events SET payload = ? WHERE id = ?', JSON.stringify(next), id);
}

/**
 * Like `updateMealNote`, but also updates `confirmedCarbsG` — for editing a
 * packaged "Nueva entrada" group (`updateUnifiedEntryGroup`), where carbs
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
  updates: { confirmedCarbsG?: number | undefined; note?: string | undefined },
): Promise<void> {
  const row = await db.getFirstAsync<{ payload: string }>('SELECT payload FROM meal_events WHERE id = ?', id);
  if (row === null) return;
  const existing = MealEventSchema.parse(JSON.parse(row.payload));
  const next = MealEventSchema.parse({
    ...existing,
    confirmedCarbsG: updates.confirmedCarbsG,
    note: updates.note,
  });
  await db.runAsync('UPDATE meal_events SET payload = ? WHERE id = ?', JSON.stringify(next), id);
  const carbRow = await db.getFirstAsync<{ id: string }>(
    "SELECT id FROM carb_events WHERE timestamp = ? AND source = 'meal_confirmed'",
    existing.timestamp,
  );
  if (next.confirmedCarbsG === undefined) {
    if (carbRow !== null) await db.runAsync('DELETE FROM carb_events WHERE id = ?', carbRow.id);
  } else if (carbRow === null) {
    await saveCarbEvent(db, {
      id: Crypto.randomUUID(),
      timestamp: existing.timestamp,
      carbsG: next.confirmedCarbsG,
      source: 'meal_confirmed',
      createdAt: existing.createdAt,
    });
  } else {
    await db.runAsync('UPDATE carb_events SET carbs_g = ? WHERE id = ?', next.confirmedCarbsG, carbRow.id);
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
}

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

  const hasMeal = input.carbsG !== undefined || input.description !== undefined || input.imageUri !== undefined;

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

  const hasMeal = input.carbsG !== undefined || input.description !== undefined;
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
        }, entryGroupId);
      } else {
        await updateMealCarbsAndNoteRows(db, existingMeal.id, {
          confirmedCarbsG: input.carbsG,
          note: input.description,
        });
      }
    } else if (existingMeal !== null) {
      await deleteMealEventRows(db, existingMeal.id);
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
): Promise<CGMReading[]> {
  const rows = await db.getAllAsync<{ payload: string }>(
    `SELECT payload FROM cgm_readings
     WHERE source_timestamp BETWEEN ? AND ? ORDER BY source_timestamp ASC`,
    from.toISOString(),
    to.toISOString(),
  );
  return rows.flatMap((row) => {
    const parsed = CGMReadingSchema.safeParse(JSON.parse(row.payload));
    return parsed.success ? [parsed.data] : [];
  });
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
  return rows.flatMap((row) => {
    const parsed = ActivityEventSchema.safeParse(JSON.parse(row.payload));
    return parsed.success ? [parsed.data] : [];
  });
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
  return rows.flatMap((row) => {
    const parsed = NoteEventSchema.safeParse(JSON.parse(row.payload));
    return parsed.success ? [parsed.data] : [];
  });
}

export async function saveVitalsEvent(db: SQLiteDatabase, vitals: VitalsEvent): Promise<void> {
  const parsed = VitalsEventSchema.parse(vitals);
  await db.runAsync(
    'INSERT OR IGNORE INTO vitals_events (id, timestamp, payload, created_at) VALUES (?, ?, ?, ?)',
    parsed.id,
    parsed.timestamp,
    JSON.stringify(parsed),
    parsed.createdAt,
  );
}

export async function getVitalsEvents(db: SQLiteDatabase, from: Date, to: Date): Promise<VitalsEvent[]> {
  const rows = await db.getAllAsync<{ payload: string }>(
    'SELECT payload FROM vitals_events WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC',
    from.toISOString(),
    to.toISOString(),
  );
  return rows.flatMap((row) => {
    const parsed = VitalsEventSchema.safeParse(JSON.parse(row.payload));
    return parsed.success ? [parsed.data] : [];
  });
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
  return rows.flatMap((row) => {
    const parsed = HbA1cLabResultSchema.safeParse(JSON.parse(row.payload));
    return parsed.success ? [parsed.data] : [];
  });
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
): Promise<InsulinEvent[]> {
  const from = new Date(before.getTime() - lookbackHours * 60 * 60_000).toISOString();
  const rows = await db.getAllAsync<{ payload: string }>(
    `SELECT payload FROM insulin_events
     WHERE type = 'rapid' AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC`,
    from,
    before.toISOString(),
  );
  return rows.flatMap((row) => {
    const parsed = InsulinEventSchema.safeParse(JSON.parse(row.payload));
    return parsed.success ? [parsed.data] : [];
  });
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
  return rows.flatMap((row) => {
    const parsed = InsulinEventSchema.safeParse(JSON.parse(row.payload));
    return parsed.success ? [parsed.data] : [];
  });
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
    const meal = MealEventSchema.safeParse(JSON.parse(row.meal_payload));
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
  const [insulinRows, carbRows, mealRows, episodeRows, glucoseRows, noteRows] = await Promise.all([
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

  for (const row of insulinRows) {
    const event = InsulinEventSchema.safeParse(JSON.parse(row.payload));
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
    const meal = MealEventSchema.safeParse(JSON.parse(row.payload));
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
    const reading = CGMReadingSchema.safeParse(JSON.parse(row.payload));
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
      detail: `${reading.data.glucose} mg/dL${glucoseOriginSuffix(reading.data.origin)}`,
      tone: reading.data.origin === 'synthetic'
        ? 'warning'
        : reading.data.origin === 'imported' || reading.data.origin === 'manual'
          ? 'muted'
          : 'teal',
      raw: reading.data,
    });
  }
  for (const row of noteRows) {
    const note = NoteEventSchema.safeParse(JSON.parse(row.payload));
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
      group.glucose === undefined ? null : `${group.glucose.glucose} mg/dL${glucoseOriginSuffix(group.glucose.origin)}`,
      group.meal?.confirmedCarbsG === undefined ? null : `${group.meal.confirmedCarbsG} g`,
      group.rapid === undefined ? null : `${group.rapid.units} U rápida`,
      group.basal === undefined ? null : `${group.basal.units} U basal`,
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
        ...(group.glucose === undefined ? {} : { glucose: group.glucose.glucose, glucoseOrigin: group.glucose.origin }),
        ...(group.meal?.note === undefined ? {} : { description: group.meal.note }),
        ...(group.meal?.confirmedCarbsG === undefined ? {} : { carbsG: group.meal.confirmedCarbsG }),
        ...(group.meal?.aiEstimatedCarbsG === undefined ? {} : { aiEstimatedCarbsG: group.meal.aiEstimatedCarbsG }),
        ...(group.rapid === undefined ? {} : { rapidUnits: group.rapid.units }),
        ...(group.basal === undefined ? {} : { basalUnits: group.basal.units }),
        ...(group.note === undefined ? {} : { note: group.note.text }),
      },
    });
  }

  return items
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit);
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
