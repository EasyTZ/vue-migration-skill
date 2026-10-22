import fs from 'node:fs/promises';
import path from 'node:path';

const [targetArg, configArg] = process.argv.slice(2);
if (!targetArg || !configArg) throw new Error('用法：node init-target.mjs <空目标目录> <控制目录>/project.json');
const target = path.resolve(targetArg);
const configPath = path.resolve(configArg);
const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
if (!['npm', 'pnpm', 'yarn', 'bun'].includes(config.packageManager)) throw new Error('请填写项目选定的 packageManager（npm/pnpm/yarn/bun）');

const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (parentDir, child) => {
  const rel = path.relative(parentDir, child);
  return Boolean(rel) && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
};

// 控制目录承载全部过程资料：project.json 必须放在控制目录根，且 control.root 指向它。
const control = await fs.realpath(path.resolve(path.dirname(configPath), config.control?.root ?? '.')).catch(() => null);
if (!control) throw new Error('先运行 init-control.mjs 建立控制目录，并在 project.json 的 control.root 填实际路径');
if (!(await fs.stat(control)).isDirectory()) throw new Error('control.root 必须是目录');
if (!same(control, path.dirname(await fs.realpath(configPath)))) throw new Error('project.json 必须放在控制目录根，且其 control.root 指向该控制目录');

if (typeof config.sourceRoot !== 'string' || !config.sourceRoot.trim()) throw new Error('请填写真实 sourceRoot，不能留空');
const source = await fs.realpath(path.resolve(control, config.sourceRoot)).catch(() => null);
if (!source) throw new Error('填写真实存在的 sourceRoot（相对路径按控制目录解析）');
const sourceStat = await fs.stat(source);
if (!sourceStat.isDirectory()) throw new Error('sourceRoot 必须是目录');
// 依赖与命令来自本次项目决策；不预置 UI、请求、状态或构建工具。
const manifest = config.targetManifest;
if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('请根据项目依赖决策填写 targetManifest；旧 versions 配置需转换');
if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('请填写 targetManifest.name');
if (!manifest.scripts || typeof manifest.scripts !== 'object' || Array.isArray(manifest.scripts)
  || !Object.keys(manifest.scripts).length || Object.values(manifest.scripts).some(value => typeof value !== 'string' || !value.trim())) {
  throw new Error('请填写目标项目真实的 targetManifest.scripts');
}
for (const group of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  const entries = manifest[group] ?? {};
  if (typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`${group} 必须为依赖映射`);
  for (const [name, version] of Object.entries(entries)) {
    const exact = typeof version === 'string' && /^\d+\.\d+\.\d+(?:\+[0-9A-Za-z.-]+)?$/.test(version);
    const workspace = typeof version === 'string' && /^workspace:/.test(version);
    // 库的 peer 范围与 workspace 内部协议保留真实契约；私有包和特殊来源需人工核验证据。
    const peerRange = group === 'peerDependencies' && typeof version === 'string' && version.trim() && !/^(latest|next|\*)$/.test(version);
    if (!exact && !workspace && !peerRange) throw new Error(`请为 ${group}.${name} 填写核验后的稳定精确版本；特殊来源请使用项目官方模板并记录依据`);
  }
}
if (!Object.keys(manifest.dependencies ?? {}).length && !Object.keys(manifest.devDependencies ?? {}).length) throw new Error('目标依赖清单为空，请先完成依赖选型');
if (config.packageManagerVersion && !/^\d+\.\d+\.\d+$/.test(config.packageManagerVersion)) throw new Error('packageManagerVersion 必须为确切版本');
// 父目录须已存在，先验证真实路径再写入，避免经链接写到源工程或控制目录。
const parent = await fs.realpath(path.dirname(target));
const resolvedTarget = path.join(parent, path.basename(target));
if ([source, control].some(dir => same(dir, resolvedTarget))) throw new Error('目标工程必须与源工程、控制目录都不同');
if (inside(source, resolvedTarget)) throw new Error('目标不可位于源工程内');
if (inside(control, resolvedTarget)) throw new Error('目标工程不可位于控制目录内');
if (!config.targetRoot) throw new Error('填写真实 targetRoot');
const declaredTarget = path.resolve(path.dirname(configPath), config.targetRoot);
if (!same(declaredTarget, target) && !same(declaredTarget, resolvedTarget)) {
  throw new Error('project.json 的 targetRoot 必须与目标参数相符');
}
try {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (await fs.readdir(target)).length) throw new Error('目标必须是空的真实目录，不覆盖现有工程');
} catch (error) { if (error.code !== 'ENOENT') throw error; }

const files = {
  'package.json': JSON.stringify({ ...manifest,
    ...(config.packageManagerVersion ? { packageManager: `${config.packageManager}@${config.packageManagerVersion}` } : {}) }, null, 2),
  'README.md': '# 目标工程\n\n依赖与命令根据源项目实际用途及目标选型生成。当前只初始化清单，尚未生成应用源码和构建配置。\n\n按所选框架和工具的官方模板补齐源码、配置、安装和运行说明，再执行清单中实际声明的检查命令。此清单不代表依赖兼容、业务迁移或验收已完成。\n',
  '.gitignore': 'node_modules/\ndist/\n.env.local\n.env.*.local\n',
};
for (const [name, content] of Object.entries(files)) {
  const file = path.join(resolvedTarget, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content + '\n', { encoding: 'utf8', flag: 'wx' });
}
console.log(`目标清单已初始化：${resolvedTarget}`);
console.log('仅生成 package.json、README 与 .gitignore，未写入过程资料；未安装依赖或生成应用骨架。');
console.log('下一步：按目标选型官方模板补齐源码与配置，使用选定包管理器安装，执行项目实际检查并运行 check-boundary.mjs。');
