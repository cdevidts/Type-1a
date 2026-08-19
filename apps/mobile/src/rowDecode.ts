/**
 * Decodificación tolerante de filas de SQLite, aparte de `db.ts` porque es
 * lógica pura: sin `expo-sqlite`, sin `expo-crypto`, y por lo tanto testeable
 * directamente (`db.ts` importa módulos nativos que no cargan en vitest).
 *
 * Cada `get*` de rango de `db.ts` valida con `Schema.safeParse(...)` para
 * tolerar una fila inválida, pero el `JSON.parse` que la alimentaba quedaba
 * **fuera** de esa red: una sola fila con el JSON corrupto (una importación
 * de MySugr interrumpida a media escritura, una fila de un esquema viejo)
 * lanzaba un `SyntaxError` que rechazaba la consulta **entera**. El efecto
 * era desproporcionado — 90 días de historial ilegibles por una fila mala, y
 * no solo en el Resumen: también en la exportación del reporte, que usa los
 * mismos getters. Ver `docs/ROADMAP_V0.2.md` § Fase 13, ítem 5.
 *
 * Descartar una fila ilegible no cruza ninguna frontera de `AGENTS.md`: no se
 * inventa ni se corrige un dato, se omite uno que no se puede leer. Lo que sí
 * sería inseguro es **descartarla en silencio** cuando el resultado alimenta
 * un agregado o una afirmación de completitud — de ahí `DecodeTally`.
 */

/**
 * Contador de filas descartadas por ilegibles.
 *
 * Un "Tiempo en rango: 82%" calculado sobre una muestra silenciosamente
 * recortada no es un dato omitido, es un número inventado; y un panel de
 * insulina reciente que dice "No hay eventos registrados" cuando en realidad
 * no pudo leer uno está afirmando algo falso justo encima de una calculadora
 * de dosis. Los getters que alimentan esas superficies aceptan un tally
 * opcional para que quien llama pueda avisarle a la usuaria.
 */
export interface DecodeTally {
  unreadable: number;
}

export function createDecodeTally(): DecodeTally {
  return { unreadable: 0 };
}

export function safeJsonParse(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    // `undefined` no valida contra ningún schema del repo, así que el
    // `safeParse` de quien llama descarta la fila por el camino normal.
    return undefined;
  }
}

/**
 * Devuelve `[valor]` si la fila se pudo decodificar y validar, o `[]` si no —
 * pensado para encadenar con `rows.flatMap(...)`. Suma al tally en el caso
 * de descarte.
 */
export function decodeRow<T>(
  payload: string,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T } },
  tally?: DecodeTally,
): T[] {
  const parsed = schema.safeParse(safeJsonParse(payload));
  if (parsed.success && parsed.data !== undefined) return [parsed.data];
  if (tally !== undefined) tally.unreadable += 1;
  return [];
}

/** Igual que `decodeRow`, para un valor ya decodificado (no un payload JSON). */
export function tallyParsed<T>(
  parsed: { success: boolean; data?: T },
  tally?: DecodeTally,
): T[] {
  if (parsed.success && parsed.data !== undefined) return [parsed.data];
  if (tally !== undefined) tally.unreadable += 1;
  return [];
}
