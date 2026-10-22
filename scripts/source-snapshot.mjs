import fs from 'node:fs/promises';
import { loadProject, scanSource, safeControlOutput } from './lib/source-state.mjs';

try {
  const [controlArg, outputArg, ...extra] = process.argv.slice(2);
  if (!controlArg || !outputArg || extra.length) throw new Error('用法：node source-snapshot.mjs <控制目录> <输出json>');
  const project = await loadProject(controlArg);
  const output = await safeControlOutput(project, outputArg);
  const snapshot = await scanSource(project);
  await fs.writeFile(output, JSON.stringify(snapshot, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  console.log(`源快照：${snapshot.files.length} 个文件，${snapshot.excluded.length} 项排除；${output}`);
} catch (error) {
  console.error(`源快照失败：${error.message}`);
  process.exitCode = 1;
}
