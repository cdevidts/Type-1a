import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { SQLiteDatabase } from 'expo-sqlite';

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

import type { PendingInsulinAssociation, StoredMealEpisode, TimelineItem } from './types';

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

export async function saveTherapyProfile(db: SQLiteDatabase, profile: TherapyProfile): Promise<void> {
  const parsed = TherapyProfileSchema.parse(profile);
  await db.runAsync(
    'INSERT OR REPLACE INTO therapy_profile (id, payload, updated_at) VALUES (1, ?, ?)',
    JSON.stringify(parsed),
    new Date().toISOString(),
  );
}

export async function saveInsulinEvent(db: SQLiteDatabase, event: InsulinEvent): Promise<void> {
  const parsed = InsulinEventSchema.parse(event);
  await db.runAsync(
    'INSERT OR IGNORE INTO insulin_events (id, timestamp, type, units, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    parsed.id,
    parsed.timestamp,
    parsed.type,
    parsed.units,
    JSON.stringify(parsed),
    parsed.createdAt,
  );
}

export async function saveCarbEvent(
  db: SQLiteDatabase,
  input: { id: string; timestamp: string; carbsG: number; source: 'manual' | 'meal_confirmed' | 'imported'; createdAt: string },
): Promise<void> {
  // Validate explicitly rather than relying only on the SQL CHECK
  // constraint: now that this is INSERT OR IGNORE (for idempotent
  // imports), a constraint violation would otherwise be silently dropped
  // instead of surfacing to the caller.
  const parsed = CarbEventSchema.parse(input);
  await db.runAsync(
    'INSERT OR IGNORE INTO carb_events (id, timestamp, carbs_g, source, created_at) VALUES (?, ?, ?, ?, ?)',
    parsed.id,
    parsed.timestamp,
    parsed.carbsG,
    parsed.source,
    parsed.createdAt,
  );
}

export async function saveMealWithEpisode(db: SQLiteDatabase, meal: MealEvent): Promise<string> {
  const parsed = MealEventSchema.parse(meal);
  const episodeId = Crypto.randomUUID();
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      'INSERT INTO meal_events (id, timestamp, payload, created_at) VALUES (?, ?, ?, ?)',
      parsed.id,
      parsed.timestamp,
      JSON.stringify(parsed),
      parsed.createdAt,
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
      });
    }
  });
  return episodeId;
}

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
  const timestamp = new Date().toISOString();
  const outcome: UnifiedEntryOutcome = {
    episodeId: null,
    savedGlucose: false,
    savedRapid: false,
    savedBasal: false,
    savedNote: false,
  };

  if (input.manualGlucose !== undefined) {
    // A value the user measured and typed. `origin: 'manual'` keeps it
    // distinguishable from sensor data everywhere it is displayed, and
    // sourceTimestamp/ingestedAt are both "now" because the measurement and
    // its entry genuinely happened at the same time.
    await upsertCGMReadings(db, [{
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
    }]);
    outcome.savedGlucose = true;
  }

  const hasMeal = input.carbsG !== undefined || input.description !== undefined || input.imageUri !== undefined;
  if (hasMeal) {
    outcome.episodeId = await saveMealWithEpisode(db, {
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
    });
  }

  if (input.rapidUnits !== undefined) {
    await saveInsulinEvent(db, {
      id: Crypto.randomUUID(),
      timestamp,
      type: 'rapid',
      units: input.rapidUnits,
      source: 'manual',
      createdAt: timestamp,
      // Descriptive bookkeeping only — `purpose` never feeds a calculation.
      purpose: hasMeal ? (outcome.savedGlucose ? 'combined' : 'meal') : 'correction',
    });
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
    });
    outcome.savedBasal = true;
  }

  if (input.note !== undefined) {
    await saveNoteEvent(db, {
      id: Crypto.randomUUID(),
      timestamp,
      text: input.note,
      source: 'manual',
      createdAt: timestamp,
    });
    outcome.savedNote = true;
  }

  return outcome;
}

export async function upsertCGMReadings(db: SQLiteDatabase, readings: readonly CGMReading[]): Promise<void> {
  if (readings.length === 0) return;
  await db.withTransactionAsync(async () => {
    for (const reading of readings) {
      const parsed = CGMReadingSchema.parse(reading);
      await db.runAsync(
        `INSERT OR REPLACE INTO cgm_readings
          (id, source_timestamp, payload, ingested_at) VALUES (?, ?, ?, ?)`,
        parsed.id,
        parsed.sourceTimestamp,
        JSON.stringify(parsed),
        parsed.ingestedAt,
      );
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

export async function saveNoteEvent(db: SQLiteDatabase, note: NoteEvent): Promise<void> {
  const parsed = NoteEventSchema.parse(note);
  await db.runAsync(
    'INSERT OR IGNORE INTO note_events (id, timestamp, payload, created_at) VALUES (?, ?, ?, ?)',
    parsed.id,
    parsed.timestamp,
    JSON.stringify(parsed),
    parsed.createdAt,
  );
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

export async function getTimeline(db: SQLiteDatabase, limit = 80): Promise<TimelineItem[]> {
  const [insulinRows, carbRows, mealRows, episodeRows, glucoseRows] = await Promise.all([
    db.getAllAsync<{ payload: string }>(
      'SELECT payload FROM insulin_events ORDER BY timestamp DESC LIMIT ?',
      limit,
    ),
    db.getAllAsync<{ id: string; timestamp: string; carbs_g: number; source: 'manual' | 'meal_confirmed' | 'imported' }>(
      'SELECT id, timestamp, carbs_g, source FROM carb_events ORDER BY timestamp DESC LIMIT ?',
      limit,
    ),
    db.getAllAsync<{ payload: string }>(
      'SELECT payload FROM meal_events ORDER BY timestamp DESC LIMIT ?',
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
    db.getAllAsync<{ payload: string }>(
      'SELECT payload FROM cgm_readings ORDER BY source_timestamp DESC LIMIT ?',
      limit,
    ),
  ]);

  const items: TimelineItem[] = [];
  for (const row of insulinRows) {
    const event = InsulinEventSchema.safeParse(JSON.parse(row.payload));
    if (event.success) {
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
  }
  for (const row of carbRows) {
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
    if (meal.success) {
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
  }
  for (const row of glucoseRows) {
    const reading = CGMReadingSchema.safeParse(JSON.parse(row.payload));
    if (reading.success) {
      const originSuffix = reading.data.origin === 'imported'
        ? ' · importado'
        : reading.data.origin === 'synthetic'
          ? ' · sintético'
          : '';
      items.push({
        id: reading.data.id,
        kind: 'glucose',
        timestamp: reading.data.sourceTimestamp,
        title: 'Glucosa',
        detail: `${reading.data.glucose} mg/dL${originSuffix}`,
        tone: reading.data.origin === 'synthetic'
          ? 'warning'
          : reading.data.origin === 'imported'
            ? 'muted'
            : 'teal',
        raw: reading.data,
      });
    }
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
