import fs from 'node:fs/promises';
import path from 'node:path';
import { parseJson } from './json.mjs';

export const hasText = value => typeof value === 'string' && Boolean(value.trim());

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return Boolean(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * 把控制目录内的相对路径解析成真实文件路径。
 * 验收状态/日志/场景文件都只能落在控制目录里，避免运行期资料污染新工程。
 */
export async function resolveControlFile(project, relative, { mustExist = false, createParent = false } = {}) {
  if (!hasText(relative)) throw new Error('请填写控制目录内的相对路径');
  if (path.isAbsolute(relative) || relative.includes('\\') || relative.includes(':')) {
    throw new Error(`路径必须是控制目录内的相对路径并使用 / 分隔：${relative}`);
  }
  const requested = path.resolve(project.control, relative);
  if (!inside(project.control, requested)) throw new Error(`路径越出控制目录：${relative}`);
  const parent = createParent
    ? await fs.mkdir(path.dirname(requested), { recursive: true }).then(() => fs.realpath(path.dirname(requested)))
    : await fs.realpath(path.dirname(requested));
  if (!inside(project.control, parent)) throw new Error(`父目录经链接越出控制目录：${relative}`);
  const file = path.join(parent, path.basename(requested));
  const stat = await fs.lstat(file).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (stat?.isSymbolicLink()) throw new Error(`不接受符号链接：${relative}`);
  if (!stat && mustExist) throw new Error(`文件不存在：${relative}`);
  return file;
}

/** 读取控制目录内的 JSON；不存在时给出可执行的下一步提示。 */
export async function readControlJson(project, relative, label = relative) {
  let file;
  try {
    file = await resolveControlFile(project, relative);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`缺少 ${label}：${relative}\n先运行 init-acceptance.mjs 生成种子并补齐场景`);
    throw error;
  }
  try {
    return parseJson(await fs.readFile(file, 'utf8'), `${label}（${relative}）`);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error(`缺少 ${label}：${relative}\n先运行 init-acceptance.mjs 生成种子并补齐场景`);
    throw error;
  }
}

export async function writeControlJson(project, relative, value, { overwrite = false } = {}) {
  const file = await resolveControlFile(project, relative, { createParent: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
  return file;
}
