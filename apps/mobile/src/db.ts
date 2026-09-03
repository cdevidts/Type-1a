import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import type { SQLiteDatabase } from 'expo-sqlite';
import { z } from 'zod';

import { applyCatalogEdit, applyRecipeFixPlan, blendCatalogEntry, convertGlucose, foodKey, isValidRecipeItemGrams, MAX_RECIPE_ITEM_GRAMS, MIN_RECIPE_ITEM_GRAMS, recipesUsingFood, insulinNameForType, insulinPurposeForEntry, isPlausibleCatalogEntry, planMySugrImport, resolveInsulinNameForEdit, resolveInsulinPurposeForEdit, type CatalogFood, type CatalogFoodEdit, type Recipe, type RecipeFixPlan, type RecipeItem } from '@type1a/domain';
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
  WaterEventSchema,
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
  type WaterEvent,
  type TherapyProfile,
  type VitalsEvent,
} from '@type1a/schemas';

import { serializeWrite } from './dbWriteQueue';
import { withClaimedEntryGroup, type EntryGroupClaimStore, type EntryGroupClaimTarget } from './entryGroupClaim';
import { hasMealContent, MEAL_FIELDS, promotesLooseCarbToMeal } from './mealFields';
import { standaloneVitalsItems } from './timelineVitals';
import { decodeRow, decodeTherapyProfileRow, safeJsonParse, tallyParsed, type DecodeTally, type TherapyProfileRead } from './rowDecode';
import { partitionCarbRows, type CarbRowForTimeline } from './mealCarbMirror';
import type { PendingInsulinAssociation, PromotableTable, ReminderAlertStyle, StoredMealEpisode, TimelineEntryGroupRaw, TimelineItem } from './types';

const DATABASE_KEY_NAME = 'type1a.database-key.v1';

const DEFAULT_PROFILE: TherapyProfile = {
  glucoseUnit: 'mg/dL',
  targetGlucose: 110,
  correctionFactor: 45,
  doseIncrement: 0.5,
};

/**
 * **Toda** transacción de este módulo pasa por acá y por ninguna otra vía.
 *
 * `expo-sqlite` abre la transacción con un `BEGIN` que está dentro del `try`
 * de `withTransactionAsync`, así que dos transacciones solapadas sobre la
 * misma conexión no fallan limpio: el `BEGIN` de la segunda revienta y su
 * `catch` ejecuta un `ROLLBACK` que cierra la transacción de la **primera**,
 * dejándola escribiendo suelto y terminando en "no se pudo guardar" después
 * de haber aplicado parte de sus filas. El porqué completo, y quiénes
 * chocaban en esta app, están en `dbWriteQueue.ts`.
 *
 * No es defensa contra un doble toque solamente: `refresh()` escribe lecturas
 * CGM en cada vuelta a primer plano, y eso se solapa con un guardado sin que
 * la usuaria haga nada raro.
 *
 * ⚠️ Una función que ya corre dentro de este `work` **no puede** volver a
 * llamar acá: la cola es FIFO y no reentrante, así que se trabaría a sí misma.
 * Hoy ninguna lo hace —los doce llamadores son funciones exportadas de nivel
 * superior— y `importMySugrCsv` llama a `upsertCGMReadings` **antes** de abrir
 * la suya, no dentro.
 */
function serializedTransaction(db: SQLiteDatabase, work: () => Promise<void>): Promise<void> {
  return serializeWrite(() => db.withTransactionAsync(work));
}

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
  // Antes de `journal_mode`, porque desde este commit hay dos conexiones
  // reales contra el archivo —la de la pantalla (`SQLiteProvider`) y la de
  // `backgroundSync.ts`— y sin esto la que llega segunda a una escritura
  // recibe `database is locked` de inmediato en vez de esperar su turno. WAL
  // deja leer mientras otro escribe, pero admite un solo escritor a la vez.
  // Cinco segundos: más que cualquier transacción de esta app y menos que lo
  // que la usuaria toleraría mirando una pantalla trabada.
  await db.execAsync('PRAGMA busy_timeout = 5000;');
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
    -- Agua bebida (2026-09-03). Tabla propia y no un campo de comida: el agua
    -- se toma entre comidas tanto como con ellas, y colgarla de una comida
    -- obligaría a inventar una comida para registrar un vaso. Ver
    -- WaterEventSchema en packages/schemas para el resto del razonamiento.
    CREATE TABLE IF NOT EXISTS water_events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      entry_group_id TEXT
    );
    CREATE INDEX IF NOT EXISTS water_events_timestamp ON water_events(timestamp);
    CREATE INDEX IF NOT EXISTS water_events_group ON water_events(entry_group_id);
    -- Recetas (2026-09-01). ADITIVAS: ninguna fila de food_catalog se toca, se
    -- reinterpreta ni se borra, así que el catálogo que ya está en el teléfono
    -- sigue funcionando exactamente igual.
    --
    -- Una receta NO guarda macros. Sus totales se derivan de sus componentes
    -- al leer (recipeTotals, en dominio): corregir el arroz corrige todas las
    -- recetas que lo usan, y no hay dos verdades que diverjan. Ver
    -- packages/domain/src/recipe.ts
    CREATE TABLE IF NOT EXISTS recipes (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      image_uri TEXT,
      times_seen INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
    -- ON DELETE CASCADE sobre la receta —borrar el plato se lleva su
    -- composición— pero NUNCA sobre food_catalog: borrar un alimento usado
    -- está bloqueado a propósito, y una cascada ahí cambiaría recetas a
    -- espaldas de la usuaria. Ver deleteCatalogFood.
    CREATE TABLE IF NOT EXISTS recipe_items (
      recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
      food_key TEXT NOT NULL,
      grams REAL NOT NULL,
      PRIMARY KEY (recipe_id, food_key)
    );
    CREATE INDEX IF NOT EXISTS recipe_items_food_key ON recipe_items(food_key);
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
  // Quién fijó la porción. Aditiva y nullable como las de arriba: NULL en toda
  // fila anterior, y `rowToCatalogFood` las lee como `'user'` a propósito —
  // son justo las porciones que Verónica escribió a mano en el editor, y
  // tratarlas como propuestas de la IA las volvería pisables por el próximo
  // análisis. Ver `blendCatalogEntry`.
  if (!catalogColumns.some((column) => column.name === 'serving_source')) {
    await db.execAsync('ALTER TABLE food_catalog ADD COLUMN serving_source TEXT;');
  }
  // Foto del alimento. Aditiva y nullable por la misma razón que las dos de
  // arriba: la tabla ya tiene datos reales en el teléfono de Verónica y todos
  // ellos son anteriores a este campo. NULL = sin foto, que es exactamente lo
  // que son, y la tarjeta muestra su fallback. **Nunca se rellena con una
  // imagen inventada.**
  if (!catalogColumns.some((column) => column.name === 'image_uri')) {
    await db.execAsync('ALTER TABLE food_catalog ADD COLUMN image_uri TEXT;');
  }
  // "Solo receta" (2026-09-02). Aditiva y con DEFAULT 1: toda fila anterior
  // es un alimento que ella guardó a la vista, y así se queda. 0 = componente
  // que vive solo dentro de sus recetas; se lista desde el detalle de la
  // receta, nunca en la grilla ni en el buscador de comidas. Antes de esta
  // columna "solo receta" y "las dos cosas" escribían exactamente lo mismo.
  if (!catalogColumns.some((column) => column.name === 'listed')) {
    await db.execAsync('ALTER TABLE food_catalog ADD COLUMN listed INTEGER NOT NULL DEFAULT 1;');
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
  await serializedTransaction(db, async () => {
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

/**
 * Lo configurado en Ajustes → Terapia que sirve para estampar y reestampar el
 * nombre de una dosis.
 *
 * Lleva los **ids del catálogo** además de los nombres escritos a mano: elegir
 * "Fiasp" de la lista guarda el id, no el nombre, y sin esto
 * `insulinNameForType` no tenía de dónde sacarlo — las dosis quedaban sin
 * marca y la pantalla decía "sin configurar". Ver esa función.
 */
export interface ProfileInsulinNames {
  rapidInsulinName?: string | undefined;
  /**
   * El propósito y el desglose de la rápida del grupo. La fila del timeline
   * mostraba solo el total: no decía cuánto cubría los carbohidratos, cuánto
   * corregía la glucosa, ni cuánta insulina activa se descontó al proponerla.
   */
  rapidPurpose?: 'meal' | 'correction' | 'combined' | undefined;
  rapidMealUnits?: number | undefined;
  rapidCorrectionUnits?: number | undefined;
  rapidIobUnits?: number | undefined;
  basalInsulinName?: string | undefined;
  rapidInsulinId?: string | undefined;
  basalInsulinId?: string | undefined;
}

/**
 * Corrige una dosis ya guardada.
 *
 * **Ya no recibe un nombre de insulina escrito a mano**, y esa ausencia es el
 * cambio: el nombre no es un campo por registro sino configuración
 * (`insulinNameForType` en `packages/domain`). Antes esta función lo asignaba
 * incondicionalmente, así que cada llamada de `updateUnifiedEntryGroup` —que
 * nunca lo pasaba— borraba en silencio el nombre de una dosis que sí lo tenía.
 *
 * Qué nombre queda lo decide `resolveInsulinNameForEdit`, con test: importado
 * conserva el suyo, un cambio de rápida ↔ basal reestampa el del tipo nuevo, y
 * un tipo que no cambió conserva lo que ya había.
 */
export async function updateInsulinEvent(
  db: SQLiteDatabase,
  id: string,
  updates: {
    type: 'rapid' | 'basal';
    units: number;
    /** Mover la dosis en el tiempo. Ausente = se queda donde está. */
    timestamp?: string;
    profileInsulinNames?: ProfileInsulinNames;
    /** Obligatorio solo al reclasificar; una edición del mismo tipo conserva. */
    purposeContext?: { hasMeal: boolean; includesCorrection: boolean };
  },
): Promise<void> {
  const row = await db.getFirstAsync<{ payload: string }>('SELECT payload FROM insulin_events WHERE id = ?', id);
  if (row === null) return;
  const existing = InsulinEventSchema.parse(JSON.parse(row.payload));
  const insulinName = resolveInsulinNameForEdit({
    source: existing.source,
    existingName: existing.insulinName,
    previousType: existing.type,
    nextType: updates.type,
    profile: updates.profileInsulinNames ?? {},
  });
  if (existing.type !== updates.type && updates.purposeContext === undefined) {
    throw new Error('Falta el contexto para reclasificar la insulina.');
  }
  const purpose = resolveInsulinPurposeForEdit({
    existingPurpose: existing.purpose,
    previousType: existing.type,
    nextType: updates.type,
    hasMeal: updates.purposeContext?.hasMeal ?? false,
    includesCorrection: updates.purposeContext?.includesCorrection ?? false,
  });
  const next = InsulinEventSchema.parse({
    ...existing,
    type: updates.type,
    units: updates.units,
    ...(updates.timestamp === undefined ? {} : { timestamp: updates.timestamp }),
    // Se asigna siempre, no con un spread condicional: si la resolución dice
    // `undefined` (no hay nada configurado y no había nada guardado), tiene
    // que quedar sin nombre y no heredar el de `...existing`.
    insulinName,
    purpose,
  });
  await db.runAsync(
    'UPDATE insulin_events SET type = ?, units = ?, timestamp = ?, payload = ? WHERE id = ?',
    next.type,
    next.units,
    next.timestamp,
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
  await serializedTransaction(db, async () => {
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
/**
 * Non-transactional core — see `writeMealWithEpisode` for why this exists.
 *
 * **Dos semánticas en el mismo objeto, y la diferencia es deliberada:**
 *
 * - Carbohidratos, nota, macros y calorías son **reemplazo completo**: el
 *   formulario los muestra todos, así que un campo vaciado es una instrucción
 *   de borrar. `undefined` = borrar.
 * - Foto y análisis son **parche**: `undefined` = no se tocó, `null` = quitar.
 *   Una foto no es un campo que se deje "en blanco" — se reemplaza o se quita
 *   con una acción propia. Tratarla como reemplazo haría que guardar
 *   cualquier corrección de macros borrara la imagen de la comida.
 *
 * Delega en `updateMealFromEditRows` para que **haya un solo escritor** del
 * payload de una comida: la fase anterior tuvo dos y se separaron.
 */
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
     * "no lo anoté", que es distinto de "0 g".
     */
    proteinG?: number | undefined;
    fatG?: number | undefined;
    fiberG?: number | undefined;
    caloriesKcal?: number | undefined;
    /** Parche: ausente no toca la foto guardada, `null` la quita. */
    imageUri?: string | null | undefined;
    /** Parche: un análisis nuevo reemplaza al anterior; ausente lo conserva. */
    analysis?: { aiEstimatedCarbsG: number; aiAnalysisId: string } | undefined;
    /**
     * Estimación sin análisis propio (catálogo o carrito). Ver
     * `MealEditPatch.estimatedCarbsG`.
     *
     * **Declarado explícitamente, no heredado por el spread del llamador.** El
     * chequeo de propiedades en exceso de TypeScript **no aplica a un
     * spread**: un campo que no esté en esta interfaz se descarta en silencio
     * con `pnpm verify` en verde. Ya pasó con `macrosSource`, y el precio fue
     * que los macros de la IA llegaran al reporte médico sin procedencia.
     */
    estimatedCarbsG?: number | null | undefined;
    /**
     * Procedencia ya resuelta por `packages/domain`. `null` la borra, que es
     * lo que corresponde cuando la comida se quedó sin macros: una etiqueta
     * de procedencia colgando sobre campos vacíos miente en el reporte.
     */
    macrosSource?: MealEvent['macrosSource'] | null;
  },
): Promise<void> {
  await updateMealFromEditRows(db, id, {
    confirmedCarbsG: updates.confirmedCarbsG ?? null,
    note: updates.note ?? null,
    proteinG: updates.proteinG ?? null,
    fatG: updates.fatG ?? null,
    fiberG: updates.fiberG ?? null,
    caloriesKcal: updates.caloriesKcal ?? null,
    ...(updates.imageUri === undefined ? {} : { imageUri: updates.imageUri }),
    ...(updates.analysis === undefined ? {} : { analysis: updates.analysis }),
    ...(updates.estimatedCarbsG === undefined ? {} : { estimatedCarbsG: updates.estimatedCarbsG }),
    ...(updates.macrosSource === undefined ? {} : { macrosSource: updates.macrosSource }),
  });
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
  // El grupo de la comida acota la búsqueda **antes** que la hora.
  //
  // Emparejar solo por `timestamp` era tolerable mientras las horas venían de
  // `new Date()` y traían milisegundos: dos comidas con el ISO exacto era casi
  // imposible. Desde que se puede corregir la hora, `combineDayAndTime`
  // construye el instante con segundos y milisegundos en cero, así que dos
  // comidas movidas a "13:00" del mismo día tienen timestamps **idénticos** —
  // y editar la segunda reescribía el espejo de la primera. Con grupo, la
  // pregunta deja de ser ambigua; sin grupo se cae al emparejamiento de
  // siempre, que es el que conocen las comidas de los accesos rápidos.
  const mealRow = await db.getFirstAsync<{ entry_group_id: string | null }>(
    'SELECT entry_group_id FROM meal_events WHERE id = ?',
    existing.id,
  );
  const carbRow = mealRow?.entry_group_id != null
    ? await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM carb_events WHERE entry_group_id = ? AND source = 'meal_confirmed'",
      mealRow.entry_group_id,
    )
    : await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM carb_events WHERE timestamp = ? AND source = 'meal_confirmed' AND entry_group_id IS NULL",
      existing.timestamp,
    );
  if (confirmedCarbsG === undefined) {
    if (carbRow !== null) await db.runAsync('DELETE FROM carb_events WHERE id = ?', carbRow.id);
  } else if (carbRow === null) {
    // La fila espejo hereda el grupo de la comida: sin eso, una comida
    // empaquetada a la que se le agregan carbohidratos por primera vez dejaba
    // su espejo suelto, y el timeline lo dibujaba como una tarjeta más.
    await saveCarbEvent(db, {
      id: Crypto.randomUUID(),
      timestamp: existing.timestamp,
      carbsG: confirmedCarbsG,
      source: 'meal_confirmed',
      createdAt: existing.createdAt,
    }, mealRow?.entry_group_id ?? undefined);
  } else {
    await db.runAsync('UPDATE carb_events SET carbs_g = ? WHERE id = ?', confirmedCarbsG, carbRow.id);
  }
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
  /**
   * `null` **borra** la procedencia. Hace falta: una comida que se quedó sin
   * macros no puede conservar la etiqueta "estimados por IA" colgando sobre
   * campos vacíos, porque esa etiqueta se imprime en el reporte médico.
   */
  macrosSource?: MealEvent['macrosSource'] | null;
  /**
   * Análisis nuevo, cuando la edición pasó por la IA. `aiEstimatedCarbsG` y
   * `aiAnalysisId` se **reemplazan**, no se borran: son el registro de lo
   * último que la IA dijo sobre esta comida, y después de re-analizarla el
   * registro viejo ya no describe nada.
   */
  analysis?: { aiEstimatedCarbsG: number; aiAnalysisId: string };
  /**
   * Estimación **sin** análisis propio: los gramos que sugirió el catálogo o
   * el carrito.
   *
   * Existe porque el catálogo es una media de estimaciones de IA y no tiene un
   * `analysisId`. Sin este campo, un carbo del carrito llegaba a
   * `confirmedCarbsG` sin ningún rastro de ser una estimación, y quedaba
   * indistinguible de uno pesado en balanza — para ella y para el reporte.
   * Al reemplazarlo se borra el `aiAnalysisId` anterior: apuntaba a un
   * análisis que ya no describe estos gramos.
   */
  estimatedCarbsG?: number | null;
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
    ...(patch.macrosSource === undefined ? {} : { macrosSource: patch.macrosSource ?? undefined }),
    ...(patch.analysis === undefined
      ? {}
      : {
          aiEstimatedCarbsG: patch.analysis.aiEstimatedCarbsG,
          aiAnalysisId: patch.analysis.aiAnalysisId,
        }),
    // Sin análisis propio: se escribe el estimado y se suelta el `aiAnalysisId`
    // viejo, que ya no describe estos gramos.
    ...(patch.estimatedCarbsG === undefined || patch.analysis !== undefined
      ? {}
      : { aiEstimatedCarbsG: patch.estimatedCarbsG ?? undefined, aiAnalysisId: undefined }),
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
  await serializedTransaction(db, async () => {
    await updateMealFromEditRows(db, id, patch);
  });
}

/** Non-transactional core — see `writeMealWithEpisode` for why this exists. */
async function deleteMealEventRows(db: SQLiteDatabase, id: string): Promise<void> {
  const row = await db.getFirstAsync<{ timestamp: string; entry_group_id: string | null }>(
    'SELECT timestamp, entry_group_id FROM meal_events WHERE id = ?',
    id,
  );
  // ON DELETE CASCADE on meal_episodes.meal_id takes care of the episode.
  await db.runAsync('DELETE FROM meal_events WHERE id = ?', id);
  if (row !== null) {
    // The carb_events row created alongside this meal (writeMealWithEpisode)
    // has no foreign key back to it — matched by group when it has one, and
    // by timestamp + source otherwise. Left behind, it would read as a
    // standalone "Carbohidratos confirmados" entry for a meal that no longer
    // exists.
    //
    // El grupo va primero por la misma razón que en `syncConfirmedCarbRow`:
    // con horas corregibles a "13:00" exactas, borrar por hora global podía
    // llevarse el espejo de OTRA comida del mismo minuto.
    if (row.entry_group_id !== null) {
      await db.runAsync(
        "DELETE FROM carb_events WHERE entry_group_id = ? AND source = 'meal_confirmed'",
        row.entry_group_id,
      );
    } else {
      await db.runAsync(
        "DELETE FROM carb_events WHERE timestamp = ? AND source = 'meal_confirmed' AND entry_group_id IS NULL",
        row.timestamp,
      );
    }
  }
}

export async function deleteMealEvent(db: SQLiteDatabase, id: string): Promise<void> {
  await serializedTransaction(db, async () => {
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
    // timestamp compartido es load-bearing en cuatro lugares que emparejan
    // ambas filas por él: `updateCarbEvent`, `deleteMealEventRows`,
    // `partitionCarbRows` (el que evita que la comida se vea dos veces) y
    // `buildNutritionInsights` (packages/domain), que lo usa para no contar
    // dos veces el mismo plato en el promedio de carbohidratos por franja.
    // Mover la HORA de una comida mueve también esta fila — ver
    // `moveEntryGroupRows`.
    await writeMirrorCarbRow(db, parsed, entryGroupId);
  }
  return episodeId;
}

/**
 * Escribe la fila espejo de carbohidratos de una comida **adoptando** la que
 * ya haya en vez de crear una segunda.
 *
 * Existe por el camino de promoción: un carbohidrato suelto al que se le
 * agrega una comida encima ya tiene su fila, y crear otra dejaría los mismos
 * gramos contados dos veces en Nutrición y en el reporte. Adoptarla conserva
 * además el id y el `created_at` originales, que es lo que la promoción
 * promete no perder.
 *
 * `source` pasa a `'meal_confirmed'` a propósito: esos gramos ahora **son**
 * los carbohidratos confirmados de la comida que acaba de crearse a su
 * alrededor. La alternativa —borrar y recrear— pierde la identidad de la fila,
 * que es justo lo que no se puede perder.
 */
async function writeMirrorCarbRow(db: SQLiteDatabase, meal: MealEvent, entryGroupId?: string): Promise<void> {
  if (meal.confirmedCarbsG === undefined) return;
  // Igual que en `syncConfirmedCarbRow`: dentro de un grupo la pregunta no es
  // ambigua; sin grupo se empareja por hora, que es lo que conocen las comidas
  // de los accesos rápidos.
  const adopted = entryGroupId === undefined
    ? await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM carb_events WHERE timestamp = ? AND source = 'meal_confirmed' AND entry_group_id IS NULL",
      meal.timestamp,
    )
    : await db.getFirstAsync<{ id: string }>('SELECT id FROM carb_events WHERE entry_group_id = ?', entryGroupId);
  if (adopted !== null) {
    await db.runAsync(
      "UPDATE carb_events SET carbs_g = ?, timestamp = ?, source = 'meal_confirmed' WHERE id = ?",
      meal.confirmedCarbsG,
      meal.timestamp,
      adopted.id,
    );
    return;
  }
  await saveCarbEvent(db, {
    id: Crypto.randomUUID(),
    timestamp: meal.timestamp,
    carbsG: meal.confirmedCarbsG,
    source: 'meal_confirmed',
    createdAt: meal.createdAt,
  }, entryGroupId);
}

/**
 * Una comida con su episodio, por el camino del botón rápido.
 *
 * `entryGroupId` es opcional pero **el llamador debería darlo siempre que la
 * comida venga acompañada de algo más** —una dosis, típicamente—. El timeline
 * agrupa exclusivamente por esa columna: sin ella, la comida y su insulina se
 * dibujan como dos hechos sueltos que pasaron a la misma hora, y la app vuelve
 * a preguntar qué dosis fue con qué comida, que es justo lo que la Fase 21
 * dijo que eliminaba. `saveUnifiedEntry` (el maestro) ya lo hacía; este camino
 * no, y por eso la asimetría se notaba solo desde el acceso rápido.
 */
export async function saveMealWithEpisode(
  db: SQLiteDatabase,
  meal: MealEvent,
  entryGroupId?: string,
): Promise<string> {
  let episodeId = '';
  await serializedTransaction(db, async () => {
    episodeId = await writeMealWithEpisode(db, meal, entryGroupId);
  });
  return episodeId;
}

/**
 * Bounds mirrored from the event schemas in `@type1a/schemas`, checked
 * before any row is written so a combined entry can't land half-saved.
 */
const InsulinUnitsSchema = InsulinEventSchema.shape.units;
const CarbGramsSchema = CarbEventSchema.shape.carbsG;
const WaterMlSchema = WaterEventSchema.shape.ml;

/** Traduce la procedencia del formulario a la del evento guardado. */
function waterSourceFor(fromAi: 'photo' | 'text' | undefined): WaterEvent['source'] {
  if (fromAi === 'photo') return 'ai_photo';
  if (fromAi === 'text') return 'ai_text';
  return 'manual';
}
/** Gramos de un macro, con el mismo límite que `MealEventSchema`. */
const MacroGramsSchema = MealEventSchema.shape.proteinG.unwrap();
const GlucoseValueSchema = CGMReadingSchema.shape.glucose;

/**
 * Corrección de un registro de vitales, campo por campo.
 *
 * `undefined` = **no se tocó** · `null` = **borrar** · número = el valor.
 *
 * La distinción no es estilística: una fila de `vitals_events` puede traer
 * cetonas, peso y presión juntos, y reescribir el objeto entero para corregir
 * una cetona mal tecleada se llevaba el peso de esa misma fila en silencio.
 * "Ausente" y "vacíalo" tienen que ser dos afirmaciones distintas, igual que
 * en `MealEditPatch`, y por la misma razón: un borrado se pide, no se deduce.
 */
export interface VitalsPatch {
  ketonesMmolL?: number | null;
  weightKg?: number | null;
  systolicBP?: number | null;
  diastolicBP?: number | null;
}

/** True si el parche no dice nada — ni un valor, ni un borrado. */
function isEmptyVitalsPatch(patch: VitalsPatch | undefined): boolean {
  if (patch === undefined) return true;
  return patch.ketonesMmolL === undefined && patch.weightKg === undefined
    && patch.systolicBP === undefined && patch.diastolicBP === undefined;
}

/** True si el parche trae al menos un valor real que guardar. */
function vitalsPatchHasValue(patch: VitalsPatch | undefined): boolean {
  if (patch === undefined) return false;
  return [patch.ketonesMmolL, patch.weightKg, patch.systolicBP, patch.diastolicBP]
    .some((value) => typeof value === 'number');
}

export interface UnifiedEntryInput {
  /** Agua bebida en esta entrada, en mL. Ausente = no hubo. */
  waterMl?: number;
  /**
   * Cómo llegó ese volumen. Ausente = lo escribió ella.
   *
   * Se guarda en `WaterEvent.source`, que el detalle del registro imprime: un
   * número que produjo un modelo no puede mostrarse como "Ingresado a mano".
   */
  waterFromAi?: 'photo' | 'text';
  manualGlucose?: number;
  description?: string;
  carbsG?: number;
  /**
   * Foto de la comida. Al **crear** es la ruta de la imagen; al **editar** es
   * un parche: ausente no toca la foto guardada y `null` la quita. Una foto
   * no es un campo que se deje en blanco.
   */
  imageUri?: string | null;
  aiEstimatedCarbsG?: number;
  proteinG?: number;
  fatG?: number;
  fiberG?: number;
  caloriesKcal?: number;
  aiAnalysisId?: string;
  rapidUnits?: number;
  /**
   * El desglose de la rápida, cuando salió de la calculadora: cuánto cubría
   * los carbohidratos, cuánto corregía la glucosa, y cuánta insulina activa
   * se descontó al proponerla (2026-09-02).
   *
   * Ausentes cuando la escribió a mano — y ausencia es "no se sabe", nunca
   * cero. Se guardan **como se calcularon**: si después edita el total, el
   * desglose sigue describiendo el cálculo, no el número final, y la pantalla
   * muestra las dos cosas en vez de reescribir uno para que cuadre con otro.
   */
  rapidMealUnits?: number;
  rapidCorrectionUnits?: number;
  rapidIobUnits?: number;
  basalUnits?: number;
  note?: string;
  /**
   * When the entry happened, as shown to the user while filling the sheet.
   * Passed in rather than taken at write time so a sheet left open for
   * twenty minutes doesn't stamp everything — including the meal episode's
   * +60/+120/+180 window — twenty minutes after the header said.
   *
   * **Al editar, este es también el mecanismo de "mover de hora".** Si difiere
   * del que tienen las filas del grupo, `updateUnifiedEntryGroup` las mueve
   * todas en la misma transacción — ver `moveEntryGroupRows`.
   */
  timestamp: string;
  /** True when the rapid dose covers a correction as well as carbs. */
  rapidIncludesCorrection?: boolean;
  /**
   * Cetonas, peso y presión (2026-08-27).
   *
   * Se escriben como `VitalsEvent`, que es donde ya viven, no como campos
   * nuevos: el acceso rápido de cetonas y este parche terminan en la misma
   * tabla y se leen igual. Ver `VitalsPatch` para la semántica de cada valor.
   */
  vitals?: VitalsPatch;
  /**
   * Procedencia de los macros: `'ai'`, `'user'` o `'mixed'`; `null` la borra.
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
  macrosSource?: MealEvent['macrosSource'] | null;
  /**
   * Los nombres de insulina configurados en Ajustes → Terapia.
   *
   * Viajan como dato y no se leen acá dentro para que la resolución siga
   * siendo la función pura de `packages/domain`. Sin ellos, una dosis nueva
   * dentro de un grupo quedaría sin nombre y una reclasificada rápida ↔ basal
   * conservaría el del tipo anterior.
   */
  profileInsulinNames?: ProfileInsulinNames;
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
  savedWater: boolean;
  /**
   * Episodios cuyas notificaciones ya programadas dejaron de describir la
   * realidad y hay que **cancelar antes** de programar las nuevas.
   *
   * Se devuelve en vez de cancelarse acá porque `db.ts` no habla con
   * `expo-notifications`: una alarma es una decisión de la capa que orquesta.
   * Sin esto, mover una comida de las 21:00 a las 13:00 dejaba las tres
   * alarmas viejas en pie y sumaba tres nuevas.
   */
  movedEpisodeIds: string[];
}

const EMPTY_OUTCOME = (): UnifiedEntryOutcome => ({
  episodeId: null,
  savedGlucose: false,
  savedRapid: false,
  savedBasal: false,
  savedNote: false,
  savedWater: false,
  movedEpisodeIds: [],
});

/**
 * Margen de reloj al rechazar una fecha futura.
 *
 * Un minuto: el suficiente para que un reloj apenas adelantado no rechace un
 * "ahora" legítimo, y demasiado poco para que sirva de puerta a un registro
 * de mañana. Rechazar el futuro no es una preferencia de UI — un evento que
 * todavía no pasó contamina episodios, ventanas de patrones y el reporte.
 */
export const FUTURE_TIMESTAMP_TOLERANCE_MS = 60_000;

export function isFutureTimestamp(timestamp: string, now = Date.now()): boolean {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed > now + FUTURE_TIMESTAMP_TOLERANCE_MS;
}

function assertNotFuture(timestamp: string): void {
  if (isFutureTimestamp(timestamp)) {
    throw new Error('No se puede guardar un registro con fecha y hora futuras.');
  }
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
  assertNotFuture(timestamp);
  const outcome = EMPTY_OUTCOME();

  // Validate every piece up front. Each write below is an independent
  // INSERT, so a schema rejection partway through would otherwise leave a
  // half-written entry the user can only "fix" by re-saving — duplicating
  // everything that already landed, since each retry mints new ids.
  if (input.rapidUnits !== undefined) InsulinUnitsSchema.parse(input.rapidUnits);
  if (input.basalUnits !== undefined) InsulinUnitsSchema.parse(input.basalUnits);
  if (input.carbsG !== undefined) CarbGramsSchema.parse(input.carbsG);
  if (input.manualGlucose !== undefined) GlucoseValueSchema.parse(input.manualGlucose);
  // El agua entra a la validación previa por la misma razón que las demás: su
  // insert corre dentro de la transacción, así que un 20000 tecleado por 2000
  // tumbaba el guardado ENTERO —la glucosa y las unidades que sí estaban
  // bien— detrás de un "no se pudo guardar" que no decía qué campo fue.
  if (input.waterMl !== undefined) WaterMlSchema.parse(input.waterMl);

  const hasMeal = hasMealContent(input);

  // Every row this save produces shares one id, so the pieces can be shown
  // and edited later as the single packaged thing they were entered as —
  // see getTimeline()'s grouping and updateUnifiedEntryGroup/
  // deleteUnifiedEntryGroup. A glucose-only save still gets a group id even
  // though there's nothing to group it WITH yet; if the entry is later
  // edited to add carbs or a dose, they join this same id instead of the
  // edit silently starting a second, disconnected group.
  const entryGroupId = Crypto.randomUUID();

  await serializedTransaction(db, async () => {
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
        ...(input.imageUri === undefined || input.imageUri === null ? {} : { imageUri: input.imageUri }),
        ...(input.aiEstimatedCarbsG === undefined ? {} : { aiEstimatedCarbsG: input.aiEstimatedCarbsG }),
        ...(input.proteinG === undefined ? {} : { proteinG: input.proteinG }),
        ...(input.fatG === undefined ? {} : { fatG: input.fatG }),
        ...(input.fiberG === undefined ? {} : { fiberG: input.fiberG }),
        ...(input.caloriesKcal === undefined ? {} : { caloriesKcal: input.caloriesKcal }),
        ...(input.aiAnalysisId === undefined ? {} : { aiAnalysisId: input.aiAnalysisId }),
        ...(input.macrosSource === undefined || input.macrosSource === null ? {} : { macrosSource: input.macrosSource }),
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
        ...(input.rapidMealUnits === undefined ? {} : { mealUnits: input.rapidMealUnits }),
        ...(input.rapidCorrectionUnits === undefined ? {} : { correctionUnits: input.rapidCorrectionUnits }),
        ...(input.rapidIobUnits === undefined ? {} : { iobUnits: input.rapidIobUnits }),
        // El nombre se estampa al crear y queda congelado: si mañana cambia
        // de tratamiento, lo de hoy siguió siendo lo de hoy.
        ...(insulinNameForType(input.profileInsulinNames ?? {}, 'rapid') === undefined
          ? {}
          : { insulinName: insulinNameForType(input.profileInsulinNames ?? {}, 'rapid')! }),
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
        ...(insulinNameForType(input.profileInsulinNames ?? {}, 'basal') === undefined
          ? {}
          : { insulinName: insulinNameForType(input.profileInsulinNames ?? {}, 'basal')! }),
      }, entryGroupId);
      outcome.savedBasal = true;
    }

    if (vitalsPatchHasValue(input.vitals)) {
      const vitals = input.vitals!;
      await saveVitalsEvent(db, {
        id: Crypto.randomUUID(),
        timestamp,
        ...(typeof vitals.ketonesMmolL === 'number' ? { ketonesMmolL: vitals.ketonesMmolL } : {}),
        ...(typeof vitals.weightKg === 'number' ? { weightKg: vitals.weightKg } : {}),
        ...(typeof vitals.systolicBP === 'number' ? { systolicBP: vitals.systolicBP } : {}),
        ...(typeof vitals.diastolicBP === 'number' ? { diastolicBP: vitals.diastolicBP } : {}),
        source: 'manual',
        createdAt: timestamp,
      }, entryGroupId);
    }

    if (input.waterMl !== undefined) {
      await saveWaterEvent(db, {
        id: Crypto.randomUUID(),
        timestamp,
        ml: input.waterMl,
        source: waterSourceFor(input.waterFromAi),
        createdAt: timestamp,
      }, entryGroupId);
      outcome.savedWater = true;
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
 * Mueve **todas** las filas de un grupo a otro momento, en la transacción que
 * abrió quien llama.
 *
 * ## Qué se mueve y qué no
 *
 * Se mueve la columna `timestamp` **y** el `timestamp` de dentro del payload:
 * son dos copias del mismo dato y actualizar una sola las bifurca — la lista
 * ordenaría por una y el detalle mostraría la otra. Se mueve también
 * `meal_episodes.meal_timestamp` y la fila espejo de carbohidratos, que se
 * empareja por hora.
 *
 * **`ingestedAt` no se mueve nunca.** Es cuándo la app recibió el dato, no
 * cuándo ocurrió; moverlo fingiría otro momento de ingestión y rompería
 * `assessFreshness`, que es la garantía de que una lectura atrasada no pase
 * por actual (`AGENTS.md`).
 *
 * **Una lectura que no es `'manual'` tampoco se mueve.** La hora de un sensor
 * es parte de lo que reportó el sensor. En un grupo anclado a una lectura
 * externa se mueven los adjuntos y la lectura se queda donde estaba.
 *
 * ## Por qué devuelve los episodios
 *
 * Un episodio movido tiene que **recalcularse** (sus métricas describían otra
 * ventana de CGM) y sus notificaciones tienen que cancelarse antes de
 * programar las nuevas. Ambas cosas viven fuera de `db.ts`.
 */
async function moveEntryGroupRows(
  db: SQLiteDatabase,
  entryGroupId: string,
  nextTimestamp: string,
): Promise<{ movedEpisodeIds: string[]; previousTimestamp: string | null }> {
  const movedEpisodeIds: string[] = [];
  let previousTimestamp: string | null = null;

  for (const table of ['insulin_events', 'carb_events', 'note_events', 'meal_events', 'vitals_events', 'water_events'] as const) {
    const rows = await db.getAllAsync<{ id: string; timestamp: string; payload: string | null }>(
      // `carb_events` no tiene payload: sus datos son columnas. El SELECT
      // pide NULL en su lugar para que el bucle sea uno solo.
      table === 'carb_events'
        ? 'SELECT id, timestamp, NULL as payload FROM carb_events WHERE entry_group_id = ?'
        : `SELECT id, timestamp, payload FROM ${table} WHERE entry_group_id = ?`,
      entryGroupId,
    );
    for (const row of rows) {
      if (row.timestamp === nextTimestamp) continue;
      previousTimestamp ??= row.timestamp;
      if (row.payload === null) {
        await db.runAsync(`UPDATE ${table} SET timestamp = ? WHERE id = ?`, nextTimestamp, row.id);
        continue;
      }
      const parsed = safeJsonParse(row.payload);
      const payload = typeof parsed === 'object' && parsed !== null ? { ...parsed, timestamp: nextTimestamp } : null;
      if (payload === null) {
        // Una fila ilegible se mueve igual en su columna: dejarla atrás la
        // separaría del resto del grupo, y el payload roto ya lo declara
        // `DecodeTally` en cada lectura.
        await db.runAsync(`UPDATE ${table} SET timestamp = ? WHERE id = ?`, nextTimestamp, row.id);
        continue;
      }
      await db.runAsync(
        `UPDATE ${table} SET timestamp = ?, payload = ? WHERE id = ?`,
        nextTimestamp,
        JSON.stringify(payload),
        row.id,
      );
      if (table === 'meal_events') {
        // El episodio vuelve a 'collecting' y suelta sus métricas: describían
        // la ventana de CGM del horario anterior. `processReadyEpisodes` lo
        // recalcula con las lecturas del horario nuevo.
        const episode = await db.getFirstAsync<{ id: string }>(
          'SELECT id FROM meal_episodes WHERE meal_id = ?',
          row.id,
        );
        if (episode !== null) {
          await db.runAsync(
            `UPDATE meal_episodes
             SET meal_timestamp = ?, status = 'collecting', metrics_json = NULL, insight_json = NULL, updated_at = ?
             WHERE id = ?`,
            nextTimestamp,
            new Date().toISOString(),
            episode.id,
          );
          movedEpisodeIds.push(episode.id);
        }
      }
    }
  }

  // La lectura del grupo: solo si es capilar tecleada por ella. Se mueven la
  // medición (`timestamp`, `sourceTimestamp`) y nunca `ingestedAt`.
  const reading = await db.getFirstAsync<{ id: string; payload: string }>(
    'SELECT id, payload FROM cgm_readings WHERE entry_group_id = ?',
    entryGroupId,
  );
  if (reading !== null) {
    const parsed = CGMReadingSchema.safeParse(safeJsonParse(reading.payload));
    if (parsed.success && parsed.data.origin === 'manual' && parsed.data.sourceTimestamp !== nextTimestamp) {
      previousTimestamp ??= parsed.data.sourceTimestamp;
      const next = CGMReadingSchema.parse({
        ...parsed.data,
        timestamp: nextTimestamp,
        sourceTimestamp: nextTimestamp,
        // `ingestedAt` intacto a propósito. Ver la cabecera.
      });
      await db.runAsync(
        'UPDATE cgm_readings SET source_timestamp = ?, payload = ? WHERE id = ?',
        nextTimestamp,
        JSON.stringify(next),
        reading.id,
      );
    }
  }

  return { movedEpisodeIds, previousTimestamp };
}

/**
 * Convierte un evento suelto en una entrada agrupada, sin perder su
 * identidad.
 *
 * ## Qué problema resuelve
 *
 * "El tipo con el que se creó un evento no restringe lo que se le puede sumar
 * más tarde" (`projectbrief.md`). Una insulina suelta a la que hoy se le
 * quiere agregar la comida que la acompañó no tiene grupo, y sin grupo no hay
 * dónde colgar nada: el timeline agrupa por `entry_group_id` y **jamás** por
 * hora (Regla 3b).
 *
 * ## Lo que garantiza
 *
 * - **No borra ni recrea el evento.** Es un `UPDATE` de una columna: id,
 *   timestamp, `created_at`, `source`, `origin` y el payload entero siguen
 *   siendo los mismos objetos. Un borrado y una reinserción perderían el id,
 *   y con él cualquier notificación, episodio o referencia que lo apuntara.
 * - **Es idempotente.** Si la fila ya tiene grupo, devuelve ese mismo id sin
 *   escribir. Un doble toque o un reintento no puede producir dos grupos, que
 *   es exactamente cómo un registro se parte en dos tarjetas.
 * - **No duplica el episodio de una comida.** Promover un `meal_events` no
 *   crea uno nuevo: el que ya tiene sigue siendo suyo.
 * - **Es atómica.** La abre en su propia transacción, así que un fallo a
 *   mitad deja la fila exactamente como estaba.
 */
export async function promoteEventToEntryGroup(
  db: SQLiteDatabase,
  table: PromotableTable,
  rowId: string,
): Promise<string> {
  return withClaimedEntryGroup(
    entryGroupClaimStore(db),
    null,
    { table, rowId },
    () => Crypto.randomUUID(),
    async (confirmedGroupId) => confirmedGroupId,
  );
}

/** Adaptador SQLite de la regla pura y testeable de reclamación de grupos. */
function entryGroupClaimStore(db: SQLiteDatabase): EntryGroupClaimStore<SQLiteDatabase> {
  return {
    // Debe ser ESTA conexión: SQLCipher recibe su PRAGMA key por conexión en
    // initializeDatabase, y Expo abre una conexión **nueva** para la variante
    // exclusiva — esa conexión no queda autenticada y no puede leer la base.
    // Por eso el aislamiento no viene de `withExclusiveTransactionAsync` sino
    // de la cola: `serializedTransaction` es la MISMA que usan las otras once
    // transacciones del módulo. Tener una cola propia acá no servía de nada —
    // dos colas contra una sola conexión anidan el `BEGIN` igual, y este
    // camino compartía conexión con el `upsertCGMReadings` de `refresh()`.
    transaction: async (work) => serializedTransaction(db, async () => work(db)),
    read: async (transaction, target) => {
      const row = await transaction.getFirstAsync<{ entry_group_id: string | null }>(
        `SELECT entry_group_id FROM ${target.table} WHERE id = ?`,
        target.rowId,
      );
      return row === null ? undefined : row.entry_group_id;
    },
    claim: async (transaction, target, candidateGroupId) => {
      // La tabla está cerrada por `EntryGroupClaimTable`; no acepta texto
      // arbitrario. La condición hace idempotente el doble toque.
      await transaction.runAsync(
        `UPDATE ${target.table} SET entry_group_id = ? WHERE id = ? AND entry_group_id IS NULL`,
        candidateGroupId,
        target.rowId,
      );
    },
    alignMealMirror: async (transaction, mealId, confirmedGroupId) => {
      const meal = await transaction.getFirstAsync<{ timestamp: string }>(
        'SELECT timestamp FROM meal_events WHERE id = ?',
        mealId,
      );
      if (meal !== null) {
        // Se asigna el id CONFIRMADO, incluso si otra llamada ganó. Usar el
        // candidato propio partía comida y espejo en grupos distintos.
        await transaction.runAsync(
          "UPDATE carb_events SET entry_group_id = ? WHERE timestamp = ? AND source = 'meal_confirmed' AND entry_group_id IS NULL",
          confirmedGroupId,
          meal.timestamp,
        );
      }
    },
  };
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
 *
 * Las tres excepciones a "lo que se omite se borra", todas escritas con
 * sangre: los vitales son un **parche** (`VitalsPatch`), la foto y el análisis
 * de la comida son un parche, y el nombre de la insulina lo resuelve
 * `resolveInsulinNameForEdit`. Un formulario que no conoce un campo no puede
 * destruirlo.
 */
export async function updateUnifiedEntryGroup(
  db: SQLiteDatabase,
  knownEntryGroupId: string | null,
  input: UnifiedEntryInput,
  claimTarget?: EntryGroupClaimTarget,
): Promise<UnifiedEntryOutcome> {
  const timestamp = input.timestamp;
  assertNotFuture(timestamp);
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
  const profileNames = input.profileInsulinNames ?? {};

  return withClaimedEntryGroup(
    entryGroupClaimStore(db),
    knownEntryGroupId,
    claimTarget,
    () => Crypto.randomUUID(),
    async (entryGroupId, db) => {
    const outcome = EMPTY_OUTCOME();
    // Mover PRIMERO, editar después: todo lo que sigue empareja la fila
    // espejo de carbohidratos y el episodio por el timestamp de la comida, y
    // hacerlo al revés dejaría media transacción emparejando por la hora
    // vieja y la otra media por la nueva.
    const moved = await moveEntryGroupRows(db, entryGroupId, timestamp);
    outcome.movedEpisodeIds = moved.movedEpisodeIds;

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
    // Un carbohidrato **suelto** del grupo: el que se promovió desde su propia
    // fila del timeline y todavía no tiene comida alrededor.
    const looseCarb = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM carb_events WHERE entry_group_id = ? AND source != 'meal_confirmed'",
      entryGroupId,
    );
    // ¿La edición trae algo de comida **más allá** de los gramos? La lista es
    // la misma de `MEAL_FIELDS`, sin `carbsG`, y vive en `mealFields.ts` con
    // test: tenerla duplicada acá es exactamente cómo se desincronizaron los
    // dos booleanos `hasMeal` que borraron comidas dos veces.
    const hasMealBeyondCarbs = promotesLooseCarbToMeal(input);

    // **Un carbohidrato manual suelto sigue siendo un carbohidrato suelto.**
    //
    // `hasMealContent` cuenta los gramos como comida, y para "Nueva entrada"
    // eso es correcto: anotar 25 g ahí es registrar lo que comiste. Pero al
    // **editar** una fila que nació como carbohidrato suelto, aplicar la misma
    // regla la convertía en comida solo por abrirla y guardar — con episodio
    // nuevo y tres alarmas encima. Una colación anotada a las 16:00 no puede
    // volverse un plato porque alguien corrigió los gramos.
    //
    // Se vuelve comida cuando la edición **agrega** algo que solo una comida
    // tiene: descripción, macros, foto o análisis. Ahí la promoción es lo que
    // se pidió, y `writeMirrorCarbRow` adopta esta misma fila como espejo en
    // vez de crear una segunda.
    if (hasMeal && existingMeal === null && looseCarb !== null && !hasMealBeyondCarbs) {
      if (input.carbsG !== undefined) {
        await db.runAsync(
          'UPDATE carb_events SET carbs_g = ?, timestamp = ? WHERE id = ?',
          input.carbsG,
          timestamp,
          looseCarb.id,
        );
      }
    } else if (hasMeal) {
      if (existingMeal === null) {
        // **Todas** las facultades de una comida, también al crearla desde una
        // edición: foto, análisis de IA, carbohidratos estimados, calorías y
        // procedencia. Antes acá solo llegaban carbos, nota y los tres macros,
        // así que adjuntar una comida completa a una glucosa de anteayer
        // perdía en silencio la foto y el análisis — el hueco central que este
        // cambio viene a cerrar.
        outcome.episodeId = await writeMealWithEpisode(db, {
          id: Crypto.randomUUID(),
          timestamp,
          createdAt: timestamp,
          ...(input.carbsG === undefined ? {} : { confirmedCarbsG: input.carbsG }),
          ...(input.description === undefined ? {} : { note: input.description }),
          ...(input.imageUri === undefined || input.imageUri === null ? {} : { imageUri: input.imageUri }),
          ...(input.aiEstimatedCarbsG === undefined ? {} : { aiEstimatedCarbsG: input.aiEstimatedCarbsG }),
          ...(input.aiAnalysisId === undefined ? {} : { aiAnalysisId: input.aiAnalysisId }),
          ...(input.proteinG === undefined ? {} : { proteinG: input.proteinG }),
          ...(input.fatG === undefined ? {} : { fatG: input.fatG }),
          ...(input.fiberG === undefined ? {} : { fiberG: input.fiberG }),
          ...(input.caloriesKcal === undefined ? {} : { caloriesKcal: input.caloriesKcal }),
          // La procedencia la decide `packages/domain` antes de llegar acá.
          // Nunca se marca `'user'` una estimación: eso lo resuelve
          // `resolveMacrosSource` en quien llama.
          ...(input.macrosSource === undefined || input.macrosSource === null ? {} : { macrosSource: input.macrosSource }),
        }, entryGroupId);
        // **La fila suelta se consume, siempre.**
        //
        // `writeMirrorCarbRow` la adopta como espejo —le cambia el `source`—
        // solo cuando la comida trae carbohidratos confirmados. Si la usuaria
        // borró los gramos y escribió "pan con queso", la comida nace sin
        // ellos y la fila de 25 g se quedaba viva dentro del grupo: el
        // timeline la volvía a mostrar (`entryGroupRaw` cae en `group.carb`),
        // el maestro la sembraba de nuevo, y al segundo guardado
        // `syncConfirmedCarbRow` creaba un espejo aparte — dos filas a la
        // misma hora y **50 g en Nutrición para un plato de 25**. Un dato que
        // ella borró no puede resucitar, y menos duplicado.
        //
        // Se re-consulta en vez de reusar `looseCarb`: si fue adoptada, ya no
        // es suelta y esta consulta no la encuentra.
        const orphanCarb = await db.getFirstAsync<{ id: string }>(
          "SELECT id FROM carb_events WHERE entry_group_id = ? AND source != 'meal_confirmed'",
          entryGroupId,
        );
        if (orphanCarb !== null) await db.runAsync('DELETE FROM carb_events WHERE id = ?', orphanCarb.id);
      } else {
        await updateMealCarbsAndNoteRows(db, existingMeal.id, {
          confirmedCarbsG: input.carbsG,
          note: input.description,
          proteinG: input.proteinG,
          fatG: input.fatG,
          fiberG: input.fiberG,
          caloriesKcal: input.caloriesKcal,
          ...(input.imageUri === undefined ? {} : { imageUri: input.imageUri }),
          // Un análisis nuevo trae los dos campos. El carrito trae **solo** el
          // estimado: el catálogo es una media de estimaciones de IA y no
          // tiene un `analysisId` propio. Exigir los dos juntos descartaba ese
          // rastro y, peor, dejaba encima el `aiEstimatedCarbsG` de un
          // análisis anterior que ya no describía nada.
          ...(input.aiEstimatedCarbsG === undefined
            ? {}
            : input.aiAnalysisId === undefined
              ? { estimatedCarbsG: input.aiEstimatedCarbsG }
              : { analysis: { aiEstimatedCarbsG: input.aiEstimatedCarbsG, aiAnalysisId: input.aiAnalysisId } }),
          ...(input.macrosSource === undefined ? {} : { macrosSource: input.macrosSource }),
        });
      }
    } else if (existingMeal !== null) {
      await deleteMealEventRows(db, existingMeal.id);
    } else if (looseCarb !== null) {
      // La usuaria vació los gramos del carbohidrato suelto: eso es pedir que
      // se borre, igual que en el resto del formulario.
      await db.runAsync('DELETE FROM carb_events WHERE id = ?', looseCarb.id);
    }

    // Vitales del grupo: **parche**, no reemplazo. Corregir una cetona mal
    // tecleada no puede llevarse el peso ni la presión de la misma fila, y un
    // campo que el formulario no muestra no puede borrar nada.
    const existingVitals = await db.getFirstAsync<{ id: string; payload: string }>(
      'SELECT id, payload FROM vitals_events WHERE entry_group_id = ?',
      entryGroupId,
    );
    if (!isEmptyVitalsPatch(input.vitals)) {
      await applyVitalsPatchRows(db, existingVitals, input.vitals!, timestamp, entryGroupId);
    }

    const existingRapid = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM insulin_events WHERE entry_group_id = ? AND type = 'rapid'",
      entryGroupId,
    );
    const existingBasalRow = await db.getFirstAsync<{ id: string }>(
      "SELECT id FROM insulin_events WHERE entry_group_id = ? AND type = 'basal'",
      entryGroupId,
    );

    /**
     * Reclasificar rápida ↔ basal es una **actualización**, no un borrado más
     * un alta.
     *
     * Los dos tipos se buscan y se escriben por separado, así que mover las
     * unidades del campo "Acción prolongada" al de "Rápida" ejecutaba
     * `deleteInsulinEvent` + `saveInsulinEvent`: se perdían el `id`, el
     * `created_at` y —si la dosis venía de una importación de MySugr— el
     * `source: 'imported'` se convertía en `'manual'`, afirmando que la
     * escribió ella. Como efecto colateral, la rama `previousType !==
     * nextType` de `resolveInsulinNameForEdit` era inalcanzable desde acá,
     * pese a ser el caso que sus tests describen.
     *
     * Solo aplica cuando hay **exactamente una** dosis antes y **exactamente
     * una** después, del otro tipo: con dos dosis no hay reclasificación que
     * deducir, hay dos hechos distintos.
     */
    const reclassify: { id: string; nextType: 'rapid' | 'basal'; units: number } | null = (() => {
      const onlyRapidBefore = existingRapid !== null && existingBasalRow === null;
      const onlyBasalBefore = existingBasalRow !== null && existingRapid === null;
      const onlyBasalAfter = input.basalUnits !== undefined && input.rapidUnits === undefined;
      const onlyRapidAfter = input.rapidUnits !== undefined && input.basalUnits === undefined;
      if (onlyRapidBefore && onlyBasalAfter) {
        return { id: existingRapid.id, nextType: 'basal', units: input.basalUnits! };
      }
      if (onlyBasalBefore && onlyRapidAfter) {
        return { id: existingBasalRow.id, nextType: 'rapid', units: input.rapidUnits! };
      }
      return null;
    })();

    if (reclassify !== null) {
      await updateInsulinEvent(db, reclassify.id, {
        type: reclassify.nextType,
        units: reclassify.units,
        timestamp,
        profileInsulinNames: profileNames,
        purposeContext: {
          hasMeal,
          includesCorrection: input.rapidIncludesCorrection === true,
        },
      });
      if (reclassify.nextType === 'rapid') outcome.savedRapid = true;
      else outcome.savedBasal = true;
    } else if (input.rapidUnits !== undefined) {
      const includesCorrection = input.rapidIncludesCorrection === true;
      if (existingRapid === null) {
        const name = insulinNameForType(profileNames, 'rapid');
        await saveInsulinEvent(db, {
          id: Crypto.randomUUID(),
          timestamp,
          type: 'rapid',
          units: input.rapidUnits,
          source: 'manual',
          createdAt: timestamp,
          purpose: insulinPurposeForEntry('rapid', hasMeal, includesCorrection),
          ...(name === undefined ? {} : { insulinName: name }),
        }, entryGroupId);
      } else {
        await updateInsulinEvent(db, existingRapid.id, {
          type: 'rapid',
          units: input.rapidUnits,
          timestamp,
          profileInsulinNames: profileNames,
        });
      }
      outcome.savedRapid = true;
    } else if (existingRapid !== null) {
      await deleteInsulinEvent(db, existingRapid.id);
    }

    const existingBasal = existingBasalRow;
    if (reclassify !== null) {
      // Ya resuelto arriba, en una sola fila.
    } else if (input.basalUnits !== undefined) {
      if (existingBasal === null) {
        const name = insulinNameForType(profileNames, 'basal');
        await saveInsulinEvent(db, {
          id: Crypto.randomUUID(),
          timestamp,
          type: 'basal',
          units: input.basalUnits,
          source: 'manual',
          createdAt: timestamp,
          ...(name === undefined ? {} : { insulinName: name }),
        }, entryGroupId);
      } else {
        await updateInsulinEvent(db, existingBasal.id, {
          type: 'basal',
          units: input.basalUnits,
          timestamp,
          profileInsulinNames: profileNames,
        });
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

    // Agua: mismo contrato que la nota. Un `undefined` borra, porque el
    // maestro manda el campo SIEMPRE al editar y `undefined` solo llega
    // cuando ella lo vació.
    const existingWater = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM water_events WHERE entry_group_id = ?',
      entryGroupId,
    );
    if (input.waterMl !== undefined) {
      if (existingWater === null) {
        await saveWaterEvent(db, {
          id: Crypto.randomUUID(),
          timestamp,
          ml: input.waterMl,
          source: waterSourceFor(input.waterFromAi),
          createdAt: timestamp,
        }, entryGroupId);
      } else {
        await updateWaterEvent(db, existingWater.id, input.waterMl);
      }
      outcome.savedWater = true;
    } else if (existingWater !== null) {
      await deleteWaterEvent(db, existingWater.id);
    }

    // If a sensor-anchored entry has had every attachment removed, it's no
    // longer an "entry" — just the plain sensor reading again. Detach it
    // (clear the group id) rather than leave a one-item group that would
    // render as "Entrada registrada" wrapping a lone glucose value. The
    // reading itself is never deleted here.
    const remainingVitals = await db.getFirstAsync<{ id: string }>(
      'SELECT id FROM vitals_events WHERE entry_group_id = ?',
      entryGroupId,
    );
    if (hasSensorAnchor && existingGlucose !== null
      && !hasMeal && input.rapidUnits === undefined && input.basalUnits === undefined
      && input.note === undefined && remainingVitals === null) {
      await db.runAsync('UPDATE cgm_readings SET entry_group_id = NULL WHERE id = ?', existingGlucose.id);
    }
    return outcome;
  });
}

/**
 * Aplica un `VitalsPatch` sobre la fila del grupo, creándola si hace falta y
 * borrándola solo cuando se queda sin ninguna medición.
 *
 * Un campo ausente del parche **no se toca**; uno en `null` se borra. La fila
 * entera desaparece únicamente cuando ya no queda nada que guardar en ella,
 * porque `VitalsEventSchema` exige al menos una medición.
 */
async function applyVitalsPatchRows(
  db: SQLiteDatabase,
  existing: { id: string; payload: string } | null,
  patch: VitalsPatch,
  timestamp: string,
  entryGroupId: string | undefined,
): Promise<void> {
  const previous = existing === null ? {} : (safeJsonParse(existing.payload) ?? {});
  const base = typeof previous === 'object' && previous !== null ? previous as Record<string, unknown> : {};
  const merged: Record<string, unknown> = { ...base };
  for (const field of ['ketonesMmolL', 'weightKg', 'systolicBP', 'diastolicBP'] as const) {
    const value = patch[field];
    if (value === undefined) continue;         // no se tocó
    if (value === null) delete merged[field];  // borrado explícito
    else merged[field] = value;
  }
  const hasAnyMeasurement = ['ketonesMmolL', 'weightKg', 'systolicBP', 'diastolicBP']
    .some((field) => typeof merged[field] === 'number');

  if (!hasAnyMeasurement) {
    if (existing !== null) await db.runAsync('DELETE FROM vitals_events WHERE id = ?', existing.id);
    return;
  }
  if (existing === null) {
    await saveVitalsEvent(db, VitalsEventSchema.parse({
      ...merged,
      id: Crypto.randomUUID(),
      timestamp,
      source: 'manual',
      createdAt: timestamp,
    }), entryGroupId);
    return;
  }
  const next = VitalsEventSchema.parse({
    ...merged,
    id: existing.id,
    timestamp,
    // `source` y `createdAt` salen de `merged`, o sea de la fila que ya
    // estaba: una corrección no reescribe cuándo ni de dónde vino el dato.
    source: typeof base['source'] === 'string' ? base['source'] : 'manual',
    createdAt: typeof base['createdAt'] === 'string' ? base['createdAt'] : timestamp,
  });
  await db.runAsync(
    'UPDATE vitals_events SET payload = ?, timestamp = ? WHERE id = ?',
    JSON.stringify(next),
    timestamp,
    existing.id,
  );
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
  input: Omit<UnifiedEntryInput, 'timestamp'> & { timestamp?: string },
): Promise<UnifiedEntryOutcome> {
  const row = await db.getFirstAsync<{ payload: string; entry_group_id: string | null }>(
    'SELECT payload, entry_group_id FROM cgm_readings WHERE id = ?',
    readingId,
  );
  if (row === null) throw new Error('La lectura ya no existe.');
  const reading = CGMReadingSchema.parse(JSON.parse(row.payload));
  // Validate the attachments up front, before tagging the reading — the only
  // pre-write throw inside the delegated updateUnifiedEntryGroup is this same
  // validation, so doing it here first means a bad input can't leave the
  // reading tagged into a one-item group with nothing attached.
  if (input.rapidUnits !== undefined) InsulinUnitsSchema.parse(input.rapidUnits);
  if (input.basalUnits !== undefined) InsulinUnitsSchema.parse(input.basalUnits);
  if (input.carbsG !== undefined) CarbGramsSchema.parse(input.carbsG);
  if (input.manualGlucose !== undefined) GlucoseValueSchema.parse(input.manualGlucose);

  // **Idempotente**: si la lectura ya es parte de un grupo se edita ese
  // grupo, no se acuña uno segundo. Antes esto lanzaba, así que un doble
  // toque terminaba en un error rojo sobre un guardado que sí correspondía.
  // Delegate the attachment writes to the same in-place editor used for every
  // later edit, so there's one code path (and one set of safety rules) for a
  // group's contents. It preserves the now-anchored reading because its origin
  // isn't 'manual' — or, for a manual reading, applies `manualGlucose` if given.
  // The glucose value is only ever forwarded for a 'manual' reading; for any
  // other origin it's dropped entirely, never passed as undefined.
  const { manualGlucose, timestamp, ...rest } = input;
  const glucoseOverride = reading.origin === 'manual' && manualGlucose !== undefined ? { manualGlucose } : {};
  return updateUnifiedEntryGroup(db, row.entry_group_id, {
    ...rest,
    ...glucoseOverride,
    // Una lectura externa fija el momento del grupo: sus adjuntos van a la
    // hora que reportó la fuente y no a otra. Solo una capilar tecleada por
    // ella se puede mover, y entonces manda el timestamp que llegue.
    timestamp: reading.origin === 'manual' ? (timestamp ?? reading.sourceTimestamp) : reading.sourceTimestamp,
  }, { table: 'cgm_readings', rowId: readingId });
}

/**
 * Deletes a packaged entry. A hand-typed 'manual' anchor is part of the
 * entry and gets deleted with it; a sensor/imported/synthetic anchor is real
 * source data, so it is preserved and simply detached (its group id cleared)
 * while the attachments are removed — deleting the "entry" must never destroy
 * a real sensor reading.
 */
export async function deleteUnifiedEntryGroup(db: SQLiteDatabase, entryGroupId: string): Promise<void> {
  await serializedTransaction(db, async () => {
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
    // Sin esta línea la fila de agua quedaba con un `entry_group_id` colgando:
    // seguía sumando al total del día para siempre, reaparecía como una
    // "Entrada vacía" en el timeline, y borrar esa entrada volvía a correr las
    // mismas consultas — o sea que no había forma de sacarla nunca.
    await db.runAsync('DELETE FROM water_events WHERE entry_group_id = ?', entryGroupId);
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
  await serializedTransaction(db, async () => {
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

/**
 * Registra agua bebida.
 *
 * `INSERT OR IGNORE` como el resto: reintentar un guardado no duplica el vaso.
 */
export async function saveWaterEvent(db: SQLiteDatabase, water: WaterEvent, entryGroupId?: string): Promise<void> {
  const parsed = WaterEventSchema.parse(water);
  await db.runAsync(
    'INSERT OR IGNORE INTO water_events (id, timestamp, payload, created_at, entry_group_id) VALUES (?, ?, ?, ?, ?)',
    parsed.id,
    parsed.timestamp,
    JSON.stringify(parsed),
    parsed.createdAt,
    entryGroupId ?? null,
  );
}

export async function updateWaterEvent(db: SQLiteDatabase, id: string, ml: number): Promise<void> {
  const row = await db.getFirstAsync<{ payload: string }>('SELECT payload FROM water_events WHERE id = ?', id);
  if (row === null) return;
  const existing = WaterEventSchema.parse(JSON.parse(row.payload));
  const next = WaterEventSchema.parse({ ...existing, ml });
  await db.runAsync('UPDATE water_events SET payload = ? WHERE id = ?', JSON.stringify(next), id);
}

export async function deleteWaterEvent(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM water_events WHERE id = ?', id);
}

/**
 * El agua de un rango.
 *
 * `tally` viaja igual que en las otras lecturas: una fila ilegible no puede
 * pasar por "no tomaste agua". Aquí el costo de mentir es bajo comparado con
 * una glucosa, pero la regla es la misma y el hábito importa más que el caso.
 */
export async function getWaterEvents(
  db: SQLiteDatabase,
  from: Date,
  to: Date,
  tally?: DecodeTally,
): Promise<WaterEvent[]> {
  const rows = await db.getAllAsync<{ payload: string }>(
    'SELECT payload FROM water_events WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC',
    from.toISOString(),
    to.toISOString(),
  );
  return rows.flatMap((row) => decodeRow(row.payload, WaterEventSchema, tally));
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

/**
 * Borra un registro de vitales (cetonas, peso, presión) desde su propia
 * tarjeta del timeline.
 *
 * Existe desde que las cetonas sueltas se muestran ahí: un ítem que se ve y no
 * se puede quitar es un callejón sin salida.
 *
 * ⚠️ **Tenía un `AND entry_group_id IS NULL` y hubo que quitarlo.** La guarda
 * era correcta cuando "tener grupo" implicaba "estar dentro de una entrada
 * empaquetada", que se borra por `deleteUnifiedEntryGroup`. Desde que editar
 * un registro lo **promueve** a grupo, una fila de cetonas puede tener grupo y
 * seguir siendo la única pieza que hay: el timeline la dibuja con su tipo
 * nativo (ver `singleGroupItem`) y la guarda hacía que el botón Eliminar no
 * hiciera nada, en silencio. El callejón sin salida volvía por la puerta de
 * atrás.
 *
 * Borrar la fila es suficiente: si el grupo tenía más piezas, la tarjeta de
 * este ítem no existe y nadie llega hasta acá; si no las tenía, el grupo queda
 * sin filas y deja de existir solo.
 */
export async function deleteVitalsEvent(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync('DELETE FROM vitals_events WHERE id = ?', id);
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

  await serializedTransaction(db, async () => {
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

/**
 * La ventana por defecto de dosis rápidas recientes, en horas.
 *
 * Alcanza para el contexto en pantalla con cualquier análoga (3-5 h), pero
 * **no** para la insulina activa de una insulina más larga: `App.tsx` la
 * ensancha a la duración del modelo cuando hace falta. Ver ahí el porqué.
 */
export const DEFAULT_RAPID_LOOKBACK_HOURS = 6;

export async function getRecentRapidInsulin(
  db: SQLiteDatabase,
  before = new Date(),
  lookbackHours = DEFAULT_RAPID_LOOKBACK_HOURS,
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
  /**
   * Un carbohidrato del grupo que **no** es el espejo de su comida.
   *
   * Aparece cuando un carbohidrato suelto se promueve a entrada: la fila
   * conserva su identidad y se une al grupo, pero todavía no hay comida
   * alrededor. Sin esta rama la tarjeta decía "Entrada vacía" sobre unos
   * gramos que sí estaban guardados.
   */
  carb?: { id: string; carbsG: number; source: 'manual' | 'meal_confirmed' | 'imported' };
  rapid?: InsulinEvent;
  basal?: InsulinEvent;
  note?: NoteEvent;
  vitals?: VitalsEvent;
  water?: WaterEvent;
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
  const [insulinRows, carbRows, mealRows, episodeRows, glucoseRows, noteRows, groupedVitalsRows, looseVitalsRows, waterRows] = await Promise.all([
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
    // Dos consultas, con su propio `LIMIT` cada una, y **eso es la parte que
    // importa**.
    //
    // Hasta el 2026-08-26 acá había un `WHERE entry_group_id IS NOT NULL` que
    // hacía desaparecer las cetonas del acceso rápido. Quitarlo a secas —el
    // primer intento— las mostraba pero ponía a competir las agrupadas y las
    // sueltas por los mismos 80 cupos, y cada importación de MySugr escribe
    // una fila suelta por día con peso o presión. Con 80 filas sueltas más
    // nuevas, la fila agrupada se caía de la ventana, la entrada se dibujaba
    // sin sus cetonas, **y editar esa entrada las borraba de la base**: el
    // formulario sembraba el campo vacío y guardar interpretaba el vacío como
    // "bórralas". Una ventana de visualización no puede destruir un dato
    // guardado, y menos el de triage de cetoacidosis.
    db.getAllAsync<{ payload: string; entry_group_id: string | null }>(
      'SELECT payload, entry_group_id FROM vitals_events WHERE entry_group_id IS NOT NULL ORDER BY timestamp DESC LIMIT ?',
      limit,
    ),
    db.getAllAsync<{ payload: string; entry_group_id: string | null }>(
      'SELECT payload, entry_group_id FROM vitals_events WHERE entry_group_id IS NULL ORDER BY timestamp DESC LIMIT ?',
      limit,
    ),
    db.getAllAsync<{ payload: string; entry_group_id: string | null }>(
      'SELECT payload, entry_group_id FROM water_events ORDER BY timestamp DESC LIMIT ?',
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

  for (const row of groupedVitalsRows) {
    if (row.entry_group_id === null) continue;
    const event = VitalsEventSchema.safeParse(safeJsonParse(row.payload));
    if (!event.success) continue;
    groupFor(row.entry_group_id, event.data.timestamp).vitals = event.data;
  }
  // Las sueltas van como ítem propio. El mapeo vive en un módulo puro para
  // poder verificarlo sin teléfono: es donde estaba el hueco.
  items.push(...standaloneVitalsItems(looseVitalsRows));

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
  // Las filas espejo se resuelven contra **todas** las comidas que podrían
  // explicarlas, no solo contra las que entraron en el `LIMIT` de arriba: si
  // la comida se cayó de la ventana y su espejo no, la usuaria vería una
  // tarjeta de "Carbohidratos confirmados" huérfana al lado de nada. Una
  // ventana de visualización no puede cambiar qué es un hecho.
  const mirrorTimestamps = [...new Set(
    carbRows.filter((row) => row.source === 'meal_confirmed').map((row) => row.timestamp),
  )];
  const mealAnchors = mirrorTimestamps.length === 0
    ? []
    : await db.getAllAsync<{ id: string; timestamp: string }>(
      `SELECT id, timestamp FROM meal_events WHERE timestamp IN (${mirrorTimestamps.map(() => '?').join(',')})`,
      ...mirrorTimestamps,
    );
  const carbPartition = partitionCarbRows(
    carbRows.map((row): CarbRowForTimeline => ({
      id: row.id,
      timestamp: row.timestamp,
      carbsG: row.carbs_g,
      source: row.source,
      entryGroupId: row.entry_group_id,
    })),
    mealAnchors,
  );
  for (const row of carbPartition.standalone) {
    // Una fila agrupada la dibuja la tarjeta de su grupo. Las espejo de una
    // comida las escondió `partitionCarbRows`: para la usuaria comer una vez
    // es un solo acontecimiento, aunque por dentro se guarde dos veces.
    if (row.entryGroupId !== null) {
      groupFor(row.entryGroupId, row.timestamp).carb = { id: row.id, carbsG: row.carbsG, source: row.source };
      continue;
    }
    items.push({
      id: row.id,
      kind: 'carbs',
      timestamp: row.timestamp,
      // Un espejo que llega hasta acá es huérfano: su comida ya no existe.
      // Se nombra como lo que es, para que no parezca la comida que falta.
      title: row.source === 'meal_confirmed' ? 'Carbohidratos de una comida borrada' : 'Carbohidratos',
      detail: `${row.carbsG} g`,
      tone: 'orange',
      raw: { carbsG: row.carbsG, source: row.source },
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
  // El agua suelta se ve en el timeline como cualquier otro registro: si se
  // guarda y no se ve, no se puede corregir ni borrar. Es la misma falla que
  // tuvieron las cetonas sueltas y que costó un `WHERE` de más.
  for (const row of waterRows) {
    const water = WaterEventSchema.safeParse(safeJsonParse(row.payload));
    if (!water.success) continue;
    if (row.entry_group_id !== null) {
      groupFor(row.entry_group_id, water.data.timestamp).water = water.data;
      continue;
    }
    items.push({
      id: water.data.id,
      kind: 'water',
      timestamp: water.data.timestamp,
      title: 'Agua',
      detail: `${water.data.ml} mL`,
      tone: 'blue',
      raw: water.data,
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
    // **Un grupo de una sola pieza no es una entrada empaquetada.**
    //
    // Desde que editar cualquier registro lo promueve a grupo (para poder
    // sumarle lo que falte), corregir las unidades de una insulina suelta la
    // dejaba dentro de un grupo de un solo elemento — y el timeline la
    // dibujaba como "Entrada registrada · 3 U rápida". Un cambio de forma que
    // nadie pidió y que además le quita su tarjeta propia.
    //
    // La regla es de presentación y va acá, junto a la que arma los grupos:
    // se cuenta lo que hay dentro y, si es una sola cosa, se emite con su tipo
    // nativo. El `entry_group_id` **se conserva en la base**, así que volver a
    // editarla reusa el mismo grupo en vez de acuñar otro.
    const singleton = singleGroupItem(entryGroupId, group);
    if (singleton !== null) {
      items.push(singleton);
      continue;
    }
    const parts = [
      // A grouped reading is usually a hand-typed 'manual' value, but can now
      // be an auto-saved sensor reading Verónica attached carbs/insulin to
      // after the fact — so the provenance suffix is derived from the reading,
      // never hardcoded, keeping every glucose display honest about its source.
      group.glucose === undefined ? null : `${convertGlucose(group.glucose.glucose, group.glucose.unit, 'mg/dL')} mg/dL${glucoseOriginSuffix(group.glucose.origin)}`,
      group.meal?.confirmedCarbsG === undefined
        ? (group.carb === undefined ? null : `${group.carb.carbsG} g`)
        : `${group.meal.confirmedCarbsG} g`,
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
      // Por la misma razón que las cetonas: una entrada cuyo único contenido
      // es agua aparecía como "Entrada registrada · Entrada vacía".
      group.water === undefined ? null : `${group.water.ml} mL agua`,
      group.note === undefined ? null : 'nota',
    ].filter((part): part is string => part !== null);
    items.push({
      id: entryGroupId,
      kind: 'entry',
      timestamp: group.timestamp,
      title: 'Entrada registrada',
      detail: parts.length === 0 ? 'Entrada vacía' : parts.join(' · '),
      tone: 'teal',
      raw: entryGroupRaw(entryGroupId, group),
    });
  }

  return items
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, limit);
}

/**
 * El `raw` de una entrada empaquetada, con **todo** lo que el editor necesita
 * para no destruir nada.
 *
 * La regla que lo gobierna es una sola y ya costó dos bugs: **un dato que el
 * formulario no ve es un dato que el guardado borra.** Por eso viajan de
 * vuelta también el nombre de la insulina, las calorías, el peso y la presión,
 * aunque la fila del timeline no los muestre.
 */
function entryGroupRaw(entryGroupId: string, group: EntryGroupAccumulator): TimelineEntryGroupRaw {
  const carbsG = group.meal?.confirmedCarbsG ?? group.carb?.carbsG;
  return {
    entryGroupId,
    // Convertido a mg/dL acá también — `TimelineDetailModal` muestra
    // `raw.glucose` con la etiqueta "mg/dL" fija, sin volver a convertir,
    // así que el valor tiene que serlo ya en este punto.
    ...(group.glucose === undefined ? {} : { glucose: convertGlucose(group.glucose.glucose, group.glucose.unit, 'mg/dL'), glucoseOrigin: group.glucose.origin }),
    ...(group.meal === undefined ? {} : { meal: group.meal }),
    ...(group.meal?.note === undefined ? {} : { description: group.meal.note }),
    ...(carbsG === undefined ? {} : { carbsG }),
    ...(group.meal?.aiEstimatedCarbsG === undefined ? {} : { aiEstimatedCarbsG: group.meal.aiEstimatedCarbsG }),
    // Fase 21: sin leerlos de vuelta, el formulario de edición abría con
    // los macros en blanco y al guardar los borraba.
    ...(group.meal?.proteinG === undefined ? {} : { proteinG: group.meal.proteinG }),
    ...(group.meal?.fatG === undefined ? {} : { fatG: group.meal.fatG }),
    ...(group.meal?.fiberG === undefined ? {} : { fiberG: group.meal.fiberG }),
    ...(group.meal?.caloriesKcal === undefined ? {} : { caloriesKcal: group.meal.caloriesKcal }),
    ...(group.meal?.imageUri === undefined ? {} : { imageUri: group.meal.imageUri }),
    ...(group.rapid === undefined ? {} : { rapidUnits: group.rapid.units }),
    ...(group.basal === undefined ? {} : { basalUnits: group.basal.units }),
    // El nombre estampado viaja de vuelta al editor. Sin esto el formulario
    // no sabía que existía, y una actualización parcial lo borraba.
    ...(group.rapid?.insulinName === undefined ? {} : { rapidInsulinName: group.rapid.insulinName }),
    ...(group.rapid?.purpose === undefined ? {} : { rapidPurpose: group.rapid.purpose }),
    ...(group.rapid?.mealUnits === undefined ? {} : { rapidMealUnits: group.rapid.mealUnits }),
    ...(group.rapid?.correctionUnits === undefined ? {} : { rapidCorrectionUnits: group.rapid.correctionUnits }),
    ...(group.rapid?.iobUnits === undefined ? {} : { rapidIobUnits: group.rapid.iobUnits }),
    ...(group.basal?.insulinName === undefined ? {} : { basalInsulinName: group.basal.insulinName }),
    ...(group.water === undefined ? {} : { waterMl: group.water.ml }),
    ...(group.note === undefined ? {} : { note: group.note.text }),
    ...(group.vitals?.ketonesMmolL === undefined ? {} : { ketonesMmolL: group.vitals.ketonesMmolL }),
    // Peso y presión, por la misma razón que las cetonas.
    ...(group.vitals?.weightKg === undefined ? {} : { weightKg: group.vitals.weightKg }),
    ...(group.vitals?.systolicBP === undefined ? {} : { systolicBP: group.vitals.systolicBP }),
    ...(group.vitals?.diastolicBP === undefined ? {} : { diastolicBP: group.vitals.diastolicBP }),
  };
}

/**
 * El ítem nativo de un grupo que solo tiene una pieza, o `null` si tiene más
 * de una.
 *
 * Ver el comentario en `getTimeline`. La comida es la excepción que **no** se
 * colapsa cuando además hay un espejo de carbohidratos: ese par es una sola
 * pieza por definición y ya viene contado como una.
 */
function singleGroupItem(entryGroupId: string, group: EntryGroupAccumulator): TimelineItem | null {
  const pieces = [
    group.glucose === undefined ? null : 'glucose',
    group.meal === undefined ? null : 'meal',
    // El espejo de la comida no cuenta como pieza propia: es la misma.
    group.carb === undefined || group.meal !== undefined ? null : 'carb',
    group.rapid === undefined ? null : 'rapid',
    group.basal === undefined ? null : 'basal',
    group.note === undefined ? null : 'note',
    group.vitals === undefined ? null : 'vitals',
    // El agua cuenta como pieza. Sin esto, un grupo de glucosa + agua se
    // dibujaba como una glucosa suelta, el maestro la abría sin conocer el
    // campo, y al guardar **borraba el agua en silencio** — exactamente el
    // fallo que este archivo documenta en `moveEntryGroupRows`: un formulario
    // que no conoce un campo no puede destruirlo.
    group.water === undefined ? null : 'water',
  ].filter((piece): piece is string => piece !== null);
  if (pieces.length !== 1) return null;

  if (group.glucose !== undefined) {
    const reading = group.glucose;
    return {
      id: reading.id,
      kind: 'glucose',
      timestamp: reading.sourceTimestamp,
      title: 'Glucosa',
      detail: `${convertGlucose(reading.glucose, reading.unit, 'mg/dL')} mg/dL${glucoseOriginSuffix(reading.origin)}`,
      tone: reading.origin === 'synthetic'
        ? 'warning'
        : reading.origin === 'imported' || reading.origin === 'manual'
          ? 'muted'
          : 'teal',
      raw: reading,
    };
  }
  if (group.meal !== undefined) {
    const meal = group.meal;
    return {
      id: meal.id,
      kind: 'meal',
      timestamp: meal.timestamp,
      title: 'Comida registrada',
      detail: meal.confirmedCarbsG === undefined
        ? 'Sin carbohidratos confirmados'
        : `${meal.confirmedCarbsG} g confirmados`,
      tone: 'orange',
      raw: meal,
    };
  }
  if (group.carb !== undefined) {
    const carb = group.carb;
    return {
      id: carb.id,
      kind: 'carbs',
      timestamp: group.timestamp,
      title: 'Carbohidratos',
      detail: `${carb.carbsG} g`,
      tone: 'orange',
      raw: { carbsG: carb.carbsG, source: carb.source },
    };
  }
  const insulin = group.rapid ?? group.basal;
  if (insulin !== undefined) {
    return {
      id: insulin.id,
      kind: 'insulin',
      timestamp: insulin.timestamp,
      title: insulin.type === 'rapid' ? 'Insulina rápida' : 'Insulina basal',
      detail: `${insulin.units} U`,
      tone: insulin.type === 'rapid' ? 'blue' : 'navy',
      raw: insulin,
    };
  }
  if (group.note !== undefined) {
    return {
      id: group.note.id,
      kind: 'note',
      timestamp: group.note.timestamp,
      title: 'Nota',
      detail: group.note.text,
      tone: 'navy',
      raw: group.note,
    };
  }
  if (group.vitals !== undefined) {
    // `entry_group_id: null` a propósito: `standaloneVitalsItems` descarta las
    // agrupadas porque su tarjeta la dibuja el grupo, y acá se está pidiendo
    // exactamente lo contrario — el grupo tiene una sola pieza y hay que
    // dibujarla con su tipo nativo. Lo que se reusa es el mapeo fila → ítem
    // (título, banda de cetonas escrita, tono), que es donde estaba el hueco
    // y por eso vive con test en su propio módulo.
    void entryGroupId;
    const [item] = standaloneVitalsItems([{ payload: JSON.stringify(group.vitals), entry_group_id: null }]);
    return item ?? null;
  }
  return null;
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
  await serializedTransaction(db, async () => {
    for (const entry of entries) {
      const row = await db.getFirstAsync<FoodCatalogRow>('SELECT * FROM food_catalog WHERE key = ?', entry.key);

      if (row === null) {
        // Las columnas de porción van acá **y no solo en el UPDATE**: hasta
        // ahora el alta las omitía, así que un alimento nuevo perdía su
        // porción en el primer guardado y solo la recuperaba si volvía a
        // aparecer. No se notaba porque la IA todavía no proponía porción.
        await db.runAsync(
          `INSERT INTO food_catalog
             (key, name, carbs_per_100g, protein_per_100g, fat_per_100g, fiber_per_100g, kcal_per_100g, times_seen, last_seen_at, serving_grams, serving_label, serving_source, image_uri, listed)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
          entry.key, entry.name,
          entry.carbsPer100g, entry.proteinPer100g, entry.fatPer100g, entry.fiberPer100g, entry.kcalPer100g,
          entry.lastSeenAt,
          entry.servingGrams ?? null, entry.servingLabel ?? null, entry.servingSource ?? null,
          entry.imageUri ?? null,
          entry.listed === false ? 0 : 1,
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
           serving_grams = ?, serving_label = ?, serving_source = ?, image_uri = ?, listed = ?
         WHERE key = ?`,
        merged.name, merged.carbsPer100g, merged.proteinPer100g, merged.fatPer100g,
        merged.fiberPer100g, merged.kcalPer100g, merged.timesSeen, merged.lastSeenAt,
        merged.servingGrams ?? null, merged.servingLabel ?? null, merged.servingSource ?? null,
        // `blendCatalogEntry` conserva la foto anterior cuando la nueva no
        // trae una, así que escribir el resultado nunca la borra.
        merged.imageUri ?? null,
        // Y hace OR con la visibilidad: uno a la vista no se esconde.
        merged.listed === false ? 0 : 1,
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
       fiber_per_100g = ?, kcal_per_100g = ?, serving_grams = ?, serving_label = ?,
       serving_source = ?, image_uri = ?
     WHERE key = ?`,
    next.name, next.carbsPer100g, next.proteinPer100g, next.fatPer100g,
    next.fiberPer100g, next.kcalPer100g,
    next.servingGrams ?? null, next.servingLabel ?? null, next.servingSource ?? null,
    next.imageUri ?? null,
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
       (key, name, carbs_per_100g, protein_per_100g, fat_per_100g, fiber_per_100g, kcal_per_100g, times_seen, last_seen_at, serving_grams, serving_label, serving_source, image_uri)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    key, created.name,
    created.carbsPer100g, created.proteinPer100g, created.fatPer100g,
    created.fiberPer100g, created.kcalPer100g, created.lastSeenAt,
    created.servingGrams ?? null, created.servingLabel ?? null, created.servingSource ?? null,
    created.imageUri ?? null,
  );
  return created;
}

/**
 * Error de borrado bloqueado. Lleva las recetas afectadas para que la pantalla
 * pueda ofrecer resolverlas en vez de dejar un callejón sin salida.
 */
export class FoodInUseByRecipesError extends Error {
  constructor(public readonly recipes: Recipe[]) {
    super(
      recipes.length === 1
        ? `No se puede borrar: lo usa la receta "${recipes[0]!.name}".`
        : `No se puede borrar: lo usan ${recipes.length} recetas.`,
    );
    this.name = 'FoodInUseByRecipesError';
  }
}

/**
 * Borra un alimento del catálogo, **salvo que alguna receta lo use**.
 *
 * El bloqueo es la decisión de producto (Verónica, 2026-09-01) y las dos
 * alternativas se descartaron por lo que le hacen a un dato que nadie estaba
 * editando: la cascada cambia recetas a espaldas de la usuaria, y congelar los
 * totales deja una receta con componentes inexistentes y una suma que ya no se
 * puede verificar contra nada.
 *
 * No es un callejón: quien reciba este error abre la pantalla de ayuda y
 * resuelve receta por receta (`applyRecipeFixPlan` + `resolveRecipesAndDeleteFood`).
 */
export async function deleteCatalogFood(db: SQLiteDatabase, key: string): Promise<void> {
  const blocking = recipesUsingFood(key, await getRecipes(db));
  if (blocking.length > 0) throw new FoodInUseByRecipesError(blocking);
  await db.runAsync('DELETE FROM food_catalog WHERE key = ?', key);
}

interface RecipeRow {
  id: string; key: string; name: string;
  image_uri: string | null; times_seen: number;
  created_at: string; last_seen_at: string;
}

/**
 * Todas las recetas con sus componentes.
 *
 * Se leen enteras en dos consultas y se arman en memoria: el catálogo de una
 * persona son decenas de filas, no miles, y una consulta por receta sería N+1
 * para nada.
 */
export async function getRecipes(db: SQLiteDatabase): Promise<Recipe[]> {
  const rows = await db.getAllAsync<RecipeRow>(
    'SELECT * FROM recipes ORDER BY times_seen DESC, last_seen_at DESC',
  );
  if (rows.length === 0) return [];
  const items = await db.getAllAsync<{ recipe_id: string; food_key: string; grams: number }>(
    'SELECT recipe_id, food_key, grams FROM recipe_items',
  );
  const byRecipe = new Map<string, RecipeItem[]>();
  for (const item of items) {
    const list = byRecipe.get(item.recipe_id) ?? [];
    list.push({ foodKey: item.food_key, grams: item.grams });
    byRecipe.set(item.recipe_id, list);
  }
  return rows.map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    items: byRecipe.get(row.id) ?? [],
    timesSeen: row.times_seen,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    ...(row.image_uri === null ? {} : { imageUri: row.image_uri }),
  }));
}

/**
 * Crea una receta, o **suma una vista** a la que ya existe con esa clave.
 *
 * Volver a fotografiar el mismo plato no crea un duplicado ni reescribe su
 * composición: la composición es de la usuaria desde que la confirmó, igual
 * que la porción de un alimento. Solo se actualizan `times_seen`,
 * `last_seen_at` y —si no tenía— la foto.
 */
export async function saveRecipe(
  db: SQLiteDatabase,
  input: { name: string; items: RecipeItem[]; imageUri?: string | undefined; seenAt: string },
): Promise<string> {
  const key = foodKey(input.name);
  if (key === '') throw new Error('La receta necesita un nombre.');
  if (input.items.length === 0) throw new Error('Una receta necesita al menos un alimento.');
  for (const item of input.items) {
    if (!isValidRecipeItemGrams(item.grams)) {
      throw new Error(`Los gramos de un componente deben estar entre ${MIN_RECIPE_ITEM_GRAMS} y ${MAX_RECIPE_ITEM_GRAMS} g.`);
    }
  }

  let recipeId = '';
  await serializedTransaction(db, async () => {
    const existing = await db.getFirstAsync<{ id: string; image_uri: string | null }>(
      'SELECT id, image_uri FROM recipes WHERE key = ?', key,
    );
    if (existing !== null) {
      recipeId = existing.id;
      await db.runAsync(
        'UPDATE recipes SET times_seen = times_seen + 1, last_seen_at = ?, image_uri = ? WHERE id = ?',
        input.seenAt, existing.image_uri ?? input.imageUri ?? null, existing.id,
      );
      return;
    }
    recipeId = Crypto.randomUUID();
    await db.runAsync(
      'INSERT INTO recipes (id, key, name, image_uri, times_seen, created_at, last_seen_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
      recipeId, key, input.name.trim(), input.imageUri ?? null, input.seenAt, input.seenAt,
    );
    for (const item of input.items) {
      await db.runAsync(
        'INSERT OR REPLACE INTO recipe_items (recipe_id, food_key, grams) VALUES (?, ?, ?)',
        recipeId, item.foodKey, item.grams,
      );
    }
  });
  return recipeId;
}

/** Reescribe la composición de una receta. Vacía no se acepta: ver `isEmptyRecipe`. */
export async function updateRecipeItems(
  db: SQLiteDatabase,
  recipeId: string,
  items: readonly RecipeItem[],
): Promise<void> {
  if (items.length === 0) throw new Error('Una receta sin alimentos no se puede guardar. Bórrala en su lugar.');
  await serializedTransaction(db, async () => {
    await db.runAsync('DELETE FROM recipe_items WHERE recipe_id = ?', recipeId);
    for (const item of items) {
      await db.runAsync(
        'INSERT OR REPLACE INTO recipe_items (recipe_id, food_key, grams) VALUES (?, ?, ?)',
        recipeId, item.foodKey, item.grams,
      );
    }
  });
}

/**
 * Muestra u oculta un alimento como suelto. Es la salida del "solo receta":
 * desde el detalle de la receta un componente oculto puede pasar a la grilla.
 */
export async function setCatalogFoodListed(db: SQLiteDatabase, key: string, listed: boolean): Promise<void> {
  await db.runAsync('UPDATE food_catalog SET listed = ? WHERE key = ?', listed ? 1 : 0, key);
}

/**
 * Renombra una receta y/o cambia su foto.
 *
 * Renombrar recalcula la clave —es lo que evita duplicados al volver a
 * fotografiar el plato— y se rechaza si otra receta ya la tiene: dos platos
 * con la misma clave se fusionarían en el próximo guardado sin que nadie lo
 * pidiera. `imageUri` en `null` quita la foto; ausente la deja.
 */
export async function updateRecipe(
  db: SQLiteDatabase,
  recipeId: string,
  patch: { name?: string | undefined; imageUri?: string | null | undefined },
): Promise<void> {
  await serializedTransaction(db, async () => {
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      const key = foodKey(name);
      if (key === '') throw new Error('La receta necesita un nombre.');
      const clash = await db.getFirstAsync<{ id: string }>('SELECT id FROM recipes WHERE key = ? AND id <> ?', key, recipeId);
      if (clash !== null) throw new Error('Ya tienes una receta con ese nombre.');
      await db.runAsync('UPDATE recipes SET name = ?, key = ? WHERE id = ?', name, key, recipeId);
    }
    if (patch.imageUri !== undefined) {
      await db.runAsync('UPDATE recipes SET image_uri = ? WHERE id = ?', patch.imageUri, recipeId);
    }
  });
}

/**
 * Borra una receta **y los componentes que solo existían para ella**.
 *
 * Un alimento guardado con "solo receta" (`listed = 0`) no está en la grilla,
 * así que nadie podría borrarlo después: quedaría una fila invisible e
 * inalcanzable. Se va con la última receta que lo usa. Los alimentos a la
 * vista no se tocan — son de ella, no de la receta.
 */
export async function deleteRecipe(db: SQLiteDatabase, recipeId: string): Promise<{ deletedFoodKeys: string[] }> {
  const deletedFoodKeys: string[] = [];
  await serializedTransaction(db, async () => {
    const orphans = await db.getAllAsync<{ key: string }>(
      `SELECT f.key FROM food_catalog f
        JOIN recipe_items ri ON ri.food_key = f.key AND ri.recipe_id = ?
       WHERE f.listed = 0
         AND NOT EXISTS (SELECT 1 FROM recipe_items o WHERE o.food_key = f.key AND o.recipe_id <> ?)`,
      recipeId, recipeId,
    );
    // `recipe_items` cae por la clave foránea con `ON DELETE CASCADE`; el
    // `DELETE` explícito cubre una base donde `foreign_keys` no estuviera activo.
    await db.runAsync('DELETE FROM recipe_items WHERE recipe_id = ?', recipeId);
    await db.runAsync('DELETE FROM recipes WHERE id = ?', recipeId);
    for (const orphan of orphans) {
      await db.runAsync('DELETE FROM food_catalog WHERE key = ?', orphan.key);
      deletedFoodKeys.push(orphan.key);
    }
  });
  return { deletedFoodKeys };
}

/** Actualiza la foto de una receta. `null` la quita. */
export async function updateRecipePhoto(
  db: SQLiteDatabase,
  recipeId: string,
  imageUri: string | null,
): Promise<void> {
  await db.runAsync('UPDATE recipes SET image_uri = ? WHERE id = ?', imageUri, recipeId);
}

/**
 * Aplica el plan de resolución y borra el alimento **si el plan lo permite**.
 *
 * Todo en una transacción: dejar recetas resueltas a medias y el alimento sin
 * borrar es un estado que nadie pidió. La decisión de qué es "permitido" vive
 * en `applyRecipeFixPlan`, pura y con test — acá solo se escribe.
 */
export async function resolveRecipesAndDeleteFood(
  db: SQLiteDatabase,
  foodKeyToDelete: string,
  plans: readonly RecipeFixPlan[],
): Promise<{ deleted: boolean }> {
  const outcome = applyRecipeFixPlan(foodKeyToDelete, await getRecipes(db), plans);
  await serializedTransaction(db, async () => {
    for (const updated of outcome.updated) {
      await db.runAsync('DELETE FROM recipe_items WHERE recipe_id = ?', updated.id);
      for (const item of updated.items) {
        await db.runAsync(
          'INSERT OR REPLACE INTO recipe_items (recipe_id, food_key, grams) VALUES (?, ?, ?)',
          updated.id, item.foodKey, item.grams,
        );
      }
    }
    for (const recipeId of outcome.deletedRecipeIds) {
      await db.runAsync('DELETE FROM recipe_items WHERE recipe_id = ?', recipeId);
      await db.runAsync('DELETE FROM recipes WHERE id = ?', recipeId);
    }
    if (outcome.canDeleteFood) {
      await db.runAsync('DELETE FROM food_catalog WHERE key = ?', foodKeyToDelete);
    }
  });
  return { deleted: outcome.canDeleteFood };
}

interface FoodCatalogRow {
  key: string; name: string; carbs_per_100g: number; protein_per_100g: number;
  fat_per_100g: number; fiber_per_100g: number; kcal_per_100g: number;
  times_seen: number; last_seen_at: string;
  serving_grams: number | null; serving_label: string | null;
  serving_source: string | null;
  image_uri: string | null;
  listed: number | null;
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
    // NULL = fila anterior a la columna = la escribió ella. Ver la migración.
    ...(row.serving_grams === null
      ? {}
      : { servingSource: row.serving_source === 'ai' ? ('ai' as const) : ('user' as const) }),
    // Una fila anterior a la columna llega con `undefined` y así se queda: no
    // se inventa una imagen para datos viejos, se muestra el fallback.
    ...(row.image_uri === null || row.image_uri === undefined ? {} : { imageUri: row.image_uri }),
    // Solo se materializa el `false`: una fila visible no lleva el campo, igual
    // que las anteriores a la columna. Ver `CatalogFood.listed`.
    ...(row.listed === 0 ? { listed: false } : {}),
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
  await serializedTransaction(db, async () => {
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
