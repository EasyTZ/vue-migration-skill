import fs from 'node:fs/promises';
import path from 'node:path';
import { loadProject } from './lib/source-state.mjs';
import { parseArgs, parsePositiveInteger } from './lib/cli.mjs';
import { readControlJson, resolveControlFile } from './lib/control-paths.mjs';
import { loadAcceptanceSettings, defaultUrl } from './lib/runtime.mjs';
import { normalizeRoutes } from './lib/routes.mjs';
import { runBrowserAudit } from './lib/browser.mjs';

const usage = `用法：node browser-audit.mjs <控制目录> <输出json> [选项]
  --routes runtime/routes.json          目标入口表（同一 id 同时用于基线对比）
  --scenarios runtime/scenarios.json    交互场景（基线采集时可省略）
  --base-url http://127.0.0.1:4175/     运行中的目标地址
  --mode history|hash
  --baseline evidence/baseline          与旧版基线对比
  --capture evidence/baseline           采集旧版基线（先对老工程运行）
  --source-paths                        基线采集时用路由表的 sourcePath 访问老工程（id 与目标对齐）
  --screens evidence/runs/r01/screens   截图目录，默认输出同目录 screens/
  --playwright <模块路径>               Playwright 入口；默认从 cwd 解析 playwright
  --channel chrome | --browser-executable <浏览器路径>
  --storage-state runtime/auth.json     登录态（控制目录内，默认不入库）
  --vite 之类参数不在此列：先启动服务，再运行本工具。
  --crawl / --no-crawl                  访问根页面后补审计同源菜单链接（默认开启）
  --allow-remote                        允许非回环地址（部署/测试环境，需授权）
  --viewport 1440x900 --timeout 15000`;

try {
  const { options, positional } = parseArgs(process.argv.slice(2), {
    valued: ['routes', 'scenarios', 'base-url', 'mode', 'baseline', 'capture', 'screens', 'playwright', 'channel', 'browser-executable', 'storage-state', 'viewport', 'timeout'],
    flags: ['crawl', 'no-crawl', 'source-paths', 'allow-remote'],
  });
  const [controlArg, outputArg] = positional;
  if (!controlArg || !outputArg || positional.length > 2) throw new Error(usage);
  const project = await loadProject(controlArg);
  const settings = loadAcceptanceSettings(project);
  const baseUrl = options['base-url'] ?? defaultUrl(settings);
  if (!baseUrl) throw new Error('缺少目标地址：填写 project.json 的 acceptance.url/port，或传入 --base-url');
  const routesRelative = options.routes ?? settings.routesFile;
  const table = normalizeRoutes(await readControlJson(project, routesRelative, '验收路由表'), { source: routesRelative, mode: options.mode ?? null });
  const auditRoutes = options['source-paths']
    ? table.routes.map(route => {
      if (!route.sourcePath) throw new Error(`路由 ${route.id} 没有 sourcePath，无法用 --source-paths 采集老工程基线`);
      if (route.sourcePath.split('/').some(segment => segment.startsWith(':') || segment === '*') || route.sourcePath.includes('${')) {
        throw new Error(`路由 ${route.id} 的 sourcePath 含动态参数：${route.sourcePath}；基线采集同样需要具体测试路径`);
      }
      return { ...route, targetPath: route.sourcePath };
    })
    : table.routes;
  let scenarios = [];
  let scenarioSource = options.scenarios ?? settings.scenariosFile;
  if (options.capture && !options.scenarios) scenarioSource = null;
  if (scenarioSource) {
    try {
      scenarios = await readControlJson(project, scenarioSource, '验收场景');
    } catch (error) {
      if (!options.capture) throw error;
      console.warn(`提醒：${error.message.split('\n')[0]}；基线采集不使用交互场景`);
    }
  }
  const output = await resolveControlFile(project, outputArg, { createParent: true });
  if (await fs.lstat(output).catch(() => null)) throw new Error(`输出已存在，不覆盖旧证据：${outputArg}`);
  const outputDirectory = path.dirname(output);
  const screensRelative = options.screens ?? path.relative(project.control, path.join(outputDirectory, 'screens')).split(path.sep).join('/');
  const screenshotDir = await resolveControlFile(project, screensRelative, { createParent: true });
  let baselineDir = null;
  let captureDir = null;
  if (options.baseline) baselineDir = await resolveControlFile(project, options.baseline);
  if (options.capture) captureDir = await resolveControlFile(project, options.capture, { createParent: true });
  let storageStateFile = null;
  if (options['storage-state']) storageStateFile = await resolveControlFile(project, options['storage-state']);
  const viewport = (() => {
    const match = /^(\d+)x(\d+)$/i.exec(options.viewport ?? '');
    if (!match) return settings.viewport ?? { width: 1440, height: 900 };
    return { width: Number(match[1]), height: Number(match[2]) };
  })();
  const report = await runBrowserAudit({
    baseUrl,
    routes: auditRoutes,
    scenarios,
    scenarioSource: scenarioSource ?? '（基线采集未使用）',
    mode: options.mode ?? table.mode ?? 'history',
    viewport,
    mountSelector: settings.spaMountSelector,
    baselineDir,
    captureDir,
    screenshotDir,
    storageStateFile,
    playwrightModule: options.playwright ?? settings.browser?.playwrightModule ?? null,
    channel: options.channel ?? settings.browser?.channel ?? null,
    executablePath: options['browser-executable'] ?? settings.browser?.executablePath ?? null,
    ignoreConsolePatterns: settings.ignoreConsolePatterns,
    ignoreRequestPatterns: settings.ignoreRequestPatterns,
    crawl: !options['no-crawl'],
    allowRemote: options['allow-remote'] === true,
    navigationTimeoutMs: parsePositiveInteger(options.timeout, 'timeout', 30000),
  });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  const summary = report.summary;
  console.log(`${report.browser.capture ? '基线采集' : '浏览器审计'}：入口渲染 ${summary.rendered}/${summary.routes}，场景 ${summary.scenarioPassed}/${summary.scenarioTotal} 通过，控制台错误 ${summary.consoleErrors}，请求失败 ${summary.failedRequests}；${output}`);
  if (report.baselineAvailable) console.log(`基线对比 ${summary.comparedRoutes} 条入口，平均相似度 ${(report.routes.filter(route => route.metrics.similarity !== null).reduce((total, route) => total + route.metrics.similarity, 0) / Math.max(1, summary.comparedRoutes)).toFixed(4)}`);
  for (const route of report.routes.filter(item => item.render === 'failed')) console.error(`入口失败 ${route.path}：${route.failureReasons.join('；')}`);
  for (const scenario of report.scenarios.filter(item => item.status === 'failed')) console.error(`场景失败 ${scenario.id}：${scenario.failures.map(failure => failure.message).join('；')}`);
  process.exitCode = summary.failed || summary.scenarioFailed || summary.setupFailed ? 2 : 0;
} catch (error) {
  console.error(`浏览器审计失败：${error.message}`);
  process.exitCode = 1;
}
