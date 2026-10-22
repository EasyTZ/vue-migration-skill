import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function* files(dir) {
  for (const item of await fs.readdir(dir, { withFileTypes: true })) {
    if (item.isSymbolicLink() || ['.git', 'node_modules'].includes(item.name)) continue;
    const full = path.join(dir, item.name);
    if (item.isDirectory()) yield* files(full);
    else yield full;
  }
}

test('Skill 入口元数据与必要资源有效', async () => {
  const skill = await fs.readFile(path.join(root, 'SKILL.md'), 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skill)?.[1];
  assert.ok(frontmatter, '缺少 Skill frontmatter');
  assert.match(frontmatter, /^name:\s*vue2-to-vue3-migration\s*$/m);
  assert.match(frontmatter, /^description:\s*\S.+$/m);
  for (const dir of ['scripts', 'references', 'assets']) assert.ok((await fs.stat(path.join(root, dir))).isDirectory());
  const config = JSON.parse(await fs.readFile(path.join(root, 'assets/project.example.json'), 'utf8'));
  assert.deepEqual(config.targetManifest.dependencies, {});
  assert.deepEqual(config.targetManifest.devDependencies, {});
});

test('Markdown 文档本地链接存在（代码块内示例除外）', async () => {
  for await (const file of files(root)) {
    if (!file.endsWith('.md')) continue;
    const body = (await fs.readFile(file, 'utf8')).replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '');
    for (const match of body.matchAll(/\]\((<[^>]+>|[^\s)]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1].replace(/^<|>$/g, '');
      if (/^(?:https?:|mailto:|#)/.test(href)) continue;
      const target = decodeURIComponent(href.split('#')[0]);
      if (!target) continue;
      const full = path.resolve(path.dirname(file), target);
      await assert.doesNotReject(fs.access(full), `${path.relative(root, file)} 中的引用不存在：${href}`);
    }
  }
});

test('辅助脚本和测试文件通过 Node 语法检查', async () => {
  for (const dir of ['scripts', 'tests']) for await (const file of files(path.join(root, dir))) {
    if (!file.endsWith('.mjs')) continue;
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 20000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${path.relative(root, file)}：${result.stderr}`);
  }
});
