import fs from 'node:fs/promises';
import { loadProject, safeControlOutput } from './lib/source-state.mjs';
import { extractCapabilities } from './lib/capabilities.mjs';
import { readControlJson } from './lib/control-paths.mjs';
import { seedAcceptanceFiles } from './lib/acceptance-seed.mjs';

try {
  const [controlArg, inventoryArg = 'inventory/capabilities.json', ...extra] = process.argv.slice(2);
  if (!controlArg || extra.length) throw new Error('用法：node init-acceptance.mjs <控制目录> [inventory/能力清单.json]');
  const project = await loadProject(controlArg);
  let inventory;
  try {
    inventory = await readControlJson(project, inventoryArg, '能力清单');
  } catch (error) {
    if (!error.message.startsWith('缺少 能力清单')) throw error;
    const output = await safeControlOutput(project, inventoryArg);
    inventory = await extractCapabilities(project);
    await fs.writeFile(output, JSON.stringify(inventory, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    console.log(`能力清单不存在，已自动抽取：${output}`);
  }
  const seeded = await seedAcceptanceFiles(project, inventory);
  console.log(`验收种子：路由 ${seeded.counts.routes} 条，场景 ${seeded.counts.scenarios} 条，能力状态 ${seeded.counts.requiredUnits} 项。`);
  if (seeded.created.length) console.log(`已创建：${seeded.created.join('、')}`);
  if (seeded.kept.length) console.log(`已存在，保留人工内容：${seeded.kept.join('、')}`);
  if (!seeded.counts.routes) console.warn('提醒：没有提取到路由。若是纯组件库/SSR/微前端工程，请手工登记入口并在迁移规范说明。');
  console.log('下一步：');
  console.log(`1. 核对 ${seeded.paths.routesFile}：targetPath 必须是目标工程真实入口，菜单外页面与弹窗型入口也要登记。`);
  console.log(`2. 在 ${seeded.paths.scenariosFile} 补齐 phase=interaction 的场景，覆盖表单、校验、查询、弹窗、权限、上传下载等能力；用 covers 引用能力 id。`);
  console.log('3. 运行 acceptance.mjs 完成本机启动、HTTP/UI/API 巡检与复原度评分。');
} catch (error) {
  console.error(`验收初始化失败：${error.message}`);
  process.exitCode = 1;
}
