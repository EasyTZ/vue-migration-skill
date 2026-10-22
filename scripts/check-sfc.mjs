import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

if (!process.argv[2]) throw new Error('用法：node check-sfc.mjs <目标工程>');
const root = path.resolve(process.argv[2]);
const require = createRequire(path.join(root, 'package.json'));
let compiler;
try {
  compiler = require('@vue/compiler-sfc');
} catch (error) {
  throw new Error(`无法从目标工程加载 @vue/compiler-sfc，请先安装依赖：${error.message}`);
}
const source = path.join(root, 'src');
if (!(await fs.stat(source).catch(() => null))?.isDirectory()) throw new Error(`目标工程没有 src 目录：${source}`);

let count = 0;
const failures = [];
async function walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === 'node_modules') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { await walk(file); continue; }
    if (!entry.name.endsWith('.vue')) continue;
    count++;
    const label = path.relative(root, file);
    try {
      const { descriptor: d, errors } = compiler.parse(await fs.readFile(file, 'utf8'), { filename: file });
      if (errors.length) throw new Error(errors.map(String).join('\n'));
      if ([d.script, d.scriptSetup, d.template, ...d.styles].some(b => b?.src)) throw new Error('外部 src 块需另行编译验证');
      const id = `sfc-${count}`;
      const script = d.script || d.scriptSetup ? compiler.compileScript(d, { id }) : null;
      if (d.template) {
        const result = compiler.compileTemplate({ source: d.template.content, filename: file, id,
          scoped: d.styles.some(s => s.scoped), preprocessLang: d.template.lang,
          compilerOptions: { bindingMetadata: script?.bindings } });
        if (result.errors.length) throw new Error(result.errors.map(String).join('\n'));
      }
      for (const style of d.styles) {
        const result = await compiler.compileStyleAsync({ source: style.content, filename: file, id,
          scoped: style.scoped, modules: style.module !== undefined, preprocessLang: style.lang });
        if (result.errors.length) throw new Error(result.errors.map(String).join('\n'));
      }
    } catch (error) { failures.push(`${label}: ${error.message}`); }
  }
}
await walk(source);
if (!count) failures.push('未发现 Vue 组件，不能视为通过');
for (const failure of failures) console.error(failure);
console.log(`SFC 编译：${count} 个文件，${failures.length} 项失败`);
if (failures.length) process.exitCode = 1;
