import fs from 'node:fs/promises';
import path from 'node:path';

const [controlArg, targetArg] = process.argv.slice(2);
if (!controlArg || !targetArg) throw new Error('用法：node check-boundary.mjs <控制目录> <目标工程>');

const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
const inside = (parentDir, child) => {
  const rel = path.relative(parentDir, child);
  return Boolean(rel) && !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
};

const control = await fs.realpath(controlArg).catch(() => null);
if (!control) throw new Error(`控制目录不存在：${path.resolve(controlArg)}`);
const target = await fs.realpath(targetArg).catch(() => null);
if (!target) throw new Error(`目标工程不存在：${path.resolve(targetArg)}`);
const configFile = path.join(control, 'project.json');
const raw = await fs.readFile(configFile, 'utf8').catch(() => { throw new Error(`控制目录缺少 project.json：${configFile}`); });
let config;
try {
  config = JSON.parse(raw);
} catch (error) {
  throw new Error(`project.json 不是合法 JSON：${error.message}`);
}
if (same(control, target)) throw new Error('控制目录与目标工程不能是同一个目录');

const violations = [];
const warnings = [];
const skip = new Set(['node_modules', '.git', 'dist', 'coverage', '.vite', '.idea', 'build', '.output']);
// 过程资料的固定命名：出现在新工程即为越界。
const artifacts = /^(迁移台账|迁移规范|迁移计划书|迁移计划|验收报告|检查点|迁移报告|对拍|证据)/;
// 组合特征识别迁移资料；单个同名业务键只提醒，不能据此移动业务文件。
const configKeys = ['sourceRoot', 'targetRoot', 'controlRoot', 'componentCount'];

async function scanTarget(dir, depth) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    const label = path.relative(target, full).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (skip.has(entry.name)) continue;
      if (entry.name === 'migration') { violations.push(`过程目录出现在新工程：${label}/`); continue; }
      if (depth === 0 && ['evidence', 'inventory', 'tools'].includes(entry.name)) {
        warnings.push(`新工程顶层有 ${label}/，确认它不是迁移过程目录或迁移专用工具`);
      }
      await scanTarget(full, depth + 1);
      continue;
    }
    if (/\.(md|json|ya?ml)$/.test(entry.name) && artifacts.test(entry.name)) { violations.push(`过程资料出现在新工程：${label}`); continue; }
    if (!entry.name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(full, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const migrationConfig = typeof parsed.sourceRoot === 'string' && typeof parsed.targetRoot === 'string'
          && parsed.control && typeof parsed.control.root === 'string';
        const inventory = typeof parsed.sourceRoot === 'string' && typeof parsed.generatedAt === 'string'
          && Array.isArray(parsed.files) && typeof parsed.componentCount === 'number';
        const sourceSnapshot = parsed.schemaVersion === 1 && typeof parsed.sourceRoot === 'string'
          && typeof parsed.fingerprint === 'string' && Array.isArray(parsed.files) && parsed.policy?.algorithm === 'sha256';
        const migrationStatus = parsed.schemaVersion === 1 && typeof parsed.baselineSnapshot === 'string'
          && Array.isArray(parsed.files) && Array.isArray(parsed.entries) && Array.isArray(parsed.architecture) && Array.isArray(parsed.checks);
        const progressReport = parsed.schemaVersion === 1 && typeof parsed.sourceRoot === 'string'
          && typeof parsed.baselineFingerprint === 'string' && typeof parsed.currentFingerprint === 'string'
          && (typeof parsed.changed === 'boolean' || typeof parsed.reviewReady === 'boolean');
        if (migrationConfig || inventory || sourceSnapshot || migrationStatus || progressReport) violations.push(`迁移配置、状态或源快照出现在新工程：${label}`);
        else if (configKeys.some(key => Object.hasOwn(parsed, key))) warnings.push(`JSON 含候选过程字段，请人工确认，不自动移动：${label}`);
      }
    } catch { /* 非 JSON 或无需解析，忽略 */ }
  }
}

if (inside(target, control)) violations.push(`控制目录位于新工程内部：${control}`);
await scanTarget(target, 0);

const declaredControl = config.control?.root ? path.resolve(control, config.control.root) : null;
if (declaredControl && !same(declaredControl, control)) warnings.push(`project.json 的 control.root 与实际控制目录不一致：${declaredControl}`);
if (config.targetRoot && !same(path.resolve(control, config.targetRoot), target)) warnings.push(`project.json 的 targetRoot 与实际目标工程不一致：${config.targetRoot}`);

let sourceRoot = null;
if (config.sourceRoot) {
  sourceRoot = await fs.realpath(path.resolve(control, config.sourceRoot)).catch(() => null);
  if (!sourceRoot) warnings.push(`project.json 的 sourceRoot 无法解析：${config.sourceRoot}`);
}
if (sourceRoot && !same(sourceRoot, control) && !same(sourceRoot, target)) {
  for (const entry of await fs.readdir(sourceRoot, { withFileTypes: true })) {
    const full = path.join(sourceRoot, entry.name);
    if (same(full, control) || same(full, target)) continue;
    if (entry.isFile() && /\.(md|json|ya?ml)$/.test(entry.name) && artifacts.test(entry.name)) {
      warnings.push(`源工程根目录有过程资料，应收进控制目录：${full}`);
    }
    if (entry.isDirectory() && entry.name === 'migration') warnings.push(`源工程根目录存在 migration 目录，若不是本项目控制目录请确认：${full}`);
  }
}

for (const warning of warnings) console.warn(`提醒：${warning}`);
for (const violation of violations) console.error(`越界：${violation}`);
console.log(`边界检查：控制目录 ${control}；新工程 ${target}；${violations.length} 项越界，${warnings.length} 项提醒`);
if (violations.length) {
  console.error('把越界文件移入控制目录后从新工程删除，并在迁移台账登记；验收报告等过程资料不放进新工程。');
  process.exitCode = 1;
}
