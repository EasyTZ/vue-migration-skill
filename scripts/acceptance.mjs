import fs from 'node:fs/promises';
import path from 'node:path';
import { loadProject, samePath } from './lib/source-state.mjs';
import { parseArgs, parseCommandArgument, parsePositiveInteger, parseUnitInterval, timestampId } from './lib/cli.mjs';
import { readControlJson, resolveControlFile } from './lib/control-paths.mjs';
import { loadAcceptanceSettings, startRuntime, stopRuntime, probeHttp, defaultUrl } from './lib/runtime.mjs';
import { extractCapabilities } from './lib/capabilities.mjs';
import { seedAcceptanceFiles } from './lib/acceptance-seed.mjs';
import { normalizeRoutes } from './lib/routes.mjs';
import { probeRoutes } from './lib/http-probe.mjs';
import { runBrowserAudit } from './lib/browser.mjs';
import { buildAcceptance, renderAcceptance, DIMENSION_LABELS } from './lib/fidelity.mjs';
import { isLocalAddress } from './lib/similarity.mjs';

const usage = `用法：node acceptance.mjs <控制目录> [选项]
  --run-id r01                 本次运行目录名（默认时间戳），已存在则拒绝覆盖
  --port 4175 --script dev --command "npm run dev" --args "-- --port {port}"
  --base-url http://127.0.0.1:4175/     覆盖 project.json 的 acceptance.url
  --playwright <模块路径> --channel chrome --browser-executable <浏览器路径>
  --storage-state runtime/auth.json     登录态（控制目录内）
  --threshold 0.99 --min-similarity 0.9
  --no-crawl                   不补审计页面里的同源链接
  --no-manage                  使用已运行的外部服务（不提供托管停止证据）

执行顺序：能力抽取/种子补齐 → 托管启动 → HTTP 巡检 → 浏览器审计 → 停止并核对端口 → 复原度报告。
任一步失败都会留下证据并停止服务；不会把未执行的项目写成通过。`;

const isMissing = error => /^缺少 /.test(error.message);
async function optionalJson(project, relative, label) {
  try { return await readControlJson(project, relative, label); } catch (error) { if (isMissing(error)) return null; throw error; }
}

let activeRuntime = null;
let runtimeStopped = false;
const cleanupRuntime = async () => {
  if (!activeRuntime || runtimeStopped) return;
  runtimeStopped = true;
  try {
    const result = await stopRuntime({ project: activeRuntime.project, settings: activeRuntime.settings, stateArg: activeRuntime.stateRelative });
    for (const warning of result.warnings) console.warn(`提醒：${warning}`);
  } catch (error) {
    console.error(`停止托管服务失败：${error.message}`);
  }
};
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.warn(`收到 ${signal}，先停止托管服务……`);
    await cleanupRuntime();
    process.exit(130);
  });
}

try {
  const { options, positional } = parseArgs(process.argv.slice(2), {
    valued: ['run-id', 'port', 'script', 'command', 'args', 'base-url', 'playwright', 'channel', 'browser-executable', 'storage-state', 'threshold', 'min-similarity', 'ready-timeout'],
    flags: ['no-crawl', 'no-manage'],
  });
  const [controlArg] = positional;
  if (!controlArg || positional.length > 1) throw new Error(usage);
  const project = await loadProject(controlArg);
  if (!project.target) throw new Error('请先在 project.json 填写 targetRoot（目标工程路径）');
  const settings = loadAcceptanceSettings(project);
  const baseUrl = options['base-url'] ?? defaultUrl(settings);
  if (!baseUrl) throw new Error('缺少目标地址：填写 acceptance.url/port，或传入 --base-url');
  if (!isLocalAddress(baseUrl)) throw new Error(`自动化验收只允许本机回环地址：${baseUrl}；远程环境请使用部署验证流程并显式授权`);

  const runId = options['run-id'] ?? timestampId();
  if (!/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('--run-id 只能包含字母、数字、点、下划线和短横线');
  const runRelative = `${settings.runDirectory}/${runId}`;
  const runParent = await resolveControlFile(project, `${settings.runDirectory}/placeholder`, { createParent: true }).then(file => path.dirname(file));
  const runDirectory = path.join(runParent, runId);
  try {
    await fs.mkdir(runDirectory);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`运行目录已存在，不覆盖旧证据：${runRelative}`);
    throw error;
  }
  const screensDirectory = path.join(runDirectory, 'screens');
  await fs.mkdir(screensDirectory, { recursive: true });

  // 1. 能力清单与验收种子
  let capabilitiesRelative = 'inventory/capabilities.json';
  let capabilities = await optionalJson(project, capabilitiesRelative, '能力清单');
  if (capabilities) {
    if (capabilities.kind !== 'capability-inventory') throw new Error(`${capabilitiesRelative} 不是能力清单（kind=${capabilities.kind ?? '缺失'}）`);
    if (!capabilities.sourceRoot || !samePath(capabilities.sourceRoot, project.source)) {
      throw new Error(`能力清单来自其它源工程：${capabilities.sourceRoot ?? '未知'}；请换文件名重新抽取，避免沿用旧结论`);
    }
  }
  if (!capabilities) {
    capabilities = await extractCapabilities(project);
    const output = await resolveControlFile(project, capabilitiesRelative, { createParent: true });
    await fs.writeFile(output, JSON.stringify(capabilities, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    console.log(`能力清单不存在，已自动抽取：${capabilitiesRelative}`);
  }
  const seeded = await seedAcceptanceFiles(project, capabilities);
  if (seeded.created.length) console.log(`已生成验收种子：${seeded.created.join('、')}（需回读复核）`);
  const routesRelative = settings.routesFile;
  const routes = normalizeRoutes(await readControlJson(project, routesRelative, '验收路由表'), { source: routesRelative });
  if (!routes.routes.length) throw new Error('验收路由表为空：请先按源工程入口填写 runtime/routes.json');
  const scenarios = await readControlJson(project, settings.scenariosFile, '验收场景');
  const capabilityStatus = await optionalJson(project, settings.capabilityStatusFile, '能力核对状态');
  const acceptedDifferences = project.config.acceptedDifferences ?? [];
  let baselineDir = null;
  try {
    const stat = await fs.stat(await resolveControlFile(project, settings.baselineDirectory));
    if (stat.isDirectory()) baselineDir = await resolveControlFile(project, settings.baselineDirectory);
  } catch { baselineDir = null; }
  if (!baselineDir) console.warn(`提醒：没有旧版基线目录 ${settings.baselineDirectory}；视觉维度会阻塞，直到采集基线或由用户批准降级。`);

  // 2. 托管启动
  const overrides = {
    port: options.port ? parsePositiveInteger(options.port, 'port') : undefined,
    script: options.script,
    command: options.command ? parseCommandArgument(options.command, 'command') : undefined,
    args: options.args ? parseCommandArgument(options.args, 'args') : undefined,
    url: options['base-url'],
    readyTimeout: options['ready-timeout'] ? parsePositiveInteger(options['ready-timeout'], 'ready-timeout') : undefined,
  };
  let runtime = null;
  let runtimeStateRelative = settings.runtimeStateFile;
  if (options['no-manage']) {
    const probe = await probeHttp(baseUrl);
    if (!probe.ok) throw new Error(`外部服务不可用：${baseUrl}（${probe.error ?? probe.status}）；先启动服务或去掉 --no-manage`);
    console.log(`使用外部已启动服务：${baseUrl}（无托管停止证据）`);
  } else {
    const started = await startRuntime({ project, settings, root: project.target, overrides: { ...overrides, state: runtimeStateRelative, log: settings.serverLogFile } });
    activeRuntime = { project, settings, stateRelative: runtimeStateRelative };
    runtimeStopped = false;
    console.log(`已托管启动：${started.state.url}（PID ${started.state.pid}），日志 ${settings.serverLogFile}`);
  }

  // 3. HTTP 巡检
  let probeReport = null;
  let probeRelative = `${runRelative}/http.json`;
  try {
    probeReport = await probeRoutes({
      baseUrl,
      routes: routes.routes,
      mode: routes.mode,
      mountSelector: settings.spaMountSelector,
      allowRemote: false,
    });
    const output = await resolveControlFile(project, probeRelative, { createParent: true });
    await fs.writeFile(output, JSON.stringify(probeReport, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    console.log(`HTTP 巡检：入口 ${probeReport.summary.passed}/${probeReport.summary.total} 通过`);
  } catch (error) {
    console.error(`HTTP 巡检未完成：${error.message}`);
    probeReport = null;
  }

  // 4. 浏览器审计
  let uiReport = null;
  let uiRelative = `${runRelative}/ui.json`;
  let uiError = null;
  try {
    uiReport = await runBrowserAudit({
      baseUrl,
      routes: routes.routes,
      scenarios,
      scenarioSource: settings.scenariosFile,
      mode: routes.mode,
      viewport: settings.viewport,
      mountSelector: settings.spaMountSelector,
      baselineDir,
      screenshotDir: screensDirectory,
      storageStateFile: options['storage-state'] ? await resolveControlFile(project, options['storage-state']) : null,
      playwrightModule: options.playwright ?? settings.browser?.playwrightModule ?? null,
      channel: options.channel ?? settings.browser?.channel ?? null,
      executablePath: options['browser-executable'] ?? settings.browser?.executablePath ?? null,
      ignoreConsolePatterns: settings.ignoreConsolePatterns,
      ignoreRequestPatterns: settings.ignoreRequestPatterns,
      crawl: !options['no-crawl'],
      routesSource: routesRelative,
    });
    const output = await resolveControlFile(project, uiRelative, { createParent: true });
    await fs.writeFile(output, JSON.stringify(uiReport, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    console.log(`浏览器审计：入口渲染 ${uiReport.summary.rendered}/${uiReport.summary.routes}，场景 ${uiReport.summary.scenarioPassed}/${uiReport.summary.scenarioTotal} 通过`);
  } catch (error) {
    uiError = error.message;
    console.error(`浏览器审计未完成：${uiError}`);
  }

  // 5. 停止并核对端口
  let runtimeState = null;
  if (activeRuntime && !runtimeStopped) {
    await cleanupRuntime();
    runtimeStopped = true;
  }
  if (!options['no-manage']) {
    try { runtimeState = await readControlJson(project, runtimeStateRelative, '托管运行状态'); } catch { runtimeState = null; }
    if (runtimeState) {
      console.log(`托管状态：${runtimeState.state}；端口释放 ${runtimeState.stop?.portReleased === false ? '否' : '是'}`);
    }
  }

  // 6. 复原度
  const report = buildAcceptance({
    routes, probe: probeReport, ui: uiReport, capabilities, capabilityStatus, runtime: runtimeState,
    thresholds: {
      ...settings,
      minScore: parseUnitInterval(options.threshold, 'threshold', settings.minScore),
      minSimilarity: parseUnitInterval(options['min-similarity'], 'min-similarity', settings.minSimilarity),
      requireRuntime: options['no-manage'] ? false : settings.requireRuntime,
    },
    acceptedDifferences,
    evidence: {
      routes: routesRelative, scenarios: settings.scenariosFile,
      capabilities: capabilitiesRelative,
      capabilityStatus: capabilityStatus ? settings.capabilityStatusFile : null,
      probe: probeReport ? probeRelative : null,
      ui: uiReport ? uiRelative : null,
      runtime: runtimeState ? runtimeStateRelative : null,
      baseline: baselineDir ? settings.baselineDirectory : null,
      run: runRelative,
    },
    generatedAt: new Date().toISOString(),
  });
  if (uiError) report.gate.blocking.push(`浏览器审计未执行：${uiError.split('\n')[0]}`);
  report.gate.blocking = [...new Set(report.gate.blocking)];
  if (options['no-manage']) { report.gate.degraded = true; report.gate.warnings.push('使用外部服务运行：缺少托管启动/停止证据'); }
  report.gate.passed = report.score >= report.thresholds.minScore && report.gate.blocking.length === 0;
  report.gate.fullClaim = report.gate.passed && !report.gate.degraded;
  const jsonFile = path.join(runDirectory, 'fidelity.json');
  const markdownFile = path.join(runDirectory, 'fidelity.md');
  await fs.writeFile(jsonFile, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  await fs.writeFile(markdownFile, renderAcceptance(report), { encoding: 'utf8', flag: 'wx' });

  console.log('');
  console.log(`复原度：${report.percent}%（门禁 ${(report.thresholds.minScore * 100).toFixed(2)}%）`);
  console.log(`门禁：${report.gate.passed ? '通过' : '未通过'}；完整声明：${report.gate.fullClaim ? '可以宣称迁移验收完成' : '不可宣称迁移验收完成'}`);
  for (const dimension of report.dimensions) {
    const label = DIMENSION_LABELS[dimension.id] ?? dimension.id;
    console.log(`- ${label}：${dimension.applicable ? `${(dimension.score * 100).toFixed(2)}%（${dimension.passed}/${dimension.total}）` : '不适用'}`);
  }
  console.log(`证据：${path.join(runRelative, 'fidelity.json')}；${path.join(runRelative, 'fidelity.md')}`);
  for (const item of report.gate.blocking.slice(0, 12)) console.error(`阻塞：${item}`);
  console.log(`本次运行目录：${runRelative}`);
  process.exitCode = report.gate.passed ? 0 : 2;
} catch (error) {
  await cleanupRuntime();
  console.error(`自动化验收失败：${error.message}`);
  process.exitCode = 1;
}
