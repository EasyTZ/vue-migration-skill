import fs from 'node:fs/promises';
import { loadProject, scanSource, safeControlOutput, readSnapshot } from './lib/source-state.mjs';

try {
  const [controlArg, baselineArg, outputArg, ...extra] = process.argv.slice(2);
  if (!controlArg || !baselineArg || !outputArg || extra.length) throw new Error('用法：node check-source.mjs <控制目录> <基线snapshot> <输出json>');
  const project = await loadProject(controlArg);
  const baseline = await readSnapshot(project, baselineArg);
  const output = await safeControlOutput(project, outputArg);
  const current = await scanSource(project);
  const previousFiles = new Map(baseline.files.map(row => [row.path, row]));
  const currentFiles = new Map(current.files.map(row => [row.path, row]));
  const added = current.files.filter(row => !previousFiles.has(row.path)).map(row => row.path);
  const modified = current.files.filter(row => previousFiles.has(row.path)
    && (previousFiles.get(row.path).sha256 !== row.sha256 || previousFiles.get(row.path).size !== row.size)).map(row => row.path);
  const deleted = baseline.files.filter(row => !currentFiles.has(row.path)).map(row => row.path);
  const changed = Boolean(added.length || modified.length || deleted.length);
  const report = {
    schemaVersion: 1, sourceRoot: project.source, generatedAt: new Date().toISOString(),
    baselineFingerprint: baseline.fingerprint, currentFingerprint: current.fingerprint, changed,
    counts: { added: added.length, modified: modified.length, deleted: deleted.length }, added, modified, deleted,
    excluded: current.excluded, policy: current.policy,
    note: '重命名呈现为删除加新增；不修改源文件或更新基线。变更需由后续迁移批次重新分析。',
  };
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(`源增量：新增 ${added.length}，修改 ${modified.length}，删除 ${deleted.length}；${output}`);
  process.exitCode = changed ? 2 : 0;
} catch (error) {
  console.error(`源增量检查失败：${error.message}`);
  process.exitCode = 1;
}
