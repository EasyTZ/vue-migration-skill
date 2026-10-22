import assert from 'node:assert/strict';
export async function evaluateDomain(domain, { timeoutMs = 2000 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('契约超时必须为正数');
  const checks = [];
  async function check(id, action) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`检查超时：${timeoutMs}ms`)), timeoutMs); }),
      ]);
      checks.push({ id, status: 'passed' });
    }
    catch (error) { checks.push({ id, status: 'failed', message: error.message }); }
    finally { clearTimeout(timer); }
  }
  await check('必填校验', () => assert.equal(domain.normalizeDraft({ name: '', quantity: 1 }).ok, false));
  await check('正常保存', () => assert.deepEqual(domain.normalizeDraft({ name: ' 演示设备 ', quantity: 2 }), { ok: true, value: { name: '演示设备', quantity: 2 } }));
  await check('BUG-001-零库存可保存', () => assert.equal(domain.normalizeDraft({ name: '演示设备', quantity: 0 }).ok, true));
  await check('非法数量拒绝', () => {
    for (const quantity of ['', null, undefined, -1, 1.5, 'x']) assert.equal(domain.normalizeDraft({ name: '演示设备', quantity }).ok, false, `数量 ${String(quantity)} 应拒绝`);
  });
  await check('BUG-002-后发查询优先', async () => {
    const pending = new Map();
    const instance = domain.createSearch(query => new Promise(resolve => pending.set(query, resolve)));
    const slow = instance.search('旧');
    const fast = instance.search('新');
    pending.get('新')([{ id: 'new' }]); await fast;
    pending.get('旧')([{ id: 'old' }]); await slow;
    assert.deepEqual(instance.state.items, [{ id: 'new' }]);
    assert.equal(instance.state.loading, false);
  });
  await check('请求失败恢复', async () => {
    const instance = domain.createSearch(async () => { throw new Error('合成失败'); });
    await instance.search('失败');
    assert.equal(instance.state.error, '合成失败'); assert.equal(instance.state.loading, false);
  });
  return { schemaVersion: 1, kind: 'domain-contract', checks, passed: checks.filter(c => c.status === 'passed').length, failed: checks.filter(c => c.status === 'failed').length };
}
