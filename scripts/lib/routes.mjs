/** 路由表是验收的输入契约：源入口、目标入口、覆盖的能力 id 都写在这里。 */
export function normalizeRoutes(document, { source = '路由表', mode = null } = {}) {
  const raw = Array.isArray(document) ? { routes: document } : document;
  if (!raw || typeof raw !== 'object') throw new Error(`${source} 必须是 JSON 对象或数组`);
  if (raw.kind === 'capability-inventory') {
    const routes = (raw.routeCandidates ?? []).map((candidate, index) => ({
      id: `R-${String(index + 1).padStart(3, '0')}`,
      title: candidate.title ?? null,
      sourcePath: candidate.path,
      targetPath: candidate.path,
      covers: candidate.unitId ? [candidate.unitId] : [],
      seeded: true,
    }));
    if (!routes.length) throw new Error(`${source} 是从能力清单推导的，但没有提取到路由；请手工建立路由表`);
    return { routes: dedupeRoutes(routes, source), mode: mode ?? raw.mode ?? 'history', kind: 'acceptance-routes', seeded: true };
  }
  if (!Array.isArray(raw.routes)) throw new Error(`${source} 缺少 routes 数组`);
  const routes = raw.routes.map((route, index) => {
    if (!route || typeof route !== 'object') throw new Error(`${source} 第 ${index + 1} 条路由不是对象`);
    const targetPath = route.targetPath ?? route.path;
    if (typeof targetPath !== 'string' || !targetPath.trim()) throw new Error(`${source} 第 ${index + 1} 条路由缺少 targetPath`);
    if (!targetPath.startsWith('/')) throw new Error(`${source} 第 ${index + 1} 条路由的 targetPath 必须以 / 开头：${targetPath}`);
    // 验收要打开真实页面：动态段/通配符必须替换成测试数据，否则浏览器只能访问字面量路径。
    if (targetPath.split('/').some(segment => segment.startsWith(':') || segment === '*') || targetPath.includes('${')) {
      throw new Error(`${source} 第 ${index + 1} 条路由的 targetPath 含动态参数或通配符：${targetPath}\n请替换为可访问的具体测试路径（如 /user/edit/1），并保证测试数据可回收`);
    }
    const id = typeof route.id === 'string' && route.id.trim() ? route.id : `R-${String(index + 1).padStart(3, '0')}`;
    return {
      id,
      title: route.title ?? null,
      sourcePath: typeof route.sourcePath === 'string' && route.sourcePath ? route.sourcePath : null,
      targetPath,
      menuVisible: route.menuVisible ?? null,
      covers: Array.isArray(route.covers) ? route.covers.filter(item => typeof item === 'string') : [],
      flags: route.flags ?? null,
      seeded: raw.seeded === true,
    };
  });
  if (!routes.length) throw new Error(`${source} 没有任何路由；纯组件/库工程请在迁移规范说明并改用入口冒烟`);
  return {
    routes: dedupeRoutes(routes, source),
    mode: mode ?? raw.mode ?? 'history',
    kind: 'acceptance-routes',
    seeded: raw.seeded === true,
    reviewed: raw.reviewed === true,
  };
}

function dedupeRoutes(routes, source) {
  const seenIds = new Set();
  const seenPaths = new Set();
  for (const route of routes) {
    if (seenIds.has(route.id)) throw new Error(`${source} 存在重复路由 id：${route.id}`);
    seenIds.add(route.id);
    if (seenPaths.has(route.targetPath)) throw new Error(`${source} 存在重复 targetPath：${route.targetPath}`);
    seenPaths.add(route.targetPath);
  }
  return routes;
}

export function routeUrl(baseUrl, routePath, mode = 'history') {
  const base = new URL(baseUrl);
  const path = String(routePath || '/');
  const rootPath = `${base.pathname.replace(/\/+$/, '')}/`;
  if (mode === 'hash') return `${base.origin}${rootPath}#${path.startsWith('/') ? path : `/${path}`}`;
  return `${base.origin}${rootPath}${path.replace(/^\/+/, '')}`;
}
