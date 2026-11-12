import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { normalizeRoutes } from '../scripts/lib/routes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
function run(script, args, expected = 0) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${script}\n${result.stdout}\n${result.stderr}`);
  return result;
}

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vue-acceptance-test-'));
  t.after(async () => {
    const actual = await fs.realpath(temp);
    assert.equal(path.dirname(actual), await fs.realpath(os.tmpdir()));
    await fs.rm(actual, { recursive: true, force: true });
  });
  const source = path.join(temp, '源工程');
  await fs.mkdir(path.join(source, 'src/router'), { recursive: true });
  await fs.mkdir(path.join(source, 'src/api'), { recursive: true });
  await fs.mkdir(path.join(source, 'src/views'), { recursive: true });
  await writeJson(path.join(source, 'package.json'), { name: 'legacy', dependencies: { vue: '2.7.16', echarts: '4.9.0' } });
  await fs.writeFile(path.join(source, 'src/router/index.js'), [
    "import { createRouter } from 'vue-router';",
    'const routes = [{',
    "  path: '/user/:id', name: 'User', component: () => import('../views/User.vue'),",
    "  meta: { title: '用户', requiresAuth: true },",
    '}];',
    'export default createRouter({ routes });',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(source, 'src/api/user.js'), [
    "export const list = () => axios.get('/api/users');",
    "export const save = (id) => request({ url: '/api/users/123', method: 'put' });",
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(source, 'src/views/User.vue'), [
    '<template>',
    '  <el-form v-model="form" :rules="rules"><el-form-item prop="name"><el-input v-model="form.name" /></el-form-item></el-form>',
    '  <el-table :data="rows"><el-table-column label="名称" prop="name" /></el-table>',
    '  <el-dialog title="编辑" :visible="open" />',
    '  <el-upload action="/api/upload" />',
    '  <button v-permission="\'user:add\'" @click="save">新增</button>',
    '  <div ref="chart" />',
    '  <button @click="window.print()">打印</button>',
    '</template>',
    "<script>import * as echarts from 'echarts'; localStorage.setItem('token', token); setInterval(tick, 1000); export default { data() { return { form: { name: '' }, rules: { name: [{ required: true, message: '请输入名称' }] } }; } };</script>",
    '',
  ].join('\n'), 'utf8');
  run('init-control.mjs', [source]);
  const control = path.join(source, 'migration');
  await fs.writeFile(path.join(control, 'tools/ignored.js'), "const path = '/control-only';\n", 'utf8');
  const configFile = path.join(control, 'project.json');
  const config = await readJson(configFile);
  const target = path.join(temp, '目标工程');
  await fs.mkdir(target);
  await writeJson(path.join(target, 'package.json'), { name: 'modern', private: true });
  config.targetRoot = target;
  config.packageManager = 'npm';
  config.acceptance.port = 4175;
  config.acceptance.url = 'http://127.0.0.1:4175/';
  await writeJson(configFile, config);
  return { temp, source, control, configFile, config, target };
}

test('能力抽取识别路由/接口/表单/权限/存储等验收面，并跳过控制目录', async t => {
  const f = await fixture(t);
  const inventoryFile = path.join(f.control, 'inventory/capabilities.json');
  run('extract-capabilities.mjs', [f.control, 'inventory/capabilities.json']);
  const inventory = await readJson(inventoryFile);
  assert.equal(inventory.kind, 'capability-inventory');
  assert.equal(inventory.sourceRoot, await fs.realpath(f.source));
  const kinds = new Set(inventory.units.map(unit => unit.kind));
  for (const kind of ['route', 'api', 'form', 'table', 'dialog', 'permission', 'storage', 'chart', 'timer', 'upload', 'print']) {
    assert.ok(kinds.has(kind), `应识别 ${kind}，实际：${[...kinds].join(',')}`);
  }
  assert.ok(inventory.routeCandidates.some(candidate => candidate.path === '/user/:id' && candidate.flags.requiresAuth === true));
  assert.ok(inventory.units.some(unit => unit.kind === 'api' && unit.detail === 'GET /api/users'));
  assert.ok(inventory.units.some(unit => unit.kind === 'api' && unit.detail === 'PUT /api/users/:param'));
  assert.ok(inventory.units.every(unit => !unit.file.startsWith('migration/')), '控制目录不应参与能力抽取');
  const ids = inventory.units.map(unit => unit.id);
  assert.equal(new Set(ids).size, ids.length, '能力 id 必须唯一');
  assert.ok(inventory.stats.required > 0 && inventory.stats.advisory > 0);
  const before = await fs.readFile(inventoryFile, 'utf8');
  run('extract-capabilities.mjs', [f.control, 'inventory/capabilities.json'], 1);
  assert.equal(await fs.readFile(inventoryFile, 'utf8'), before);
});

test('验收种子生成路由/场景/能力状态，重复执行保留人工修改', async t => {
  const f = await fixture(t);
  run('extract-capabilities.mjs', [f.control, 'inventory/capabilities.json']);
  run('init-acceptance.mjs', [f.control, 'inventory/capabilities.json']);
  const routesFile = path.join(f.control, 'runtime/routes.json');
  const scenariosFile = path.join(f.control, 'runtime/scenarios.json');
  const statusFile = path.join(f.control, 'runtime/capability-status.json');
  const routes = await readJson(routesFile);
  const scenarios = await readJson(scenariosFile);
  const status = await readJson(statusFile);
  assert.equal(routes.kind, 'acceptance-routes');
  assert.ok(routes.routes.length >= 1);
  assert.equal(routes.routes[0].sourcePath, '/user/:id');
  assert.equal(routes.routes[0].targetPath, '/user/:id');
  assert.equal(routes.reviewed, false);
  assert.ok(scenarios.scenarios.some(scenario => scenario.phase === 'route'));
  assert.ok(status.units.length >= 1);
  const routesText = (await fs.readFile(routesFile, 'utf8')).replace('/user/:id', '/custom');
  await fs.writeFile(routesFile, routesText, 'utf8');
  const result = run('init-acceptance.mjs', [f.control, 'inventory/capabilities.json']);
  assert.match(result.stdout, /保留人工内容/);
  assert.match(await fs.readFile(routesFile, 'utf8'), /\/custom/);
});

test('验收路由表要求具体 targetPath，拒绝动态段与重复入口', () => {
  assert.throws(() => normalizeRoutes({ routes: [{ id: 'R-1', targetPath: '/user/:id' }] }), /动态参数/);
  assert.throws(() => normalizeRoutes({ routes: [{ id: 'R-1', targetPath: '/x' }, { id: 'R-2', targetPath: '/x' }] }), /重复 targetPath/);
  assert.throws(() => normalizeRoutes({ routes: [{ id: 'R-1', targetPath: 'x' }] }), /以 \/ 开头/);
  const table = normalizeRoutes({ routes: [{ id: 'R-1', path: '/ok' }] });
  assert.equal(table.routes[0].targetPath, '/ok');
});

test('边界检查识别验收证据、运行状态与验收文档', async t => {
  const f = await fixture(t);
  const write = (name, value) => fs.writeFile(path.join(f.target, name), JSON.stringify(value), 'utf8');
  run('check-boundary.mjs', [f.control, f.target]);
  await write('business.json', { kind: 'business', schemaVersion: 1, items: [] });
  run('check-boundary.mjs', [f.control, f.target]);
  await write('target-runtime.json', { schemaVersion: 1, kind: 'runtime-state', state: 'running' });
  run('check-boundary.mjs', [f.control, f.target], 1);
  await fs.unlink(path.join(f.target, 'target-runtime.json'));
  await write('http-probe.json', { schemaVersion: 1, kind: 'http-probe', routes: [] });
  run('check-boundary.mjs', [f.control, f.target], 1);
  await fs.unlink(path.join(f.target, 'http-probe.json'));
  await fs.writeFile(path.join(f.target, '运行验收.md'), '# 验收记录', 'utf8');
  run('check-boundary.mjs', [f.control, f.target], 1);
});
