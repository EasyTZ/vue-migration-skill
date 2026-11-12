// 新旧页面对拍的可计算信号：文本、结构、接口路径。
// 这些指标只用于发现差异和排序问题，不能单独证明业务正确。

export function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\d+(?:[.,]\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(value, limit = 600) {
  const tokens = new Set();
  for (const token of normalizeText(value).split(/[^\p{L}\p{N}_#:./-]+/u)) {
    if (token.length < 2 || token.length > 32) continue;
    tokens.add(token);
    if (tokens.size >= limit) break;
  }
  return [...tokens];
}

export function textSimilarity(tokensA, tokensB) {
  const first = new Set(tokensA ?? []);
  const second = new Set(tokensB ?? []);
  if (!first.size && !second.size) return 1;
  if (!first.size || !second.size) return 0;
  let intersection = 0;
  for (const token of first) if (second.has(token)) intersection += 1;
  return round(intersection / (first.size + second.size - intersection));
}

const multiset = list => {
  const map = new Map();
  for (const key of list) map.set(key, (map.get(key) ?? 0) + 1);
  return map;
};

function multisetJaccard(listA, listB) {
  const first = multiset(listA);
  const second = multiset(listB);
  if (!first.size && !second.size) return 1;
  let intersection = 0;
  let union = 0;
  for (const [key, count] of first) {
    intersection += Math.min(count, second.get(key) ?? 0);
    union += Math.max(count, second.get(key) ?? 0);
  }
  for (const [key, count] of second) if (!first.has(key)) union += count;
  return union ? round(intersection / union) : 1;
}

const bucket = value => {
  const numeric = Number.isFinite(Number(value)) ? Number(value) : 0;
  return Math.min(2048, Math.round(numeric / 24) * 24);
};

export function layoutSignature(fingerprint) {
  return (fingerprint?.nodes ?? []).map(node => `${node.tag}|${node.role ?? ''}|${bucket(node.w)}x${bucket(node.h)}`);
}

export function controlCounts(fingerprint) {
  return fingerprint?.controls ?? {};
}

function controlSimilarity(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  let distance = 0;
  let total = 0;
  for (const key of keys) {
    const first = Number(a?.[key] ?? 0);
    const second = Number(b?.[key] ?? 0);
    distance += Math.abs(first - second);
    total += Math.max(first, second);
  }
  return total ? round(1 - distance / total) : 1;
}

/**
 * 布局相似度：可见节点「标签+role+尺寸档位」的多重集合 + 控件数量分布。
 * 组件库内部 DOM 会变（wrapper 层数、class 名），所以刻意不比 class 与绝对坐标。
 */
export function layoutSimilarity(fingerprintA, fingerprintB) {
  const structure = multisetJaccard(layoutSignature(fingerprintA), layoutSignature(fingerprintB));
  const controls = controlSimilarity(controlCounts(fingerprintA), controlCounts(fingerprintB));
  return round(structure * 0.6 + controls * 0.4);
}

const COMBINE_WEIGHTS = { pixels: 0.4, text: 0.3, layout: 0.3 };
export function combineSimilarity(parts = {}) {
  let score = 0;
  let weight = 0;
  for (const [key, partWeight] of Object.entries(COMBINE_WEIGHTS)) {
    if (typeof parts[key] !== 'number' || Number.isNaN(parts[key])) continue;
    score += parts[key] * partWeight;
    weight += partWeight;
  }
  return weight ? round(score / weight) : null;
}

/**
 * 接口路径归一：去掉 origin、把模板变量/数字/UUID/日期/长随机串变为占位符，
 * 保留 query 键名用于提示，不保留 query 值（值通常随测试数据变化）。
 */
export function normalizeEndpoint(method, rawPath) {
  const methodName = String(method || 'GET').toUpperCase();
  let pathname = String(rawPath ?? '').trim();
  try { if (/^https?:\/\//i.test(pathname)) pathname = new URL(pathname).pathname; } catch { /* 保留原始字符串继续归一 */ }
  pathname = pathname.replace(/\$\{[^}]+\}/g, ':param');
  const [beforeHash] = pathname.split('#');
  const [pathPart, queryPart = ''] = beforeHash.split('?');
  const queryKeys = queryPart
    ? [...new Set(queryPart.split('&').filter(Boolean).map(pair => pair.split('=')[0]).filter(Boolean))].sort()
    : [];
  let normalized = pathPart.replace(/\/+/g, '/');
  if (!normalized.startsWith('/')) normalized = `/${normalized}`;
  if (normalized.length > 1) normalized = normalized.replace(/\/+$/, '');
  normalized = normalized.split('/').map(segment => {
    if (!segment) return segment;
    if (/^:[\w-]+$/.test(segment)) return ':param';
    if (/^\d+$/.test(segment)) return ':param';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ':param';
    if (/^[0-9a-f]{16,}$/i.test(segment)) return ':param';
    if (/^\d{4}-\d{2}-\d{2}/.test(segment)) return ':param';
    if (segment.length > 24 && /^[A-Za-z0-9_\-%=]+$/.test(segment)) return ':param';
    return segment;
  }).join('/');
  return { method: methodName, path: normalized || '/', queryKeys };
}

export function endpointKey(method, rawPath) {
  const normalized = normalizeEndpoint(method, rawPath);
  return `${normalized.method} ${normalized.path}`;
}

const segments = value => value.split('/').filter(Boolean);

/** 允许代理改写前缀（/api/x → /x）时以整段后缀匹配，避免把同一接口算成两个。 */
function pathMatches(sourcePath, observedPath) {
  if (sourcePath === observedPath) return 'exact';
  const source = segments(sourcePath);
  const observed = segments(observedPath);
  const shorter = source.length <= observed.length ? source : observed;
  const longer = source.length <= observed.length ? observed : source;
  if (!shorter.length) return null;
  const tail = longer.slice(longer.length - shorter.length);
  // 动态段已统一归一为 :param，因此这里只做逐段字面比较，不能让任意字面段匹配占位符。
  const same = shorter.every((segment, index) => segment === tail[index]);
  if (!same) return null;
  if (shorter.length >= 2 || longer.join('/').length >= 6) return 'suffix';
  return null;
}

/**
 * 把源工程提取到的接口与目标工程实际发出的请求做匹配。
 * 返回 matched 时同时给出命中的实际请求，便于在报告里核对。
 */
export function matchEndpoint(source, observed) {
  const normalizedSource = typeof source === 'object' ? normalizeEndpoint(source.method, source.path) : normalizeEndpoint(...String(source).split(' '));
  const candidates = [];
  for (const item of observed ?? []) {
    const normalized = normalizeEndpoint(item.method, item.path ?? item.url ?? '');
    if (normalizedSource.method !== 'ANY' && normalized.method !== normalizedSource.method) continue;
    const reason = pathMatches(normalizedSource.path, normalized.path);
    if (reason) candidates.push({ ...item, normalized, reason });
  }
  if (!candidates.length) return { matched: false, candidates: [] };
  const exact = candidates.filter(item => item.reason === 'exact');
  return { matched: true, reason: exact.length ? 'exact' : 'suffix', observed: (exact[0] ?? candidates[0]) };
}

export function isLocalAddress(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return ['localhost', '127.0.0.1', '[::1]', '::1', '0.0.0.0'].includes(url.hostname);
  } catch { return false; }
}

const round = value => Math.round(value * 10000) / 10000;
