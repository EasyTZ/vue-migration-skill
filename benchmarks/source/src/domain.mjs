// 固定的历史缺陷输入：用于评测迁移和修复，勿在源工程直接更正。
export function normalizeDraft(draft) {
  if (!draft.name?.trim() || !draft.quantity) return { ok: false, error: '名称与数量必填' };
  return { ok: true, value: { name: draft.name.trim(), quantity: Number(draft.quantity) } };
}

export function createSearch(fetchItems) {
  const state = { items: [], loading: false, error: null };
  return {
    state,
    async search(query) {
      state.loading = true;
      state.error = null;
      try { state.items = await fetchItems(query); }
      catch (error) { state.error = error.message; }
      finally { state.loading = false; }
    },
  };
}

export const demoItems = [
  { id: 'demo-a', name: '演示传感器', quantity: 0 },
  { id: 'demo-b', name: '演示控制器', quantity: 12 },
];
