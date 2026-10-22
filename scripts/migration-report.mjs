import fs from 'node:fs/promises';
import { loadProject, scanSource, safeControlOutput, readSnapshot } from './lib/source-state.mjs';
import { readControlJson, buildReport, renderReport } from './lib/migration-report.mjs';

const [controlArg, ledgerArg = 'migration-status.json', jsonArg, markdownArg] = process.argv.slice(2);
if (!controlArg || !jsonArg || !markdownArg) throw new Error('用法：node migration-report.mjs <控制目录> <状态相对路径> <报告JSON路径> <报告Markdown路径>');
const project = await loadProject(controlArg);
const ledger = await readControlJson(project, ledgerArg);
const baseline = await readSnapshot(project, ledger.baselineSnapshot);
const current = await scanSource(project);
const report = await buildReport(project, baseline, current, ledger);
const jsonOutput = await safeControlOutput(project, jsonArg);
const markdownOutput = await safeControlOutput(project, markdownArg);
if ((process.platform === 'win32' ? jsonOutput.toLowerCase() === markdownOutput.toLowerCase() : jsonOutput === markdownOutput)) throw new Error('两个报告输出路径不能相同');
for (const output of [jsonOutput, markdownOutput]) {
  if (await fs.lstat(output).catch(() => null)) throw new Error(`报告已存在，不覆盖：${output}`);
}
await fs.writeFile(jsonOutput, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
await fs.writeFile(markdownOutput, renderReport(report), { encoding: 'utf8', flag: 'wx' });
console.log(`报告已生成：${jsonOutput}；${markdownOutput}；${report.problems.length} 项待处理。`);
if (!report.reviewReady) process.exitCode = 2;
