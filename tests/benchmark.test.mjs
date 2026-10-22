import test from 'node:test';
import assert from 'node:assert/strict';
import * as source from '../benchmarks/source/src/domain.mjs';
import * as reference from '../benchmarks/reference-target/src/domain.mjs';
import { evaluateDomain } from '../benchmarks/contract.mjs';

test('合成评测源确实暴露已知缺陷，参考目标满足公开契约', async () => {
  const before = await evaluateDomain(source);
  assert.ok(before.checks.some(c => c.id === 'BUG-001-零库存可保存' && c.status === 'failed'));
  assert.ok(before.checks.some(c => c.id === 'BUG-002-后发查询优先' && c.status === 'failed'));
  const after = await evaluateDomain(reference);
  assert.equal(after.failed, 0, JSON.stringify(after));
  assert.equal(after.passed, after.checks.length);
});

test('目标异步实现不返回时，契约评测明确超时而非挂起', async () => {
  const result = await evaluateDomain({ ...reference, createSearch: () => ({ search: () => new Promise(() => {}), state: {} }) }, { timeoutMs: 20 });
  assert.ok(result.checks.some(c => c.status === 'failed' && /超时/.test(c.message)));
});
