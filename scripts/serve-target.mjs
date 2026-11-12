import { loadProject } from './lib/source-state.mjs';
import { parseArgs, parseCommandArgument, parsePositiveInteger } from './lib/cli.mjs';
import {
  loadAcceptanceSettings, startRuntime, stopRuntime, getRuntimeStatus,
} from './lib/runtime.mjs';

const usage = `用法：
  node serve-target.mjs start <控制目录> [--root 工程目录] [--script dev] [--port 4175] [--host 127.0.0.1] [--url http://127.0.0.1:4175/]
      [--command '["npm","run","dev"]'] [--args '["--","--port","{port}"]'] [--state runtime/target-runtime.json] [--log evidence/runtime/target.log] [--ready-timeout 120000]
  node serve-target.mjs status <控制目录> [--state runtime/target-runtime.json] [--json]
  node serve-target.mjs stop <控制目录> [--state runtime/target-runtime.json]

说明：只启动本机回环地址；状态、日志、PID 全部写在控制目录，关闭后核对端口释放。`;

try {
  const { options, positional } = parseArgs(process.argv.slice(2), {
    valued: ['root', 'script', 'port', 'host', 'url', 'command', 'args', 'state', 'log', 'ready-timeout'],
    flags: ['json'],
  });
  const [action, controlArg] = positional;
  if (!action || !controlArg || positional.length > 2) throw new Error(usage);
  const project = await loadProject(controlArg);
  const settings = loadAcceptanceSettings(project);
  const overrides = {};
  if (options.root) overrides.root = options.root;
  if (options.script) overrides.script = options.script;
  if (options.port) overrides.port = parsePositiveInteger(options.port, 'port');
  if (options.host) overrides.host = options.host;
  if (options.url) overrides.url = options.url;
  if (options.command) overrides.command = parseCommandArgument(options.command, 'command');
  if (options.args) overrides.args = parseCommandArgument(options.args, 'args');
  if (options['ready-timeout']) overrides.readyTimeout = parsePositiveInteger(options['ready-timeout'], 'ready-timeout');

  if (action === 'start') {
    const result = await startRuntime({
      project, settings,
      root: overrides.root ?? project.target,
      overrides: { ...overrides, state: options.state, log: options.log },
    });
    console.log(`已托管启动：${result.state.url}（PID ${result.state.pid}）`);
    console.log(`状态：${result.stateFile}`);
    console.log(`日志：${result.logFile}`);
    console.log('结束前务必执行 stop，并确认端口已释放。');
  } else if (action === 'status') {
    const status = await getRuntimeStatus({ project, settings, stateArg: options.state });
    if (options.json) console.log(JSON.stringify(status, null, 2));
    else {
      console.log(status.exists
        ? `状态：${status.recordedState}；进程${status.processAlive ? '存活' : '不在'}；端口${status.portOpen ? '监听' : '未监听'}；HTTP ${status.http?.ok ? status.http.status : status.http?.error ?? '未探测'}`
        : `未托管启动：${status.stateFile}`);
      if (status.url) console.log(`地址：${status.url}`);
      if (status.logFile) console.log(`日志：${status.logFile}`);
    }
    process.exitCode = status.running && status.http?.ok ? 0 : 2;
  } else if (action === 'stop') {
    const result = await stopRuntime({ project, settings, stateArg: options.state });
    for (const warning of result.warnings) console.warn(`提醒：${warning}`);
    console.log(result.existed
      ? `已停止：端口${result.portReleased ? '已释放' : '仍被占用'}；进程${result.processAlive ? '仍在' : '已结束'}；状态文件 ${result.stateFile}`
      : `没有需要停止的服务：${result.stateFile}`);
    process.exitCode = result.stopped && result.portReleased ? 0 : 2;
  } else {
    throw new Error(`未知动作：${action}\n${usage}`);
  }
} catch (error) {
  console.error(`托管运行命令失败：${error.message}`);
  process.exitCode = 1;
}
