import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
export function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
const hasPath = value => typeof value === 'string' && Boolean(value.trim());
const overlap = (a, b) => samePath(a, b) || isInside(a, b) || isInside(b, a);

async function resolveFuture(file) {
  try { return await fs.realpath(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(file);
    if (parent === file) throw error;
    return path.join(await resolveFuture(parent), path.basename(file));
  }
}

export async function loadProject(controlArg) {
  if (!hasPath(controlArg)) throw new Error('请指定控制目录');
  const requested = path.resolve(controlArg);
  const stat = await fs.lstat(requested);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('控制目录必须是真实目录，不能是符号链接');
  const control = await fs.realpath(requested);
  const marker = path.join(control, 'project.json');
  if (!(await fs.lstat(marker)).isFile()) throw new Error('控制目录 project.json 必须是真实文件');
  const config = JSON.parse(await fs.readFile(marker, 'utf8'));
  if (!hasPath(config.sourceRoot) || !hasPath(config.control?.root)) throw new Error('project.json 必须填写 sourceRoot 和 control.root');
  const declaredControl = await fs.realpath(path.resolve(control, config.control.root));
  const source = await fs.realpath(path.resolve(control, config.sourceRoot));
  if (!samePath(control, declaredControl)) throw new Error('control.root 与实际控制目录不匹配');
  if (!(await fs.stat(source)).isDirectory()) throw new Error('sourceRoot 必须为目录');
  if (samePath(control, source) || isInside(control, source)) throw new Error('控制目录不能是源根目录，也不能包含源工程');
  if (isInside(source, control) && path.dirname(control) !== source) throw new Error('源内控制目录必须位于源工程顶层');
  let target = null;
  if (config.targetRoot !== null && config.targetRoot !== undefined) {
    if (!hasPath(config.targetRoot)) throw new Error('targetRoot 必须为空值或有效路径');
    target = await resolveFuture(path.resolve(control, config.targetRoot));
    if (overlap(source, target) || overlap(control, target)) throw new Error('目标工程不能与源工程或控制目录重叠');
  }
  return { control, source, target, config };
}

export async function safeControlOutput(project, arg) {
  if (!hasPath(arg)) throw new Error('请填写输出路径');
  const requested = path.resolve(project.control, arg);
  if (!isInside(project.control, requested)) throw new Error('输出必须位于控制目录内');
  const parent = await fs.realpath(path.dirname(requested));
  const output = path.join(parent, path.basename(requested));
  if (!isInside(project.control, output)) throw new Error('输出父目录经链接越出控制目录');
  const stat = await fs.lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (stat?.isSymbolicLink()) throw new Error('输出不能是符号链接');
  return output;
}

const skippedDirectories = new Set(['node_modules', '.git', 'dist', 'coverage', '.vite', '.idea', 'build', '.output', '.nuxt', '.next', '.cache', 'test-results', 'playwright-report']);
const isSecret = name => /^\.env/i.test(name) || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(name)
  || /^(?:\.npmrc|\.yarnrc\.yml|id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|credentials\.json)$/i.test(name);
export const SNAPSHOT_POLICY_VERSION = 1;
export function fingerprintFiles(files) {
  const sorted = [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return createHash('sha256').update(JSON.stringify(sorted.map(({ path: name, sha256, size }) => ({ path: name, sha256, size })))).digest('hex');
}

export async function scanSource(project) {
  const files = [];
  const excluded = [];
  const label = file => path.relative(project.source, file).split(path.sep).join('/');
  async function walk(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      const relative = label(file);
      if (samePath(file, project.control)) { excluded.push({ path: relative, reason: '控制目录' }); continue; }
      if (entry.isSymbolicLink()) { excluded.push({ path: relative, reason: '符号链接，未跟随' }); continue; }
      if (isSecret(entry.name)) { excluded.push({ path: relative, reason: '秘密配置或密钥候选，未读取内容' }); continue; }
      if (entry.isDirectory()) {
        if (skippedDirectories.has(entry.name)) excluded.push({ path: relative, reason: '依赖、产物或缓存目录' });
        else await walk(file);
        continue;
      }
      if (!entry.isFile()) { excluded.push({ path: relative, reason: '非普通文件' }); continue; }
      const before = await fs.lstat(file, { bigint: true });
      if (!before.isFile()) throw new Error(`扫描时源文件类型发生变化，请重试：${relative}`);
      const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const hash = createHash('sha256');
      let after;
      try {
        const opened = await handle.stat({ bigint: true });
        if (opened.ino !== before.ino || opened.dev !== before.dev) throw new Error(`扫描时源文件被替换，请重试：${relative}`);
        for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
        after = await handle.stat({ bigint: true });
      } finally { await handle.close(); }
      const current = await fs.lstat(file, { bigint: true });
      if (!current.isFile() || current.ino !== before.ino || current.dev !== before.dev || before.size !== after.size || before.mtimeNs !== after.mtimeNs
        || before.size !== current.size || before.mtimeNs !== current.mtimeNs) throw new Error(`扫描时源文件发生变化，请重试：${relative}`);
      if (after.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`源文件过大，不能可靠记录大小：${relative}`);
      files.push({ path: relative, sha256: hash.digest('hex'), size: Number(after.size) });
    }
  }
  await walk(project.source);
  return {
    schemaVersion: 1, sourceRoot: project.source, generatedAt: new Date().toISOString(),
    fingerprint: fingerprintFiles(files), files, excluded,
    policy: {
      version: SNAPSHOT_POLICY_VERSION, algorithm: 'sha256', scope: '全部普通文件（包含源码、配置、锁文件和资源），按以下策略排除',
      skippedDirectories: [...skippedDirectories], secrets: '所有 .env*、.npmrc、.yarnrc.yml、密钥/证书及凭证候选文件',
      symlinks: '不跟随；excluded 单列记录', limitation: '文件内容快照，不是原子文件系统快照；不证明依赖图或业务覆盖完整',
    },
  };
}

export async function readSnapshot(project, arg) {
  const file = await safeControlOutput(project, arg);
  const snapshot = JSON.parse(await fs.readFile(file, 'utf8'));
  if (snapshot.schemaVersion !== 1 || snapshot.sourceRoot !== project.source || !Array.isArray(snapshot.files)) throw new Error('快照格式、版本或源工程不匹配');
  if (snapshot.policy?.version !== SNAPSHOT_POLICY_VERSION) throw new Error('快照扫描策略版本不匹配，请在确认边界后重新建立基线');
  const seen = new Set();
  for (const row of snapshot.files) {
    if (!row || typeof row.path !== 'string' || !row.path || row.path.includes('\\') || path.posix.isAbsolute(row.path)
      || row.path.split('/').some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:/.test(row.path)
      || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.size) || row.size < 0 || seen.has(row.path)) throw new Error('快照文件记录无效或重复');
    seen.add(row.path);
  }
  if (snapshot.fingerprint !== fingerprintFiles(snapshot.files)) throw new Error('快照指纹校验失败');
  return snapshot;
}
