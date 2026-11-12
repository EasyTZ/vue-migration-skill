import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { samePath } from './source-state.mjs';
import { resolveControlFile } from './control-paths.mjs';
import { isLocalAddress } from './similarity.mjs';
import { parseJson } from './json.mjs';
import { splitCommandLine } from './cli.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const debug = (...args) => { if (process.env.MIGRATION_DEBUG) console.error('[runtime]', ...args); };

export function loadAcceptanceSettings(project) {
  const raw = project.config?.acceptance ?? {};
  const number = (value, fallback) => (value === null || value === undefined || value === '' ? fallback : Number(value));
  const list = value => {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string' && value.trim()) return splitCommandLine(value, 'acceptance 命令');
    return null;
  };
  const settings = {
    runScript: raw.runScript ?? 'dev',
    command: list(raw.command),
    args: list(raw.args) ?? [],
    host: raw.host ?? '127.0.0.1',
    port: Number.isInteger(raw.port) ? raw.port : (raw.port === null || raw.port === undefined ? null : Number(raw.port)),
    url: raw.url ?? null,
    readyTimeoutMs: number(raw.readyTimeoutMs, 120000),
    routesFile: raw.routesFile ?? 'runtime/routes.json',
    scenariosFile: raw.scenariosFile ?? 'runtime/scenarios.json',
    capabilityStatusFile: raw.capabilityStatusFile ?? 'runtime/capability-status.json',
    runtimeStateFile: raw.runtimeStateFile ?? 'runtime/target-runtime.json',
    serverLogFile: raw.serverLogFile ?? 'evidence/runtime/target-server.log',
    baselineDirectory: raw.baselineDirectory ?? 'evidence/baseline',
    runDirectory: raw.runDirectory ?? 'evidence/runs',
    minScore: number(raw.minScore, 0.99),
    minSimilarity: number(raw.minSimilarity, 0.9),
    requireBaseline: raw.requireBaseline !== false,
    requireRuntime: raw.requireRuntime !== false,
    baselineUnavailableApproved: raw.baselineUnavailableApproved === true,
    baselineUnavailableReason: raw.baselineUnavailableReason ?? null,
    spaMountSelector: raw.spaMountSelector ?? '#app',
    viewport: raw.viewport ?? { width: 1440, height: 900 },
    browser: raw.browser ?? {},
    ignoreConsolePatterns: Array.isArray(raw.ignoreConsolePatterns) ? raw.ignoreConsolePatterns : [],
    ignoreRequestPatterns: Array.isArray(raw.ignoreRequestPatterns) ? raw.ignoreRequestPatterns : [],
  };
  if (settings.port !== null && (!Number.isInteger(settings.port) || settings.port < 1 || settings.port > 65535)) {
    throw new Error('project.json 的 acceptance.port 必须是 1~65535 的整数');
  }
  for (const [key, value] of [['minScore', settings.minScore], ['minSimilarity', settings.minSimilarity]]) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`acceptance.${key} 必须在 0~1 之间`);
  }
  if (!Number.isFinite(settings.readyTimeoutMs) || settings.readyTimeoutMs < 1000) throw new Error('acceptance.readyTimeoutMs 至少为 1000');
  return settings;
}

export function defaultUrl(settings) {
  if (settings.url) return settings.url;
  if (!settings.port) return null;
  const host = ['0.0.0.0', '::'].includes(settings.host) ? '127.0.0.1' : settings.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${settings.port}/`;
}

function ensureLocalUrl(value) {
  if (!value) return null;
  if (!isLocalAddress(value)) throw new Error(`验收地址必须是本机回环地址（localhost/127.0.0.1/::1）：${value}`);
  return value;
}

const PLACEHOLDER_TOKENS = ['{port}', '{host}', '{url}'];

/** 构造启动命令。默认使用项目选定的包管理器运行 package.json 脚本。 */
export async function buildStartCommand({ project, settings, root, overrides = {} }) {
  const port = overrides.port ?? settings.port;
  const host = overrides.host ?? settings.host;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('请用 --port 或 project.json 的 acceptance.port 指定 1~65535 的端口');
  }
  const url = ensureLocalUrl(overrides.url ?? defaultUrl({ ...settings, port, host }));
  const substitute = token => PLACEHOLDER_TOKENS.reduce((value, placeholder) => value
    .replaceAll(placeholder, placeholder === '{port}' ? String(port) : placeholder === '{host}' ? host : url), String(token));
  const extraArgs = [...settings.args, ...(overrides.args ?? [])].map(substitute);
  const requestedCommand = overrides.command ?? settings.command;
  if (requestedCommand) {
    const command = requestedCommand.map(substitute);
    if (!command.length || !command[0]) throw new Error('--command 不能为空');
    return { command, program: command[0], args: command.slice(1), script: null, port, host, url };
  }
  const script = overrides.script ?? settings.runScript;
  if (!script) throw new Error('请在 project.json 的 acceptance.runScript 或 --script 指定启动脚本');
  let manifestText;
  try {
    manifestText = await fs.readFile(path.join(root, 'package.json'), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`工程根目录缺少 package.json：${root}\n改用 --command 指定实际启动命令`);
    throw error;
  }
  const manifest = parseJson(manifestText, 'package.json');
  const scripts = manifest?.scripts ?? {};
  if (!scripts[script]) throw new Error(`package.json 没有脚本 "${script}"；可用脚本：${Object.keys(scripts).join('、') || '无'}`);
  const packageManager = project.config?.packageManager ?? 'npm';
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(packageManager)) throw new Error(`不支持的 packageManager：${packageManager}`);
  const program = process.platform === 'win32' && ['npm', 'pnpm', 'yarn'].includes(packageManager) ? `${packageManager}.cmd` : packageManager;
  const command = [program, 'run', script, ...extraArgs];
  return { command, program, args: command.slice(1), script, port, host, url };
}

export function isPortOpen(host, port, timeoutMs = 1000) {
  return new Promise(resolve => {
    const socket = net.connect({ host, port });
    const finish = result => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function probeHttp(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual', headers: { accept: 'text/html,*/*' } });
    await response.arrayBuffer().catch(() => {});
    return { ok: true, status: response.status };
  } catch (error) {
    return { ok: false, status: null, error: error.name === 'AbortError' ? `超时（${timeoutMs}ms）` : error.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function waitForPortState(host, port, shouldBeOpen, timeoutMs = 15000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await isPortOpen(host, port)) === shouldBeOpen) return true;
    await sleep(intervalMs);
  }
  return false;
}

const SERVICE_WRAPPER = new URL('./service-wrapper.mjs', import.meta.url);

function spawnService({ command, cwd, env, logFile }) {
  // 由内部 wrapper 持有服务进程并转发输出：日志用普通文件流写入，
  // 运行中也能被读取；停止时 taskkill /T 或进程组信号会一起收掉整棵树。
  const payload = Buffer.from(JSON.stringify({ command, cwd, logFile }), 'utf8').toString('base64url');
  return spawn(process.execPath, [fileURLToPath(SERVICE_WRAPPER), payload], {
    cwd, env, detached: true, windowsHide: true, stdio: 'ignore',
  });
}

export function killProcessTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { killed: false, detail: '没有可结束的进程号' };
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
    return { killed: result.status === 0, detail: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try { process.kill(pid, 'SIGTERM'); } catch { return { killed: false, detail: '进程不存在' }; }
  }
  return { killed: true, detail: '已发送 SIGTERM' };
}

async function readLogTail(file, maxBytes = 6000) {
  try {
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat();
      const length = Math.min(maxBytes, stat.size);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, stat.size - length));
      return buffer.toString('utf8').trim();
    } finally { await handle.close(); }
  } catch { return ''; }
}

async function writeRuntimeState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(state, null, 2) + '\n', { encoding: 'utf8' });
}

export async function readRuntimeState(project, relative) {
  let file;
  try {
    file = await resolveControlFile(project, relative);
  } catch (error) {
    if (error.code === 'ENOENT') return { file: path.join(project.control, relative), state: null };
    throw error;
  }
  try {
    return { file, state: parseJson(await fs.readFile(file, 'utf8'), `运行状态（${relative}）`) };
  } catch (error) {
    if (error.code === 'ENOENT') return { file, state: null };
    throw error;
  }
}

/**
 * 托管启动：拉起目标工程、等待 HTTP 就绪、把 PID/端口/日志/状态写入控制目录。
 * 拒绝占用已被占用的端口，不擅自结束未知进程。
 */
export async function startRuntime({ project, settings, root = project.target, overrides = {} }) {
  if (!root) throw new Error('请先在 project.json 填写 targetRoot，或用 --root 指定要启动的工程目录');
  const resolvedRoot = await fs.realpath(root).catch(() => { throw new Error(`工程目录不存在：${path.resolve(root)}`); });
  if (!(await fs.stat(resolvedRoot)).isDirectory()) throw new Error('--root 必须是工程目录');
  if (samePath(resolvedRoot, project.control)) throw new Error('不能把控制目录当作运行根目录');
  const resolved = await buildStartCommand({ project, settings, root: resolvedRoot, overrides });
  const { port, host, url } = resolved;
  if (await isPortOpen(host, port)) {
    throw new Error(`端口 ${port} 已被占用：先结束占用进程或改用其它端口（本工具不会结束未知进程）`);
  }
  const stateFile = await resolveControlFile(project, overrides.state ?? settings.runtimeStateFile, { createParent: true });
  const logFile = await resolveControlFile(project, overrides.log ?? settings.serverLogFile, { createParent: true });
  await fs.mkdir(path.dirname(logFile), { recursive: true });
  await fs.writeFile(logFile, '', 'utf8');
  const state = {
    schemaVersion: 1, kind: 'runtime-state', state: 'starting',
    root: resolvedRoot, command: resolved.command, script: resolved.script,
    host, port, url, pid: null,
    startedAt: new Date().toISOString(), readyAt: null, stoppedAt: null,
    stateFile, logFile,
  };
  await writeRuntimeState(stateFile, state);
  const environment = {
    ...process.env, PORT: String(port), HOST: host, BROWSER: 'none', FORCE_COLOR: '0', NO_COLOR: '1', CI: '1',
  };
  let child;
  let spawned;
  child = spawnService({ command: resolved.command, cwd: resolvedRoot, env: environment, logFile });
  // 必须在任何 await 之前挂监听：spawn 事件可能在写状态文件时已经发出。
  spawned = new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  state.pid = Number.isInteger(child.pid) ? child.pid : null;
  await writeRuntimeState(stateFile, state);

  let spawnError = null;
  try {
    await spawned;
    debug('子进程已启动', state.pid);
  } catch (error) {
    spawnError = error;
  }

  const timeoutMs = overrides.readyTimeout ?? settings.readyTimeoutMs;
  const deadline = Date.now() + timeoutMs;
  let ready = null;
  let lastError = null;
  let exited = null;
  while (!spawnError && Date.now() < deadline) {
    if (child.exitCode !== null) { exited = child.exitCode; break; }
    const probe = await probeHttp(url);
    if (probe.ok) { ready = probe; break; }
    lastError = probe.error ?? `HTTP ${probe.status}`;
    debug('尚未就绪', probe.status ?? probe.error);
    await sleep(300);
  }
  if (!ready) {
    killProcessTree(state.pid);
    const logTail = await readLogTail(logFile);
    state.state = 'failed';
    state.failedAt = new Date().toISOString();
    state.error = spawnError ? spawnError.message : exited !== null ? `启动进程退出，退出码 ${exited}` : `等待 ${url} 就绪超时（${timeoutMs}ms）：${lastError}`;
    await writeRuntimeState(stateFile, state);
    throw new Error(`${state.error}\n启动命令：${resolved.command.join(' ')}\n日志：${path.relative(project.control, logFile)}\n${logTail}`);
  }
  state.state = 'running';
  state.readyAt = new Date().toISOString();
  state.readyStatus = ready.status;
  await writeRuntimeState(stateFile, state);
  child.unref();
  return { state, stateFile, logFile };
}

/** 结束托管服务并核对端口释放；不结束状态文件之外的进程。 */
export async function stopRuntime({ project, settings, stateArg = null, timeoutMs = 15000 }) {
  const relative = stateArg ?? settings.runtimeStateFile;
  let stateFile;
  try {
    stateFile = await resolveControlFile(project, relative);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { existed: false, stopped: true, stateFile: path.join(project.control, relative), portReleased: true, processAlive: false, warnings: ['状态文件不存在：未发现本工具启动的服务'] };
    }
    throw error;
  }
  let state;
  try {
    state = parseJson(await fs.readFile(stateFile, 'utf8'), `运行状态（${relative}）`);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { existed: false, stopped: true, stateFile, portReleased: true, processAlive: false, warnings: ['状态文件不存在：未发现本工具启动的服务'] };
    }
    throw error;
  }
  const pid = Number(state.pid);
  const port = Number(state.port);
  const host = state.host ?? '127.0.0.1';
  const warnings = [];
  let processAlive = isProcessAlive(pid);
  const initiallyAlive = processAlive;
  let killed = false;
  if (processAlive) {
    const result = killProcessTree(pid);
    killed = result.killed;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && isProcessAlive(pid)) await sleep(150);
    if (isProcessAlive(pid) && process.platform !== 'win32') {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* 已退出 */ } }
      const forceDeadline = Date.now() + 3000;
      while (Date.now() < forceDeadline && isProcessAlive(pid)) await sleep(150);
    }
    processAlive = isProcessAlive(pid);
    if (processAlive) warnings.push(`进程 ${pid} 仍未结束，请人工核查`);
  }
  let portReleased = true;
  if (Number.isInteger(port) && port > 0) {
    portReleased = await waitForPortState(host, port, false, timeoutMs);
  }
  if (!processAlive && !portReleased) warnings.push(`端口 ${port} 仍被占用，可能不是本次启动的进程，未擅自结束`);
  if (!initiallyAlive && state.state === 'running') warnings.push('记录中的进程已不存在，可能已提前退出');
  state.state = processAlive || !portReleased ? 'stop-failed' : 'stopped';
  state.stoppedAt = state.state === 'stopped' ? new Date().toISOString() : state.stoppedAt ?? null;
  state.stop = { killed, processAlive, portReleased, checkedAt: new Date().toISOString() };
  await writeRuntimeState(stateFile, state);
  return { existed: true, stopped: state.state === 'stopped', state, stateFile, portReleased, processAlive, killed, warnings };
}

export async function getRuntimeStatus({ project, settings, stateArg = null, probe = true }) {
  const relative = stateArg ?? settings.runtimeStateFile;
  const { file, state } = await readRuntimeState(project, relative);
  if (!state) return { exists: false, stateFile: file, running: false, detail: '状态文件不存在，尚未托管启动' };
  const pid = Number(state.pid);
  const port = Number(state.port);
  const processAlive = isProcessAlive(pid);
  const portOpen = Number.isInteger(port) ? await isPortOpen(state.host ?? '127.0.0.1', port) : false;
  const http = probe && state.url ? await probeHttp(state.url) : null;
  return {
    exists: true, stateFile: file, recordedState: state.state, running: processAlive && portOpen,
    pid, port, url: state.url ?? null, logFile: state.logFile ?? null,
    processAlive, portOpen, http, startedAt: state.startedAt ?? null, readyAt: state.readyAt ?? null,
  };
}
