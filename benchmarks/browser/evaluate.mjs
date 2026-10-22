import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const address = process.argv[2];
if (!address) throw new Error('用法：node benchmarks/browser/evaluate.mjs <本地预览URL> [--expect-source-bugs]');
const url = new URL(address);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许本地合成样板预览地址');
let ready = false;
for (let attempt = 0; attempt < 30; attempt++) {
  try { if ((await fetch(address, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch { /* 等待本次预览服务就绪 */ }
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!ready) throw new Error('本地预览服务未就绪');
const playwright = process.env.BENCHMARK_PLAYWRIGHT_MODULE
  ? await import(pathToFileURL(process.env.BENCHMARK_PLAYWRIGHT_MODULE)) : await import('playwright');
const browser = await playwright.chromium.launch({
  ...(process.env.BENCHMARK_BROWSER_EXECUTABLE ? { executablePath: process.env.BENCHMARK_BROWSER_EXECUTABLE } : {}),
});
const page = await browser.newPage();
const checks = [];
const runtimeErrors = [];
page.on('pageerror', error => runtimeErrors.push(error.message));
async function check(id, action) {
  try { await action(); checks.push({ id, status: 'passed' }); }
  catch (error) { checks.push({ id, status: 'failed', message: error.message }); }
}
try {
  await page.goto(address);
  await page.getByRole('heading', { name: '合成设备台账', exact: true }).waitFor();
  await check('列表与作用域插槽', async () => assert.equal(await page.getByTestId('item').count(), 2));
  await check('必填校验', async () => {
    await page.getByTestId('save').click();
    assert.ok((await page.getByTestId('error').textContent()).trim());
    assert.equal((await page.getByTestId('saved').textContent()).trim(), '');
  });
  await check('BUG-001-零库存可保存', async () => {
    await page.getByTestId('name').fill('演示设备'); await page.getByTestId('quantity').fill('0');
    await page.getByTestId('save').click();
    assert.equal((await page.getByTestId('saved').textContent()).trim(), '演示设备：0');
  });
  await check('BUG-002-后发查询优先', async () => {
    // 同一浏览器任务中触发两次，避免慢CI的跨进程操作延迟改变竞态输入。
    await page.evaluate(() => {
      const input = document.querySelector('[data-testid="query"]');
      const button = document.querySelector('[data-testid="search"]');
      for (const query of ['传', '控']) {
        input.value = query;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        button.click();
      }
    });
    // 合成接口约定：旧查询120ms、新查询10ms；等待两者返回后验证最终状态。
    await page.waitForTimeout(250);
    const items = await page.getByTestId('item').allTextContents();
    assert.equal(items.length, 1); assert.match(items[0], /演示控制器/);
  });
  await check('无运行时错误', () => assert.deepEqual(runtimeErrors, []));
} finally { await browser.close(); }
const failures = checks.filter(c => c.status === 'failed').map(c => c.id);
const expected = ['BUG-001-零库存可保存', 'BUG-002-后发查询优先'];
const expectedSource = process.argv.includes('--expect-source-bugs');
const accepted = expectedSource ? JSON.stringify([...failures].sort()) === JSON.stringify([...expected].sort()) : failures.length === 0;
console.log(JSON.stringify({ schemaVersion: 1, kind: 'browser-contract', url: address, expectedSourceBugs: expectedSource, accepted, checks }, null, 2));
if (!accepted) process.exitCode = 1;
