/**
 * Dónde viven las fotos, y por qué no donde vivían.
 *
 * ## El bug que este archivo cierra
 *
 * Los cinco sitios que guardaban una foto llamaban a `saveAsync()` sin decirle
 * dónde escribir, y `expo-image-manipulator` sin destino escribe en el
 * **directorio de caché**. En la base quedaba solo la ruta.
 *
 * Android vacía la caché cuando necesita espacio, sin avisar y sin que la
 * usuaria haga nada. O sea que la foto de una comida podía desaparecer **sin
 * reinstalar la app**, dejando una fila que apunta a un archivo que ya no
 * existe. No era un problema del respaldo: era un problema de todos los días
 * que el respaldo solo hizo visible.
 *
 * Ahora toda foto se copia a `Paths.document`, que Android no toca.
 *
 * ## Por qué es un módulo y no cinco copias
 *
 * Porque ya nos pasó tres veces: una capacidad que vive en un solo camino
 * termina siendo una asimetría. El bloque de comprimir-y-guardar estaba escrito
 * seis veces y por eso el bug estaba en los seis.
 */

import { Directory, File, Paths } from 'expo-file-system';

/** Carpeta permanente. Fuera de la caché a propósito. */
export const PHOTO_DIR = 'type1a-fotos';

/** `true` si la ruta apunta al directorio que Android puede vaciar. */
export function isCachedPhoto(uri: string): boolean {
  return uri.startsWith(Paths.cache.uri);
}

/** `true` si la foto ya vive donde tiene que vivir. */
export function isPersistedPhoto(uri: string): boolean {
  return uri.includes(`/${PHOTO_DIR}/`);
}

function newPhotoName(): string {
  // Fecha + azar: dos fotos guardadas en el mismo milisegundo no se pisan.
  return `foto-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
}

/**
 * Copia una foto recién comprimida al almacenamiento permanente y devuelve su
 * ruta nueva.
 *
 * **Si algo falla devuelve la ruta original**, no lanza: una foto en la caché
 * es peor que una permanente, pero es infinitamente mejor que ninguna. Quien
 * llama guarda lo que reciba y la comida queda con su foto igual.
 */
export async function persistPhoto(uri: string): Promise<string> {
  if (isPersistedPhoto(uri)) return uri;
  try {
    const dir = new Directory(Paths.document, PHOTO_DIR);
    if (!dir.exists) dir.create({ intermediates: true });
    const source = new File(uri);
    if (!source.exists) return uri;
    const target = new File(dir, newPhotoName());
    source.copy(target);
    return target.uri;
  } catch {
    return uri;
  }
}

// ---------------------------------------------------------------------------
// Migración de lo que ya está en la caché
// ---------------------------------------------------------------------------

/**
 * Una foto vieja y a dónde la apunta la base.
 *
 * El tipo lo declara quien migra, no `photos.ts`: acá no se sabe nada de
 * SQLite, y así este módulo se puede probar sin base.
 */
export interface PhotoOwner {
  uri: string;
  /** Qué fila la reclama, para poder reescribirla. */
  kind: 'meal' | 'catalog' | 'recipe';
  id: string;
}

export interface PhotoMigrationStep {
  owner: PhotoOwner;
  /** La ruta nueva. Igual a la vieja si no se pudo mover. */
  uri: string;
  moved: boolean;
}

/**
 * Copia a permanente cada foto que siga en la caché.
 *
 * **Nunca borra el original ni la fila.** Una foto que ya no existe se reporta
 * como no movida y su fila queda como estaba: perder el archivo es malo, pero
 * borrar el registro de que esa comida tenía foto es peor.
 */
export async function migratePhotosToDocuments(owners: readonly PhotoOwner[]): Promise<PhotoMigrationStep[]> {
  const steps: PhotoMigrationStep[] = [];
  // Una misma foto puede estar reclamada por dos filas: se copia una vez.
  const done = new Map<string, string>();
  for (const owner of owners) {
    if (isPersistedPhoto(owner.uri)) continue;
    const cached = done.get(owner.uri);
    if (cached !== undefined) {
      steps.push({ owner, uri: cached, moved: cached !== owner.uri });
      continue;
    }
    const uri = await persistPhoto(owner.uri);
    done.set(owner.uri, uri);
    steps.push({ owner, uri, moved: uri !== owner.uri });
  }
  return steps;
}
