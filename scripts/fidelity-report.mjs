import fs from 'node:fs/promises';
import { loadProject } from './lib/source-state.mjs';
import { parseArgs, parseJsonArgument, parseUnitInterval } from './lib/cli.mjs';
import { readControlJson, resolveControlFile } from './lib/control-paths.mjs';
import { loadAcceptanceSettings } from './lib/runtime.mjs';
import { normalizeRoutes } from './lib/routes.mjs';
import { buildAcceptance, renderAcceptance } from './lib/fidelity.mjs';

const usage = `用法：node fidelity-report.mjs <控制目录> <输出json> <输出md> [选项]
  --routes runtime/routes.json            验收路由表
  --probe evidence/runs/r01/http.json     HTTP 巡检报告
  --ui evidence/runs/r01/ui.json          浏览器审计报告
  --capabilities inventory/capabilities.json
  --capability-status runtime/capability-status.json
  --runtime runtime/target-runtime.json   托管运行状态（必须已停止）
  --threshold 0.99 --min-similarity 0.9
  --no-require-baseline --no-require-runtime
  --accepted-differences '[...]'          覆盖 project.json 的允许差异（JSON 数组）

分数只是门禁信号：报告中的 blocking 非空时不得宣称迁移完成。`;

const isMissing = error => /^缺少 /.test(error.message);

async function optionalJson(project, relative, label) {
  try {
    return await readControlJson(project, relative, label);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

try {
  const { options, positional } = parseArgs(process.argv.slice(2), {
    valued: ['routes', 'probe', 'ui', 'capabilities', 'capability-status', 'runtime', 'threshold', 'min-similarity', 'accepted-differences'],
    flags: ['no-require-baseline', 'no-require-runtime'],
  });
  const [controlArg, jsonArg, markdownArg] = positional;
  if (!controlArg || !jsonArg || !markdownArg || positional.length > 3) throw new Error(usage);
  const project = await loadProject(controlArg);
  const settings = loadAcceptanceSettings(project);
  const routesRelative = options.routes ?? settings.routesFile;
  const routes = normalizeRoutes(await readControlJson(project, routesRelative, '验收路由表'), { source: routesRelative });
  const probeRelative = options.probe;
  const uiRelative = options.ui;
  if (!probeRelative || !uiRelative) throw new Error('必须提供 --probe 与 --ui 证据');
  const probe = await optionalJson(project, probeRelative, 'HTTP 巡检报告');
  const ui = await optionalJson(project, uiRelative, '浏览器审计报告');
  const capabilitiesRelative = options.capabilities ?? 'inventory/capabilities.json';
  const capabilities = await optionalJson(project, capabilitiesRelative, '能力清单');
  const capabilityStatus = await optionalJson(project, options['capability-status'] ?? settings.capabilityStatusFile, '能力核对状态');
  const runtime = await optionalJson(project, options.runtime ?? settings.runtimeStateFile, '托管运行状态');
  const acceptedDifferences = options['accepted-differences']
    ? parseJsonArgument(options['accepted-differences'], 'accepted-differences')
    : (project.config.acceptedDifferences ?? []);
  const report = buildAcceptance({
    routes, probe, ui, capabilities, capabilityStatus, runtime,
    thresholds: {
      ...settings,
      minScore: parseUnitInterval(options.threshold, 'threshold', settings.minScore),
      minSimilarity: parseUnitInterval(options['min-similarity'], 'min-similarity', settings.minSimilarity),
      requireBaseline: options['no-require-baseline'] ? false : settings.requireBaseline,
      requireRuntime: options['no-require-runtime'] ? false : settings.requireRuntime,
    },
    acceptedDifferences,
    evidence: {
      routes: routesRelative, probe: probeRelative, ui: uiRelative,
      capabilities: capabilities ? capabilitiesRelative : null,
      capabilityStatus: capabilityStatus ? (options['capability-status'] ?? settings.capabilityStatusFile) : null,
      runtime: runtime ? (options.runtime ?? settings.runtimeStateFile) : null,
    },
  });
  const jsonFile = await resolveControlFile(project, jsonArg, { createParent: true });
  const markdownFile = await resolveControlFile(project, markdownArg, { createParent: true });
  if (jsonFile === markdownFile) throw new Error('JSON 与 Markdown 输出不能相同');
  for (const [label, file] of [['JSON', jsonFile], ['Markdown', markdownFile]]) {
    if (await fs.lstat(file).catch(() => null)) throw new Error(`${label} 输出已存在，不覆盖旧报告：${file}`);
  }
  await fs.writeFile(jsonFile, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  await fs.writeFile(markdownFile, renderAcceptance(report), { encoding: 'utf8', flag: 'wx' });
  console.log(`复原度：${report.percent}%（门禁 ${(report.thresholds.minScore * 100).toFixed(2)}%）；门禁${report.gate.passed ? '通过' : '未通过'}；${report.gate.blocking.length} 项阻塞。`);
  console.log(`报告：${jsonFile}；${markdownFile}`);
  for (const item of report.gate.blocking.slice(0, 10)) console.error(`阻塞：${item}`);
  process.exitCode = report.gate.passed ? 0 : 2;
} catch (error) {
  console.error(`复原度报告失败：${error.message}`);
  process.exitCode = 1;
}
