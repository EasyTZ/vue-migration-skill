import fs from 'node:fs/promises';
import path from 'node:path';

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) throw new Error('用法：node inventory.mjs <源工程> <控制目录>/inventory/<快照名>.json');
const root = await fs.realpath(sourceArg);
const output = path.resolve(outputArg);
// 输出父目录须已存在，先解析真实路径再校验，避免经链接写进源码区。
const realParent = await fs.realpath(path.dirname(output));
const destination = path.join(realParent, path.basename(output));
const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (parentDir, child) => {
  const rel = path.relative(parentDir, child);
  return Boolean(rel) && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
};

// 控制目录是源工程内唯一允许写入的位置；它用根目录下的 project.json 自证身份。
let controlDirectory = null;
if (inside(root, destination)) {
  const [top] = path.relative(root, destination).split(path.sep);
  controlDirectory = path.join(root, top);
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(path.join(controlDirectory, 'project.json'), 'utf8'));
  } catch { /* 没有有效标记，按非控制目录拒绝 */ }
  const declaredControl = typeof marker?.control?.root === 'string'
    ? await fs.realpath(path.resolve(controlDirectory, marker.control.root)).catch(() => null) : null;
  const declaredSource = typeof marker?.sourceRoot === 'string'
    ? await fs.realpath(path.resolve(controlDirectory, marker.sourceRoot)).catch(() => null) : null;
  if (!declaredControl || !declaredSource || !same(declaredControl, controlDirectory) || !same(declaredSource, root)) {
    throw new Error(`源工程内只允许写入控制目录（根目录 project.json 的源/控制路径须匹配）：${destination}\n先运行 init-control.mjs，或把输出改到控制目录下`);
  }
}

const skip = new Set(['node_modules', '.git', 'dist', 'coverage', '.vite', '.idea', 'build', '.output']);
const patterns = {
  classComponent: /vue-property-decorator|vue-class-component|@Component/,
  legacySlots: /slot-scope|\$scopedSlots|\$listeners|slot="/,
  legacyInstances: /\$children|\$set\b|\$delete\b|Vue\.prototype/,
  webpack: /require\.context|process\.env|require\(/,
  globalRegistration: /Vue\.(use|component|directive|mixin)\s*\(|app\.(use|component|directive|mixin)\s*\(/,
  syncModifier: /\.sync=/,
  legacyFilters: /\bfilters\s*:\s*\{/,
  internalCss: /\.el-|\/deep\/|>>>/,
  legacyIconClass: /el-icon-|class="[^"]*\bel-icon\b/,
  timersAndEvents: /setInterval|setTimeout|addEventListener|subscribe\(/,
  graphics: /pixi|echarts|canvas|WebGL/i,
};

const files = [];
async function walk(dir) {
  for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (controlDirectory && same(full, controlDirectory)) continue;
    if (entry.isDirectory()) { if (!skip.has(entry.name)) await walk(full); continue; }
    if (!/\.(vue|[cm]?[jt]sx?)$/.test(entry.name)) continue;
    const text = await fs.readFile(full, 'utf8');
    files.push({ path: path.relative(root, full).split(path.sep).join('/'), lines: text ? text.split(/\r?\n/).length : 0,
      signals: Object.entries(patterns).filter(([, re]) => re.test(text)).map(([name]) => name) });
  }
}
await walk(root);

const lockfiles = [];
for (const name of ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']) {
  const stat = await fs.stat(path.join(root, name)).catch(() => null);
  if (stat?.isFile()) lockfiles.push(name);
}
let sourcePackage;
try {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  sourcePackage = { name: pkg.name ?? null, packageManager: pkg.packageManager ?? null, lockfiles,
    dependencies: pkg.dependencies ?? {}, devDependencies: pkg.devDependencies ?? {}, scripts: pkg.scripts ?? {} };
} catch (error) {
  sourcePackage = { name: null, packageManager: null, lockfiles, dependencies: {}, devDependencies: {}, scripts: {},
    error: error.code === 'ENOENT' ? '源工程根目录没有 package.json' : `package.json 解析失败：${error.message}` };
}

const report = { sourceRoot: root, controlDirectory, generatedAt: new Date().toISOString(),
  note: '正则信号包含注释和字符串，只供人工确认；跳过符号链接、依赖/构建目录及控制目录。清单是候选信号，不是缺陷结论。',
  sourcePackage, componentCount: files.filter(f => f.path.endsWith('.vue')).length, files };
try {
  await fs.writeFile(destination, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
} catch (error) {
  if (error.code === 'EEXIST') throw new Error(`快照已存在，不覆盖旧清单，请换一个快照名：${destination}`);
  throw error;
}
console.log(`已普查 ${files.length} 个源码文件，${report.componentCount} 个 Vue 组件：${destination}`);
if (controlDirectory) console.log(`控制目录（不参与普查）：${controlDirectory}`);
