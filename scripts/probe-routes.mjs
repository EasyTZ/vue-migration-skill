import fs from 'node:fs/promises';
import { loadProject } from './lib/source-state.mjs';
import { parseArgs, parsePositiveInteger } from './lib/cli.mjs';
import { readControlJson, resolveControlFile } from './lib/control-paths.mjs';
import { loadAcceptanceSettings, defaultUrl } from './lib/runtime.mjs';
import { normalizeRoutes } from './lib/routes.mjs';
import { probeRoutes } from './lib/http-probe.mjs';

const usage = `用法：node probe-routes.mjs <控制目录> <输出json> [--routes runtime/routes.json] [--base-url http://127.0.0.1:4175/] [--mode history|hash] [--mount '#app'] [--timeout 10000] [--allow-remote]

对本机运行中的目标工程逐个入口做 HTTP 巡检；只接受回环地址，远程环境需显式 --allow-remote。`;

try {
  const { options, positional } = parseArgs(process.argv.slice(2), {
    valued: ['routes', 'base-url', 'mode', 'mount', 'timeout'],
    flags: ['allow-remote'],
  });
  const [controlArg, outputArg] = positional;
  if (!controlArg || !outputArg || positional.length > 2) throw new Error(usage);
  const project = await loadProject(controlArg);
  const settings = loadAcceptanceSettings(project);
  const baseUrl = options['base-url'] ?? defaultUrl(settings);
  if (!baseUrl) throw new Error('缺少目标地址：在 project.json 填写 acceptance.url/port，或传入 --base-url');
  const routesRelative = options.routes ?? settings.routesFile;
  const document = await readControlJson(project, routesRelative, '验收路由表');
  const table = normalizeRoutes(document, { source: routesRelative, mode: options.mode ?? null });
  const report = await probeRoutes({
    baseUrl,
    routes: table.routes,
    mode: options.mode ?? table.mode ?? 'history',
    mountSelector: options.mount ?? settings.spaMountSelector,
    timeoutMs: parsePositiveInteger(options.timeout, 'timeout', 10000),
    allowRemote: options['allow-remote'] === true,
  });
  const output = await resolveControlFile(project, outputArg, { createParent: true });
  if (await fs.lstat(output).catch(() => null)) throw new Error(`输出已存在，不覆盖旧证据：${outputArg}`);
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(`HTTP 巡检：入口 ${report.summary.passed}/${report.summary.total} 通过，资源失败 ${report.summary.failedAssets}；${output}`);
  for (const route of report.routes.filter(item => item.status === 'failed')) {
    console.error(`失败 ${route.path}：${route.failures.join('；')}`);
  }
  if (report.root.status === 'failed') console.error(`入口根地址失败：${report.root.failures.join('；')}`);
  process.exitCode = report.summary.failed || report.root.status === 'failed' ? 2 : 0;
} catch (error) {
  console.error(`HTTP 巡检失败：${error.message}`);
  process.exitCode = 1;
}
