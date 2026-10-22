import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { scanSource, fingerprintFiles } from '../scripts/lib/source-state.mjs';
import { buildReport, renderReport } from '../scripts/lib/migration-report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clone = value => structuredClone(value);
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value), 'utf8');
function run(script, args, expected = 0) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { encoding: 'utf8', timeout: 20000 });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${script}\n${result.stdout}\n${result.stderr}`);
  return result;
}
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vue-report-test-'));
  t.after(async () => {
    const actual = await fs.realpath(temp);
    assert.equal(path.dirname(actual), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(actual).startsWith('vue-report-test-'));
    await fs.rm(actual, { recursive: true, force: true });
  });
  const source = path.join(temp, '源工程');
  const target = path.join(temp, '目标工程');
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.mkdir(path.join(target, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'src/App.vue'), '<template>旧应用</template>', 'utf8');
  await fs.writeFile(path.join(target, 'src/App.vue'), '<template>新应用</template>', 'utf8');
  run('init-control.mjs', [source]);
  const control = path.join(source, 'migration');
  const configFile = path.join(control, 'project.json');
  const config = JSON.parse(await fs.readFile(configFile, 'utf8'));
  config.targetRoot = target;
  await writeJson(configFile, config);
  await fs.writeFile(path.join(control, 'evidence/check.txt'), '合成检查记录：仅验证报告引用与闭环规则。', 'utf8');
  const project = { control, source, target, config };
  const snapshot = await scanSource(project);
  await writeJson(path.join(control, 'inventory/base.json'), snapshot);
  const template = JSON.parse(await fs.readFile(path.join(root, 'assets/migration-status.example.json'), 'utf8'));
  const evidence = ['evidence/check.txt'];
  const ledger = {
    ...template, baselineSnapshot: 'inventory/base.json', entriesReviewed: true, architectureReviewed: true,
    files: snapshot.files.map(file => ({ source: file.path, sourceSha256: file.sha256, targets: ['src/App.vue'], disposition: 'mapped', stage: 'verified', evidence })),
    entries: [{ id: 'main', status: 'verified', sourceFiles: ['src/App.vue'], targets: ['src/App.vue'], evidence }],
    architecture: [{ id: 'runtime', status: 'verified', evidence }],
    checks: ['lint', 'static', 'test', 'build'].map(kind => ({ id: kind, kind, status: 'passed', command: `synthetic-${kind}`, exitCode: 0, executedAt: '2026-10-22T00:00:00Z', testCount: kind === 'test' ? 1 : undefined, evidence })),
    bugs: [{ id: 'BUG-1', status: 'fixed', expected: '零值仍为有效值', basis: '合成样板契约', evidence }],
  };
  return { temp, project, snapshot, ledger, template };
}

test('报告仅在源覆盖、入口、架构、检查与缺陷记录完整时满足复核条件', async t => {
  const f = await fixture(t);
  const report = await buildReport(f.project, f.snapshot, f.snapshot, f.ledger);
  assert.equal(report.reviewReady, true);
  assert.equal(report.summary.completedFiles, f.snapshot.files.length);
  assert.equal(report.summary.completedChecks, 4);
  assert.equal(report.summary.completedBugs, 1);
  assert.deepEqual(report.problems, []);
  assert.equal(report.sourceChanged, false);
  assert.equal(report.accepted, undefined, '工具不应自动给出业务人工验收结论');
  assert.match(renderReport(report), /仍需审查证据/);

  const pending = clone(f.ledger);
  pending.entriesReviewed = false;
  pending.files[0].stage = 'pending';
  pending.checks[0].status = 'pending';
  const incomplete = await buildReport(f.project, f.snapshot, f.snapshot, pending);
  assert.equal(incomplete.reviewReady, false);
  assert.equal(incomplete.summary.completedFiles, 0);
  assert.equal(incomplete.summary.completedChecks, 3);
});

test('未登记文件、源文件新增删除和内容变化不会延用旧的全绿结果', async t => {
  const f = await fixture(t);
  const missing = clone(f.ledger);
  missing.files = [];
  const uncovered = await buildReport(f.project, f.snapshot, f.snapshot, missing);
  assert.equal(uncovered.reviewReady, false);
  assert.deepEqual(uncovered.uncovered, ['src/App.vue']);

  await fs.writeFile(path.join(f.project.source, 'src/App.vue'), '<template>源已变更</template>', 'utf8');
  await fs.writeFile(path.join(f.project.source, 'new.json'), '{}', 'utf8');
  const changed = await buildReport(f.project, f.snapshot, await scanSource(f.project), f.ledger);
  assert.equal(changed.reviewReady, false);
  assert.equal(changed.sourceChanged, true);
  assert.equal(changed.summary.staleFiles, 1);
  assert.ok(changed.delta.changed.includes('new.json'));
  assert.equal(changed.files[0].complete, false);

  await fs.unlink(path.join(f.project.source, 'src/App.vue'));
  const deleted = await buildReport(f.project, f.snapshot, await scanSource(f.project), f.ledger);
  assert.ok(deleted.delta.deleted.includes('src/App.vue'));
  assert.equal(deleted.reviewReady, false);
});

test('伪造通过声明不能绕过退出码、执行时间、非零测试数及证据约束', async t => {
  const f = await fixture(t);
  const changes = [
    ledger => { ledger.checks[0].evidence = []; },
    ledger => { ledger.checks[0].exitCode = 1; },
    ledger => { ledger.checks[0].executedAt = '不是时间'; },
    ledger => { ledger.checks[0].command = ''; },
    ledger => { ledger.checks.find(row => row.kind === 'test').testCount = 0; },
    ledger => { ledger.checks = ledger.checks.filter(row => row.kind !== 'build'); },
    ledger => { ledger.bugs[0].basis = ''; },
  ];
  for (const mutate of changes) {
    const ledger = clone(f.ledger);
    mutate(ledger);
    assert.equal((await buildReport(f.project, f.snapshot, f.snapshot, ledger)).reviewReady, false);
  }
});

test('入口关联、目标边界和证据边界需有真实目录内文件支持', async t => {
  const f = await fixture(t);
  const changes = [
    ledger => { ledger.entries[0].sourceFiles = ['missing.vue']; },
    ledger => { ledger.entries[0].sourceFiles = []; },
    ledger => { ledger.entries[0].sourceFiles = 'src/App.vue'; },
    ledger => { ledger.entries[0].targets = ['../源工程/src/App.vue']; },
    ledger => { ledger.files[0].targets = ['missing.vue']; },
    ledger => { ledger.architecture[0].evidence = ['../src/App.vue']; },
    ledger => { ledger.files[0].evidence = [path.join(f.temp, 'outside.txt')]; },
  ];
  for (const mutate of changes) {
    const ledger = clone(f.ledger);
    mutate(ledger);
    assert.equal((await buildReport(f.project, f.snapshot, f.snapshot, ledger)).reviewReady, false);
  }
});

test('经目录链接越界的证据和目标文件仍不可作为闭环依据', async t => {
  const f = await fixture(t);
  const outside = path.join(f.temp, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'proof.txt'), '外部文件', 'utf8');
  const link = path.join(f.project.control, 'evidence/external');
  try { await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) return t.skip('当前文件系统不允许创建目录链接');
    throw error;
  }
  const ledger = clone(f.ledger);
  ledger.files[0].evidence = ['evidence/external/proof.txt'];
  assert.equal((await buildReport(f.project, f.snapshot, f.snapshot, ledger)).reviewReady, false);
  await fs.symlink(outside, path.join(f.project.target, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
  ledger.files[0].evidence = ['evidence/check.txt'];
  ledger.files[0].targets = ['external/proof.txt'];
  assert.equal((await buildReport(f.project, f.snapshot, f.snapshot, ledger)).reviewReady, false);
});

test('不迁移决定和不适用检查也必须有理由、验证状态和证据', async t => {
  const f = await fixture(t);
  const ledger = clone(f.ledger);
  ledger.entries = [];
  Object.assign(ledger.files[0], { targets: [], disposition: 'omitted', reason: '经检查该源文件已无入口', stage: 'verified' });
  Object.assign(ledger.checks[0], { status: 'not-applicable', reason: '合成评测的独立适用性依据' });
  assert.equal((await buildReport(f.project, f.snapshot, f.snapshot, ledger)).reviewReady, true);
  for (const mutate of [
    value => { value.files[0].reason = ''; },
    value => { value.files[0].stage = 'blocked'; },
    value => { value.files[0].evidence = []; },
    value => { value.checks[0].reason = ''; },
  ]) {
    const invalid = clone(ledger);
    mutate(invalid);
    assert.equal((await buildReport(f.project, f.snapshot, f.snapshot, invalid)).reviewReady, false);
  }
});

test('重复记录与不受支持的状态或快照格式不能生成有效全绿报告', async t => {
  const f = await fixture(t);
  for (const key of ['files', 'entries', 'architecture', 'checks', 'bugs']) {
    const ledger = clone(f.ledger);
    ledger[key].push(clone(ledger[key][0]));
    assert.equal((await buildReport(f.project, f.snapshot, f.snapshot, ledger)).reviewReady, false);
  }
  const invalidLedger = clone(f.ledger);
  invalidLedger.schemaVersion = 999;
  await assert.rejects(buildReport(f.project, f.snapshot, f.snapshot, invalidLedger));
  const invalidSnapshot = clone(f.snapshot);
  invalidSnapshot.files[0].path = '../escape';
  invalidSnapshot.fingerprint = fingerprintFiles(invalidSnapshot.files);
  await assert.rejects(buildReport(f.project, invalidSnapshot, f.snapshot, f.ledger));
  const tampered = clone(f.snapshot);
  tampered.files[0].sha256 = '0'.repeat(64);
  await assert.rejects(buildReport(f.project, tampered, f.snapshot, f.ledger));
});

test('状态与报告 CLI 保留人工状态，输出控制目录且以退出码区分缺口', async t => {
  const f = await fixture(t);
  run('init-status.mjs', [f.project.control, 'inventory/base.json']);
  const stateFile = path.join(f.project.control, 'migration-status.json');
  const initial = await fs.readFile(stateFile, 'utf8');
  const state = JSON.parse(initial);
  assert.equal(state.files.length, f.snapshot.files.length);
  assert.ok(state.files.every(row => row.stage === 'pending'));
  run('init-status.mjs', [f.project.control, 'inventory/base.json'], 1);
  assert.equal(await fs.readFile(stateFile, 'utf8'), initial);
  run('migration-report.mjs', [f.project.control, 'migration-status.json', 'pending.json', 'pending.md'], 2);
  const pendingOutput = await fs.readFile(path.join(f.project.control, 'pending.json'), 'utf8');
  assert.equal(JSON.parse(pendingOutput).reviewReady, false);
  run('migration-report.mjs', [f.project.control, 'migration-status.json', 'pending.json', 'other.md'], 1);
  assert.equal(await fs.readFile(path.join(f.project.control, 'pending.json'), 'utf8'), pendingOutput);
  await assert.rejects(fs.access(path.join(f.project.control, 'other.md')));
  run('migration-report.mjs', [f.project.control, 'migration-status.json', '../escape.json', 'escape.md'], 1);
  await assert.rejects(fs.access(path.join(f.project.source, 'escape.json')));
  await writeJson(stateFile, f.ledger);
  run('migration-report.mjs', [f.project.control, 'migration-status.json', 'ready.json', 'ready.md']);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.project.control, 'ready.json'), 'utf8')).reviewReady, true);
  assert.equal(await fs.readFile(stateFile, 'utf8'), JSON.stringify(f.ledger));
});

test('边界检查识别新工具真实产物，但不把同名业务字段当作迁移资料', async t => {
  const f = await fixture(t);
  await writeJson(path.join(f.project.control, 'migration-status.json'), f.ledger);
  run('check-source.mjs', [f.project.control, 'inventory/base.json', 'delta.json']);
  run('migration-report.mjs', [f.project.control, 'migration-status.json', 'coverage.json', 'coverage.md']);
  const businessFile = path.join(f.project.target, 'business.json');
  const business = { sourceRoot: '/业务数据路径', componentCount: 12, name: '合成业务统计' };
  await writeJson(businessFile, business);
  run('check-boundary.mjs', [f.project.control, f.project.target]);
  assert.deepEqual(JSON.parse(await fs.readFile(businessFile, 'utf8')), business);

  const copied = path.join(f.project.target, 'arbitrary-name.json');
  for (const artifact of ['inventory/base.json', 'migration-status.json', 'delta.json', 'coverage.json']) {
    const original = await fs.readFile(path.join(f.project.control, artifact), 'utf8');
    await fs.writeFile(copied, original, 'utf8');
    run('check-boundary.mjs', [f.project.control, f.project.target], 1);
    assert.equal(await fs.readFile(copied, 'utf8'), original, '检查器不能自动修改误放文件');
    await fs.unlink(copied);
  }
  run('check-boundary.mjs', [f.project.control, f.project.target]);
});
