import { isLocalAddress } from './similarity.mjs';
import { routeUrl } from './routes.mjs';

const defaultTimeoutMs = 10000;

function selectorHint(selector) {
  if (!selector) return null;
  const id = /^#([\w-]+)$/.exec(selector);
  if (id) return new RegExp(`\\bid\\s*=\\s*["']${id[1]}["']`, 'i');
  const className = /^\.([\w-]+)$/.exec(selector);
  if (className) return new RegExp(`\\bclass\\s*=\\s*["'][^"']*\\b${className[1]}\\b`, 'i');
  const tag = /^([a-z][\w-]*)$/i.exec(selector);
  if (tag) return new RegExp(`<${tag[1]}\\b`, 'i');
  return null;
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual', headers: { accept: 'text/html,application/xhtml+xml' } });
    const text = await response.text();
    return { status: response.status, contentType: response.headers.get('content-type') ?? '', text };
  } catch (error) {
    return { status: null, contentType: '', text: '', error: error.name === 'AbortError' ? `超时（${timeoutMs}ms）` : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAsset(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    await response.body?.cancel().catch(() => {});
    return { status: response.status };
  } catch (error) {
    return { status: null, error: error.name === 'AbortError' ? `超时（${timeoutMs}ms）` : error.message };
  } finally {
    clearTimeout(timer);
  }
}

function extractAssets(html, pageUrl, limit) {
  const assets = [];
  const tags = /<(script|link)\b([^>]*)>/gi;
  let match;
  while ((match = tags.exec(html)) && assets.length < limit) {
    // 站点图标常由部署层提供，缺失不应阻塞业务入口验收；浏览器审计另有 favicon 过滤。
    if (match[1].toLowerCase() === 'link' && /\brel\s*=\s*["'][^"']*\bicon\b/i.test(match[2])) continue;
    const attribute = /(?:src|href)\s*=\s*["']([^"']+)["']/i.exec(match[2])?.[1];
    if (!attribute || /^(?:data:|blob:|mailto:|javascript:|#)/i.test(attribute)) continue;
    let absolute;
    try { absolute = new URL(attribute, pageUrl); } catch { continue; }
    if (!['http:', 'https:'].includes(absolute.protocol)) continue;
    if (absolute.origin !== new URL(pageUrl).origin) continue;
    if (!assets.includes(absolute.href)) assets.push(absolute.href);
  }
  return assets;
}

function httpCheck(name, detail, passed) {
  return { name, status: passed ? 'passed' : 'failed', detail };
}

/** 对每个目标入口做 HTTP 层巡检：状态码、HTML、挂载节点、同源脚本/样式资源。 */
export async function probeRoutes({
  baseUrl, routes, mode = 'history', mountSelector = '#app', timeoutMs = defaultTimeoutMs, allowRemote = false, maxAssets = 8,
}) {
  let base;
  try { base = new URL(baseUrl); } catch { throw new Error(`--base-url 不是合法 URL：${baseUrl}`); }
  if (!['http:', 'https:'].includes(base.protocol)) throw new Error('--base-url 必须是 http(s) 地址');
  if (!allowRemote && !isLocalAddress(base.href)) throw new Error(`只允许巡检本机回环地址：${baseUrl}（远程环境需显式 --allow-remote）`);
  const mountHint = selectorHint(mountSelector);
  const assetCache = new Map();
  const htmlCache = new Map();
  const assetChecks = [];

  const checkAssets = async assets => {
    const failures = [];
    for (const asset of assets) {
      if (!assetCache.has(asset)) assetCache.set(asset, await fetchAsset(asset, timeoutMs));
      const result = assetCache.get(asset);
      const passed = result.status !== null && result.status < 400;
      assetChecks.push({ url: asset, status: result.status, passed });
      if (!passed) failures.push(`${asset} → ${result.status ?? result.error}`);
    }
    return failures;
  };

  const checkPage = async url => {
    if (!htmlCache.has(url)) htmlCache.set(url, await fetchText(url, timeoutMs));
    const page = htmlCache.get(url);
    const checks = [];
    const failures = [];
    const httpOk = page.status !== null && page.status >= 200 && page.status < 400;
    checks.push(httpCheck('http', page.status === null ? page.error : `HTTP ${page.status}`, httpOk));
    if (!httpOk) failures.push(`HTTP ${page.status ?? page.error}`);
    const htmlOk = /text\/html/i.test(page.contentType) && page.text.length > 0;
    checks.push(httpCheck('content-type', page.contentType || '缺少 Content-Type', htmlOk));
    if (!htmlOk && httpOk) failures.push(`响应不是 HTML（${page.contentType || '空类型'}）`);
    if (httpOk && /Internal Server Error|Pre-transform error|\[plugin:/i.test(page.text)) {
      checks.push(httpCheck('server-error', 'HTML 含开发服务器错误内容', false));
      failures.push('HTML 含开发服务器错误内容');
    }
    if (mountHint) {
      const mountOk = mountHint.test(page.text);
      checks.push(httpCheck('mount', `HTML ${mountOk ? '包含' : '未找到'}挂载节点 ${mountSelector}`, mountOk));
      if (!mountOk) failures.push(`HTML 未找到挂载节点 ${mountSelector}`);
    }
    const assets = extractAssets(page.text, url, maxAssets);
    const assetFailures = await checkAssets(assets);
    checks.push(httpCheck('assets', assets.length ? `检查 ${assets.length} 个同源资源` : '无同源脚本/样式资源', assetFailures.length === 0));
    failures.push(...assetFailures);
    return { status: page.status, contentType: page.contentType, checks, failures };
  };

  const rootUrl = routeUrl(base.href, '/', mode);
  const rootPage = await checkPage(rootUrl);
  const root = {
    url: rootUrl, httpStatus: rootPage.status,
    status: rootPage.failures.length ? 'failed' : 'passed',
    checks: rootPage.checks, failures: rootPage.failures,
  };
  const results = [];
  for (const route of routes) {
    const url = routeUrl(base.href, route.targetPath, mode);
    const page = await checkPage(url);
    results.push({
      id: route.id, path: route.targetPath, url, httpStatus: page.status,
      status: page.failures.length ? 'failed' : 'passed',
      checks: page.checks, failures: page.failures,
      note: mode === 'hash' ? 'hash 路由共用入口 HTML，页面 DOM 由浏览器审计验证' : null,
    });
  }
  const failed = results.filter(route => route.status === 'failed');
  return {
    schemaVersion: 1, kind: 'http-probe', generatedAt: new Date().toISOString(),
    baseUrl: base.href, mode, mountSelector, allowRemote, timeoutMs,
    root: { url: root.url, httpStatus: root.httpStatus, status: root.status, checks: root.checks, failures: root.failures },
    routes: results,
    summary: {
      total: results.length, passed: results.length - failed.length, failed: failed.length,
      assetsChecked: assetChecks.length, failedAssets: assetChecks.filter(asset => !asset.passed).length,
    },
    note: 'HTTP 巡检只能证明入口返回可解析的 HTML 与资源；渲染、交互、接口与视觉需浏览器审计与场景测试。',
  };
}
