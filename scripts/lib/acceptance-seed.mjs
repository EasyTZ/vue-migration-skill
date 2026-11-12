import { writeControlJson, readControlJson } from './control-paths.mjs';

const acceptancePaths = config => {
  const acceptance = config?.acceptance ?? {};
  return {
    routesFile: acceptance.routesFile ?? 'runtime/routes.json',
    scenariosFile: acceptance.scenariosFile ?? 'runtime/scenarios.json',
    capabilityStatusFile: acceptance.capabilityStatusFile ?? 'runtime/capability-status.json',
    viewport: acceptance.viewport ?? { width: 1440, height: 900 },
  };
};

async function writeIfMissing(project, relative, value, created, kept) {
  try {
    await writeControlJson(project, relative, value);
    created.push(relative);
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') { kept.push(relative); return false; }
    throw error;
  }
}

/**
 * 依据能力清单生成验收种子：路由此表、场景骨架、能力核对状态。
 * 只补齐缺失文件，不覆盖人工修改；路由映射与交互场景仍需按实物复核。
 */
export async function seedAcceptanceFiles(project, inventory) {
  const paths = acceptancePaths(project.config);
  const created = [];
  const kept = [];
  const seen = new Set();
  const candidates = [];
  for (const candidate of inventory.routeCandidates ?? []) {
    if (!candidate.path || seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    candidates.push(candidate);
  }
  const routeUnit = new Map((inventory.units ?? []).filter(unit => unit.kind === 'route').map(unit => [unit.detail, unit.id]));
  const routes = candidates.map((candidate, index) => ({
    id: `R-${String(index + 1).padStart(3, '0')}`,
    title: candidate.title ?? null,
    sourcePath: candidate.path,
    targetPath: candidate.path,
    menuVisible: null,
    flags: candidate.flags ?? null,
    covers: routeUnit.has(candidate.path) ? [routeUnit.get(candidate.path)] : [],
  }));

  const routesDocument = {
    schemaVersion: 1, kind: 'acceptance-routes', generatedAt: new Date().toISOString(),
    seeded: true, reviewed: false,
    mode: project.config.routing?.mode ?? 'history',
    base: project.config.routing?.base ?? '/',
    routes,
    issues: routes.length ? [] : ['未从源工程提取到路由；若是纯组件/SSR/微前端工程，请手工登记入口并在迁移规范说明'],
    _instructions: 'targetPath 为待验收的真实入口路径；逐条核对并在 reviewed 改为 true。补上源码里没有的入口、弹窗型入口与菜单外页面。',
  };
  const scenarios = routes.map((route, index) => ({
    id: `SC-ROUTE-${String(index + 1).padStart(3, '0')}`,
    phase: 'route',
    covers: route.covers ?? [],
    route: route.targetPath,
    steps: [],
    note: '路由冒烟：只负责打开页面；渲染与运行时错误由浏览器审计判定。交互场景请按能力清单补齐。',
  }));
  const scenariosDocument = {
    schemaVersion: 1, kind: 'acceptance-scenarios', generatedAt: new Date().toISOString(),
    seeded: true, reviewed: false,
    viewport: paths.viewport,
    setup: [],
    scenarios,
    _instructions: 'setup 场景用于登录等前置步骤；phase=interaction 的场景计入交互维度，必须覆盖表单、校验、查询、弹窗、上传下载等能力。',
  };
  const requiredUnits = (inventory.units ?? []).filter(unit => unit.severity === 'required');
  const statusDocument = {
    schemaVersion: 1, kind: 'capability-status', generatedAt: new Date().toISOString(),
    reviewed: false,
    units: requiredUnits.map(unit => ({ id: unit.id, status: 'pending', reason: null, evidence: [] })),
    _instructions: '场景 covers 命中或状态改为 verified（附证据）才算覆盖；确属不适用时改为 omitted 并写理由。',
  };

  await writeIfMissing(project, paths.routesFile, routesDocument, created, kept);
  await writeIfMissing(project, paths.scenariosFile, scenariosDocument, created, kept);
  await writeIfMissing(project, paths.capabilityStatusFile, statusDocument, created, kept);
  // 种子文件可能原本就存在并按人工内容保留；统计要以实际文件为准，避免“路由 0 条”的误导。
  const readBack = async (relative, selector) => {
    try { return (selector(await readControlJson(project, relative))) ?? null; } catch { return null; }
  };
  const routeCount = (await readBack(paths.routesFile, document => document.routes?.length)) ?? routes.length;
  const scenarioCount = (await readBack(paths.scenariosFile, document => document.scenarios?.length)) ?? scenarios.length;
  const statusCount = (await readBack(paths.capabilityStatusFile, document => document.units?.length)) ?? requiredUnits.length;
  return {
    created, kept, paths,
    counts: { routes: routeCount, scenarios: scenarioCount, requiredUnits: statusCount, generatedRoutes: routes.length },
    routeUnitCount: routeUnit.size,
  };
}
