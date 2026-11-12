import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { loadProject } from '../scripts/lib/source-state.mjs';
import {
  loadAcceptanceSettings, startRuntime, stopRuntime, getRuntimeStatus, isPortOpen,
} from '../scripts/lib/runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8');
function run(script, args, expected = 0) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { encoding: 'utf8', timeout: 60000 });
  assert.ifError(result.error);
  assert.equal(result.status, expected, `${script}\n${result.stdout}\n${result.stderr}`);
  return result;
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'vue-runtime-test-'));
  const source = path.join(temp, '源工程');
  const target = path.join(temp, '目标工程');
  await fs.mkdir(source);
  await fs.mkdir(target);
  await writeJson(path.join(source, 'package.json'), { name: 'legacy' });
  await writeJson(path.join(target, 'package.json'), { name: 'modern', scripts: { dev: 'node server.mjs' } });
  await fs.writeFile(path.join(target, 'server.mjs'), [
    "import http from 'node:http';",
    "const port = Number(process.env.PORT || 0);",
    "http.createServer((request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<div id=\"app\">ok</div>'); })",
    "  .listen(port, '127.0.0.1', () => console.log('runtime-ready', port));",
    '',
  ].join('\n'), 'utf8');
  run('init-control.mjs', [source]);
  const control = path.join(source, 'migration');
  const configFile = path.join(control, 'project.json');
  const port = await freePort();
  const config = await readJson(configFile);
  config.targetRoot = target;
  config.packageManager = 'npm';
  config.acceptance.command = ['node', 'server.mjs'];
  config.acceptance.port = port;
  config.acceptance.url = `http://127.0.0.1:${port}/`;
  config.acceptance.readyTimeoutMs = 20000;
  await writeJson(configFile, config);
  t.after(async () => {
    // 即使断言失败也要结束服务，避免测试留下监听端口。
    const project = await loadProject(control).catch(() => null);
    if (project) {
      const settings = loadAcceptanceSettings(project);
      await stopRuntime({ project, settings }).catch(() => {});
    }
    const actual = await fs.realpath(temp);
    assert.equal(path.dirname(actual), await fs.realpath(os.tmpdir()));
    await fs.rm(actual, { recursive: true, force: true });
  });
  return { temp, source, target, control, configFile, config, port };
}

test('托管启动、状态、日志、停止与端口释放可端到端执行', async t => {
  const f = await fixture(t);
  const start = run('serve-target.mjs', ['start', f.control]);
  assert.match(start.stdout, /已托管启动/);
  assert.equal(await isPortOpen('127.0.0.1', f.port), true);
  const logFile = path.join(f.control, 'evidence/runtime/target-server.log');
  let log = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    log = await fs.readFile(logFile, 'utf8').catch(() => '');
    if (log.includes('runtime-ready')) break;
    await sleep(100);
  }
  assert.match(log, /runtime-ready/, '运行中应能读取服务日志');
  const status = run('serve-target.mjs', ['status', f.control, '--json']);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.running, true);
  assert.equal(parsed.portOpen, true);
  assert.equal(parsed.http.status, 200);
  run('serve-target.mjs', ['stop', f.control]);
  assert.equal(await isPortOpen('127.0.0.1', f.port), false);
  const state = await readJson(path.join(f.control, 'runtime/target-runtime.json'));
  assert.equal(state.state, 'stopped');
  assert.equal(state.stop.portReleased, true);
  const secondStop = run('serve-target.mjs', ['stop', f.control]);
  assert.match(secondStop.stdout, /已停止|没有需要停止/);
});

test('端口冲突拒绝启动，运行状态不能写到控制目录外', async t => {
  const f = await fixture(t);
  const project = await loadProject(f.control);
  const settings = loadAcceptanceSettings(project);
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(f.port, '127.0.0.1', resolve));
  try {
    await assert.rejects(
      startRuntime({ project, settings, root: project.target, overrides: { state: 'runtime/busy.json', log: 'evidence/busy.log' } }),
      /已被占用/,
    );
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }
  const free = await freePort();
  const other = { ...settings, port: free, url: `http://127.0.0.1:${free}/` };
  await assert.rejects(
    startRuntime({ project, settings: other, root: project.target, overrides: { state: '../outside.json', log: 'evidence/outside.log' } }),
    /控制目录/,
  );
  await assert.rejects(
    startRuntime({ project, settings: { ...other, command: ['node', 'server.mjs'] }, root: project.target, overrides: { url: 'http://example.com/' } }),
    /回环地址/,
  );
});

test('启动失败不遗留进程，缺脚本时给出可用脚本', async t => {
  const f = await fixture(t);
  const project = await loadProject(f.control);
  const settings = loadAcceptanceSettings(project);
  const port = await freePort();
  const failing = {
    ...settings,
    port,
    url: `http://127.0.0.1:${port}/`,
    command: ['node', '-e', 'setTimeout(() => {}, 10000)'],
    readyTimeoutMs: 1200,
  };
  await assert.rejects(
    startRuntime({ project, settings: failing, root: project.target, overrides: { state: 'runtime/failed.json', log: 'evidence/failed.log' } }),
    /等待.*就绪超时|启动进程退出/,
  );
  assert.equal(await isPortOpen('127.0.0.1', port), false);
  const failed = await readJson(path.join(f.control, 'runtime/failed.json'));
  assert.equal(failed.state, 'failed');

  const missingScript = { ...settings, command: null, runScript: 'not-exists' };
  await assert.rejects(
    startRuntime({ project, settings: missingScript, root: project.target, overrides: { state: 'runtime/missing.json', log: 'evidence/missing.log' } }),
    /没有脚本/,
  );
  const status = await getRuntimeStatus({ project, settings, stateArg: 'runtime/no-such-state.json' });
  assert.equal(status.exists, false);
  assert.equal(status.running, false);
});
