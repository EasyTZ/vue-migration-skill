import { matchEndpoint, normalizeEndpoint } from './similarity.mjs';

export const DIMENSION_WEIGHTS = { render: 0.25, visual: 0.25, interaction: 0.25, api: 0.15, capability: 0.10 };
export const DIMENSION_LABELS = {
  render: '渲染与运行时错误', visual: '视觉与基线相似度', interaction: '交互场景', api: '接口调用', capability: '能力覆盖',
};
export const DEFAULT_THRESHOLDS = {
  minScore: 0.99, minSimilarity: 0.9, requireBaseline: true, requireRuntime: true,
  baselineUnavailableApproved: false, baselineUnavailableReason: null,
};

const round = value => Math.round(value * 10000) / 10000;
const nonempty = value => typeof value === 'string' && Boolean(value.trim());

function assertKind(value, kind, label) {
  if (!value || value.kind !== kind) throw new Error(`${label} 不是 ${kind} 证据（实际：${value?.kind ?? '缺失'}）`);
}

function normalizeThresholds(input = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...input };
  for (const key of ['minScore', 'minSimilarity']) {
    const value = Number(thresholds[key]);
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`阈值 ${key} 必须在 0~1 之间`);
    thresholds[key] = value;
  }
  thresholds.requireBaseline = thresholds.requireBaseline !== false;
  thresholds.requireRuntime = thresholds.requireRuntime !== false;
  thresholds.baselineUnavailableApproved = thresholds.baselineUnavailableApproved === true;
  return thresholds;
}

function normalizeAcceptedDifferences(list) {
  if (!Array.isArray(list)) throw new Error('acceptedDifferences 必须是数组');
  const seen = new Set();
  return list.map((entry, index) => {
    const label = entry?.id ? `允许差异 ${entry.id}` : `允许差异第 ${index + 1} 条`;
    if (!entry || typeof entry !== 'object') throw new Error(`${label} 不是对象`);
    const id = nonempty(entry.id) ? entry.id : `AD-${index + 1}`;
    if (seen.has(id)) throw new Error(`允许差异编号重复：${id}`);
    seen.add(id);
    if (!nonempty(entry.reason)) throw new Error(`${label} 缺少理由`);
    if (!nonempty(entry.approvedBy)) throw new Error(`${label} 缺少批准人/日期`);
    const scope = entry.scope && typeof entry.scope === 'object' ? entry.scope : {};
    const routes = Array.isArray(scope.routes) ? scope.routes.filter(nonempty) : [];
    const api = Array.isArray(scope.api) ? scope.api.filter(nonempty) : [];
    const capabilities = Array.isArray(scope.capabilities) ? scope.capabilities.filter(nonempty) : [];
    if (!routes.length && !api.length && !capabilities.length) throw new Error(`${label} 的 scope 至少填写 routes/api/capabilities 之一`);
    return {
      id, reason: entry.reason.trim(), approvedBy: entry.approvedBy.trim(), scope: { routes, api, capabilities },
      apiKeys: api.map(value => {
        const match = /^([A-Za-z]+)\s+(.+)$/.exec(value.trim());
        const normalized = match ? normalizeEndpoint(match[1], match[2]) : normalizeEndpoint('ANY', value);
        return `${normalized.method} ${normalized.path}`;
      }),
    };
  });
}

function sourceEndpointsFrom(capabilities) {
  const endpoints = new Map();
  for (const unit of capabilities?.units ?? []) {
    if (unit.kind !== 'api') continue;
    const method = unit.extra?.method ?? /^([A-Z]+)\s/.exec(unit.detail)?.[1] ?? 'ANY';
    const path = unit.extra?.path ?? unit.detail.replace(/^[A-Z]+\s+/, '');
    const normalized = normalizeEndpoint(method, path);
    const key = `${normalized.method} ${normalized.path}`;
    if (!endpoints.has(key)) endpoints.set(key, { unitId: unit.id, ...normalized, detail: unit.detail, file: unit.file, line: unit.line });
  }
  return [...endpoints.values()];
}

function collectObserved(ui) {
  const records = [];
  for (const route of ui?.routes ?? []) for (const call of route.apiCalls ?? []) records.push({ ...call, source: `入口 ${route.path}` });
  for (const scenario of ui?.scenarios ?? []) for (const call of scenario.apiCalls ?? []) records.push({ ...call, source: `场景 ${scenario.id}` });
  const normalized = [];
  for (const record of records) {
    const endpoint = normalizeEndpoint(record.method, record.path ?? record.url ?? '');
    if (!endpoint.path || endpoint.path === '/') continue;
    normalized.push({ ...record, method: endpoint.method, path: endpoint.path, key: `${endpoint.method} ${endpoint.path}` });
  }
  const byKey = new Map();
  for (const record of normalized) {
    const existing = byKey.get(record.key);
    if (existing) {
      if (!existing.statuses.includes(record.status)) existing.statuses.push(record.status);
      if (existing.samples.length < 3) existing.samples.push(record.url);
      continue;
    }
    byKey.set(record.key, { method: record.method, path: record.path, key: record.key, statuses: [record.status], samples: [record.url], source: record.source });
  }
  return { records: normalized, endpoints: [...byKey.values()] };
}

function findProbe(probe, route) {
  if (!probe) return null;
  const byId = probe.routes?.find(item => item.id === route.id);
  if (byId) return byId;
  return probe.routes?.find(item => item.path === route.targetPath || item.path === route.sourcePath) ?? null;
}

function findUiRoute(ui, route) {
  return ui?.routes?.find(item => item.id === route.id)
    ?? ui?.routes?.find(item => item.path === route.targetPath)
    ?? null;
}

/**
 * 复原度验收：把 HTTP 巡检、浏览器审计、能力清单、托管运行状态合成一个可复核的分数。
 * 分数是门禁信号；blocking 非空时即使分数高也不能宣称迁移完成。
 */
export function buildAcceptance({
  routes, probe, ui, capabilities = null, capabilityStatus = null, runtime = null,
  thresholds: thresholdInput = {}, acceptedDifferences = [], evidence = {}, generatedAt = new Date().toISOString(),
}) {
  if (!routes || !Array.isArray(routes.routes)) throw new Error('缺少规范化后的验收路由表');
  if (!routes.routes.length) throw new Error('验收路由表为空，无法计算复原度');
  if (probe) assertKind(probe, 'http-probe', 'HTTP 巡检');
  if (ui) assertKind(ui, 'browser-audit', '浏览器审计报告');
  if (capabilities) assertKind(capabilities, 'capability-inventory', '能力清单');
  if (capabilityStatus) assertKind(capabilityStatus, 'capability-status', '能力核对状态');
  if (runtime) assertKind(runtime, 'runtime-state', '运行状态');
  const thresholds = normalizeThresholds(thresholdInput);
  const differences = normalizeAcceptedDifferences(acceptedDifferences);
  const excludedRouteIds = new Set(differences.flatMap(item => item.scope.routes));
  const excludedApiKeys = new Set(differences.flatMap(item => item.apiKeys));
  const excludedCapabilityIds = new Set(differences.flatMap(item => item.scope.capabilities));
  const blocking = [];
  const warnings = [];
  let degraded = false;

  const tableRoutes = routes.routes.map(route => ({ ...route, discovered: false }));
  const routeById = new Map(tableRoutes.map(route => [route.id, route]));
  for (const route of ui?.routes ?? []) {
    if (routeById.has(route.id)) continue;
    routeById.set(route.id, {
      id: route.id, targetPath: route.path, sourcePath: route.sourcePath ?? null,
      discovered: true, covers: [],
    });
  }
  const allRoutes = [...routeById.values()];

  // 1. 渲染与运行时错误
  const renderRows = [];
  let renderPassed = 0;
  let renderTotal = 0;
  for (const route of allRoutes) {
    if (excludedRouteIds.has(route.id)) { renderRows.push({ id: route.id, path: route.targetPath, excluded: true, status: 'excluded' }); continue; }
    renderTotal += 1;
    const probeRoute = findProbe(probe, route);
    const uiRoute = findUiRoute(ui, route);
    const failures = [];
    if (!probe) failures.push('未执行 HTTP 巡检');
    else if (!route.discovered && !probeRoute) failures.push('HTTP 巡检缺少该入口');
    else if (!route.discovered && probeRoute?.status !== 'passed') failures.push(`HTTP 巡检失败：${probeRoute?.failures?.join('；') ?? '未通过'}`);
    if (!uiRoute) failures.push('浏览器审计缺少该入口');
    else {
      if (uiRoute.render !== 'passed') failures.push(...(uiRoute.failureReasons?.length ? uiRoute.failureReasons : ['渲染失败']));
      if (uiRoute.errors?.length) failures.push(`控制台/运行期错误 ${uiRoute.errors.length} 条`);
      if (uiRoute.failedRequests?.length) failures.push(`请求失败 ${uiRoute.failedRequests.length} 个`);
    }
    const passed = failures.length === 0;
    if (passed) renderPassed += 1;
    else if (probe && ui) blocking.push(`入口 ${route.targetPath} 未通过渲染验收：${failures[0]}`);
    renderRows.push({
      id: route.id, path: route.targetPath, discovered: route.discovered,
      probe: probeRoute?.status ?? (route.discovered ? 'not-probed' : 'missing'),
      render: uiRoute?.render ?? 'missing',
      similarity: uiRoute?.metrics?.similarity ?? null,
      errors: uiRoute?.errors ?? [], failedRequests: uiRoute?.failedRequests ?? [],
      failures, status: passed ? 'passed' : 'failed',
    });
  }
  const renderApplicable = renderTotal > 0 && Boolean(ui) && Boolean(probe);
  if (!probe) blocking.push('未执行 HTTP 路由巡检：无法证明入口可直达、资源可加载');
  if (!ui) blocking.push('未执行浏览器审计：无法证明页面渲染、交互与接口调用');
  if (!renderApplicable && renderTotal > 0) {
    if (!ui || !probe) degraded = true;
  }

  // 2. 视觉与基线相似度
  const visualRows = [];
  const baselineAvailable = Boolean(ui?.baselineAvailable) && (ui?.routes ?? []).some(route => route.metrics?.similarity !== null);
  const baselineApproved = thresholds.baselineUnavailableApproved;
  const isApiExcluded = (method, path) => ['ANY', method].some(candidate => excludedApiKeys.has(`${candidate} ${path}`));
  let visualApplicable = true;
  let visualScore = 0;
  let visualPassed = 0;
  let visualTotal = 0;
  if (!baselineAvailable) {
    if (!ui) {
      // 浏览器审计都没跑时，“缺基线”不是主因；避免重复/误导性阻塞，等浏览器可用后再判断。
      visualApplicable = false;
    } else if (baselineApproved) {
      visualApplicable = false;
      degraded = true;
      warnings.push(`视觉维度降级：${thresholds.baselineUnavailableReason ?? '旧版基线不可用（已批准）'}`);
    } else if (thresholds.requireBaseline) {
      blocking.push('缺少旧版基线截图：无法计算视觉复原度。先在老工程运行 browser-audit --capture 采集基线，或由用户批准降级');
      visualScore = 0;
      degraded = true;
    } else {
      visualApplicable = false;
      degraded = true;
      warnings.push('未要求视觉基线，视觉维度不参与评分；不能据此宣称 UI 复原度');
    }
  } else {
    for (const route of allRoutes) {
      if (route.discovered) { visualRows.push({ id: route.id, path: route.targetPath, discovered: true, status: 'skipped', reason: '爬取发现的入口无旧版基线' }); continue; }
      if (excludedRouteIds.has(route.id)) { visualRows.push({ id: route.id, path: route.targetPath, excluded: true, status: 'excluded' }); continue; }
      visualTotal += 1;
      const uiRoute = findUiRoute(ui, route);
      const similarity = uiRoute?.metrics?.similarity ?? null;
      const passed = typeof similarity === 'number' && similarity >= thresholds.minSimilarity;
      if (passed) visualPassed += 1;
      else blocking.push(`入口 ${route.targetPath} 视觉相似度 ${similarity === null ? '缺失' : similarity.toFixed(4)} 低于 ${thresholds.minSimilarity}`);
      visualRows.push({
        id: route.id, path: route.targetPath, similarity,
        parts: uiRoute?.metrics?.similarityParts ?? null,
        status: passed ? 'passed' : 'failed',
        reason: passed ? null : similarity === null ? (uiRoute?.metrics?.baselineReason ?? '基线未对比') : `低于阈值 ${thresholds.minSimilarity}`,
      });
    }
    visualScore = visualTotal ? visualPassed / visualTotal : 0;
    if (!visualTotal) visualApplicable = false;
  }

  // 3. 交互场景
  const scenarioList = ui?.scenarios ?? [];
  const setupScenarios = scenarioList.filter(scenario => scenario.phase === 'setup');
  const interactionScenarios = scenarioList.filter(scenario => scenario.phase !== 'setup' && scenario.phase !== 'route');
  const routeScenarios = scenarioList.filter(scenario => scenario.phase === 'route');
  const failedSetup = setupScenarios.filter(scenario => scenario.status === 'failed');
  for (const scenario of failedSetup) blocking.push(`前置场景失败 ${scenario.id}：${scenario.failures?.[0]?.message ?? '未知错误'}`);
  let interactionApplicable = Boolean(ui);
  let interactionScore = 0;
  const failedInteractions = interactionScenarios.filter(scenario => scenario.status === 'failed');
  if (ui) {
    if (!interactionScenarios.length) {
      blocking.push('没有交互场景（phase=interaction）：无法证明表单、查询、弹窗、权限等功能复原');
      interactionScore = 0;
    } else {
      interactionScore = (interactionScenarios.length - failedInteractions.length) / interactionScenarios.length;
      for (const scenario of failedInteractions) blocking.push(`交互场景失败 ${scenario.id}：${scenario.failures?.[0]?.message ?? '未知错误'}`);
    }
  } else {
    interactionApplicable = false;
    interactionScore = 0;
  }

  // 4. 接口调用
  const observed = collectObserved(ui);
  const omittedUnitIds = new Set((capabilityStatus?.units ?? []).filter(unit => unit.status === 'omitted' && nonempty(unit.reason)).map(unit => unit.id));
  const sourceEndpoints = sourceEndpointsFrom(capabilities)
    .filter(endpoint => !omittedUnitIds.has(endpoint.unitId))
    .filter(endpoint => !isApiExcluded(endpoint.method, endpoint.path));
  const apiRows = [];
  const missingEndpoints = [];
  const warning4xx = [];
  let apiPassed = 0;
  const unexpected5xx = observed.endpoints.filter(endpoint => endpoint.statuses.some(status => status >= 500)
    && !isApiExcluded(endpoint.method, endpoint.path));
  for (const endpoint of unexpected5xx) blocking.push(`接口 ${endpoint.method} ${endpoint.path} 返回 5xx：${endpoint.statuses.join('/')}`);
  for (const endpoint of observed.endpoints) {
    if (endpoint.statuses.some(status => status >= 400 && status < 500)) warning4xx.push(`${endpoint.method} ${endpoint.path}：${endpoint.statuses.join('/')}`);
  }
  for (const source of sourceEndpoints) {
    const matches = observed.endpoints.filter(candidate => matchEndpoint(source, [candidate]).matched);
    const statuses = [...new Set(matches.flatMap(match => match.statuses))];
    const pass = matches.length > 0 && !statuses.some(status => status >= 500);
    if (pass) apiPassed += 1;
    else missingEndpoints.push(source);
    apiRows.push({
      id: source.unitId, method: source.method, path: source.path,
      status: pass ? 'passed' : matches.length ? 'failed' : 'missing',
      statuses, matched: matches.map(match => match.key),
    });
  }
  const apiApplicable = sourceEndpoints.length > 0 || observed.endpoints.length > 0;
  let apiScore;
  if (sourceEndpoints.length) {
    apiScore = apiPassed / sourceEndpoints.length;
    if (missingEndpoints.length) blocking.push(`源接口未被目标调用覆盖 ${missingEndpoints.length} 个：${missingEndpoints.slice(0, 5).map(item => `${item.method} ${item.path}`).join('、')}${missingEndpoints.length > 5 ? ' 等' : ''}`);
  } else if (observed.endpoints.length) {
    apiScore = unexpected5xx.length ? 0 : 1;
  } else {
    apiScore = 0;
  }
  if (warning4xx.length) warnings.push(`观察到 ${warning4xx.length} 个接口返回 4xx：${warning4xx.slice(0, 5).join('；')}`);

  // 5. 能力覆盖
  const requiredUnits = (capabilities?.units ?? []).filter(unit => unit.severity === 'required' && unit.kind !== 'route' && unit.kind !== 'api');
  const advisoryUnits = (capabilities?.units ?? []).filter(unit => unit.severity === 'advisory');
  const statusByUnit = new Map((capabilityStatus?.units ?? []).map(unit => [unit.id, unit]));
  const coveredByScenario = new Set();
  for (const scenario of [...scenarioList].filter(item => item.status === 'passed')) for (const id of scenario.covers ?? []) coveredByScenario.add(id);
  const capabilityRows = [];
  const gaps = [];
  let capabilityCovered = 0;
  let capabilityTotal = 0;
  const omittedCapabilities = [];
  for (const unit of requiredUnits) {
    if (excludedCapabilityIds.has(unit.id)) { capabilityRows.push({ id: unit.id, kind: unit.kind, status: 'excluded' }); continue; }
    const status = statusByUnit.get(unit.id);
    if (status?.status === 'omitted' && nonempty(status.reason)) {
      omittedCapabilities.push({ id: unit.id, reason: status.reason });
      capabilityRows.push({ id: unit.id, kind: unit.kind, status: 'omitted' });
      continue;
    }
    capabilityTotal += 1;
    const verified = status?.status === 'verified' && Array.isArray(status.evidence) && status.evidence.length > 0;
    const covered = verified || coveredByScenario.has(unit.id);
    if (covered) capabilityCovered += 1;
    else gaps.push({
      id: unit.id, kind: unit.kind, label: unit.label, detail: unit.detail,
      file: unit.file, line: unit.line,
      reason: status?.status === 'verified' ? '标记 verified 但缺少证据引用' : coveredByScenario.has(unit.id) ? '覆盖场景未通过' : '未被通过的交互场景覆盖，也未登记核对证据',
    });
    capabilityRows.push({
      id: unit.id, kind: unit.kind, label: unit.label, status: covered ? 'covered' : 'gap',
      byScenario: coveredByScenario.has(unit.id), byStatus: verified,
    });
  }
  const capabilityApplicable = Boolean(capabilities) && capabilityTotal > 0;
  let capabilityScore = capabilityTotal ? capabilityCovered / capabilityTotal : 0;
  if (!capabilities) blocking.push('缺少能力清单：无法核对从老工程抽取的功能面是否都被验收');
  else if (gaps.length) blocking.push(`能力覆盖缺口 ${gaps.length} 项：${gaps.slice(0, 5).map(item => item.id).join('、')}${gaps.length > 5 ? ' 等' : ''}`);
  const uncoveredAdvisory = advisoryUnits.filter(unit => !coveredByScenario.has(unit.id) && statusByUnit.get(unit.id)?.status !== 'verified' && statusByUnit.get(unit.id)?.status !== 'omitted');
  if (uncoveredAdvisory.length) warnings.push(`提示类能力未登记核对 ${uncoveredAdvisory.length} 项（不计入门禁）：${uncoveredAdvisory.slice(0, 5).map(unit => unit.id).join('、')}${uncoveredAdvisory.length > 5 ? ' 等' : ''}`);

  // 6. 托管运行与清理
  let runtimeSummary = null;
  if (runtime) {
    runtimeSummary = {
      state: runtime.state, url: runtime.url ?? null, command: runtime.command ?? null,
      startedAt: runtime.startedAt ?? null, readyAt: runtime.readyAt ?? null,
      stoppedAt: runtime.stoppedAt ?? null,
      portReleased: runtime.stop?.portReleased ?? null,
    };
    if (runtime.state !== 'stopped') blocking.push(`托管服务状态为 ${runtime.state}：交付前必须停止并确认端口释放`);
    if (runtime.stop && runtime.stop.portReleased === false) blocking.push('托管服务端口未释放：先释放端口再交付');
    if (!runtime.readyAt) blocking.push('运行状态缺少就绪时间：无法证明本机实际启动成功');
  } else if (thresholds.requireRuntime) {
    blocking.push('缺少托管启动/停止证据：未证明新工程能在本机直接跑起来');
    degraded = true;
  } else {
    warnings.push('未提供托管运行状态证据');
    degraded = true;
  }

  const dimensions = [
    { id: 'render', weight: DIMENSION_WEIGHTS.render, applicable: renderApplicable, score: renderTotal ? renderPassed / renderTotal : 0, passed: renderPassed, total: renderTotal, rows: renderRows },
    { id: 'visual', weight: DIMENSION_WEIGHTS.visual, applicable: visualApplicable && baselineAvailable, score: visualScore, passed: visualPassed, total: visualTotal, rows: visualRows, degraded: !baselineAvailable && baselineApproved },
    { id: 'interaction', weight: DIMENSION_WEIGHTS.interaction, applicable: interactionApplicable, score: interactionScore, passed: interactionScenarios.filter(item => item.status === 'passed').length, total: interactionScenarios.length, rows: interactionScenarios },
    { id: 'api', weight: DIMENSION_WEIGHTS.api, applicable: apiApplicable, score: apiScore, passed: apiPassed, total: sourceEndpoints.length, rows: apiRows },
    { id: 'capability', weight: DIMENSION_WEIGHTS.capability, applicable: capabilityApplicable, score: capabilityScore, passed: capabilityCovered, total: capabilityTotal, rows: capabilityRows },
  ].map(dimension => ({
    ...dimension,
    label: DIMENSION_LABELS[dimension.id],
    score: round(dimension.score),
    detail: dimension.applicable ? null : dimension.id === 'api' ? '未发现接口调用' : dimension.id === 'capability' ? '没有可核对的能力或缺少能力清单' : '缺少必要的验收证据',
  }));
  const applicable = dimensions.filter(dimension => dimension.applicable);
  const totalWeight = applicable.reduce((sum, dimension) => sum + dimension.weight, 0);
  const score = totalWeight ? round(applicable.reduce((sum, dimension) => sum + dimension.weight * dimension.score, 0) / totalWeight) : 0;
  const uniqueBlocking = [...new Set(blocking)];
  const passed = score >= thresholds.minScore && uniqueBlocking.length === 0;
  const fullClaim = passed && !degraded;

  if (routes.seeded || routes.reviewed === false) warnings.push('验收路由表仍是自动种子/未标记 reviewed：需逐条复核入口映射，避免漏测菜单外页面');
  warnings.push(...(renderRows.some(row => row.discovered) ? [`浏览器爬取发现 ${renderRows.filter(row => row.discovered).length} 个未登记入口，已纳入渲染验收`] : []));

  return {
    schemaVersion: 1, kind: 'restoration-acceptance', generatedAt,
    target: { url: ui?.baseUrl ?? null, mode: routes.mode ?? ui?.mode ?? 'history', browser: ui?.browser ?? null },
    thresholds,
    score, percent: (score * 100).toFixed(2),
    gate: { passed, fullClaim, degraded, blocking: uniqueBlocking, warnings: [...new Set(warnings)], threshold: thresholds.minScore },
    dimensions: dimensions.map(({ rows, ...dimension }) => dimension),
    routes: renderRows,
    visual: visualRows,
    scenarios: interactionScenarios.map(scenario => ({
      id: scenario.id, route: scenario.route, status: scenario.status, covers: scenario.covers ?? [],
      failures: scenario.failures ?? [], steps: scenario.steps?.length ?? 0,
    })),
    routeScenarios: routeScenarios.map(scenario => ({ id: scenario.id, status: scenario.status, covers: scenario.covers ?? [] })),
    setup: setupScenarios.map(scenario => ({ id: scenario.id, status: scenario.status, failures: scenario.failures ?? [] })),
    api: {
      sourceTotal: sourceEndpoints.length, covered: apiPassed,
      missing: missingEndpoints.map(item => ({ id: item.unitId, method: item.method, path: item.path, file: item.file, line: item.line })),
      unexpected5xx: unexpected5xx.map(item => ({ method: item.method, path: item.path, statuses: item.statuses })),
      observed: observed.endpoints.map(item => ({ method: item.method, path: item.path, statuses: item.statuses, samples: item.samples })),
      excluded: [...excludedApiKeys],
    },
    capabilities: {
      required: requiredUnits.length, covered: capabilityCovered, gaps,
      omitted: omittedCapabilities,
      advisories: advisoryUnits.length, uncoveredAdvisories: uncoveredAdvisory.map(unit => unit.id),
    },
    acceptedDifferences: differences.map(({ apiKeys, ...entry }) => entry),
    runtime: runtimeSummary,
    evidence,
    note: '分数由五个维度按权重合成；任一门禁项未通过即不可宣称迁移完成。视觉相似度是像素/文本/结构信号，不替代人工查看截图与业务确认；工具不代签人工验收。',
  };
}

const cell = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const percent = value => `${(Number(value ?? 0) * 100).toFixed(2)}%`;

export function renderAcceptance(report) {
  const gate = report.gate;
  const lines = [
    '# 复原度验收报告',
    '',
    `生成时间：${report.generatedAt}`,
    '',
    '## 结论',
    '',
    `- 复原度：**${report.percent}%**（门禁 ${percent(report.thresholds.minScore)}）`,
    `- 门禁：${gate.passed ? '通过' : '未通过'}；完整声明：${gate.fullClaim ? '可以宣称迁移验收完成' : '不可宣称迁移验收完成'}`,
    `- 降级：${gate.degraded ? '有（视觉或运行证据不完整）' : '无'}`,
    '',
    '## 维度',
    '',
    '| 维度 | 权重 | 得分 | 通过 / 总数 | 说明 |',
    '|---|---|---|---|---|',
    ...report.dimensions.map(dimension => `| ${cell(dimension.label)} | ${dimension.weight} | ${dimension.applicable ? percent(dimension.score) : '不适用'} | ${dimension.total ? `${dimension.passed} / ${dimension.total}` : '—'} | ${cell(dimension.detail ?? '')} |`),
    '',
    '## 阻塞项',
    '',
    ...(gate.blocking.length ? gate.blocking.map(item => `- ${cell(item)}`) : ['- 无']),
    '',
    '## 提醒',
    '',
    ...(gate.warnings.length ? gate.warnings.map(item => `- ${cell(item)}`) : ['- 无']),
    '',
    '## 入口',
    '',
    '| 入口 | HTTP | 渲染 | 相似度 | 错误 | 状态 |',
    '|---|---|---|---|---|---|',
    ...report.routes.map(route => `| ${cell(route.path)}${route.discovered ? '（爬取）' : ''} | ${cell(route.probe)} | ${cell(route.render)} | ${route.similarity === null ? '—' : percent(route.similarity)} | ${route.errors.length + route.failedRequests.length} | ${route.status === 'excluded' ? '允许差异' : route.status} |`),
    '',
    '## 交互场景',
    '',
    ...(report.scenarios.length ? [
      '| 场景 | 入口 | 状态 | 覆盖能力 | 首个失败 |', '|---|---|---|---|---|',
      ...report.scenarios.map(scenario => `| ${cell(scenario.id)} | ${cell(scenario.route ?? '')} | ${scenario.status} | ${scenario.covers.length} | ${cell(scenario.failures[0]?.message ?? '')} |`),
    ] : ['- 没有交互场景。']),
    '',
    '## 接口',
    '',
    `- 源接口 ${report.api.sourceTotal} 个，已覆盖 ${report.api.covered} 个；目标实际观察到 ${report.api.observed.length} 个。`,
    ...(report.api.missing.length ? [`- 未覆盖：${report.api.missing.map(item => `${item.method} ${item.path}`).join('、')}`] : []),
    ...(report.api.unexpected5xx.length ? [`- 5xx：${report.api.unexpected5xx.map(item => `${item.method} ${item.path} ${item.statuses.join('/')}`).join('、')}`] : []),
    '',
    '## 能力覆盖',
    '',
    `- 必需能力 ${report.capabilities.required} 项，已覆盖 ${report.capabilities.covered} 项，缺口 ${report.capabilities.gaps.length} 项，按理由豁免 ${report.capabilities.omitted.length} 项。`,
    ...report.capabilities.gaps.slice(0, 30).map(gap => `- 缺口 ${cell(gap.id)}（${cell(gap.label)}，${cell(gap.file)}:${gap.line}）：${cell(gap.reason)}`),
    '',
    '## 允许差异',
    '',
    ...(report.acceptedDifferences.length ? report.acceptedDifferences.map(item => `- ${cell(item.id)}：${cell(item.reason)}（批准：${cell(item.approvedBy)}）`) : ['- 无']),
    '',
    '## 运行与证据',
    '',
    `- 目标地址：${cell(report.target.url ?? '—')}`,
    `- 浏览器：${cell(report.target.browser ? `${report.target.browser.name} ${report.target.browser.version}` : '—')}`,
    `- 托管运行：${report.runtime ? `${report.runtime.state}，就绪 ${report.runtime.readyAt ?? '—'}，停止 ${report.runtime.stoppedAt ?? '—'}，端口释放 ${report.runtime.portReleased === null ? '未核对' : report.runtime.portReleased ? '是' : '否'}` : '缺少状态证据'}`,
    ...Object.entries(report.evidence ?? {}).filter(([, value]) => value).map(([key, value]) => `- ${key}：${cell(value)}`),
    '',
    '## 口径',
    '',
    report.note,
    '',
  ];
  return lines.join('\n');
}
