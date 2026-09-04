import type { PromotableTable } from './types';

export type EntryGroupClaimTable = PromotableTable | 'cgm_readings';

export interface EntryGroupClaimTarget {
  table: EntryGroupClaimTable;
  rowId: string;
}

/**
 * El acceso mínimo que necesita la coordinación de un grupo.
 *
 * Está separado de Expo/SQLite para poder probar las carreras y los rollbacks
 * como reglas de estado, sin fingir que Vitest puede cargar una base nativa.
 */
export interface EntryGroupClaimStore<TransactionContext = void> {
  transaction(work: (transaction: TransactionContext) => Promise<void>): Promise<void>;
  /** `undefined` significa que la fila ya no existe; `null`, que sigue suelta. */
  read(transaction: TransactionContext, target: EntryGroupClaimTarget): Promise<string | null | undefined>;
  claim(transaction: TransactionContext, target: EntryGroupClaimTarget, candidateGroupId: string): Promise<void>;
  alignMealMirror(transaction: TransactionContext, mealId: string, confirmedGroupId: string): Promise<void>;
}

/**
 * Reclama —o reutiliza— el grupo real de una fila y ejecuta su edición dentro
 * de la MISMA transacción.
 *
 * La relectura posterior al `claim` es la guarda de concurrencia: el id que
 * manda es el que quedó en la fila, no necesariamente el candidato de esta
 * llamada. Si `work` falla, la reclamación y cualquier espejo vuelven atrás
 * junto con el resto de la edición.
 */
export async function withClaimedEntryGroup<T, TransactionContext>(
  store: EntryGroupClaimStore<TransactionContext>,
  knownEntryGroupId: string | null,
  target: EntryGroupClaimTarget | undefined,
  createGroupId: () => string,
  work: (confirmedGroupId: string, transaction: TransactionContext) => Promise<T>,
): Promise<T> {
  let result: { value: T } | undefined;

  await store.transaction(async (transaction) => {
    let confirmedGroupId = knownEntryGroupId;

    if (target !== undefined) {
      // Aunque el llamador haya leído un grupo, el target se vuelve a leer
      // dentro de la transacción: pudo desanclarse mientras se abría el modal.
      const before = await store.read(transaction, target);
      if (before === undefined) throw new Error('Ese registro ya no existe.');

      if (before === null) {
        await store.claim(transaction, target, createGroupId());
      }

      // Nunca confiar en el candidato propio: otra llamada puede haber ganado.
      const after = await store.read(transaction, target);
      if (after === undefined) throw new Error('Ese registro ya no existe.');
      if (after === null) throw new Error('No se pudo preparar el registro para editarlo.');
      confirmedGroupId = after;

      if (target.table === 'meal_events') {
        await store.alignMealMirror(transaction, target.rowId, confirmedGroupId);
      }
    } else if (confirmedGroupId === null) {
      throw new Error('Falta el registro que se debe preparar para editar.');
    }

    result = { value: await work(confirmedGroupId, transaction) };
  });

  if (result === undefined) throw new Error('La transacción no terminó.');
  return result.value;
}
