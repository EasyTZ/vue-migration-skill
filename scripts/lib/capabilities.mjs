import fs from 'node:fs/promises';
import path from 'node:path';
import { samePath } from './source-state.mjs';
import { normalizeEndpoint } from './similarity.mjs';

// 从老工程抽取“必须被验收的行为面”。required 计入复原度分母，
// advisory 只提示核对，避免把 setTimeout 这类普遍写法变成硬性欠账。
export const CAPABILITY_KINDS = [
  { id: 'route', label: '路由入口', severity: 'required', suggestion: '打开该路由：页面渲染、主要区块、默认跳转与权限表现一致', max: 400 },
  { id: 'api', label: '接口调用', severity: 'required', suggestion: '触发对应操作，核对实际 URL、method、参数与返回处理', max: 800 },
  { id: 'form', label: '表单与校验', severity: 'required', suggestion: '留空、非法值、提交、重置与错误反馈', max: 300 },
  { id: 'table', label: '表格与列表', severity: 'required', suggestion: '列表数据、分页、排序、空态与行内操作', max: 300 },
  { id: 'dialog', label: '弹窗与抽屉', severity: 'required', suggestion: '打开、关闭、重开、回填与提交', max: 300 },
  { id: 'permission', label: '权限控制', severity: 'required', suggestion: '有权限/无权限两种账号下的可见性与接口拒绝', max: 200 },
  { id: 'upload', label: '文件上传', severity: 'required', suggestion: '选择、校验、上传成功与失败', max: 100 },
  { id: 'download', label: '下载与导出', severity: 'required', suggestion: '触发下载，核对文件名、内容与鉴权', max: 100 },
  { id: 'print', label: '打印', severity: 'required', suggestion: '打印预览内容与分页', max: 100 },
  { id: 'chart', label: '图表与 Canvas', severity: 'required', suggestion: '图表渲染、数据刷新、空数据与实例销毁', max: 100 },
  { id: 'map', label: '地图', severity: 'required', suggestion: '地图加载、点位与交互', max: 50 },
  { id: 'realtime', label: '实时通信', severity: 'required', suggestion: '建立、断线重连、消息更新与离开清理', max: 100 },
  { id: 'storage', label: '本地存储', severity: 'required', suggestion: '写入/读取键名、退出清理、刷新恢复', max: 200 },
  { id: 'timer', label: '定时器', severity: 'advisory', suggestion: '定时任务启动、暂停与卸载', max: 200 },
  { id: 'i18n', label: '国际化', severity: 'advisory', suggestion: '语言切换与缺失键', max: 200 },
  { id: 'store', label: '共享状态', severity: 'advisory', suggestion: '状态读写、持久化与退出清理', max: 200 },
  { id: 'legacy', label: '旧框架写法', severity: 'advisory', suggestion: '按兼容性检查确认行为等价，非静态删除', max: 400 },
  { id: 'worker', label: 'Worker', severity: 'advisory', suggestion: 'Worker 启动、消息与错误处理', max: 50 },
];
const kindById = new Map(CAPABILITY_KINDS.map(kind => [kind.id, kind]));

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.vite', '.idea', '.output', '.nuxt', '.next', '.cache', 'test-results', 'playwright-report']);
const SOURCE_EXTENSIONS = new Set(['.vue', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.html']);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export function slugDetail(value) {
  return String(value)
    .replace(/[^\p{L}\p{N}_/:.@#-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 90) || 'unknown';
}

function makeLineLocator(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index++) if (text.charCodeAt(index) === 10) starts.push(index + 1);
  return index => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (starts[middle] <= index) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };
}

function* findAll(text, pattern) {
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  let match;
  while ((match = regex.exec(text))) {
    yield match;
    if (match.index === regex.lastIndex) regex.lastIndex += 1;
  }
}

function uniqueMatches(text, pattern, group = 1, limit = 20) {
  const values = [];
  for (const match of findAll(text, pattern)) {
    const value = match[group];
    if (value && !values.includes(value)) values.push(value);
    if (values.length >= limit) break;
  }
  return values;
}

function cleanApiPath(raw) {
  let value = String(raw ?? '').trim();
  if (!value || !value.includes('/')) return null;
  value = value.replace(/^\$\{[^}]+\}/, '');
  if (!value.includes('/') || /^(?:data:|blob:|mailto:|javascript:)/i.test(value)) return null;
  if (/^[a-z]+:\/\//i.test(value) && !/^https?:\/\//i.test(value)) return null;
  return value;
}

function pushApi(units, method, rawPath, { file, line, source }) {
  const cleaned = cleanApiPath(rawPath);
  if (!cleaned) return;
  const normalized = normalizeEndpoint(method, cleaned);
  if (normalized.path === '/' || normalized.path.split('/').filter(Boolean).length === 0) return;
  units.push({
    kind: 'api', detail: `${normalized.method} ${normalized.path}`, file, line,
    extra: { method: normalized.method, path: normalized.path, queryKeys: normalized.queryKeys, raw: String(rawPath).trim().slice(0, 160), source },
  });
}

function contextFlags(text, index) {
  const context = text.slice(Math.max(0, index - 220), Math.min(text.length, index + 640));
  const one = pattern => pattern.exec(context)?.[1] ?? null;
  return {
    name: one(/\bname\s*:\s*['"`]([^'"`]+)['"`]/),
    title: one(/\btitle\s*:\s*['"`]([^'"`]+)['"`]/),
    hidden: /\bhidden\s*:\s*true/.test(context),
    requiresAuth: /\brequiresAuth\s*:\s*true/.test(context),
    keepAlive: /\bkeepAlive\s*:\s*true/.test(context),
    redirect: one(/\bredirect\s*:\s*['"`]([^'"`]+)['"`]/),
  };
}

const isRouterFile = (file, text) => /(?:^|[\\/])[^\\/]*(?:router|routes?)[^\\/]*\.[cm]?[jt]sx?$/i.test(file)
  || /\bcreateRouter\s*\(|\bnew\s+VueRouter\s*\(|\bnew\s+Router\s*\(/.test(text);

function extractRoutes({ text, file, lineAt }) {
  const units = [];
  if (!isRouterFile(file, text)) return units;
  for (const match of findAll(text, /['"]?path['"]?\s*:\s*(['"`])([^'"`]+)\1/g)) {
    const value = match[2].trim();
    if (!value || value === '*' || value.startsWith('//')) continue;
    if (/^[a-z]+:\/\//i.test(value) || /\.(?:vue|js|ts|json|png|jpe?g|svg|css|scss)$/i.test(value)) continue;
    if (!value.startsWith('/') && !value.includes(':')) continue;
    units.push({
      kind: 'route', detail: value, file, line: lineAt(match.index),
      extra: { path: value, ...contextFlags(text, match.index) },
    });
  }
  return units;
}

function extractApis({ text, file, lineAt }) {
  const units = [];
  for (const match of findAll(text, /\b(?:axios|http|request|service|api|instance|client)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*([`'"])([^`'"]+)\2/g)) {
    pushApi(units, match[1], match[3], { file, line: lineAt(match.index), source: 'method-call' });
  }
  for (const match of findAll(text, /\bfetch\s*\(\s*([`'"])([^`'"]+)\1\s*(?:,\s*\{([\s\S]{0,400}?)\})?\s*\)/g)) {
    const method = /\bmethod\s*:\s*['"`]([A-Za-z]+)['"`]/.exec(match[3] ?? '')?.[1] ?? 'GET';
    pushApi(units, method, match[2], { file, line: lineAt(match.index), source: 'fetch' });
  }
  for (const match of findAll(text, /\burl\s*:\s*([`'"])([^`'"]+)\1/g)) {
    const around = text.slice(match.index, Math.min(text.length, match.index + 320));
    const method = /\bmethod\s*:\s*['"`]([A-Za-z]+)['"`]/.exec(around)?.[1] ?? 'ANY';
    pushApi(units, method, match[2], { file, line: lineAt(match.index), source: 'url-field' });
  }
  return units;
}

function fileUnit(kind, { text, file, lineAt }, pattern, extra = null) {
  const match = pattern.exec(text);
  if (!match) return [];
  return [{
    kind, detail: file, file, line: lineAt(match.index),
    extra: extra ? extra(text, match) : null,
  }];
}

function extractComponents({ text, file, lineAt }) {
  const units = [];
  const context = { text, file, lineAt };
  units.push(...fileUnit('form', context, /<el-form\b|<\s*form\b/i, value => ({
    fields: uniqueMatches(value, /\bv-model(?::[\w-]+)?(?:\.\w+)*\s*=\s*["']([^"']+)["']/g, 1, 20),
    props: uniqueMatches(value, /\bprop\s*=\s*["']([^"']+)["']/g, 1, 20),
    messages: uniqueMatches(value, /\bmessage\s*:\s*['"`]([^'"`]+)['"`]/g, 1, 8),
  })));
  units.push(...fileUnit('table', context, /<el-table\b|<a-table\b|<\s*table\b/i, value => ({
    columns: uniqueMatches(value, /<el-table-column\b[^>]*\blabel\s*=\s*["']([^"']+)["']/g, 1, 20),
  })));
  units.push(...fileUnit('dialog', context, /<el-dialog\b|<el-drawer\b|<a-modal\b|<Modal\b/i, value => ({
    titles: uniqueMatches(value, /\btitle\s*=\s*["']([^"']+)["']/g, 1, 8),
  })));
  units.push(...fileUnit('permission', context, /v-permission\b|v-has(?:Permi|Perm)?\b|\bcheckPermission\s*\(|\bhasPermission\s*\(|\bmeta\.roles\b/,
    value => ({
      permissions: uniqueMatches(value, /\bv-(?:permission|hasPermi|has)(?:\.\w+)?\s*=\s*["']([^"']+)["']/g, 1, 12)
        .concat(uniqueMatches(value, /\b(?:checkPermission|hasPermission)\s*\(\s*['"]([^'"]+)['"]/g, 1, 12)),
    })));
  units.push(...fileUnit('upload', context, /<el-upload\b|<input[^>]+type\s*=\s*["']file["']|\bFormData\s*\(/i));
  units.push(...fileUnit('download', context, /\bdownload\s*=|\bcreateObjectURL\s*\(|\bsaveAs\s*\(|FileSaver|\bexport(?:Excel|Csv|Pdf|File)\b/i));
  units.push(...fileUnit('print', context, /\bwindow\.print\s*\(|printJS|LODOP|打印/));
  units.push(...fileUnit('chart', context, /\becharts\b|\bnew\s+Chart\s*\(|\bChart\.js\b|<canvas\b|\bWebGL\b|\bpixi\b|\bthree(?:\.module)?\b|\bd3\./i));
  units.push(...fileUnit('map', context, /\bAMap\b|\bBMap\b|\bmapbox\b|\bleaflet\b|\bCesium\b|\bopenlayers\b|高德地图|百度地图/i));
  units.push(...fileUnit('realtime', context, /\bnew\s+WebSocket\s*\(|\bEventSource\b|\bSockJS\b|\bstomp\b|\bmqtt\b|\bsocket\.io\b|\bWebSocket\s*\(/i));
  units.push(...fileUnit('worker', context, /\bnew\s+(?:Shared)?Worker\s*\(|\bserviceWorker\b/i));
  return units;
}

function extractStorage({ text, file, lineAt }) {
  const units = [];
  for (const match of findAll(text, /(?<storage>localStorage|sessionStorage)\.(?:getItem|setItem|removeItem)\(\s*([`'"])([^`'"]+)\2/g)) {
    const key = match[3].replace(/\$\{[^}]+\}/g, ':param');
    units.push({ kind: 'storage', detail: `${match.groups?.storage ?? match[1]}:${key}`, file, line: lineAt(match.index), extra: { storage: match[1], key } });
  }
  for (const match of findAll(text, /(?:Cookies?|cookieStore)\.(?:get|set|remove)\(\s*([`'"])([^`'"]+)\1/g)) {
    units.push({ kind: 'storage', detail: `cookie:${match[2].replace(/\$\{[^}]+\}/g, ':param')}`, file, line: lineAt(match.index), extra: { storage: 'cookie', key: match[2] } });
  }
  return units;
}

function extractAdvisories({ text, file, lineAt }) {
  const units = [];
  const context = { text, file, lineAt };
  units.push(...fileUnit('timer', context, /\bsetInterval\s*\(|\brequestAnimationFrame\s*\(/));
  units.push(...fileUnit('i18n', context, /\$t\s*\(|\buseI18n\b|\bvue-i18n\b/));
  units.push(...fileUnit('store', context, /\bmapState\s*\(|\bmapGetters\s*\(|\bmapActions\s*\(|\bmapMutations\s*\(|\bdispatch\s*\(|\bcommit\s*\(|\bdefineStore\s*\(|\buseStore\s*\(|\bcreateStore\s*\(/));
  units.push(...fileUnit('legacy', context, /\bfilters\s*:\s*\{|\bmixins\s*:|\$children|\$set\s*\(|\$delete\s*\(|Vue\.prototype|\$scopedSlots|\$listeners|slot-scope|\.sync=|\bbeforeDestroy\s*\(|\bdestroyed\s*\(|\bprops\s*:\s*\[/));
  return units;
}

function unitId(kind, detail) {
  return `${kind}:${slugDetail(detail)}`;
}

function finalizeUnits(rawUnits) {
  const byId = new Map();
  const perKind = new Map();
  let dropped = 0;
  for (const raw of rawUnits) {
    const meta = kindById.get(raw.kind);
    if (!meta) continue;
    const detail = String(raw.detail).trim().slice(0, 160);
    if (!detail) continue;
    const id = unitId(raw.kind, detail);
    const source = { file: raw.file, line: raw.line };
    const existing = byId.get(id);
    if (existing) {
      if (existing.sources.length < 8 && !existing.sources.some(item => item.file === source.file && item.line === source.line)) existing.sources.push(source);
      if (raw.extra && !existing.extra) existing.extra = raw.extra;
      continue;
    }
    const count = perKind.get(raw.kind) ?? 0;
    if (count >= meta.max) { dropped += 1; continue; }
    perKind.set(raw.kind, count + 1);
    byId.set(id, {
      id, kind: raw.kind, severity: meta.severity, label: meta.label,
      detail, file: raw.file, line: raw.line, sources: [source],
      extra: raw.extra ?? null, suggestion: meta.suggestion,
    });
  }
  return { units: [...byId.values()], dropped };
}

async function walkSource(project) {
  const files = [];
  let skipped = 0;
  async function walk(dir) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (samePath(full, project.control)) continue;
      if (entry.isSymbolicLink()) { skipped += 1; continue; }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!entry.isFile() || !SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const stat = await fs.stat(full);
      if (stat.size > MAX_FILE_BYTES) { skipped += 1; continue; }
      files.push({ relative: path.relative(project.source, full).split(path.sep).join('/'), text: await fs.readFile(full, 'utf8') });
    }
  }
  await walk(project.source);
  return { files, skipped };
}

/**
 * 静态抽取能力清单。正则只提供候选：命中项必须回读文件确认，
 * 运行期以浏览器审计记录的网络与场景结果为准。
 */
export async function extractCapabilities(project) {
  const { files, skipped } = await walkSource(project);
  const raw = [];
  for (const file of files) {
    const lineAt = makeLineLocator(file.text);
    const context = { text: file.text, file: file.relative, lineAt };
    raw.push(...extractRoutes(context));
    raw.push(...extractApis(context));
    raw.push(...extractComponents(context));
    raw.push(...extractStorage(context));
    raw.push(...extractAdvisories(context));
  }
  const { units, dropped } = finalizeUnits(raw);
  const byKind = {};
  for (const unit of units) byKind[unit.kind] = (byKind[unit.kind] ?? 0) + 1;
  const routeCandidates = units.filter(unit => unit.kind === 'route').map(unit => ({
    path: unit.extra.path, title: unit.extra.title ?? null, flags: {
      hidden: Boolean(unit.extra.hidden), requiresAuth: Boolean(unit.extra.requiresAuth), keepAlive: Boolean(unit.extra.keepAlive), redirect: unit.extra.redirect ?? null,
    }, file: unit.file, line: unit.line, unitId: unit.id,
  }));
  return {
    schemaVersion: 1, kind: 'capability-inventory', sourceRoot: project.source,
    generatedAt: new Date().toISOString(),
    kinds: CAPABILITY_KINDS.map(({ id, label, severity, suggestion }) => ({ id, label, severity, suggestion })),
    units, routeCandidates,
    stats: {
      total: units.length, required: units.filter(unit => unit.severity === 'required').length,
      advisory: units.filter(unit => unit.severity === 'advisory').length,
      byKind, filesScanned: files.length, filesSkipped: skipped, droppedByKindLimit: dropped,
    },
    note: '正则信号包含注释、字符串与相邻路由配置，只作候选；命中项须回读文件确认。运行期行为以浏览器审计和场景结果为准。',
  };
}
