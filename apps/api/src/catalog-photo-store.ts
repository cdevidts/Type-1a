import type { Pool } from 'pg';

/**
 * Fotos del catálogo de alimentos. Una foto de un plato NO es un dato de
 * salud (no dice qué comió nadie ni cuándo), así que puede vivir en el
 * servidor — con o sin dueño, igual que las filas de `food_catalog`:
 * `owner_user_id IS NULL` = foto de la comunidad; `owner_user_id = <id>` =
 * foto personal de esa usuaria.
 *
 * Reusa el mismo Pool y el mismo patrón de auto-provisión que el resto del
 * backend.
 */

/** UUID cero: el valor con el que se colapsa `owner_user_id NULL` en el índice
 * único, ya que Postgres no permite un índice único directo sobre una columna
 * anulable donde NULL cuente como un valor. */
const NIL_OWNER = '00000000-0000-0000-0000-000000000000';

/** Tipos MIME permitidos para una foto. */
export const ALLOWED_PHOTO_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type PhotoMimeType = (typeof ALLOWED_PHOTO_MIME_TYPES)[number];

/** Tope de tamaño de una foto: 400 KB. La app comprime a JPEG calidad 0.72
 * antes de subir, así que 400 KB sobra; el tope solo evita que la base se
 * llene. Se supera → 413. */
export const MAX_PHOTO_BYTES = 400 * 1024;

export interface StoredPhoto {
  bytes: Buffer;
  mimeType: string;
}

export class PostgresCatalogPhotoStore {
  public constructor(private readonly pool: Pool) {}

  public async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS catalog_photos (
        owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        food_key TEXT NOT NULL,
        bytes BYTEA NOT NULL,
        mime_type TEXT NOT NULL DEFAULT 'image/jpeg',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // Clave compuesta sobre (dueño-o-cero, food_key) vía índice único, porque
    // Postgres no admite PRIMARY KEY sobre una expresión.
    await this.pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS catalog_photos_owner_key_uniq
        ON catalog_photos (coalesce(owner_user_id, '${NIL_OWNER}'::uuid), food_key);
    `);
  }

  /**
   * Devuelve la foto de `ownerId` (o la de la comunidad si `ownerId` es null)
   * para `foodKey`, o `null` si no hay. Con dueño busca EXACTAMENTE la fila de
   * esa usuaria, no cae a la de la comunidad.
   */
  public async get(ownerId: string | null, foodKey: string): Promise<StoredPhoto | null> {
    const result = await this.pool.query<{ bytes: Buffer; mime_type: string }>(
      `SELECT bytes, mime_type FROM catalog_photos
        WHERE coalesce(owner_user_id, '${NIL_OWNER}'::uuid) = coalesce($1::uuid, '${NIL_OWNER}'::uuid)
          AND food_key = $2`,
      [ownerId, foodKey],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    return { bytes: row.bytes, mimeType: row.mime_type };
  }

  /** Inserta o reemplaza la foto personal (upsert sobre la clave compuesta). */
  public async upsert(ownerId: string, foodKey: string, bytes: Buffer, mimeType: PhotoMimeType): Promise<void> {
    await this.pool.query(
      `INSERT INTO catalog_photos (owner_user_id, food_key, bytes, mime_type, updated_at)
         VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (coalesce(owner_user_id, '${NIL_OWNER}'::uuid), food_key) DO UPDATE SET
         bytes = EXCLUDED.bytes,
         mime_type = EXCLUDED.mime_type,
         updated_at = now()`,
      [ownerId, foodKey, bytes, mimeType],
    );
  }

  /** Borra la foto personal de esa usuaria. Idempotente. */
  public async delete(ownerId: string, foodKey: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM catalog_photos WHERE owner_user_id = $1 AND food_key = $2',
      [ownerId, foodKey],
    );
  }
}
