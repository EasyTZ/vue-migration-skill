import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { combineSimilarity, isLocalAddress, layoutSimilarity, textSimilarity, tokenize } from './similarity.mjs';
import { routeUrl } from './routes.mjs';
import { imageSimilarity } from './png.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const DEFAULT_IGNORE_CONSOLE = [/Download the Vue Devtools/i, /Vue DevTools/i];
const DEFAULT_IGNORE_REQUEST = [/\/@vite\//, /\/__vite/, /\/node_modules\/\.vite\//, /\/favicon\.ico(?:$|\?)/, /\/__webpack_hmr/, /\/sockjs-node\//];
const SEVERE_WARNING = /\[Vue warn\].*(?:Invalid prop|Failed to resolve component|Missing required prop|Extraneous non-props|Property .* was accessed during render)/i;
const DEFAULT_CRAWL_EXCLUDE = /\/(?:logout|signout|sign-out|退出|注销)(?:[/?#]|$)/i;

function compilePatterns(patterns, defaults, label) {
  const result = [];
  for (const pattern of [...defaults, ...(patterns ?? [])]) {
    try {
      result.push(pattern instanceof RegExp ? pattern : new RegExp(pattern));
    } catch (error) {
      throw new Error(`${label} 正则无效：${pattern}（${error.message}）`);
    }
  }
  return result;
}

const ignored = (value, patterns) => patterns.some(pattern => pattern.test(String(value)));

/** 依次尝试包名、显式路径与 cwd 下的 node_modules；找不到时给出安装指引。 */
async function loadPlaywright(explicit) {
  const requireFromCwd = createRequire(path.join(process.cwd(), 'noop.cjs'));
  const candidates = [];
  const add = value => { if (value && !candidates.includes(value)) candidates.push(value); };
  add(explicit);
  if (process.env.MIGRATION_PLAYWRIGHT_MODULE) add(process.env.MIGRATION_PLAYWRIGHT_MODULE);
  add('playwright');
  const errors = [];
  for (const candidate of candidates) {
    const isPath = candidate.includes('/') || candidate.includes('\\') || candidate.startsWith('.');
    try {
      if (isPath) {
        const resolved = path.resolve(candidate);
        const loaded = createRequire(import.meta.url)(resolved);
        return loaded.default ?? loaded;
      }
      try { return requireFromCwd(candidate); } catch { /* 交给动态 import */ }
      return await import(candidate);
    } catch (error) {
      errors.push(`${candidate}：${error.message.split('\n')[0]}`);
    }
  }
  throw new Error(`未找到可用的 Playwright 模块。\n可在控制目录 tools/browser 安装（npm i playwright && npx playwright install chromium），再用 --playwright 指定入口；或安装系统 Chrome 后用 --channel chrome。\n尝试结果：${errors.join('；')}`);
}

function safeName(value, fallback = 'route') {
  const name = String(value ?? '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return name || fallback;
}

/** 基线目录用路由 id 的稳定短标记，避免两边路由顺序不同导致对错文件。 */
function stableToken(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${safeName(text)}-${(hash >>> 0).toString(36).slice(0, 6)}`;
}

/** 场景步骤中的 {{ENV:NAME}} / {{NOW}} 占位符；口令只从环境变量读，不写进场景文件。 */
function resolveText(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/\{\{ENV:([A-Za-z_][A-Za-z0-9_]*)\}\}/g, (_match, name) => {
    const resolved = process.env[name];
    if (resolved === undefined) throw new Error(`场景需要的环境变量 ${name} 未设置`);
    return resolved;
  }).replace(/\{\{NOW\}\}/g, String(Date.now()));
}

function textMatches(actual, step) {
  const text = String(actual ?? '');
  if (step.equals !== undefined) return text.trim() === String(step.equals).trim();
  if (step.regex !== undefined) return new RegExp(step.regex).test(text);
  if (step.contains !== undefined) return text.includes(String(step.contains));
  throw new Error('expectText/expectUrl 需要 contains、equals 或 regex 之一');
}

async function poll(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) { lastError = error; }
    await sleep(200);
  }
  throw new Error(`${message}${lastError ? `（最后错误：${lastError.message}）` : ''}`);
}

async function executeStep(page, step, index, context) {
  const timeout = Number(step.timeout) > 0 ? Number(step.timeout) : 15000;
  const selector = typeof step.selector === 'string' ? step.selector : null;
  const locator = () => {
    if (!selector) throw new Error(`步骤 ${index}（${step.action}）缺少 selector`);
    return page.locator(selector).first();
  };
  const action = step.action;
  switch (action) {
    case 'goto': {
      const target = step.path ? routeUrl(context.baseUrl, resolveText(step.path), context.mode) : resolveText(step.url);
      if (!target) throw new Error(`步骤 ${index}（goto）需要 path 或 url`);
      await page.goto(target, { waitUntil: 'domcontentloaded', timeout });
      return;
    }
    case 'reload':
      await page.reload({ waitUntil: 'domcontentloaded', timeout });
      return;
    case 'click':
      await locator().click({ timeout });
      return;
    case 'fill':
      if (step.value === undefined) throw new Error(`步骤 ${index}（fill）缺少 value`);
      await locator().fill(String(resolveText(step.value)), { timeout });
      return;
    case 'press':
      await locator().press(String(step.key ?? 'Enter'), { timeout });
      return;
    case 'select':
      if (step.value === undefined) throw new Error(`步骤 ${index}（select）缺少 value`);
      await locator().selectOption(String(resolveText(step.value)), { timeout });
      return;
    case 'check':
      await locator().check({ timeout });
      return;
    case 'uncheck':
      await locator().uncheck({ timeout });
      return;
    case 'hover':
      await locator().hover({ timeout });
      return;
    case 'waitFor': {
      const state = step.state ?? 'visible';
      await locator().waitFor({ state, timeout });
      return;
    }
    case 'wait': {
      const duration = Math.min(Number(step.ms ?? step.value ?? 300), 15000);
      await page.waitForTimeout(duration);
      return;
    }
    case 'expectVisible':
      await locator().waitFor({ state: 'visible', timeout });
      return;
    case 'expectHidden':
      await locator().waitFor({ state: 'hidden', timeout });
      return;
    case 'expectCount': {
      if (!Number.isInteger(step.count)) throw new Error(`步骤 ${index}（expectCount）缺少整数 count`);
      await poll(async () => await page.locator(selector).count() === step.count, timeout, `元素数量不是 ${step.count}：${selector}`);
      return;
    }
    case 'expectText':
      await poll(async () => textMatches(await locator().innerText(), step), timeout, `文本不匹配：${selector}`);
      return;
    case 'expectValue':
      await poll(async () => textMatches(await locator().inputValue(), step), timeout, `输入值不匹配：${selector}`);
      return;
    case 'expectUrl':
      await poll(async () => textMatches(page.url(), step), timeout, `地址不匹配：${page.url()}`);
      return;
    case 'expectRequest': {
      const matches = request => {
        if (step.method && String(step.method).toUpperCase() !== request.method) return false;
        if (step.urlContains && !String(request.url).includes(String(step.urlContains))) return false;
        if (step.path && !(request.path ?? '').includes(String(step.path))) return false;
        if (step.status !== undefined && Number(step.status) !== request.status) return false;
        if (step.bodyContains && !String(request.requestBody ?? '').includes(String(step.bodyContains))) return false;
        return true;
      };
      await poll(async () => context.responses.some(matches), timeout, `未观察到预期请求：${JSON.stringify({ method: step.method, urlContains: step.urlContains, status: step.status })}`);
      return;
    }
    case 'screenshot': {
      await context.screenshot(`step-${index}-${safeName(step.name ?? 'shot')}`);
      return;
    }
    default:
      throw new Error(`未知步骤动作：${action}。支持 goto/reload/click/fill/press/select/check/uncheck/hover/waitFor/wait/expectVisible/expectHidden/expectCount/expectText/expectValue/expectUrl/expectRequest/screenshot`);
  }
}

function normalizeScenario(document, source) {
  const scenarioList = Array.isArray(document) ? document : document?.scenarios;
  if (!Array.isArray(scenarioList)) throw new Error(`${source} 缺少 scenarios 数组`);
  const seen = new Set();
  return scenarioList.map((scenario, index) => {
    if (!scenario || typeof scenario !== 'object') throw new Error(`${source} 第 ${index + 1} 个场景不是对象`);
    const id = typeof scenario.id === 'string' && scenario.id.trim() ? scenario.id : `SC-${index + 1}`;
    if (seen.has(id)) throw new Error(`${source} 存在重复场景 id：${id}`);
    seen.add(id);
    const phase = ['setup', 'route', 'interaction'].includes(scenario.phase) ? scenario.phase : 'interaction';
    if (!Array.isArray(scenario.steps)) throw new Error(`${source} 场景 ${id} 缺少 steps 数组`);
    return {
      id, phase,
      route: typeof scenario.route === 'string' ? scenario.route : null,
      covers: Array.isArray(scenario.covers) ? scenario.covers.filter(item => typeof item === 'string') : [],
      steps: scenario.steps,
      allowConsolePatterns: Array.isArray(scenario.allow?.console) ? scenario.allow.console : [],
      allowRequestPatterns: Array.isArray(scenario.allow?.requests) ? scenario.allow.requests : [],
    };
  });
}

const fingerprintScript = (mountSelector) => {
  const visible = element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const body = document.body;
  const text = (body?.innerText ?? '').trim();
  const controls = {
    inputs: document.querySelectorAll('input').length,
    selects: document.querySelectorAll('select').length,
    textareas: document.querySelectorAll('textarea').length,
    buttons: document.querySelectorAll('button').length,
    links: document.querySelectorAll('a[href]').length,
    tables: document.querySelectorAll('table').length,
    rows: document.querySelectorAll('table tbody tr').length,
    forms: document.querySelectorAll('form').length,
    images: document.querySelectorAll('img,svg').length,
    canvases: document.querySelectorAll('canvas').length,
  };
  const nodes = [...document.querySelectorAll('body *')].filter(visible).slice(0, 300).map(element => {
    const rect = element.getBoundingClientRect();
    return { tag: element.tagName.toLowerCase(), role: element.getAttribute('role') ?? '', w: Math.round(rect.width), h: Math.round(rect.height) };
  });
  const mount = mountSelector ? document.querySelector(mountSelector) : null;
  return {
    url: location.href,
    title: document.title,
    text: text.slice(0, 20000),
    textLength: text.length,
    controls,
    nodes,
    mountFilled: mount ? mount.childElementCount > 0 : null,
    overlay: document.querySelector('vite-error-overlay, #webpack-dev-server-client-overlay, .vite-error-overlay')?.textContent?.slice(0, 2000) ?? null,
  };
};

async function screenshotRoute(page, directory, name) {
  if (!directory) return null;
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${safeName(name)}.png`);
  try {
    await page.screenshot({ path: file, fullPage: false, animations: 'disabled', caret: 'hide' });
    return file;
  } catch { return null; }
}

function emptyBucket() {
  return { console: [], pageErrors: [], warnings: [], failedRequests: [], responses: [], apiCalls: [] };
}

function attachCapture(page, bucket, { ignoreConsole, ignoreRequest }) {
  const handlers = {
    console(message) {
      const text = message.text();
      if (ignored(text, ignoreConsole)) return;
      const locationUrl = message.location()?.url;
      // 资源 404 的 console 文案不带 URL，只能按消息位置过滤（favicon 等开发期噪声）。
      if (locationUrl && ignored(locationUrl, ignoreRequest)) return;
      if (message.type() === 'error') bucket.console.push(text);
      else if (message.type() === 'warning') {
        if (SEVERE_WARNING.test(text)) bucket.console.push(text);
        else bucket.warnings.push(text);
      }
    },
    pageerror(error) { bucket.pageErrors.push(error.message); },
    response(response) {
      const request = response.request();
      const type = request.resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;
      const url = response.url();
      if (ignored(url, ignoreRequest)) return;
      let pathName = url;
      try { const parsed = new URL(url); pathName = `${parsed.pathname}${parsed.search}`; } catch { /* 保留完整地址 */ }
      const record = { method: request.method(), url, path: pathName, status: response.status() };
      bucket.responses.push({ ...record, requestBody: request.postData() ?? null });
      bucket.apiCalls.push(record);
    },
    requestfailed(request) {
      if (ignored(request.url(), ignoreRequest)) return;
      const errorText = request.failure()?.errorText ?? '';
      // 切页时未完成的请求会被浏览器取消，这不是页面缺陷。
      if (errorText.includes('net::ERR_ABORTED')) return;
      bucket.failedRequests.push({ url: request.url(), resourceType: request.resourceType(), error: errorText || '请求失败' });
    },
  };
  page.on('console', handlers.console);
  page.on('pageerror', handlers.pageerror);
  page.on('response', handlers.response);
  page.on('requestfailed', handlers.requestfailed);
  return () => {
    page.off('console', handlers.console);
    page.off('pageerror', handlers.pageerror);
    page.off('response', handlers.response);
    page.off('requestfailed', handlers.requestfailed);
  };
}

async function compareBaseline(baselineDir, index, route, fingerprint, screenshotFile) {
  const directory = path.join(baselineDir, stableToken(route.id));
  const domFile = path.join(directory, 'dom.json');
  const shotFile = path.join(directory, 'shot.png');
  try {
    await fs.access(domFile);
  } catch {
    return { available: false, reason: `缺少基线 ${path.basename(domFile)}` };
  }
  try {
    const baseline = JSON.parse(await fs.readFile(domFile, 'utf8'));
    const parts = {
      text: textSimilarity(tokenize(baseline.text), tokenize(fingerprint.text)),
      layout: layoutSimilarity(baseline, fingerprint),
      pixels: null,
    };
    if (screenshotFile) {
      try {
        const [current, base] = await Promise.all([fs.readFile(screenshotFile), fs.readFile(shotFile)]);
        parts.pixels = imageSimilarity(current, base).similarity;
      } catch { parts.pixels = null; }
    }
    return { available: true, parts, similarity: combineSimilarity(parts), baselineFile: domFile };
  } catch (error) {
    return { available: false, reason: `基线读取失败：${error.message}` };
  }
}

async function writeBaseline(baselineDir, index, route, fingerprint, screenshotFile, apiCalls) {
  const directory = path.join(baselineDir, stableToken(route.id));
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'dom.json'), JSON.stringify({ ...fingerprint, route: { id: route.id, targetPath: route.targetPath }, capturedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  await fs.writeFile(path.join(directory, 'network.json'), JSON.stringify(apiCalls, null, 2) + '\n', 'utf8');
  if (screenshotFile) await fs.copyFile(screenshotFile, path.join(directory, 'shot.png'));
  return directory;
}

async function auditRoute(page, route, index, context) {
  const bucket = emptyBucket();
  const detach = attachCapture(page, bucket, context);
  try {
  const url = routeUrl(context.baseUrl, route.targetPath, context.mode);
  const startedAt = Date.now();
  let navigationError = null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: context.navigationTimeoutMs });
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(context.settleMs);
  } catch (error) {
    navigationError = error.message.split('\n')[0];
  }
  let fingerprint = null;
  if (!navigationError) {
    try { fingerprint = await page.evaluate(fingerprintScript, context.mountSelector); } catch (error) { navigationError = `读取页面结构失败：${error.message}`; }
  }
  const screenshotFile = navigationError ? null : await screenshotRoute(page, context.screenshotDir, `${String(index).padStart(3, '0')}-${safeName(route.id)}`);
  const consoleErrors = [...bucket.console];
  const pageErrors = [...bucket.pageErrors];
  const errors = [...consoleErrors, ...pageErrors];
  const failedRequests = [...bucket.failedRequests];
  const overlay = fingerprint?.overlay ?? null;
  const blank = fingerprint ? fingerprint.textLength < 10 && fingerprint.controls.canvases === 0 && fingerprint.controls.images === 0 : false;
  const mountBroken = fingerprint?.mountFilled === false && fingerprint.textLength < 10;
  const failureReasons = [];
  if (navigationError) failureReasons.push(`打开失败：${navigationError}`);
  if (overlay) failureReasons.push(`页面错误遮罩：${overlay.slice(0, 200)}`);
  if (blank) failureReasons.push('页面接近空白');
  if (mountBroken) failureReasons.push('挂载节点没有渲染内容');
  if (errors.length) failureReasons.push(`控制台错误 ${errors.length} 条`);
  if (failedRequests.length) failureReasons.push(`请求失败 ${failedRequests.length} 个`);
  let baseline = { available: false, reason: '未提供旧版基线' };
  if (context.baselineDir && fingerprint) baseline = await compareBaseline(context.baselineDir, index, route, fingerprint, screenshotFile);
  if (context.captureDir && fingerprint) await writeBaseline(context.captureDir, index, route, fingerprint, screenshotFile, bucket.apiCalls);
  return {
    id: route.id, path: route.targetPath, sourcePath: route.sourcePath ?? null,
    url, title: fingerprint?.title ?? null,
    discovered: Boolean(route.discovered),
    render: failureReasons.length ? 'failed' : 'passed',
    failureReasons,
    errors, consoleErrors, pageErrors, warnings: bucket.warnings, failedRequests,
    apiCalls: dedupeCalls(bucket.apiCalls),
    metrics: {
      textLength: fingerprint?.textLength ?? 0,
      controls: fingerprint?.controls ?? null,
      mountFilled: fingerprint?.mountFilled ?? null,
      screenshot: screenshotFile,
      similarity: baseline.available ? baseline.similarity : null,
      similarityParts: baseline.available ? baseline.parts : null,
      baselineAvailable: baseline.available,
      baselineReason: baseline.available ? null : baseline.reason,
    },
    durationMs: Date.now() - startedAt,
  };
  } finally {
    detach();
  }
}

function dedupeCalls(calls) {
  const seen = new Set();
  return calls.filter(call => {
    const key = `${call.method} ${call.path} ${call.status}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function runScenario(page, scenario, index, context) {
  const bucket = emptyBucket();
  const detach = attachCapture(page, bucket, context);
  try {
  const allowConsole = compilePatterns(scenario.allowConsolePatterns, [], `场景 ${scenario.id} 的 allow.console`);
  const allowRequests = compilePatterns(scenario.allowRequestPatterns, [], `场景 ${scenario.id} 的 allow.requests`);
  const local = { ...context, responses: bucket.responses, screenshot: name => screenshotRoute(page, context.screenshotDir, `${String(index).padStart(3, '0')}-${safeName(scenario.id)}-${name}`) };
  const steps = [];
  const failures = [];
  const startedAt = Date.now();
  let routeError = null;
  try {
    if (scenario.route) await page.goto(routeUrl(context.baseUrl, resolveText(scenario.route), context.mode), { waitUntil: 'domcontentloaded', timeout: context.navigationTimeoutMs });
  } catch (error) {
    routeError = error.message.split('\n')[0];
  }
  if (!routeError) {
    for (const [stepIndex, step] of scenario.steps.entries()) {
      try {
        await executeStep(page, step, stepIndex, local);
        steps.push({ index: stepIndex, action: step.action, status: 'passed' });
      } catch (error) {
        steps.push({ index: stepIndex, action: step.action, status: 'failed', message: error.message.split('\n')[0] });
        failures.push({ step: stepIndex, action: step.action, message: error.message.split('\n')[0] });
        break;
      }
    }
  }
  if (routeError) failures.push({ step: -1, action: 'goto', message: routeError });
  const consoleErrors = bucket.console.filter(text => !ignored(text, allowConsole));
  const failedRequests = bucket.failedRequests.filter(request => !ignored(request.url, allowRequests));
  for (const message of consoleErrors) failures.push({ step: null, action: 'console', message });
  for (const request of failedRequests) failures.push({ step: null, action: 'requestfailed', message: `${request.url}：${request.error}` });
  const screenshotPath = failures.length ? await local.screenshot('failed') : null;
  return {
    id: scenario.id, phase: scenario.phase, route: scenario.route, covers: scenario.covers,
    status: failures.length ? 'failed' : 'passed',
    steps, failures, screenshot: screenshotPath,
    consoleErrors, warnings: bucket.warnings,
    apiCalls: dedupeCalls(bucket.apiCalls),
    durationMs: Date.now() - startedAt,
  };
  } finally {
    detach();
  }
}

/**
 * 浏览器审计：逐入口渲染、控制台/请求错误、接口调用、交互场景、截图与新旧基线相似度。
 * 需要 Playwright；缺少浏览器时明确失败，不把 UI 验收写成通过。
 */
export async function runBrowserAudit(options) {
  const {
    baseUrl, routes, scenarios = [], mode = 'history', viewport = { width: 1440, height: 900 },
    mountSelector = '#app', baselineDir = null, captureDir = null, screenshotDir = null,
    storageStateFile = null, playwrightModule = null, channel = null, executablePath = null,
    ignoreConsolePatterns = [], ignoreRequestPatterns = [],
    navigationTimeoutMs = 30000, settleMs = 300, crawl = false, maxCrawlRoutes = 50,
    scenarioSource = 'scenarios.json', routesSource = 'routes.json', allowRemote = false,
  } = options;
  if (!allowRemote && !isLocalAddress(baseUrl)) throw new Error(`浏览器审计只允许本机回环地址：${baseUrl}（远程环境需显式 --allow-remote）`);
  if (!routes?.length) throw new Error(`${routesSource} 没有可审计的路由`);
  const scenarioList = normalizeScenario(scenarios, scenarioSource);
  if (captureDir && !screenshotDir) throw new Error('基线采集需要截图目录');
  const ignoreConsole = compilePatterns(ignoreConsolePatterns, DEFAULT_IGNORE_CONSOLE, 'ignoreConsolePatterns');
  const ignoreRequest = compilePatterns(ignoreRequestPatterns, DEFAULT_IGNORE_REQUEST, 'ignoreRequestPatterns');
  const playwright = await loadPlaywright(playwrightModule);
  let browser;
  try {
    const launchOptions = { headless: true };
    if (channel) launchOptions.channel = channel;
    else if (executablePath) launchOptions.executablePath = executablePath;
    browser = await playwright.chromium.launch(launchOptions);
  } catch (error) {
    throw new Error(`浏览器启动失败：${error.message.split('\n')[0]}\n可执行 npx playwright install chromium，或用 --channel chrome / --browser-executable 指定本机浏览器。`);
  }
  const report = {
    schemaVersion: 1, kind: 'browser-audit', generatedAt: new Date().toISOString(),
    baseUrl, mode, viewport, browser: { name: 'chromium', version: browser.version(), channel, capture: Boolean(captureDir) },
    baselineAvailable: false, routes: [], scenarios: [], discovered: [],
    summary: null,
    note: '渲染与场景结果来自真实浏览器；截图相似度是像素信号，不等于业务正确。基线必须在相同视口、数据、账号、字体和浏览器下采集。',
  };
  let context;
  try {
    context = await browser.newContext({ viewport, ...(storageStateFile ? { storageState: storageStateFile } : {}) });
    const setupScenarios = scenarioList.filter(scenario => scenario.phase === 'setup');
    const scenarioResults = [];
    for (const [index, scenario] of setupScenarios.entries()) {
      const page = await context.newPage();
      try {
        scenarioResults.push(await runScenario(page, scenario, index, {
          baseUrl, mode, navigationTimeoutMs, screenshotDir, ignoreConsole, ignoreRequest,
          responses: [], screenshot: null,
        }));
      } finally { await page.close(); }
    }
    const page = await context.newPage();
    let routeResults = [];
    try {
      for (const [index, route] of routes.entries()) {
        routeResults.push(await auditRoute(page, route, index, {
          baseUrl, mode, mountSelector, navigationTimeoutMs, settleMs, screenshotDir,
          baselineDir, captureDir, ignoreConsole, ignoreRequest,
        }));
      }
      if (crawl && !captureDir) {
        const known = new Set(routes.map(route => route.targetPath));
        const found = new Map();
        for (const route of routeResults.filter(item => item.render === 'passed').slice(0, 3)) {
          await page.goto(route.url, { waitUntil: 'domcontentloaded', timeout: navigationTimeoutMs }).catch(() => {});
          const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(anchor => anchor.getAttribute('href')));
          for (const href of links) {
            if (!href || /^(?:#|javascript:|mailto:|tel:|data:|blob:)/i.test(href)) continue;
            let parsed;
            try { parsed = new URL(href, route.url); } catch { continue; }
            if (parsed.origin !== new URL(baseUrl).origin) continue;
            if (/\.(?:pdf|zip|rar|7z|xlsx?|docx?|pptx?|csv|png|jpe?g|gif|svg|mp4|mp3)(?:$|\?)/i.test(parsed.pathname)) continue;
            let candidatePath = mode === 'hash' ? (parsed.hash.replace(/^#/, '') || '/') : parsed.pathname;
            const basePath = new URL(baseUrl).pathname.replace(/\/+$/, '');
            if (basePath && candidatePath.startsWith(`${basePath}/`)) candidatePath = candidatePath.slice(basePath.length);
            else if (basePath && candidatePath === basePath) candidatePath = '/';
            if (!candidatePath.startsWith('/')) continue;
            if (ignored(candidatePath, [DEFAULT_CRAWL_EXCLUDE])) continue;
            if (known.has(candidatePath) || found.has(candidatePath)) continue;
            if (found.size >= maxCrawlRoutes) break;
            found.set(candidatePath, { id: `D-${String(found.size + 1).padStart(3, '0')}`, targetPath: candidatePath, sourcePath: null, discovered: true });
          }
        }
        const discovered = [...found.values()];
        for (const [index, route] of discovered.entries()) {
          routeResults.push(await auditRoute(page, route, routes.length + index, {
            baseUrl, mode, mountSelector, navigationTimeoutMs, settleMs, screenshotDir,
            baselineDir, ignoreConsole, ignoreRequest,
          }));
        }
        report.discovered = discovered.map(route => route.targetPath);
      }
    } finally {
      await page.close();
    }
    const interactionScenarios = scenarioList.filter(scenario => scenario.phase !== 'setup');
    for (const [index, scenario] of interactionScenarios.entries()) {
      const scenarioPage = await context.newPage();
      try {
        scenarioResults.push(await runScenario(scenarioPage, scenario, setupScenarios.length + index, {
          baseUrl, mode, navigationTimeoutMs, screenshotDir, ignoreConsole, ignoreRequest,
          responses: [], screenshot: null,
        }));
      } finally { await scenarioPage.close(); }
    }
    report.routes = routeResults;
    report.scenarios = scenarioResults;
    const setupFailed = scenarioResults.filter(scenario => scenario.phase === 'setup' && scenario.status === 'failed');
    const compared = routeResults.filter(route => route.metrics.similarity !== null);
    report.baselineAvailable = compared.length > 0;
    report.summary = {
      routes: routeResults.length,
      rendered: routeResults.filter(route => route.render === 'passed').length,
      failed: routeResults.filter(route => route.render === 'failed').length,
      discovered: routeResults.filter(route => route.discovered).length,
      consoleErrors: routeResults.reduce((total, route) => total + route.consoleErrors.length, 0),
      pageErrors: routeResults.reduce((total, route) => total + route.pageErrors.length, 0),
      failedRequests: routeResults.reduce((total, route) => total + route.failedRequests.length, 0),
      warnings: routeResults.reduce((total, route) => total + route.warnings.length, 0),
      scenarioTotal: interactionScenarios.length,
      scenarioPassed: scenarioResults.filter(scenario => scenario.phase === 'interaction' && scenario.status === 'passed').length,
      scenarioFailed: scenarioResults.filter(scenario => scenario.phase === 'interaction' && scenario.status === 'failed').length,
      setupFailed: setupFailed.length,
      comparedRoutes: compared.length,
      catchAll: routeResults.filter(route => /(?:^|\/)(?:404|not-found|catch-all)/i.test(route.path)).length,
    };
  } finally {
    if (context) await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
  return report;
}
