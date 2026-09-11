/**
 * La fila espejo de carbohidratos de una comida, y por qué la usuaria no
 * debe verla nunca dos veces.
 *
 * ## El hecho duplicado
 *
 * Los carbohidratos confirmados de una comida viven en **dos** filas:
 * `meal_events.payload.confirmedCarbsG` y una fila de `carb_events` con
 * `source: 'meal_confirmed'`, pareada por timestamp (ver
 * `writeMealWithEpisode` y `syncConfirmedCarbRow` en `db.ts`). Esa segunda
 * fila es útil por dentro: el reporte, los insights de nutrición y el borrado
 * la usan, así que **no se elimina**.
 *
 * Pero por fuera no son dos acontecimientos. Comiste una vez.
 *
 * `getTimeline` solo escondía la fila espejo cuando pertenecía a un
 * `entry_group_id`. Una comida guardada desde el acceso rápido —el camino más
 * usado— no tiene grupo, así que aparecía dos veces: "Comida registrada · 45 g
 * confirmados" y, justo al lado, "Carbohidratos confirmados · 45 g". Dos
 * tarjetas, un plato.
 *
 * ## Por qué es un módulo puro
 *
 * Porque decide **qué se ve y qué no**, y un filtro de visualización
 * equivocado ya escondió las cetonas del acceso rápido una vez
 * (`progress.md`). `db.ts` importa nativos de Expo y no se puede verificar sin
 * teléfono; esto sí.
 *
 * ## La regla, y lo que deliberadamente NO hace
 *
 * Se esconde una fila de carbohidratos cuando **es** la comida que ya se está
 * mostrando. Nunca se esconde un carbohidrato manual suelto: ese es un hecho
 * propio, la vía más usada para anotar una colación, y desaparecerlo sería
 * exactamente el fallo que este módulo viene a evitar en la otra dirección.
 *
 * Tampoco se esconde una fila espejo **huérfana** —cuya comida ya no existe—:
 * son carbohidratos guardados, y una ventana de visualización no puede
 * destruir ni ocultar un dato del que no queda otra copia.
 */

export interface CarbRowForTimeline {
  id: string;
  timestamp: string;
  carbsG: number;
  source: 'manual' | 'meal_confirmed' | 'imported';
  entryGroupId: string | null;
}

/** Lo mínimo que hace falta saber de una comida para resolver el espejo. */
export interface MealAnchor {
  id: string;
  timestamp: string;
}

export interface CarbPartition {
  /** Filas que sí son un hecho propio y van al timeline. */
  standalone: CarbRowForTimeline[];
  /**
   * Filas espejo escondidas, con la comida que representan.
   *
   * Se devuelven en vez de descartarse porque hay una ruta que las alcanza
   * igual: un deep link viejo, un reporte, o cualquier código que todavía
   * conozca ese id. Quien llegue ahí tiene que terminar en la **comida**, no
   * en un campo primitivo de gramos que edite media verdad.
   */
  mirrored: { row: CarbRowForTimeline; mealId: string }[];
}

/**
 * Separa las filas de carbohidratos en "hechos propios" y "espejos de una
 * comida", emparejando por el timestamp compartido que `writeMealWithEpisode`
 * garantiza.
 *
 * El emparejamiento por hora es legítimo **acá y solo acá**: no está
 * adivinando qué dosis va con qué comida (el fallo que produjo la Regla 3b),
 * está reconociendo dos copias del mismo campo que un único escritor
 * transaccional puso con el mismo timestamp a propósito. Aun así, la
 * dirección del error importa: ante la duda, la fila **se muestra**.
 */
export function partitionCarbRows(
  rows: readonly CarbRowForTimeline[],
  meals: readonly MealAnchor[],
): CarbPartition {
  const mealByTimestamp = new Map<string, string>();
  for (const meal of meals) {
    // El primero gana: si dos comidas comparten timestamp exacto, cualquiera
    // de las dos explica la fila espejo, y elegir estable evita que la
    // tarjeta cambie de destino entre lecturas.
    if (!mealByTimestamp.has(meal.timestamp)) mealByTimestamp.set(meal.timestamp, meal.id);
  }
  const partition: CarbPartition = { standalone: [], mirrored: [] };
  for (const row of rows) {
    if (row.source !== 'meal_confirmed') {
      // Un carbohidrato manual o importado es un hecho propio, tenga o no
      // grupo. Los agrupados los dibuja la tarjeta del grupo, así que esos
      // los sigue filtrando `getTimeline` por `entryGroupId`.
      partition.standalone.push(row);
      continue;
    }
    const mealId = mealByTimestamp.get(row.timestamp);
    if (mealId === undefined) {
      // Espejo huérfano: la comida ya no está. Son carbohidratos guardados y
      // se muestran; esconderlos los volvería inalcanzables e imborrables.
      partition.standalone.push(row);
      continue;
    }
    partition.mirrored.push({ row, mealId });
  }
  return partition;
}

/**
 * Los carbohidratos de un día, sin contar dos veces los de una comida.
 *
 * Misma regla que arriba, expresada para un agregado en vez de para una
 * lista: una comida aporta sus `confirmedCarbsG` una sola vez, y una fila
 * espejo nunca suma encima. Un espejo huérfano **sí** suma, porque es la
 * única copia que queda de esos gramos.
 */
export function sumDayCarbs(
  meals: readonly { timestamp: string; confirmedCarbsG?: number | undefined }[],
  carbRows: readonly { timestamp: string; carbsG: number; source: string }[],
): { fromMeals: number; fromLooseCarbs: number; total: number } {
  const mealTimestamps = new Set(meals.map((meal) => meal.timestamp));
  let fromMeals = 0;
  for (const meal of meals) fromMeals += meal.confirmedCarbsG ?? 0;
  let fromLooseCarbs = 0;
  for (const row of carbRows) {
    if (row.source === 'meal_confirmed' && mealTimestamps.has(row.timestamp)) continue;
    fromLooseCarbs += row.carbsG;
  }
  return {
    fromMeals: Number(fromMeals.toFixed(1)),
    fromLooseCarbs: Number(fromLooseCarbs.toFixed(1)),
    total: Number((fromMeals + fromLooseCarbs).toFixed(1)),
  };
}
