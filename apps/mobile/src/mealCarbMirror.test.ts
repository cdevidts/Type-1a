import { describe, expect, it } from 'vitest';

import { partitionCarbRows, sumDayCarbs, type CarbRowForTimeline } from './mealCarbMirror';

/**
 * Una comida es **un** acontecimiento, aunque por dentro se guarde dos veces.
 *
 * El fallo concreto: `getTimeline` solo escondía la fila espejo cuando
 * pertenecía a un `entry_group_id`. Una comida guardada desde el acceso rápido
 * —el camino más usado— no tiene grupo, así que aparecía dos veces: "Comida
 * registrada · 45 g confirmados" y, justo al lado, "Carbohidratos confirmados
 * · 45 g". Dos tarjetas, un plato.
 *
 * Y la dirección contraria importa igual: un carbohidrato manual suelto es un
 * hecho propio y esconderlo sería el mismo fallo al revés.
 */

const AT = '2026-08-27T13:00:00.000Z';
const OTRO = '2026-08-27T19:30:00.000Z';

const row = (over: Partial<CarbRowForTimeline> & { id: string }): CarbRowForTimeline => ({
  timestamp: AT,
  carbsG: 45,
  source: 'manual',
  entryGroupId: null,
  ...over,
});

describe('partitionCarbRows', () => {
  it('la fila espejo de una comida NO se muestra: es la misma comida', () => {
    const mirror = row({ id: 'c1', source: 'meal_confirmed' });
    const { standalone, mirrored } = partitionCarbRows([mirror], [{ id: 'm1', timestamp: AT }]);
    expect(standalone).toEqual([]);
    expect(mirrored).toEqual([{ row: mirror, mealId: 'm1' }]);
  });

  it('un carbohidrato manual suelto SÍ se muestra', () => {
    const manual = row({ id: 'c2' });
    const { standalone } = partitionCarbRows([manual], [{ id: 'm1', timestamp: AT }]);
    expect(standalone).toEqual([manual]);
  });

  it('un carbohidrato importado también es un hecho propio', () => {
    const importado = row({ id: 'c3', source: 'imported' });
    const { standalone } = partitionCarbRows([importado], [{ id: 'm1', timestamp: AT }]);
    expect(standalone).toEqual([importado]);
  });

  /**
   * Una ventana de visualización no puede ocultar un dato del que no queda
   * otra copia. Si la comida se borró, esos gramos son lo único que sobrevive.
   */
  it('un espejo HUÉRFANO se muestra: es la única copia que queda', () => {
    const huerfano = row({ id: 'c4', source: 'meal_confirmed', timestamp: OTRO });
    const { standalone, mirrored } = partitionCarbRows([huerfano], [{ id: 'm1', timestamp: AT }]);
    expect(standalone).toEqual([huerfano]);
    expect(mirrored).toEqual([]);
  });

  it('la comida se reconoce esté o no agrupada la fila espejo', () => {
    const agrupado = row({ id: 'c5', source: 'meal_confirmed', entryGroupId: 'g1' });
    const { standalone } = partitionCarbRows([agrupado], [{ id: 'm1', timestamp: AT }]);
    expect(standalone).toEqual([]);
  });

  it('mezcla realista: una comida con espejo, una colación suelta y un huérfano', () => {
    const rows = [
      row({ id: 'espejo', source: 'meal_confirmed' }),
      row({ id: 'colacion', carbsG: 15, timestamp: OTRO }),
      row({ id: 'huerfano', source: 'meal_confirmed', carbsG: 30, timestamp: '2026-08-26T09:00:00.000Z' }),
    ];
    const { standalone } = partitionCarbRows(rows, [{ id: 'm1', timestamp: AT }]);
    expect(standalone.map((r) => r.id)).toEqual(['colacion', 'huerfano']);
  });

  it('sin comidas conocidas, nada se esconde', () => {
    const rows = [row({ id: 'c1', source: 'meal_confirmed' })];
    expect(partitionCarbRows(rows, []).standalone).toEqual(rows);
  });
});

describe('sumDayCarbs — cero doble conteo, cero datos perdidos', () => {
  it('una comida con fila espejo cuenta UNA vez', () => {
    const totals = sumDayCarbs(
      [{ timestamp: AT, confirmedCarbsG: 45 }],
      [{ timestamp: AT, carbsG: 45, source: 'meal_confirmed' }],
    );
    expect(totals.fromMeals).toBe(45);
    expect(totals.fromLooseCarbs).toBe(0);
    expect(totals.total).toBe(45);
  });

  it('un carbohidrato manual suelto SÍ suma', () => {
    const totals = sumDayCarbs(
      [{ timestamp: AT, confirmedCarbsG: 45 }],
      [
        { timestamp: AT, carbsG: 45, source: 'meal_confirmed' },
        { timestamp: OTRO, carbsG: 15, source: 'manual' },
      ],
    );
    expect(totals.total).toBe(60);
  });

  /**
   * El bug que introduciría descartar todo `meal_confirmed` a ciegas: los
   * gramos de una comida borrada desaparecerían del día aunque su fila siga
   * guardada.
   */
  it('un espejo huérfano suma: es la única copia de esos gramos', () => {
    const totals = sumDayCarbs(
      [],
      [{ timestamp: AT, carbsG: 45, source: 'meal_confirmed' }],
    );
    expect(totals.total).toBe(45);
    expect(totals.fromLooseCarbs).toBe(45);
  });

  it('una comida sin carbohidratos confirmados aporta 0, no rompe la suma', () => {
    const totals = sumDayCarbs([{ timestamp: AT }], []);
    expect(totals.total).toBe(0);
  });

  it('no acumula error de coma flotante', () => {
    const totals = sumDayCarbs(
      [{ timestamp: AT, confirmedCarbsG: 0.1 }, { timestamp: OTRO, confirmedCarbsG: 0.2 }],
      [],
    );
    expect(totals.total).toBe(0.3);
  });
});
