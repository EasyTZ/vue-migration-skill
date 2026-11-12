import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAcceptance, renderAcceptance } from '../scripts/lib/fidelity.mjs';

function fixtures() {
  const routes = {
    schemaVersion: 1, kind: 'acceptance-routes', mode: 'history', reviewed: true, seeded: false,
    routes: [{ id: 'R-001', targetPath: '/', sourcePath: '/', title: '首页' }],
  };
  const probe = {
    schemaVersion: 1, kind: 'http-probe', mode: 'history', routes: [
      { id: 'R-001', path: '/', status: 'passed', failures: [], checks: [] },
    ], root: { status: 'passed', failures: [] }, summary: { total: 1, passed: 1, failed: 0 },
  };
  const ui = {
    schemaVersion: 1, kind: 'browser-audit', baselineAvailable: true, mode: 'history',
    browser: { name: 'chromium', version: 'test' },
    routes: [{
      id: 'R-001', path: '/', render: 'passed', errors: [], warnings: [], failedRequests: [],
      apiCalls: [], metrics: { similarity: 0.99, similarityParts: { pixels: 1, text: 0.98, layout: 0.99 } },
    }],
    scenarios: [{
      id: 'SC-001', phase: 'interaction', route: '/', status: 'passed', covers: ['form:a.vue'],
      failures: [], steps: [{ index: 0, action: 'click', status: 'passed' }],
    }],
    summary: { routes: 1, rendered: 1, failed: 0, scenarioTotal: 1, scenarioPassed: 1, scenarioFailed: 0 },
  };
  const capabilities = {
    schemaVersion: 1, kind: 'capability-inventory', units: [
      { id: 'route:/', kind: 'route', severity: 'required', detail: '/', file: 'src/router.js', line: 1 },
      { id: 'form:a.vue', kind: 'form', severity: 'required', detail: 'src/A.vue', file: 'src/A.vue', line: 2, label: '表单与校验' },
    ],
  };
  const capabilityStatus = {
    schemaVersion: 1, kind: 'capability-status',
    units: [{ id: 'form:a.vue', status: 'pending', reason: null, evidence: [] }],
  };
  const runtime = {
    schemaVersion: 1, kind: 'runtime-state', state: 'stopped', url: 'http://127.0.0.1:4175/',
    command: ['npm', 'run', 'dev'], readyAt: '2026-01-01T00:00:00Z', stoppedAt: '2026-01-01T00:01:00Z',
    stop: { portReleased: true, processAlive: false },
  };
  return { routes, probe, ui, capabilities, capabilityStatus, runtime };
}

const clone = value => structuredClone(value);
const build = overrides => {
  const fixture = fixtures();
  return buildAcceptance({
    routes: fixture.routes, probe: fixture.probe, ui: fixture.ui,
    capabilities: fixture.capabilities, capabilityStatus: fixture.capabilityStatus,
    runtime: fixture.runtime,
    thresholds: { minScore: 0.99, minSimilarity: 0.9 },
    ...overrides,
  });
};

test('证据完整时五维满分为 1 且门禁通过', () => {
  const report = build({});
  assert.equal(report.score, 1);
  assert.equal(report.gate.passed, true);
  assert.equal(report.gate.fullClaim, true);
  assert.deepEqual(report.gate.blocking, []);
  assert.equal(report.dimensions.find(item => item.id === 'render').score, 1);
  assert.equal(report.dimensions.find(item => item.id === 'visual').score, 1);
  assert.equal(report.dimensions.find(item => item.id === 'api').applicable, false);
  assert.match(renderAcceptance(report), /复原度：\*\*100.00%\*\*/);
  assert.match(renderAcceptance(report), /门禁：通过/);
});

test('缺少基线、入口失败、场景失败、接口缺口、能力缺口都会阻塞', () => {
  const missingBaseline = clone(fixtures());
  missingBaseline.ui.baselineAvailable = false;
  missingBaseline.ui.routes[0].metrics = { similarity: null, similarityParts: null };
  const baselineReport = build({ ui: missingBaseline.ui });
  assert.equal(baselineReport.gate.passed, false);
  assert.ok(baselineReport.gate.blocking.some(item => item.includes('基线')));
  assert.equal(baselineReport.gate.degraded, true);

  const routeFailed = clone(fixtures());
  routeFailed.ui.routes[0].render = 'failed';
  routeFailed.ui.routes[0].errors = ['Uncaught TypeError'];
  routeFailed.ui.routes[0].failureReasons = ['页面接近空白'];
  const routeReport = build({ ui: routeFailed.ui });
  assert.equal(routeReport.gate.passed, false);
  assert.ok(routeReport.gate.blocking.some(item => item.includes('入口 /')));

  const scenarioFailed = clone(fixtures());
  scenarioFailed.ui.scenarios[0].status = 'failed';
  scenarioFailed.ui.scenarios[0].failures = [{ step: 1, action: 'click', message: '按钮不可见' }];
  const scenarioReport = build({ ui: scenarioFailed.ui });
  assert.equal(scenarioReport.gate.passed, false);
  assert.ok(scenarioReport.gate.blocking.some(item => item.includes('交互场景失败')));

  const apiFixture = clone(fixtures());
  apiFixture.capabilities.units.push({ id: 'api:GET_/api/users', kind: 'api', severity: 'required', detail: 'GET /api/users', extra: { method: 'GET', path: '/api/users' }, file: 'src/api.js', line: 9 });
  const apiMissing = build({ capabilities: apiFixture.capabilities });
  assert.equal(apiMissing.gate.passed, false);
  assert.ok(apiMissing.gate.blocking.some(item => item.includes('源接口未被目标调用覆盖')));
  assert.equal(apiMissing.api.missing.length, 1);

  apiFixture.ui.routes[0].apiCalls = [{ method: 'GET', path: '/api/users', status: 200 }];
  const apiCovered = build({ capabilities: apiFixture.capabilities, ui: apiFixture.ui });
  assert.equal(apiCovered.api.covered, 1);
  assert.equal(apiCovered.gate.passed, true);

  const capabilityFixture = clone(fixtures());
  capabilityFixture.ui.scenarios[0].covers = [];
  const capabilityReport = build({ ui: capabilityFixture.ui, capabilityStatus: capabilityFixture.capabilityStatus });
  assert.equal(capabilityReport.gate.passed, false);
  assert.equal(capabilityReport.capabilities.gaps.length, 1);
  assert.ok(capabilityReport.gate.blocking.some(item => item.includes('能力覆盖缺口')));

  const fiveXx = clone(fixtures());
  fiveXx.ui.routes[0].apiCalls = [{ method: 'GET', path: '/api/boom', status: 500 }];
  const fiveReport = build({ ui: fiveXx.ui });
  assert.equal(fiveReport.gate.passed, false);
  assert.ok(fiveReport.gate.blocking.some(item => item.includes('5xx')));
});

test('托管服务未停止或缺少运行证据不能宣称完成', () => {
  const running = clone(fixtures());
  running.runtime.state = 'running';
  running.runtime.stoppedAt = null;
  running.runtime.stop = null;
  const report = build({ runtime: running.runtime });
  assert.equal(report.gate.passed, false);
  assert.ok(report.gate.blocking.some(item => item.includes('托管服务状态')));

  const noRuntime = build({ runtime: null });
  assert.equal(noRuntime.gate.passed, false);
  assert.ok(noRuntime.gate.blocking.some(item => item.includes('托管启动')));
  const allowed = build({ runtime: null, thresholds: { minScore: 0.99, minSimilarity: 0.9, requireRuntime: false } });
  assert.equal(allowed.gate.passed, true);
  assert.equal(allowed.gate.fullClaim, false, '没有运行时证据只能通过门禁，不能宣称完整');
});

test('允许差异必须给出对象、理由与批准人，并从分母扣除', () => {
  const fixture = clone(fixtures());
  fixture.ui.scenarios[0].covers = [];
  const scope = {
    id: 'AD-001', reason: '打印入口在本项目已下线，业务确认不再使用', approvedBy: '业务负责人 2026-11-12',
    scope: { capabilities: ['form:a.vue'] },
  };
  const report = build({ ui: fixture.ui, capabilityStatus: fixture.capabilityStatus, acceptedDifferences: [scope] });
  assert.equal(report.gate.passed, true);
  assert.equal(report.capabilities.gaps.length, 0);
  assert.equal(report.acceptedDifferences[0].id, 'AD-001');
  assert.match(renderAcceptance(report), /AD-001/);

  assert.throws(() => build({ acceptedDifferences: [{ id: 'AD-2', reason: '', approvedBy: 'x', scope: { routes: ['R-001'] } }] }), /缺少理由/);
  assert.throws(() => build({ acceptedDifferences: [{ id: 'AD-3', reason: 'x', approvedBy: '', scope: { routes: ['R-001'] } }] }), /缺少批准人/);
  assert.throws(() => build({ acceptedDifferences: [{ id: 'AD-4', reason: 'x', approvedBy: 'y', scope: {} }] }), /scope/);
});

test('工具拒绝错误类型的证据和非规范化路由', () => {
  const fixture = fixtures();
  assert.throws(() => buildAcceptance({ routes: fixture.routes, probe: fixture.probe, ui: { ...fixture.ui, kind: 'other' } }), /browser-audit/);
  assert.throws(() => buildAcceptance({ routes: { ...fixture.routes, routes: [] }, probe: fixture.probe, ui: fixture.ui }), /路由表为空/);
  const noEvidence = buildAcceptance({ routes: fixture.routes, probe: null, ui: null, thresholds: { requireRuntime: false } });
  assert.equal(noEvidence.gate.passed, false);
  assert.ok(noEvidence.gate.blocking.some(item => item.includes('HTTP')));
  assert.ok(noEvidence.gate.blocking.some(item => item.includes('浏览器审计')));
});
