export function normalizeDraft(draft) {
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  const empty = draft.quantity === '' || draft.quantity === null || draft.quantity === undefined;
  const quantity = Number(draft.quantity);
  if (!name || empty || !Number.isInteger(quantity) || quantity < 0) return { ok: false, error: '名称必填，数量须为非负整数' };
  return { ok: true, value: { name, quantity } };
}

export function createSearch(fetchItems) {
  const state = { items: [], loading: false, error: null };
  let generation = 0;
  return {
    state,
    async search(query) {
      const current = ++generation;
      state.loading = true;
      state.error = null;
      try {
        const items = await fetchItems(query);
        if (current === generation) state.items = items;
      } catch (error) {
        if (current === generation) state.error = error.message;
      } finally {
        if (current === generation) state.loading = false;
      }
    },
  };
}

export const demoItems = [
  { id: 'demo-a', name: '演示传感器', quantity: 0 },
  { id: 'demo-b', name: '演示控制器', quantity: 12 },
];
