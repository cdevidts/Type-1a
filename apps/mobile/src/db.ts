import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { SQLiteDatabase } from 'expo-sqlite';

import {
  CGMReadingSchema,
  GlucoseInsightSchema,
  InsulinEventSchema,
  MealEpisodeMetricsSchema,
  MealEventSchema,
  TherapyProfileSchema,
  type CGMReading,
  type GlucoseInsight,
  type InsulinEvent,
  type MealEpisodeMetrics,
  type MealEvent,
  type TherapyProfile,
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
    'INSERT INTO insulin_events (id, timestamp, type, units, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
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
  input: { id: string; timestamp: string; carbsG: number; source: 'manual' | 'meal_confirmed'; createdAt: string },
): Promise<void> {
  await db.runAsync(
    'INSERT INTO carb_events (id, timestamp, carbs_g, source, created_at) VALUES (?, ?, ?, ?, ?)',
    input.id,
    input.timestamp,
    input.carbsG,
    input.source,
    input.createdAt,
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
  const [insulinRows, carbRows, mealRows, episodeRows] = await Promise.all([
    db.getAllAsync<{ payload: string }>(
      'SELECT payload FROM insulin_events ORDER BY timestamp DESC LIMIT ?',
      limit,
    ),
    db.getAllAsync<{ id: string; timestamp: string; carbs_g: number; source: string }>(
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
