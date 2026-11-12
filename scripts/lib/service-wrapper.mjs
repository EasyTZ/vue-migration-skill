import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

// 内部辅助进程：由 serve-target 托管启动，负责把服务输出可靠地写入日志文件。
// 直接让 cmd 重定向会在 Windows 上独占日志文件；经此进程用流写入，日志可随时被读取。
const payload = process.argv[2];
if (!payload) {
  console.error('service-wrapper 由 serve-target.mjs 调用，不接受直接使用');
  process.exit(2);
}
let options;
try {
  options = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
} catch (error) {
  console.error(`service-wrapper 参数无效：${error.message}`);
  process.exit(2);
}
const { command, cwd, logFile } = options;
if (!Array.isArray(command) || !command.length || !cwd || !logFile) {
  console.error('service-wrapper 缺少 command/cwd/logFile');
  process.exit(2);
}
fs.mkdirSync(path.dirname(logFile), { recursive: true });
const output = fs.createWriteStream(logFile, { flags: 'a' });
output.write(`# ${new Date().toISOString()} ${command.join(' ')}\n`);

function quoteWindows(value) {
  const text = String(value);
  return /[\s"&|<>^]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const child = process.platform === 'win32'
  ? spawn(command.map(quoteWindows).join(' '), { cwd, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  : spawn(command[0], command.slice(1), { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });

child.stdout.pipe(output, { end: false });
child.stderr.pipe(output, { end: false });

let finished = false;
const finish = code => {
  if (finished) return;
  finished = true;
  output.end(() => process.exit(typeof code === 'number' ? code : 1));
};
child.once('exit', (code, signal) => finish(typeof code === 'number' ? code : signal ? 1 : 0));
child.once('error', error => {
  output.write(`# 启动失败：${error.message}\n`);
  finish(1);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    try { child.kill(signal); } catch { /* 已退出 */ }
  });
}
