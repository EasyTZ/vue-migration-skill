import test from 'node:test';
import assert from 'node:assert/strict';
import { runBrowserAudit } from '../scripts/lib/browser.mjs';

test('浏览器审计在加载浏览器前拒绝非回环地址', async () => {
  await assert.rejects(
    runBrowserAudit({
      baseUrl: 'https://example.com/',
      routes: [{ id: 'R-1', targetPath: '/' }],
      scenarios: [],
    }),
    /回环地址/,
  );
});

test('浏览器审计缺少路由时明确失败，不静默跳过', async () => {
  await assert.rejects(
    runBrowserAudit({ baseUrl: 'http://127.0.0.1:4175/', routes: [], scenarios: [] }),
    /没有可审计的路由/,
  );
});
