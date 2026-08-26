import { summarizeVitals } from '@type1a/domain';
import { VitalsEventSchema } from '@type1a/schemas';

import { safeJsonParse } from './rowDecode';

import type { TimelineItem } from './types';

/**
 * Las cetonas sueltas, las que se registran desde el acceso rápido.
 *
 * ## Por qué existe este archivo
 *
 * Hasta el 2026-08-26 **no se mostraban en ninguna parte**. `getTimeline`
 * consultaba `vitals_events WHERE entry_group_id IS NOT NULL` y no tenía rama
 * para las que no pertenecen a una entrada empaquetada, así que una medición
 * hecha desde su propio acceso rápido se guardaba bien y desaparecía.
 *
 * Es el dato de triage de cetoacidosis. Registrarlo y que no se vea es peor
 * que no ofrecer el registro: ella hace el gesto de anotarlo, la app lo acepta,
 * y después no está — ni en el timeline, ni cuando quiere mostrárselo a su
 * equipo clínico.
 *
 * ## Por qué es un módulo aparte
 *
 * `db.ts` arrastra `expo-sqlite`, así que nada de lo que vive ahí se puede
 * verificar sin teléfono. El mapeo fila → ítem es puro, y es justamente donde
 * estaba el hueco, así que va acá con test — mismo criterio que `rowDecode.ts`,
 * `swipeOrder.ts` y `mealFields.ts`.
 */

/** La forma en que `getTimeline` lee la tabla. */
export interface VitalsRow {
  payload: string;
  entry_group_id: string | null;
}

/**
 * Ítems de timeline para las filas de vitales **sin grupo**.
 *
 * Las que sí tienen grupo se omiten a propósito: ya se muestran dentro de su
 * entrada empaquetada, y emitirlas otra vez las duplicaría en la lista.
 *
 * Una fila que no decodifica se descarta en silencio en vez de tumbar el
 * timeline entero, igual que el resto de `getTimeline`. El conteo de ilegibles
 * lo lleva `DecodeTally` en las consultas que lo declaran.
 */
export function standaloneVitalsItems(rows: readonly VitalsRow[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const row of rows) {
    if (row.entry_group_id !== null) continue;
    const parsed = VitalsEventSchema.safeParse(safeJsonParse(row.payload));
    if (!parsed.success) continue;
    const summary = summarizeVitals(parsed.data);
    items.push({
      id: parsed.data.id,
      kind: 'vitals',
      timestamp: parsed.data.timestamp,
      title: summary.title,
      detail: summary.detail,
      // El tono acompaña; la banda va escrita en `detail`. Ver
      // `summarizeVitals` y `contracts/ux-checklist.md`.
      tone: summary.urgent ? 'red' : 'navy',
      raw: parsed.data,
    });
  }
  return items;
}
