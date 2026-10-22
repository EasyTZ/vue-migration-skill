import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadProject, scanSource, fingerprintFiles } from '../scripts/lib/source-state.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = (file, data) => fs.writeFile(file, JSON.stringify(data), 'utf8');
function run(script, args, expected = 0) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { encoding: 'utf8', timeout: 20000 });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${result.stdout}\n${result.stderr}`);
  return result;
}
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-state-'));
  t.after(async () => {
    const actual = await fs.realpath(temp);
    assert.equal(path.dirname(actual), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(actual).startsWith('migration-state-'));
    await fs.rm(actual, { recursive: true, force: true });
  });
  const source = path.join(temp, '旧工程');
  const control = path.join(source, 'migration');
  const target = path.join(temp, '新工程');
  await fs.mkdir(source);
  run('init-control.mjs', [source]);
  const configFile = path.join(control, 'project.json');
  const config = await read(configFile);
  config.targetRoot = target;
  await write(configFile, config);
  return { temp, source, control, target, config, configFile };
}

test('源快照覆盖源码、配置、锁文件及二进制，指纹不依赖扫描时间', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'App.vue'), '<template>旧页面</template>');
  await write(path.join(f.source, 'package.json'), { scripts: { build: 'legacy' } });
  await fs.writeFile(path.join(f.source, 'lock.yaml'), '固定依赖');
  await fs.writeFile(path.join(f.source, 'image.bin'), new Uint8Array([0, 255, 1]));
  run('source-snapshot.mjs', [f.control, 'inventory/base.json']);
  const baseline = await read(path.join(f.control, 'inventory/base.json'));
  assert.equal(baseline.files.length, 4);
  assert.equal(baseline.fingerprint, fingerprintFiles([...baseline.files].reverse()));
  const project = await loadProject(f.control);
  assert.equal((await scanSource(project)).fingerprint, baseline.fingerprint);
  run('check-source.mjs', [f.control, 'inventory/base.json', 'inventory/unchanged.json']);
  assert.equal((await read(path.join(f.control, 'inventory/unchanged.json'))).changed, false);
  run('source-snapshot.mjs', [f.control, 'inventory/base.json'], 1);
  assert.deepEqual(await read(path.join(f.control, 'inventory/base.json')), baseline);
});

test('增量检查识别同长度改字节、配置修改、新增和删除，不自动推进基线', async t => {
  const f = await fixture(t);
  const page = path.join(f.source, 'Page.vue');
  await fs.writeFile(page, 'aaa');
  await write(path.join(f.source, 'config.json'), { mode: 1 });
  await fs.writeFile(path.join(f.source, 'delete.js'), '旧逻辑');
  run('source-snapshot.mjs', [f.control, 'inventory/base.json']);
  const before = await fs.readFile(path.join(f.control, 'inventory/base.json'), 'utf8');
  await fs.writeFile(page, 'bbb');
  await write(path.join(f.source, 'config.json'), { mode: 2 });
  await fs.unlink(path.join(f.source, 'delete.js'));
  await fs.writeFile(path.join(f.source, 'new.css'), '.new{}');
  run('check-source.mjs', [f.control, 'inventory/base.json', 'inventory/change.json'], 2);
  const report = await read(path.join(f.control, 'inventory/change.json'));
  assert.deepEqual(report.counts, { added: 1, modified: 2, deleted: 1 });
  assert.deepEqual(report.added, ['new.css']);
  assert.deepEqual(report.modified, ['Page.vue', 'config.json']);
  assert.deepEqual(report.deleted, ['delete.js']);
  assert.equal(await fs.readFile(page, 'utf8'), 'bbb');
  assert.equal(await fs.readFile(path.join(f.control, 'inventory/base.json'), 'utf8'), before);
  run('check-source.mjs', [f.control, 'inventory/base.json', 'inventory/change.json'], 1);
});

test('秘密文件与产物不读取，控制目录变动不污染指纹，排除项显式记录', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'main.js'), '正常源码');
  for (const name of ['.env', '.env.example', '.npmrc', 'private.pem', 'id_rsa']) await fs.writeFile(path.join(f.source, name), '不可公开的内容');
  await fs.mkdir(path.join(f.source, 'node_modules'));
  await fs.writeFile(path.join(f.source, 'node_modules', 'unused.js'), '依赖');
  const project = await loadProject(f.control);
  const before = await scanSource(project);
  await fs.writeFile(path.join(f.control, '迁移台账.md'), '台账继续更新');
  await fs.writeFile(path.join(f.source, '.env'), '另一个秘密');
  const after = await scanSource(project);
  assert.equal(before.fingerprint, after.fingerprint);
  assert.deepEqual(after.files.map(row => row.path), ['main.js']);
  assert.ok(after.excluded.some(row => row.path === 'migration'));
  assert.ok(after.excluded.some(row => row.path === '.env'));
  assert.ok(after.excluded.some(row => row.path === 'node_modules'));
  assert.ok(!JSON.stringify(after).includes('不可公开的内容'));
});

test('拒绝伪造控制目录、源目录重叠和控制目录外输出', async t => {
  const f = await fixture(t);
  run('source-snapshot.mjs', [f.control, path.join(f.source, 'wrong.json')], 1);
  await assert.rejects(fs.access(path.join(f.source, 'wrong.json')));
  f.config.control.root = f.source;
  await write(f.configFile, f.config);
  run('source-snapshot.mjs', [f.control, 'inventory/wrong.json'], 1);
  f.config.control.root = f.control;
  f.config.sourceRoot = f.control;
  await write(f.configFile, f.config);
  run('source-snapshot.mjs', [f.control, 'inventory/wrong.json'], 1);
  f.config.sourceRoot = f.source;
  f.config.targetRoot = path.join(f.source, 'new');
  await write(f.configFile, f.config);
  run('source-snapshot.mjs', [f.control, 'inventory/wrong.json'], 1);
});

test('快照校验拒绝跨项目、被改写指纹和重复文件记录', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.source, 'App.vue'), '页面');
  run('source-snapshot.mjs', [f.control, 'inventory/base.json']);
  const original = await read(path.join(f.control, 'inventory/base.json'));
  const invalidFile = path.join(f.control, 'inventory/invalid.json');
  for (const bad of [
    { ...original, sourceRoot: f.temp },
    { ...original, fingerprint: '0'.repeat(64) },
    { ...original, policy: { ...original.policy, version: 999 } },
    { ...original, files: [...original.files, ...original.files] },
    { ...original, files: [{ ...original.files[0], path: '../outside.js' }] },
  ]) {
    await write(invalidFile, bad);
    run('check-source.mjs', [f.control, 'inventory/invalid.json', 'inventory/result.json'], 1);
  }
  await assert.rejects(fs.access(path.join(f.control, 'inventory/result.json')));
});

test('符号链接不跟随，输出父目录链接越界时拒绝', async t => {
  const f = await fixture(t);
  const external = path.join(f.temp, 'outside');
  await fs.mkdir(external);
  await fs.writeFile(path.join(external, 'secret.txt'), '不应扫描');
  const link = path.join(f.source, 'linked');
  try { await fs.symlink(external, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip('系统不允许创建符号链接'); return; } throw error; }
  const snapshot = await scanSource(await loadProject(f.control));
  assert.equal(snapshot.files.length, 0);
  assert.ok(snapshot.excluded.some(row => row.path === 'linked' && row.reason.includes('符号链接')));
  const outputLink = path.join(f.control, 'escaped');
  await fs.symlink(external, outputLink, process.platform === 'win32' ? 'junction' : 'dir');
  run('source-snapshot.mjs', [f.control, 'escaped/result.json'], 1);
  await assert.rejects(fs.access(path.join(external, 'result.json')));
});

test('工程外控制目录可用，并且不扫描源工程内的无效 marker 当控制目录', async t => {
  const f = await fixture(t);
  const control = path.join(f.temp, 'external-control');
  run('init-control.mjs', [f.source, control]);
  const configFile = path.join(control, 'project.json');
  const config = await read(configFile);
  config.targetRoot = f.target;
  await write(configFile, config);
  await fs.writeFile(path.join(f.source, 'App.vue'), '页面');
  const snapshot = await scanSource(await loadProject(control));
  assert.ok(snapshot.files.some(row => row.path === 'App.vue'));
  // 其他旧控制目录仍属于输入边界；不会凭文件名跳过任意业务目录。
  assert.ok(snapshot.files.some(row => row.path === 'migration/project.json'));
});
