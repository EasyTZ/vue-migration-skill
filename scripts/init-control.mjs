import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [sourceArg, controlArg] = process.argv.slice(2);
if (!sourceArg) throw new Error('用法：node init-control.mjs <源工程> [控制目录]（默认 <源工程>/migration）');

const source = await fs.realpath(sourceArg);
if (!(await fs.stat(source)).isDirectory()) throw new Error('源工程必须是目录');
const requested = controlArg ? path.resolve(controlArg) : path.join(source, 'migration');
// 父目录须已存在，先解析真实路径再写入，避免经链接写到意料之外的位置。
const parent = await fs.realpath(path.dirname(requested));
const control = path.join(parent, path.basename(requested));

const inside = (parentDir, child) => {
  const rel = path.relative(parentDir, child);
  return Boolean(rel) && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
};
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

if (same(control, source)) throw new Error('控制目录必须是独立子目录，不能是源工程根目录');
const relative = path.relative(source, control);
if (inside(source, control) && relative.includes(path.sep)) {
  throw new Error(`控制目录要放在源工程顶层，不要嵌进源码目录：${control}`);
}
let existing = null;
try {
  existing = await fs.lstat(control);
  if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error('控制目录必须是不经链接的真实目录');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (existing) {
  const entries = await fs.readdir(control);
  const looksLikeCode = entries.some(name => /^(package\.json|src)$/.test(name) || /\.vue$/.test(name) || /^main\.[cm]?[jt]s$/.test(name));
  if (looksLikeCode) {
    throw new Error(`该目录看起来是工程/源码目录，不是迁移控制目录：${control}\n请指定独立目录（默认 <源工程>/migration）`);
  }
} else {
  await fs.mkdir(control, { recursive: true });
}

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(await fs.readFile(path.join(skillRoot, 'assets', 'project.example.json'), 'utf8'));
config.sourceRoot = source;
config.control.root = control;

const files = {
  'project.json': JSON.stringify(config, null, 2) + '\n',
  '迁移规范.md': `# 迁移规范

> 按项目实物填写；未确认的项写“待确认”，不要用示例值冒充实际。

## 目标栈与版本矩阵

先从源 manifest、锁文件、源码使用点和运行形态推导目标依赖；不套用固定包清单。

| 源依赖/能力 | 实际使用点 | 目标依赖或删除 | 选择依据 | 调用改写范围 |
|---|---|---|---|---|

| 包 | 源版本 | 最新稳定候选 | 选定版本 | 核验日期/registry | 官方依据 | engines/peer | 升级/替换/删除 | 验证/例外依据 |
|---|---|---|---|---|---|---|---|---|

覆盖全部直接生产及开发依赖。精确版本与锁文件用于复现；不得为保留旧 API 降级依赖。新项目重新核验，长周期迁移在批次边界和交付前复查。

## 契约

业务、接口、鉴权、权限、时序、金额单位、部署 base、运行配置来源。

## 改写规则与约定

组件写法、API 层归属、共享状态边界、命名与目录约定、禁止事项。

## 常用命令

安装、启动、构建、类型检查、lint、测试、SFC 编译巡检。

## 允许差异与已知问题

来源缺陷、接受的差异、对应测试与批准依据。
`,
  '迁移台账.md': `# 迁移台账

> 本文件位于老工程控制目录。组件初始清单可取自 inventory/ 快照，人工状态与决策不得被重新普查覆盖。

状态取值：未开始 / 进行中 / 代码已迁 / 自动验证通过 / 对拍通过 / 验收通过 / 阻塞

## 组件对应

| 源路径 | 目标路径 | 路由/入口 | 依赖 | 风险 | 批次 | 状态 | 证据（控制目录相对路径） | 待决策 |
|---|---|---|---|---|---|---|---|---|

## 决策与问题

| 日期 | 事项 | 结论 | 依据 |
|---|---|---|---|

## 缺陷排查与修复

源缺陷在目标工程同步修复；预期不明确时待确认。源工程保持只读，已修复必须有实际回归证据。

| 编号 | 来源（源缺陷/迁移引入/疑点） | 优先级/影响 | 源/目标位置 | 触发步骤/实际结果 | 正确预期及依据 | 修复说明 | 回归用例/证据 | 状态 | 差异/确认依据 |
|---|---|---|---|---|---|---|---|---|---|

## 允许差异

| 差异 | 原因 | 批准人/日期 | 对应测试 |
|---|---|---|---|
`,
  '迁移计划书.md': `# 迁移计划书

## 准入结果

浏览器、运行环境、源架构、接口、路由与状态、静态资源、外部能力、业务风险、基线、工程边界，逐项结论与证据位置。

## 批次与依赖顺序

| 批次 | 范围 | 前置依赖 | 准入条件 | 验证方式 | 状态 |
|---|---|---|---|---|---|

## 并行任务与文件所有权

环境支持时按依赖图并行；共享清单、锁文件、根配置及总台账由主代理统一管理。

| 任务 | 负责人 | 前置契约 | 可写文件范围 | 禁止修改项 | 验证/证据 | 集成状态 |
|---|---|---|---|---|---|---|

## 测试数据与账号

数据来源与可逆性说明；真实口令不入文档。

## 验收与回滚

验收场景、人工复核点、回滚方式与触发条件。
`,
  '检查点.md': `# 检查点

> 中断续作用。只记事实与命令结果，不写推测；续作完成后可覆盖。

- 当前批次：
- 已改文件（目标工程）：
- 执行命令与结果（含退出码）：
- 证据位置（控制目录相对路径）：
- 失败项与复现步骤：
- 下一步：
`,
  '.gitignore': 'evidence/\n',
};

const created = [];
const kept = [];
for (const [name, content] of Object.entries(files)) {
  try {
    await fs.writeFile(path.join(control, name), content, { encoding: 'utf8', flag: 'wx' });
    created.push(name);
  } catch (error) {
    if (error.code === 'EEXIST') { kept.push(name); continue; }
    throw error;
  }
}
for (const dir of ['inventory', 'evidence', 'tools']) await fs.mkdir(path.join(control, dir), { recursive: true });

console.log(`控制目录：${control}`);
console.log(created.length ? `已创建：${created.join('、')}` : '控制目录已有内容，未新建文件');
if (kept.length) console.log(`已存在，未覆盖：${kept.join('、')}`);
console.log(`含下列子目录：inventory（普查快照）、evidence（截图与日志，默认不入库）、tools（一次性迁移工具）`);
console.log('下一步：补齐 project.json 其余字段（未知值用 null），确认控制目录是否纳入源工程版本控制，再运行 inventory.mjs。');
console.log('源工程既有文件保持只读；若源工程 lint/tsc/打包会扫描控制目录，先取得用户授权再最小化调整忽略配置。');
