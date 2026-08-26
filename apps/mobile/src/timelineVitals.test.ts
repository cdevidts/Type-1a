import { describe, expect, it } from 'vitest';

import { standaloneVitalsItems, type VitalsRow } from './timelineVitals';

const evento = (extra: Record<string, unknown> = {}) => JSON.stringify({
  id: 'v1',
  timestamp: '2026-08-26T10:00:00.000Z',
  source: 'manual',
  createdAt: '2026-08-26T10:00:00.000Z',
  ketonesMmolL: 2,
  ...extra,
});

const fila = (entry_group_id: string | null, payload = evento()): VitalsRow => ({ payload, entry_group_id });

/**
 * El Pecado Capital 3, en su forma exacta: una medición de cetonas hecha desde
 * el acceso rápido no tiene `entry_group_id`, y hasta el 2026-08-26 no
 * aparecía en ninguna parte. Es el dato de triage de cetoacidosis.
 */
describe('standaloneVitalsItems', () => {
  it('una fila de cetonas SIN grupo sí produce un ítem de timeline', () => {
    const items = standaloneVitalsItems([fila(null)]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'v1',
      kind: 'vitals',
      timestamp: '2026-08-26T10:00:00.000Z',
      title: 'Cetonas',
    });
  });

  it('una fila CON grupo no se emite: ya se ve dentro de su entrada', () => {
    // Emitirla acá la duplicaría en la lista.
    expect(standaloneVitalsItems([fila('grupo-1')])).toHaveLength(0);
  });

  it('separa las sueltas de las agrupadas en un mismo lote', () => {
    const items = standaloneVitalsItems([fila(null), fila('grupo-1'), fila(null, evento({ id: 'v2' }))]);
    expect(items.map((item) => item.id)).toEqual(['v1', 'v2']);
  });

  it('la banda urgente se marca en el tono Y se escribe en el detalle', () => {
    const [urgente] = standaloneVitalsItems([fila(null, evento({ ketonesMmolL: 3.2 }))]);
    expect(urgente?.tone).toBe('red');
    expect(urgente?.detail.toLowerCase()).toContain('cetoacidosis');

    const [normal] = standaloneVitalsItems([fila(null, evento({ ketonesMmolL: 0.2 }))]);
    expect(normal?.tone).toBe('navy');
    expect(normal?.detail.toLowerCase()).toContain('normales');
  });

  it('un peso suelto también se ve, no solo las cetonas', () => {
    const items = standaloneVitalsItems([fila(null, JSON.stringify({
      id: 'v3',
      timestamp: '2026-08-26T10:00:00.000Z',
      source: 'manual',
      createdAt: '2026-08-26T10:00:00.000Z',
      weightKg: 62,
    }))]);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe('Peso');
  });

  /**
   * El hallazgo de la revisión de seguridad: la primera versión quitaba el
   * `WHERE` a secas y ponía a competir agrupadas y sueltas por los mismos 80
   * cupos. Con 80 filas sueltas más nuevas —una importación de MySugr escribe
   * una por día— la agrupada se caía de la ventana, la entrada se dibujaba sin
   * sus cetonas y editarla las borraba de la base.
   *
   * `getTimeline` ahora usa dos consultas con su propio `LIMIT`. Este test fija
   * la mitad verificable sin SQLite: por muchas sueltas que haya, ninguna
   * agrupada se cuela ni desplaza a otra.
   */
  it('un lote lleno de sueltas no arrastra ninguna agrupada', () => {
    const muchas = Array.from({ length: 100 }, (_, i) => fila(null, evento({ id: `v${i}` })));
    const items = standaloneVitalsItems([...muchas, fila('grupo-1')]);
    expect(items).toHaveLength(100);
    expect(items.every((item) => item.kind === 'vitals')).toBe(true);
  });

  it('una fila ilegible se descarta sin tumbar el resto del timeline', () => {
    const items = standaloneVitalsItems([fila(null, '{no es json'), fila(null), fila(null, '{"id":"x"}')]);
    expect(items.map((item) => item.id)).toEqual(['v1']);
  });
});
