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
const compileFailures = [];
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
    } catch (error) { compileFailures.push(`${label}: ${error.message}`); }
  }
}
await walk(source);
if (!count) compileFailures.push('未发现 Vue 组件，不能视为通过');

// 编译通过不等于过渡还在工作。Vue 3 把过渡类名从 v-enter / v-leave 改成
// v-enter-from / v-leave-to：旧类名不报错，只是属性不变、transitionend 永不触发，
// 而 -enter-active / -leave-active 里的时长仍会被 Vue 读走，<Transition mode="out-in">
// 于是静默等满整段时长才挂载新组件——表现是切页"卡"一段固定时间，动画却看不见。
const TEXT_EXTENSIONS = new Set(['.vue', '.css', '.scss', '.sass', '.less', '.styl', '.stylus', '.html']);

// 注释里常写着"旧版这里是 .x-enter"这类说明，扫描前先把注释内容换成空格（保留换行，
// 行号不变），否则文档性注释会被当成遗留代码，规则也就没人敢写注释了。
function stripComments(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, (m) => m.replace(/[^\n]/g, ' '));
}

const legacyClass = /(?<![\w-])\.([A-Za-z][\w-]*?)-(enter|leave)(?![-\w])/g;
// 模板里 <Transition> 与 <transition> 两种写法都合法，扫描必须都不漏。
const transitionTag = /<transition(?![-\w])/gi;
const transitionOpen = /<transition(?![-\w])([^>]*)>/gi;
const transitionClose = /<\/transition\s*>/i;
const staticName = /\bname\s*=\s*["']([^"']+)["']/i;
const routerView = /<router-view(?![-\w])/i;
const toLine = (text, index) => text.slice(0, index).split('\n').length;

const legacyClasses = [];
const transitionNames = new Map();
const unnamedTransitions = [];
const routerViewInTransition = [];
async function scanTexts(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name === 'node_modules') continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) { await scanTexts(file); continue; }
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
    const label = path.relative(root, file);
    const raw = await fs.readFile(file, 'utf8').catch(() => '');
    if (!raw) continue;
    const text = stripComments(raw);
    for (const match of text.matchAll(legacyClass)) {
      legacyClasses.push({ name: match[1], phase: match[2], label, line: toLine(text, match.index) });
    }
    if (!entry.name.endsWith('.vue')) continue;
    for (const match of text.matchAll(transitionOpen)) {
      const name = staticName.exec(match[1])?.[1];
      const where = { label, line: toLine(text, match.index) };
      if (name) transitionNames.set(name, [...(transitionNames.get(name) || []), { ...where, named: true }]);
      else unnamedTransitions.push({ ...where, named: false });
    }
    for (const match of text.matchAll(transitionTag)) {
      const rest = text.slice(match.index);
      const close = rest.search(transitionClose);
      const body = close === -1 ? rest : rest.slice(0, close);
      if (routerView.test(body)) routerViewInTransition.push({ label, line: toLine(text, match.index) });
    }
  }
}
await scanTexts(source);

// 无 name 的 <transition> 使用默认前缀 v-（Vue 2 与 Vue 3 相同），.v-enter / .v-leave 同样是确证缺陷；
// 其余只有被 <transition name="..."> 直接引用的旧类名才算确证，剩下只作候选（可能是别的语义）。
function usersOf(name) {
  const users = [...(transitionNames.get(name) || [])];
  if (name === 'v') users.push(...unnamedTransitions);
  return users;
}
const confirmed = legacyClasses.filter(item => usersOf(item.name).length);
const candidates = legacyClasses.filter(item => !usersOf(item.name).length);

const transitionFailures = [];
for (const item of confirmed) {
  const users = usersOf(item.name);
  const where = users.map(u => `${u.label}:${u.line}`).join('、');
  const ref = [users.some(u => u.named) && `<transition name="${item.name}">`,
    users.some(u => !u.named) && '<transition>（无 name，默认前缀 v-）'].filter(Boolean).join(' 与 ');
  const expected = `${item.name}-${item.phase === 'enter' ? 'enter-from' : 'leave-to'}`;
  transitionFailures.push(`${item.label}:${item.line}  Vue 2 过渡类名 .${item.name}-${item.phase} 不会生效，却被 ${ref} 引用（${where}）；改成 .${expected}`);
}
for (const item of routerViewInTransition) {
  transitionFailures.push(`${item.label}:${item.line}  <transition> 里直接嵌 <router-view> 在 Vue 3 不工作；改用 <router-view v-slot="{ Component }"> 包 <component :is="Component" />`);
}
for (const item of candidates) {
  console.error(`${item.label}:${item.line}  候选：.${item.name}-${item.phase} 形似 Vue 2 过渡类名，但没有同名或默认前缀的 <transition> 引用，人工确认后清理或改名`);
}
if (candidates.length) console.error(`过渡类名候选 ${candidates.length} 处：仅作线索，需人工确认，不计入失败`);

for (const failure of [...compileFailures, ...transitionFailures]) console.error(failure);
console.log(`SFC 编译：${count} 个文件，${compileFailures.length} 项失败`);
const unnamed = unnamedTransitions.length ? `、${unnamedTransitions.length} 个无 name（默认前缀 v-）` : '';
console.log(`过渡扫描：${transitionNames.size} 个带 name 的 <transition>${unnamed}，${confirmed.length} 处 Vue 2 类名、${routerViewInTransition.length} 处 router-view 位置问题、${candidates.length} 处候选`);
if (compileFailures.length || transitionFailures.length) process.exitCode = 1;
