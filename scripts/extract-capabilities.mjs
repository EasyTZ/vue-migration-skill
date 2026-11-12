import fs from 'node:fs/promises';
import { loadProject, safeControlOutput } from './lib/source-state.mjs';
import { extractCapabilities } from './lib/capabilities.mjs';

try {
  const [controlArg, outputArg = 'inventory/capabilities.json', ...extra] = process.argv.slice(2);
  if (!controlArg || extra.length) throw new Error('用法：node extract-capabilities.mjs <控制目录> [inventory/能力清单.json]');
  const project = await loadProject(controlArg);
  const output = await safeControlOutput(project, outputArg);
  const inventory = await extractCapabilities(project);
  try {
    await fs.writeFile(output, JSON.stringify(inventory, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`能力清单已存在，不覆盖旧结论，请换一个文件名：${output}`);
    throw error;
  }
  const summary = Object.entries(inventory.stats.byKind).map(([kind, count]) => `${kind} ${count}`).join('、') || '无';
  console.log(`能力清单：${inventory.stats.total} 项（必需 ${inventory.stats.required}、提示 ${inventory.stats.advisory}）；${output}`);
  console.log(`按类型：${summary}`);
  console.log('下一步：运行 init-acceptance.mjs 生成验收种子，回读命中文件核对路由映射，再补齐交互场景。');
} catch (error) {
  console.error(`能力抽取失败：${error.message}`);
  process.exitCode = 1;
}
