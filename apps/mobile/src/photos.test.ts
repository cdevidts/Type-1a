import { describe, expect, it, vi } from 'vitest';

// El mock respeta la firma real: `new File(padre, nombre)` COMPONE la ruta.
// La primera versión lo ignoraba y guardaba el objeto padre como uri, así que
// el test falló por el mock y no por el código — pero un mock que no compone
// habría dejado pasar un `persistPhoto` que devuelve `[object Object]`.
const compose = (parent: unknown, name?: string): string => {
  const base = typeof parent === 'string' ? parent : (parent as { uri: string }).uri;
  return name === undefined ? base : `${base.replace(/\/$/u, '')}/${name}`;
};

vi.mock('expo-file-system', () => ({
  Paths: { document: { uri: 'file:///doc' }, cache: { uri: 'file:///cache' } },
  Directory: class {
    public readonly uri: string;
    public constructor(parent: unknown, name?: string) { this.uri = compose(parent, name); }
    public exists = true;
    public create(): void { /* no-op */ }
  },
  File: class {
    public readonly uri: string;
    public constructor(parent: unknown, name?: string) { this.uri = compose(parent, name); }
    public exists = true;
    public copy(): void { /* no-op */ }
  },
}));

const { isCachedPhoto, isPersistedPhoto, migratePhotosToDocuments, PHOTO_DIR } = await import('./photos');

describe('dónde vive una foto', () => {
  it('reconoce la caché, que es de donde hay que sacarlas', () => {
    expect(isCachedPhoto('file:///cache/ImagePicker/abc.jpg')).toBe(true);
    expect(isCachedPhoto('file:///doc/type1a-fotos/foto-1.jpg')).toBe(false);
  });

  it('reconoce una que ya está a salvo', () => {
    expect(isPersistedPhoto(`file:///doc/${PHOTO_DIR}/foto-1.jpg`)).toBe(true);
    expect(isPersistedPhoto('file:///cache/abc.jpg')).toBe(false);
  });
});

describe('migrar las que quedaron en la caché', () => {
  it('mueve una foto de la caché y devuelve a qué fila pertenece', async () => {
    const steps = await migratePhotosToDocuments([{ uri: 'file:///cache/a.jpg', kind: 'meal', id: 'm1' }]);
    expect(steps).toHaveLength(1);
    expect(steps[0]?.moved).toBe(true);
    expect(steps[0]?.uri).toContain(PHOTO_DIR);
    expect(steps[0]?.owner.id).toBe('m1');
  });

  it('no toca las que ya están a salvo: la migración es idempotente', async () => {
    const uri = `file:///doc/${PHOTO_DIR}/foto-1.jpg`;
    expect(await migratePhotosToDocuments([{ uri, kind: 'catalog', id: 'arroz' }])).toEqual([]);
  });

  it('una foto reclamada por dos filas se copia UNA vez, y las dos apuntan igual', async () => {
    // Pasa de verdad: un alimento del catálogo y la comida que lo usa pueden
    // compartir la foto del plato. Copiarla dos veces duplica cientos de kB.
    const steps = await migratePhotosToDocuments([
      { uri: 'file:///cache/a.jpg', kind: 'meal', id: 'm1' },
      { uri: 'file:///cache/a.jpg', kind: 'catalog', id: 'arroz' },
    ]);
    expect(steps).toHaveLength(2);
    expect(steps[0]?.uri).toBe(steps[1]?.uri);
  });

  it('sin fotos no hace nada', async () => {
    expect(await migratePhotosToDocuments([])).toEqual([]);
  });
});
