import { blendCatalogEntry, foodKey, isPlausibleCatalogEntry, type CatalogFood } from '@type1a/domain';
import type { SharedCatalogEntryInput } from '@type1a/schemas';
import type { Pool, QueryResult } from 'pg';

/**
 * Catálogo de alimentos COMPARTIDO entre usuarias (backend preparado
 * 2026-08-21, Fase futura del roadmap — ver `docs/adr/0003-shared-food-catalog.md`).
 *
 * Este archivo es la ÚNICA excepción al backend sin estado de
 * `docs/adr/0001-local-first.md`, y es deliberada: un alimento no lleva
 * dueño. Reusa las mismas funciones puras que ya gobiernan el catálogo LOCAL
 * de cada usuaria (`packages/domain/src/food-catalog.ts`) — `foodKey`,
 * `isPlausibleCatalogEntry`, `blendCatalogEntry` — así que "arroz" se agrupa
 * igual en el teléfono y en el servidor, y una corrección al algoritmo de
 * fusión no se puede hacer en un lado sin hacerla en el otro.
 */
export interface FoodCatalogStore {
  /**
   * `minTimesSeen` es el piso de moderación: un catálogo compartido acepta
   * escrituras de cualquier instalación, así que una estimación mala se
   * puede propagar. El peso ponderado de `blendCatalogEntry` ya amortigua
   * eso, pero un alimento visto una sola vez no debería servirse a nadie más
   * todavía — se sigue acumulando, solo no se muestra.
   */
  search(term: string, limit: number, minTimesSeen: number): Promise<CatalogFood[]>;
  /**
   * Devuelve cuántas entradas se aceptaron y cuántas se rechazaron por
   * implausibles, para que quien llama pueda decírselo a quien escribió.
   * Nunca lanza por una entrada mala — una fila implausible se descarta,
   * no tira abajo las demás de la misma subida.
   */
  upsertMany(entries: readonly SharedCatalogEntryInput[], seenAt: string): Promise<{ accepted: number; rejected: number }>;
}

interface FoodCatalogRow {
  key: string;
  name: string;
  carbs_per_100g: number;
  protein_per_100g: number;
  fat_per_100g: number;
  fiber_per_100g: number;
  kcal_per_100g: number;
  times_seen: number;
  last_seen_at: Date | string;
  serving_grams: number | null;
  serving_label: string | null;
}

function rowToCatalogFood(row: FoodCatalogRow): CatalogFood {
  return {
    key: row.key,
    name: row.name,
    carbsPer100g: Number(row.carbs_per_100g),
    proteinPer100g: Number(row.protein_per_100g),
    fatPer100g: Number(row.fat_per_100g),
    fiberPer100g: Number(row.fiber_per_100g),
    kcalPer100g: Number(row.kcal_per_100g),
    timesSeen: row.times_seen,
    lastSeenAt: new Date(row.last_seen_at).toISOString(),
    ...(row.serving_grams === null ? {} : { servingGrams: Number(row.serving_grams) }),
    ...(row.serving_label === null ? {} : { servingLabel: row.serving_label }),
  };
}

/**
 * Postgres real, sobre el Postgres que ya viene con la instancia de app de
 * Abacus (ver el ADR) — no hace falta contratar nada nuevo.
 *
 * ## Auto-provisión del esquema, a propósito
 *
 * `ensureSchema()` corre `CREATE TABLE IF NOT EXISTS` al levantar el
 * proceso, el mismo patrón que ya usa `apps/mobile/src/db.ts` con SQLite.
 * La razón es puramente de eficiencia de la corrida de DeepAgent: así su
 * trabajo se reduce a "fija DATABASE_URL y redespliega" — no tiene que
 * escribir SQL, ni verificar que una migración corrió, ni entender el
 * schema. El código ya lo sabe hacer solo.
 */
export class PostgresFoodCatalogStore implements FoodCatalogStore {
  public constructor(private readonly pool: Pool) {}

  public async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS food_catalog (
        key TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        carbs_per_100g DOUBLE PRECISION NOT NULL,
        protein_per_100g DOUBLE PRECISION NOT NULL,
        fat_per_100g DOUBLE PRECISION NOT NULL,
        fiber_per_100g DOUBLE PRECISION NOT NULL,
        kcal_per_100g DOUBLE PRECISION NOT NULL,
        times_seen INTEGER NOT NULL DEFAULT 1,
        last_seen_at TIMESTAMPTZ NOT NULL,
        serving_grams DOUBLE PRECISION,
        serving_label TEXT
      );
    `);
    // Postgres no tiene PRAGMA table_info; el equivalente para una columna
    // nueva más adelante es information_schema.columns + ALTER TABLE ADD
    // COLUMN IF NOT EXISTS. Mismo espíritu que la migración de
    // apps/mobile/src/db.ts para servingGrams/servingLabel (Fase 18): nunca
    // un CREATE que reescriba filas ya guardadas.
    await this.pool.query(`
      CREATE INDEX IF NOT EXISTS food_catalog_times_seen ON food_catalog (times_seen DESC, last_seen_at DESC);
    `);
  }

  public async search(term: string, limit: number, minTimesSeen: number): Promise<CatalogFood[]> {
    const normalized = foodKey(term);
    const result: QueryResult<FoodCatalogRow> = normalized === ''
      ? await this.pool.query(
          'SELECT * FROM food_catalog WHERE times_seen >= $1 ORDER BY times_seen DESC, last_seen_at DESC LIMIT $2',
          [minTimesSeen, limit],
        )
      : await this.pool.query(
          'SELECT * FROM food_catalog WHERE times_seen >= $1 AND key LIKE $2 ORDER BY times_seen DESC, last_seen_at DESC LIMIT $3',
          [minTimesSeen, `%${normalized.replace(/[\\%_]/gu, (match) => `\\${match}`)}%`, limit],
        );
    return result.rows.map(rowToCatalogFood);
  }

  public async upsertMany(
    entries: readonly SharedCatalogEntryInput[],
    seenAt: string,
  ): Promise<{ accepted: number; rejected: number }> {
    let accepted = 0;
    let rejected = 0;
    // Fila por fila, no en un solo INSERT masivo: cada una necesita leer su
    // propio estado previo para fusionar con `blendCatalogEntry`, igual que
    // `recordCatalogFoods` en apps/mobile/src/db.ts.
    for (const entry of entries) {
      const key = foodKey(entry.name);
      const candidate: Omit<CatalogFood, 'timesSeen'> = {
        key,
        name: entry.name.trim(),
        carbsPer100g: entry.carbsPer100g,
        proteinPer100g: entry.proteinPer100g,
        fatPer100g: entry.fatPer100g,
        fiberPer100g: entry.fiberPer100g,
        kcalPer100g: entry.kcalPer100g,
        lastSeenAt: seenAt,
        ...(entry.servingGrams === undefined ? {} : { servingGrams: entry.servingGrams }),
        ...(entry.servingLabel === undefined ? {} : { servingLabel: entry.servingLabel }),
      };
      if (key === '' || !isPlausibleCatalogEntry(candidate)) {
        rejected += 1;
        continue;
      }

      const existingResult: QueryResult<FoodCatalogRow> = await this.pool.query(
        'SELECT * FROM food_catalog WHERE key = $1',
        [key],
      );
      const existingRow = existingResult.rows[0];
      const merged: CatalogFood = existingRow === undefined
        ? { ...candidate, timesSeen: 1 }
        : blendCatalogEntry(rowToCatalogFood(existingRow), candidate);

      await this.pool.query(
        `INSERT INTO food_catalog
           (key, name, carbs_per_100g, protein_per_100g, fat_per_100g, fiber_per_100g, kcal_per_100g, times_seen, last_seen_at, serving_grams, serving_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (key) DO UPDATE SET
           name = EXCLUDED.name,
           carbs_per_100g = EXCLUDED.carbs_per_100g,
           protein_per_100g = EXCLUDED.protein_per_100g,
           fat_per_100g = EXCLUDED.fat_per_100g,
           fiber_per_100g = EXCLUDED.fiber_per_100g,
           kcal_per_100g = EXCLUDED.kcal_per_100g,
           times_seen = EXCLUDED.times_seen,
           last_seen_at = EXCLUDED.last_seen_at,
           serving_grams = EXCLUDED.serving_grams,
           serving_label = EXCLUDED.serving_label`,
        [
          merged.key, merged.name, merged.carbsPer100g, merged.proteinPer100g, merged.fatPer100g,
          merged.fiberPer100g, merged.kcalPer100g, merged.timesSeen, merged.lastSeenAt,
          merged.servingGrams ?? null, merged.servingLabel ?? null,
        ],
      );
      accepted += 1;
    }
    return { accepted, rejected };
  }
}
