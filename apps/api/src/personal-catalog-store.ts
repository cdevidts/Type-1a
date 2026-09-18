import { foodKey, isPlausibleCatalogEntry, type CatalogFood } from '@type1a/domain';
import type { SharedCatalogEntryInput } from '@type1a/schemas';
import type { Pool, QueryResult } from 'pg';

import { rowToCatalogFood, type FoodCatalogRow } from './food-catalog-store.js';

/**
 * Catálogo PERSONAL de una usuaria: las mismas filas de `food_catalog` pero
 * con `owner_user_id = <id>`. Es lo que la app carga al iniciar sesión y lo
 * que respalda sus ediciones locales del catálogo (nombre + macros por 100 g +
 * porción). No es un dato de salud: no dice qué comió ni cuándo.
 *
 * Comparte la tabla, el Pool y el índice único `(dueño-o-cero, key)` que
 * define `PostgresFoodCatalogStore.ensureSchema()` — por eso NO provee esquema
 * propio: depende de que el catálogo de la comunidad ya lo haya hecho.
 */
export interface PersonalCatalogStore {
  listMine(ownerId: string): Promise<CatalogFood[]>;
  upsertMine(ownerId: string, entries: readonly SharedCatalogEntryInput[], seenAt: string): Promise<{ accepted: number; rejected: number }>;
  deleteMine(ownerId: string, key: string): Promise<boolean>;
}

export class PostgresPersonalCatalogStore implements PersonalCatalogStore {
  public constructor(private readonly pool: Pool) {}

  /** Todo el catálogo personal de esa usuaria, más reciente primero. */
  public async listMine(ownerId: string): Promise<CatalogFood[]> {
    const result: QueryResult<FoodCatalogRow> = await this.pool.query(
      'SELECT * FROM food_catalog WHERE owner_user_id = $1 ORDER BY times_seen DESC, last_seen_at DESC',
      [ownerId],
    );
    return result.rows.map(rowToCatalogFood);
  }

  /**
   * Inserta o actualiza un lote de alimentos personales. Idempotente por
   * `key`: reenviar el mismo lote no duplica filas (ON CONFLICT sobre el
   * índice único). A diferencia del catálogo de la comunidad, acá NO se
   * fusionan estimaciones ni se acumula `times_seen` de moderación: son datos
   * propios de la usuaria, así que la última escritura manda.
   */
  public async upsertMine(
    ownerId: string,
    entries: readonly SharedCatalogEntryInput[],
    seenAt: string,
  ): Promise<{ accepted: number; rejected: number }> {
    let accepted = 0;
    let rejected = 0;
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
      await this.pool.query(
        `INSERT INTO food_catalog
           (key, name, carbs_per_100g, protein_per_100g, fat_per_100g, fiber_per_100g, kcal_per_100g, times_seen, last_seen_at, serving_grams, serving_label, owner_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $10, $11)
         ON CONFLICT (coalesce(owner_user_id, '00000000-0000-0000-0000-000000000000'::uuid), key) DO UPDATE SET
           name = EXCLUDED.name,
           carbs_per_100g = EXCLUDED.carbs_per_100g,
           protein_per_100g = EXCLUDED.protein_per_100g,
           fat_per_100g = EXCLUDED.fat_per_100g,
           fiber_per_100g = EXCLUDED.fiber_per_100g,
           kcal_per_100g = EXCLUDED.kcal_per_100g,
           last_seen_at = EXCLUDED.last_seen_at,
           serving_grams = EXCLUDED.serving_grams,
           serving_label = EXCLUDED.serving_label`,
        [
          candidate.key, candidate.name, candidate.carbsPer100g, candidate.proteinPer100g,
          candidate.fatPer100g, candidate.fiberPer100g, candidate.kcalPer100g, candidate.lastSeenAt,
          candidate.servingGrams ?? null, candidate.servingLabel ?? null, ownerId,
        ],
      );
      accepted += 1;
    }
    return { accepted, rejected };
  }

  /** Borra un alimento del catálogo personal. Devuelve si existía. */
  public async deleteMine(ownerId: string, key: string): Promise<boolean> {
    const result = await this.pool.query(
      'DELETE FROM food_catalog WHERE owner_user_id = $1 AND key = $2',
      [ownerId, key],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
