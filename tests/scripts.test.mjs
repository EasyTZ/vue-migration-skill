import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value), 'utf8');
function run(script, args, expected = 0) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { encoding: 'utf8', timeout: 20000 });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${script}\n${result.stdout}\n${result.stderr}`);
  return result;
}
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vue-migration-test-'));
  // 只清理由本测试创建且已保存的绝对临时目录，不接受外部路径。
  t.after(async () => {
    const resolvedTemp = await fs.realpath(temp);
    const resolvedParent = await fs.realpath(os.tmpdir());
    assert.equal(path.dirname(resolvedTemp), resolvedParent);
    assert.ok(path.basename(resolvedTemp).startsWith('vue-migration-test-'));
    await fs.rm(resolvedTemp, { recursive: true, force: true });
  });
  const source = path.join(temp, '源工程');
  await fs.mkdir(source);
  const control = path.join(source, 'migration');
  run('init-control.mjs', [source]);
  const configFile = path.join(control, 'project.json');
  const config = await readJson(configFile);
  const target = path.join(temp, '目标工程');
  // 以下版本是清单传递测试数据，不会安装，也不表示当前推荐版本。
  config.packageManager = 'pnpm';
  config.packageManagerVersion = '1.2.3';
  config.targetRoot = target;
  config.targetManifest = {
    name: 'fixture', private: true, type: 'module', scripts: { build: 'custom-builder' },
    dependencies: { vue: '3.0.0', 'custom-ui': '1.2.3' },
    devDependencies: { 'custom-builder': '4.5.6' },
    peerDependencies: { 'custom-host': '^2.0.0' }, exports: './src/index.js',
  };
  await writeJson(configFile, config);
  return { temp, source, control, configFile, config, target };
}

test('初始化控制目录可重跑，保留人工内容及源码', async t => {
  const f = await fixture(t);
  const ledger = path.join(f.control, '迁移台账.md');
  await fs.writeFile(ledger, '人工维护内容', 'utf8');
  const configBefore = await fs.readFile(f.configFile, 'utf8');
  const sourceFile = path.join(f.source, 'App.vue');
  await fs.writeFile(sourceFile, '<template>原工程</template>', 'utf8');
  run('init-control.mjs', [f.source]);
  assert.equal(await fs.readFile(ledger, 'utf8'), '人工维护内容');
  assert.equal(await fs.readFile(f.configFile, 'utf8'), configBefore);
  assert.equal(await fs.readFile(sourceFile, 'utf8'), '<template>原工程</template>');
  for (const name of ['inventory', 'evidence', 'tools']) assert.ok((await fs.stat(path.join(f.control, name))).isDirectory());
});

test('初始化生成的台账把路由与入口列为独立对照表', async t => {
  const f = await fixture(t);
  const ledger = await fs.readFile(path.join(f.control, '迁移台账.md'), 'utf8');
  const section = /## 路由与入口对照\n([\s\S]*?)(?:\n## |$)/.exec(ledger);
  assert.ok(section, '迁移台账缺少“路由与入口对照”一节');
  const header = /^\|(.+)\|\s*$/m.exec(section[1])?.[1];
  assert.ok(header, '路由对照缺少表头');
  const columns = header.split('|').map(cell => cell.trim());
  // 列名就是核对口径：能填完这七列，才说明该页面的跳转来源和可达性被真正对过账。
  for (const column of ['源路径', '目标路径', '菜单可见', '跳转来源（菜单/按钮/返回/外链）', '目标组件文件', '可达性状态', '证据（控制目录相对路径）']) {
    assert.ok(columns.includes(column), `路由对照缺少列：${column}`);
  }
});

test('控制目录不能复用源根目录、源码子目录或已有工程目录', async t => {
  const f = await fixture(t);
  run('init-control.mjs', [f.source, f.source], 1);
  const src = path.join(f.source, 'src');
  await fs.mkdir(src);
  run('init-control.mjs', [f.source, path.join(src, 'migration')], 1);
  const existing = path.join(f.temp, 'existing');
  await fs.mkdir(existing);
  await writeJson(path.join(existing, 'package.json'), { name: 'already-code' });
  run('init-control.mjs', [f.source, existing], 1);
});

test('普查排除控制目录和构建物，提取真实文件并保护快照和源文件', async t => {
  const f = await fixture(t);
  const sourceText = '<script>Vue.prototype.api = {}; setInterval(() => {}, 1000)</script>';
  const sourceFile = path.join(f.source, 'App.vue');
  await fs.writeFile(sourceFile, sourceText, 'utf8');
  await writeJson(path.join(f.source, 'package.json'), { name: 'original', dependencies: { vue: '2.0.0' } });
  await fs.writeFile(path.join(f.control, 'tools', 'ignore.vue'), '<template>过程文件</template>', 'utf8');
  await fs.mkdir(path.join(f.source, 'dist'));
  await fs.writeFile(path.join(f.source, 'dist', 'ignore.vue'), '<template>产物</template>', 'utf8');
  const output = path.join(f.control, 'inventory', 'first.json');
  run('inventory.mjs', [f.source, output]);
  const report = await readJson(output);
  assert.equal(report.componentCount, 1);
  assert.deepEqual(report.files.map(file => file.path), ['App.vue']);
  assert.ok(report.files[0].signals.includes('legacyInstances'));
  assert.ok(report.files[0].signals.includes('timersAndEvents'));
  assert.equal(report.sourcePackage.dependencies.vue, '2.0.0');
  const snapshot = await fs.readFile(output, 'utf8');
  run('inventory.mjs', [f.source, output], 1);
  assert.equal(await fs.readFile(output, 'utf8'), snapshot);
  run('inventory.mjs', [f.source, path.join(f.source, 'forbidden.json')], 1);
  assert.equal(await fs.readFile(sourceFile, 'utf8'), sourceText);
  await assert.rejects(fs.access(path.join(f.source, 'forbidden.json')));
});

test('目标初始化保留项目自选依赖与扩展字段，不注入固定骨架', async t => {
  const f = await fixture(t);
  run('init-target.mjs', [f.target, f.configFile]);
  const pkg = await readJson(path.join(f.target, 'package.json'));
  assert.deepEqual(pkg, { ...f.config.targetManifest, packageManager: 'pnpm@1.2.3' });
  assert.deepEqual((await fs.readdir(f.target)).sort(), ['.gitignore', 'README.md', 'package.json'].sort());
  const before = await fs.readFile(path.join(f.target, 'package.json'), 'utf8');
  run('init-target.mjs', [f.target, f.configFile], 1);
  assert.equal(await fs.readFile(path.join(f.target, 'package.json'), 'utf8'), before);
});

test('普查不能把业务 JSON 或控制配置错配目录当成控制目录', async t => {
  const f = await fixture(t);
  const src = path.join(f.source, 'src');
  await fs.mkdir(src);
  const marker = path.join(src, 'project.json');
  const forbidden = path.join(src, 'snapshot.json');
  await writeJson(marker, {});
  run('inventory.mjs', [f.source, forbidden], 1);
  await assert.rejects(fs.access(forbidden));
  // marker 确有控制字段，但实际目录与 control.root 不一致仍不能授权写入。
  await writeJson(marker, { sourceRoot: f.source, control: { root: f.control } });
  run('inventory.mjs', [f.source, forbidden], 1);
  await assert.rejects(fs.access(forbidden));
  // control.root 指向自身，sourceRoot 却指向另一个工程，也不能通过。
  const other = path.join(f.temp, 'other-source');
  await fs.mkdir(other);
  await writeJson(marker, { sourceRoot: other, control: { root: src } });
  run('inventory.mjs', [f.source, forbidden], 1);
  await assert.rejects(fs.access(forbidden));
  const valid = path.join(f.control, 'inventory', 'valid-after-rejections.json');
  run('inventory.mjs', [f.source, valid]);
  assert.equal((await readJson(valid)).sourceRoot, await fs.realpath(f.source));
});

test('目标初始化拒绝无版本依据的清单和源工程内写入', async t => {
  const f = await fixture(t);
  f.config.targetManifest.dependencies.vue = 'latest';
  await writeJson(f.configFile, f.config);
  run('init-target.mjs', [f.target, f.configFile], 1);
  await assert.rejects(fs.access(f.target));
  f.config.targetManifest.dependencies.vue = '3.0.0';
  f.config.targetRoot = path.join(f.source, 'new-target');
  await writeJson(f.configFile, f.config);
  run('init-target.mjs', [f.config.targetRoot, f.configFile], 1);
  await assert.rejects(fs.access(f.config.targetRoot));
});

test('目标初始化拒绝未填写 sourceRoot，且不创建目标目录', async t => {
  const f = await fixture(t);
  for (const sourceRoot of [null, '']) {
    f.config.sourceRoot = sourceRoot;
    await writeJson(f.configFile, f.config);
    run('init-target.mjs', [f.target, f.configFile], 1);
    await assert.rejects(fs.access(f.target));
  }
});

test('边界检查允许项目代码，但拦截迁移资料与配置副本', async t => {
  const f = await fixture(t);
  run('init-target.mjs', [f.target, f.configFile]);
  run('check-boundary.mjs', [f.control, f.target]);
  const artifact = path.join(f.target, '验收报告.md');
  await fs.writeFile(artifact, '不应进入新工程', 'utf8');
  run('check-boundary.mjs', [f.control, f.target], 1);
  await fs.unlink(artifact);
  await writeJson(path.join(f.target, 'renamed.json'), f.config);
  run('check-boundary.mjs', [f.control, f.target], 1);
  await fs.unlink(path.join(f.target, 'renamed.json'));
  await fs.mkdir(path.join(f.target, 'migration'));
  run('check-boundary.mjs', [f.control, f.target], 1);
});

test('POSIX 上大小写不同的同级目录保持独立', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t);
  const source = path.join(f.temp, 'case');
  await fs.mkdir(source);
  // macOS 默认文件系统可能不区分大小写，不能假定所有 POSIX 卷都区分。
  if (await fs.stat(path.join(f.temp, 'CASE')).catch(() => null)) {
    t.skip('当前文件系统不区分大小写');
    return;
  }
  run('init-control.mjs', [source]);
  const control = path.join(source, 'migration');
  const configFile = path.join(control, 'project.json');
  const config = { ...f.config, sourceRoot: source, control: { root: control }, targetRoot: path.join(f.temp, 'CASE') };
  await writeJson(configFile, config);
  run('init-target.mjs', [config.targetRoot, configFile]);
});

test('边界检查保留同名业务字段，但拦截真正的普查快照副本', async t => {
  const f = await fixture(t);
  run('init-target.mjs', [f.target, f.configFile]);
  const businessFile = path.join(f.target, 'business.json');
  for (const business of [{ componentCount: 3 }, { sourceRoot: 'business-source' }, { componentCount: 3, sourceRoot: 'business-source' }]) {
    await writeJson(businessFile, business);
    const before = await fs.readFile(businessFile, 'utf8');
    run('check-boundary.mjs', [f.control, f.target]);
    assert.equal(await fs.readFile(businessFile, 'utf8'), before);
  }
  const snapshotFile = path.join(f.target, 'snapshot-copy.json');
  await writeJson(snapshotFile, { sourceRoot: f.source, generatedAt: '2026-01-01T00:00:00.000Z', files: [], componentCount: 0 });
  const before = await fs.readFile(snapshotFile, 'utf8');
  run('check-boundary.mjs', [f.control, f.target], 1);
  assert.equal(await fs.readFile(snapshotFile, 'utf8'), before);
});

test('SFC 巡检对未安装编译器明确失败，不误报通过', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.target);
  await writeJson(path.join(f.target, 'package.json'), { private: true });
  const result = run('check-sfc.mjs', [f.target], 1);
  assert.match(result.stderr, /@vue\/compiler-sfc/);
});

test('SFC 巡检拦截 Vue 2 过渡类名与 transition 内嵌 router-view', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.target, { recursive: true });
  await writeJson(path.join(f.target, 'package.json'), { private: true });
  // 编译本身要过，才能证明失败来自过渡扫描而不是编译器；这里用最小编译器桩。
  const compilerDir = path.join(f.target, 'node_modules', '@vue', 'compiler-sfc');
  await fs.mkdir(compilerDir, { recursive: true });
  await writeJson(path.join(compilerDir, 'package.json'), { name: '@vue/compiler-sfc', version: '0.0.0', main: 'index.js' });
  await fs.writeFile(path.join(compilerDir, 'index.js'), [
    'module.exports = {',
    '  parse: () => ({ descriptor: { script: null, scriptSetup: null, template: null, styles: [] }, errors: [] }),',
    '  compileScript: () => ({ bindings: {} }),',
    '  compileTemplate: () => ({ errors: [] }),',
    '  compileStyleAsync: async () => ({ errors: [] }),',
    '};',
    '',
  ].join('\n'), 'utf8');
  const src = path.join(f.target, 'src');
  await fs.mkdir(src, { recursive: true });
  const page = path.join(src, 'Home.vue');
  // 旧写法：Vue 2 过渡类名 + <transition> 里直接嵌 router-view（编译都能过）
  await fs.writeFile(page, '<template><transition name="move"><router-view /></transition></template>\n<style>.move-enter, .move-leave { opacity: 0 }</style>\n', 'utf8');
  const broken = run('check-sfc.mjs', [f.target], 1);
  assert.match(broken.stderr, /\.move-enter/);
  assert.match(broken.stderr, /router-view/);
  // 正确写法：-enter-from/-leave-to + v-slot 包 component
  await fs.writeFile(page, [
    '<template><router-view v-slot="{ Component }"><transition name="move" mode="out-in">',
    '<component :is="Component" /></transition></router-view></template>',
    '<style>.move-enter-from, .move-leave-to { opacity: 0 }',
    '.move-enter-active, .move-leave-active { transition: opacity .15s }</style>',
    '',
  ].join('\n'), 'utf8');
  run('check-sfc.mjs', [f.target], 0);
  // 注释里说明旧类名不能被算作遗留代码，否则没人敢写这条注释
  await fs.writeFile(page, [
    '<template><router-view v-slot="{ Component }"><transition name="move">',
    '<component :is="Component" /></transition></router-view></template>',
    '<style>',
    '/* 旧版是 .move-enter / .move-leave，Vue 3 里不生效 */',
    '.move-enter-active { transition: opacity .15s }',
    '</style>',
    '',
  ].join('\n'), 'utf8');
  const commented = run('check-sfc.mjs', [f.target], 0);
  assert.match(commented.stdout, /0 处 Vue 2 类名/);
  // PascalCase <Transition> 与无 name 的 <transition>（默认前缀 v-）是最常见写法，漏掉等于规则失效
  await fs.writeFile(page, [
    '<template><Transition name="page"><div /></Transition><transition><div /></transition></template>',
    '<style>.page-enter { opacity: 0 } .v-enter { opacity: 0 }</style>',
    '',
  ].join('\n'), 'utf8');
  const aliases = run('check-sfc.mjs', [f.target], 1);
  assert.match(aliases.stderr, /\.page-enter/);
  assert.match(aliases.stderr, /\.v-enter/);
  assert.match(aliases.stderr, /默认前缀 v-/);
  assert.match(aliases.stdout, /2 处 Vue 2 类名/);
});
