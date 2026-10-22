import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProject, safeControlOutput, readSnapshot } from './lib/source-state.mjs';
import { validateSnapshot } from './lib/migration-report.mjs';

const [controlArg, snapshotArg, outputArg = 'migration-status.json'] = process.argv.slice(2);
if (!controlArg || !snapshotArg) throw new Error('用法：node init-status.mjs <控制目录> <基线快照相对路径> [状态输出相对路径]');
const project = await loadProject(controlArg);
const snapshot = validateSnapshot(await readSnapshot(project, snapshotArg), project.source);
const example = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets/migration-status.example.json');
const ledger = JSON.parse(await fs.readFile(example, 'utf8'));
ledger.baselineSnapshot = snapshotArg;
ledger.files = snapshot.files.map(file => ({
  source: file.path, sourceSha256: file.sha256, targets: [], disposition: 'pending',
  stage: 'pending', reason: null, evidence: [],
}));
const output = await safeControlOutput(project, outputArg);
await fs.writeFile(output, JSON.stringify(ledger, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
console.log(`已初始化 ${ledger.files.length} 个源文件的覆盖记录：${output}；入口、架构、检查与缺陷须按项目补齐，已有状态不覆盖。`);
