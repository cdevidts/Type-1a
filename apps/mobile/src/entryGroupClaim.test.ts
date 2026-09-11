import { describe, expect, it } from 'vitest';

import {
  withClaimedEntryGroup,
  type EntryGroupClaimStore,
  type EntryGroupClaimTarget,
} from './entryGroupClaim';

function fakeStore(initialGroup: string | null, concurrentWinner?: string): {
  store: EntryGroupClaimStore;
  state: { group: string | null; mirrorGroup: string | null; claims: number };
} {
  const state = { group: initialGroup, mirrorGroup: null as string | null, claims: 0 };
  const store: EntryGroupClaimStore = {
    transaction: async (work) => {
      const snapshot = { ...state };
      try {
        await work(undefined);
      } catch (error) {
        Object.assign(state, snapshot);
        throw error;
      }
    },
    read: async () => state.group,
    claim: async (_transaction, _target, candidate) => {
      state.claims += 1;
      if (state.group === null) state.group = concurrentWinner ?? candidate;
    },
    alignMealMirror: async (_transaction, _mealId, groupId) => {
      state.mirrorGroup = groupId;
    },
  };
  return { store, state };
}

const meal: EntryGroupClaimTarget = { table: 'meal_events', rowId: 'meal-1' };
const reading: EntryGroupClaimTarget = { table: 'cgm_readings', rowId: 'reading-1' };

describe('withClaimedEntryGroup', () => {
  it('revierte también la promoción si la edición falla', async () => {
    const { store, state } = fakeStore(null);

    await expect(withClaimedEntryGroup(store, null, meal, () => 'candidate', async () => {
      throw new Error('falló la edición');
    })).rejects.toThrow('falló la edición');

    expect(state).toEqual({ group: null, mirrorGroup: null, claims: 0 });
  });

  it('relee al ganador concurrente y alinea el espejo con ese grupo', async () => {
    const { store, state } = fakeStore(null, 'winner');

    const used = await withClaimedEntryGroup(store, null, meal, () => 'loser', async (groupId) => groupId);

    expect(used).toBe('winner');
    expect(state.group).toBe('winner');
    expect(state.mirrorGroup).toBe('winner');
  });

  it('es idempotente cuando la fila ya tiene grupo', async () => {
    const { store, state } = fakeStore('existing');

    const used = await withClaimedEntryGroup(store, null, meal, () => 'unused', async (groupId) => groupId);

    expect(used).toBe('existing');
    expect(state.claims).toBe(0);
    expect(state.mirrorGroup).toBe('existing');
  });

  it('descarta un grupo conocido obsoleto y reclama el estado actual dentro de la transacción', async () => {
    const { store, state } = fakeStore(null);

    const used = await withClaimedEntryGroup(store, 'stale', reading, () => 'fresh', async (groupId) => groupId);

    expect(used).toBe('fresh');
    expect(state.group).toBe('fresh');
    expect(state.claims).toBe(1);
  });

  it('rechaza una fila que desapareció antes de reclamarla', async () => {
    const { store } = fakeStore(null);
    store.read = async () => undefined;

    await expect(withClaimedEntryGroup(store, null, meal, () => 'candidate', async (groupId) => groupId))
      .rejects.toThrow('ya no existe');
  });
});
