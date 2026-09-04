/**
 * El archivo de respaldo `.t1a.json` — el reemplazo de la sincronización.
 *
 * ADR 0007 decidió que ningún dato de salud sale del teléfono hacia una base
 * nuestra. Lo que la sincronización iba a resolver —cambiar de teléfono sin
 * perder años de registros— lo resuelve un archivo que la usuaria controla, y
 * por eso este formato tiene que cumplir tres cosas que un PDF o un Excel
 * bonito no cumplen:
 *
 * 1. **Completo.** Todo lo que ella registró vuelve a entrar.
 * 2. **Sin pérdida.** Exportar e importar deja la app exactamente igual.
 * 3. **Sin duplicar.** Importar el mismo archivo dos veces no crea nada nuevo.
 *
 * La tercera es la que más cuesta y la que más importa: alguien va a importar
 * dos veces por las dudas, y una app que responde duplicando cada comida del
 * año pasado es peor que una que no importa nada.
 *
 * Este módulo es puro y determinístico: no toca SQLite, no lee reloj (la fecha
 * de exportación entra como parámetro) y no genera ids. Escribir a la base es
 * trabajo de `apps/mobile/src/db.ts`, que consume el plan que se arma acá.
 */

import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BackupFileSchema,
  type BackupData,
  type BackupFile,
} from '@type1a/schemas';

// ---------------------------------------------------------------------------
// JSON canónico
// ---------------------------------------------------------------------------

/**
 * JSON con las claves de cada objeto en orden alfabético y sin las ausentes.
 *
 * Hace falta para que la huella sea reproducible: dos exportaciones de los
 * mismos datos tienen que dar el mismo texto, y el orden en que
 * `JSON.stringify` recorre un objeto depende de en qué orden se le pusieron
 * las claves, que en esta app depende de qué rama del código lo armó.
 *
 * `undefined` desaparece —igual que en `JSON.stringify`—; `null` se conserva,
 * porque acá sí significa algo ("no hay perfil de terapia").
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  if (value === undefined) return 'null';
  return JSON.stringify(value) ?? 'null';
}

/**
 * Huella de integridad del bloque de datos.
 *
 * **Detecta corrupción, no manipulación.** No hay secreto: cualquiera puede
 * recalcularla, y esa es justamente la idea —otra app tiene que poder escribir
 * un archivo que esta lea—. Lo que ataja es un archivo truncado por un
 * traspaso a medias, que es el accidente real.
 *
 * Algoritmo, para quien lo tenga que reimplementar: FNV-1a de 32 bits sobre
 * las **unidades de código UTF-16** del JSON canónico, corrido dos veces con
 * bases distintas (`0x811c9dc5` y `0x01000193`), y las dos salidas
 * concatenadas en hexadecimal de 8 dígitos cada una. 16 caracteres en total.
 */
export function backupChecksum(data: unknown): string {
  const text = canonicalJson(data);
  const run = (seed: number): string => {
    let hash = seed;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    // `>>> 0` lo devuelve a entero sin signo: `Math.imul` entrega con signo.
    return (hash >>> 0).toString(16).padStart(8, '0');
  };
  return `${run(0x811c9dc5)}${run(0x01000193)}`;
}

// ---------------------------------------------------------------------------
// Exportar
// ---------------------------------------------------------------------------

export interface BuildBackupInput {
  data: BackupData;
  /** Cuándo se exportó. Entra como parámetro para que la función sea pura. */
  exportedAt: string;
  appVersion?: string;
  timeZone?: string;
}

export function buildBackup(input: BuildBackupInput): BackupFile {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    exportedAt: input.exportedAt,
    ...(input.appVersion === undefined ? {} : { appVersion: input.appVersion }),
    ...(input.timeZone === undefined ? {} : { timeZone: input.timeZone }),
    checksum: backupChecksum(input.data),
    data: input.data,
  };
}

/**
 * El texto que se escribe al archivo.
 *
 * Sin indentación a propósito: "un formato liviano" era el pedido, y un
 * respaldo de un año con indentación pesa cerca del doble sin decir nada más.
 * Quien lo quiera leer a ojo lo pasa por cualquier formateador.
 */
export function serializeBackup(file: BackupFile): string {
  return canonicalJson(file);
}

// ---------------------------------------------------------------------------
// Importar
// ---------------------------------------------------------------------------

export type BackupParseError =
  | { kind: 'not_json'; message: string }
  | { kind: 'not_a_backup'; message: string }
  | { kind: 'unsupported_version'; found: number; supported: number }
  | { kind: 'checksum_mismatch'; expected: string; found: string }
  | { kind: 'invalid'; message: string };

export type BackupParseResult =
  | { ok: true; file: BackupFile; checksumOk: boolean }
  | { ok: false; error: BackupParseError };

export interface ParseBackupOptions {
  /**
   * Con `false`, una huella que no cuadra deja pasar el archivo y se avisa por
   * `checksumOk`. Existe para que la usuaria pueda rescatar lo que quede de un
   * archivo dañado si decide asumir el riesgo — no para saltarse el chequeo
   * por costumbre. El default es rechazar.
   */
  requireChecksum?: boolean;
}

/**
 * Lee un archivo de respaldo. **Nunca lanza**: todo error sale como valor, que
 * es lo que una pantalla necesita para explicar qué pasó.
 */
export function parseBackup(text: string, options: ParseBackupOptions = {}): BackupParseResult {
  const requireChecksum = options.requireChecksum ?? true;

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    return { ok: false, error: { kind: 'not_json', message: (error as Error).message } };
  }

  // Se mira el sobre antes que el contenido: si el archivo es de otra app o de
  // una versión futura, el mensaje útil es ese, no cuarenta errores de campos.
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: { kind: 'not_a_backup', message: 'El archivo no es un objeto.' } };
  }
  const envelope = raw as Record<string, unknown>;
  if (envelope['format'] !== BACKUP_FORMAT) {
    return {
      ok: false,
      error: { kind: 'not_a_backup', message: 'El archivo no es un respaldo de Type 1A.' },
    };
  }
  const version = envelope['formatVersion'];
  if (typeof version !== 'number' || version > BACKUP_FORMAT_VERSION) {
    return {
      ok: false,
      error: {
        kind: 'unsupported_version',
        found: typeof version === 'number' ? version : -1,
        supported: BACKUP_FORMAT_VERSION,
      },
    };
  }

  const parsed = BackupFileSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined ? '' : ` (${first.path.join('.')}: ${first.message})`;
    return { ok: false, error: { kind: 'invalid', message: `El archivo está incompleto o dañado${where}.` } };
  }

  // La huella se verifica contra el bloque **crudo**, tal como venía en el
  // archivo, y no contra `parsed.data.data`: Zod rellena las secciones
  // ausentes con `[]`, así que comparar después haría fallar exactamente a los
  // archivos viejos que las secciones con `.default()` existen para admitir.
  // Lo que la huella protege son los bytes que alguien escribió.
  const expected = backupChecksum(envelope['data']);
  const checksumOk = expected === parsed.data.checksum;
  if (!checksumOk && requireChecksum) {
    return {
      ok: false,
      error: { kind: 'checksum_mismatch', expected, found: parsed.data.checksum },
    };
  }

  return { ok: true, file: parsed.data, checksumOk };
}

// ---------------------------------------------------------------------------
// Plan de importación
// ---------------------------------------------------------------------------

/**
 * Lo que la app ya tiene. Solo identidades: el plan no necesita el contenido y
 * cargar quince tablas enteras en memoria para importar sería absurdo.
 *
 * Los eventos se identifican por `id`; el catálogo y las recetas por `key`,
 * que es la clave normalizada con la que la app ya evita duplicados.
 */
export interface ExistingBackupIds {
  eventIds: ReadonlySet<string>;
  foodKeys: ReadonlySet<string>;
  recipeKeys: ReadonlySet<string>;
  episodeIds: ReadonlySet<string>;
  hasTherapyProfile: boolean;
  hasNutritionProfile: boolean;
}

export interface BackupSectionPlan {
  /** Cuántos vienen en el archivo, ya descontados los repetidos internos. */
  incoming: number;
  /** Cuántos se van a escribir. */
  toInsert: number;
  /** Cuántos ya estaban y se dejan como están. */
  alreadyPresent: number;
}

export interface BackupImportPlan {
  /** Los datos ya filtrados, listos para escribir tal cual. */
  data: BackupData;
  sections: Record<keyof BackupData, BackupSectionPlan>;
  /** Total de registros a escribir, para la barra de progreso. */
  totalToInsert: number;
  /** `true` si no queda nada por escribir: el archivo ya estaba importado. */
  nothingToDo: boolean;
}

const emptySection = (): BackupSectionPlan => ({ incoming: 0, toInsert: 0, alreadyPresent: 0 });

/**
 * Filtra por identidad, dentro del archivo y contra lo que ya existe.
 *
 * Dos filtros y no uno: un archivo puede traer el mismo id dos veces (un
 * exportador ajeno mal hecho), y eso rompería la promesa de "importar dos
 * veces no duplica" incluso importando una sola vez.
 */
function planRows<T>(
  rows: readonly T[],
  identity: (row: T) => string,
  existing: ReadonlySet<string>,
): { kept: T[]; plan: BackupSectionPlan } {
  const seen = new Set<string>();
  const kept: T[] = [];
  let alreadyPresent = 0;
  let incoming = 0;
  for (const row of rows) {
    const id = identity(row);
    if (seen.has(id)) continue; // repetido dentro del propio archivo
    seen.add(id);
    incoming += 1;
    if (existing.has(id)) {
      alreadyPresent += 1;
      continue;
    }
    kept.push(row);
  }
  return { kept, plan: { incoming, toInsert: kept.length, alreadyPresent } };
}

/**
 * Qué se escribiría al importar este archivo, sin escribir nada.
 *
 * **Lo que ya existe nunca se pisa.** Un respaldo es más viejo que el teléfono
 * en el que entra, así que si un id ya está, el que manda es el que la usuaria
 * tiene ahora. La única forma de que el archivo gane sería que el respaldo
 * supiera algo que la app no sabe, y no es el caso: no hay servidor que arbitre
 * ni marca de tiempo de edición que comparar.
 */
export function planBackupImport(file: BackupFile, existing: ExistingBackupIds): BackupImportPlan {
  const d = file.data;
  const byId = <T extends { id: string }>(rows: readonly T[]) =>
    planRows(rows, (row) => row.id, existing.eventIds);

  const glucose = byId(d.glucose);
  const insulin = byId(d.insulin);
  const carbs = byId(d.carbs);
  const meals = byId(d.meals);
  const activity = byId(d.activity);
  const water = byId(d.water);
  const notes = byId(d.notes);
  const vitals = byId(d.vitals);
  const hba1c = byId(d.hba1c);
  const foodCatalog = planRows(d.foodCatalog, (row) => row.key, existing.foodKeys);
  const recipes = planRows(d.recipes, (row) => row.key, existing.recipeKeys);
  const mealEpisodes = planRows(d.mealEpisodes, (row) => row.id, existing.episodeIds);

  // Los perfiles son uno solo, no una lista: si ya hay uno configurado no se
  // reemplaza. Sobrescribir el factor de corrección de alguien desde un
  // archivo viejo es exactamente el error que `AGENTS.md` prohíbe.
  const therapyProfile = existing.hasTherapyProfile ? null : d.therapyProfile;
  const nutritionProfile = existing.hasNutritionProfile ? null : d.nutritionProfile;
  const profileSection = (incoming: unknown, kept: unknown): BackupSectionPlan => ({
    incoming: incoming === null ? 0 : 1,
    toInsert: kept === null ? 0 : 1,
    alreadyPresent: incoming !== null && kept === null ? 1 : 0,
  });

  const sections: Record<keyof BackupData, BackupSectionPlan> = {
    therapyProfile: profileSection(d.therapyProfile, therapyProfile),
    nutritionProfile: profileSection(d.nutritionProfile, nutritionProfile),
    // Los ajustes no se cuentan como registros: son preferencias, no historia,
    // y nunca pisan las del teléfono que recibe.
    settings: emptySection(),
    glucose: glucose.plan,
    insulin: insulin.plan,
    carbs: carbs.plan,
    meals: meals.plan,
    activity: activity.plan,
    water: water.plan,
    notes: notes.plan,
    vitals: vitals.plan,
    hba1c: hba1c.plan,
    recipes: recipes.plan,
    foodCatalog: foodCatalog.plan,
    mealEpisodes: mealEpisodes.plan,
  };

  const totalToInsert = Object.values(sections).reduce((sum, s) => sum + s.toInsert, 0);

  return {
    data: {
      therapyProfile,
      nutritionProfile,
      settings: {},
      glucose: glucose.kept,
      insulin: insulin.kept,
      carbs: carbs.kept,
      meals: meals.kept,
      activity: activity.kept,
      water: water.kept,
      notes: notes.kept,
      vitals: vitals.kept,
      hba1c: hba1c.kept,
      recipes: recipes.kept,
      foodCatalog: foodCatalog.kept,
      mealEpisodes: mealEpisodes.kept,
    },
    sections,
    totalToInsert,
    nothingToDo: totalToInsert === 0,
  };
}

/** Cuántos registros lleva un respaldo. Para mostrarlo antes de exportar. */
export function countBackupRecords(data: BackupData): number {
  return (
    data.glucose.length
    + data.insulin.length
    + data.carbs.length
    + data.meals.length
    + data.activity.length
    + data.water.length
    + data.notes.length
    + data.vitals.length
    + data.hba1c.length
    + data.recipes.length
    + data.foodCatalog.length
    + data.mealEpisodes.length
  );
}
