import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { probeRoutes } from '../scripts/lib/http-probe.mjs';
import { routeUrl } from '../scripts/lib/routes.mjs';

async function startServer() {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://local').pathname;
    if (pathname === '/assets/app.js') {
      response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      response.end('console.log("app")');
      return;
    }
    if (pathname === '/assets/missing.js') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('missing');
      return;
    }
    if (pathname === '/broken') {
      response.writeHead(500, { 'content-type': 'text/html' });
      response.end('<pre>Internal Server Error</pre>');
      return;
    }
    if (pathname === '/nomount') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end('<html><body>没有挂载节点</body></html>');
      return;
    }
    const scripts = pathname === '/with-missing'
      ? '<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/missing.js">'
      : '<script type="module" src="/assets/app.js"></script>';
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<html><head>${scripts}</head><body><div id="app"></div></body></html>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

test('HTTP 巡检区分正常入口、缺挂载节点、资源 404 与服务器错误', async t => {
  const { server, port } = await startServer();
  t.after(() => new Promise(resolve => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${port}/`;
  const report = await probeRoutes({
    baseUrl,
    routes: [
      { id: 'R-001', targetPath: '/clean' },
      { id: 'R-002', targetPath: '/with-missing' },
      { id: 'R-003', targetPath: '/nomount' },
      { id: 'R-004', targetPath: '/broken' },
    ],
    mountSelector: '#app',
  });
  assert.equal(report.kind, 'http-probe');
  assert.equal(report.root.status, 'passed');
  const byPath = new Map(report.routes.map(route => [route.path, route]));
  assert.equal(byPath.get('/clean').status, 'passed');
  assert.equal(byPath.get('/with-missing').status, 'failed');
  assert.ok(byPath.get('/with-missing').failures.some(item => item.includes('missing.js')));
  assert.equal(byPath.get('/nomount').status, 'failed');
  assert.ok(byPath.get('/nomount').failures.some(item => item.includes('挂载节点')));
  assert.equal(byPath.get('/broken').status, 'failed');
  assert.equal(report.summary.failed, 3);
  assert.equal(report.summary.passed, 1);
});

test('HTTP 巡检只接受回环地址，hash 模式检查入口 HTML', async t => {
  const { server, port } = await startServer();
  t.after(() => new Promise(resolve => server.close(resolve)));
  await assert.rejects(
    probeRoutes({ baseUrl: 'http://example.com/', routes: [{ id: 'R-1', targetPath: '/' }] }),
    /回环地址/,
  );
  const report = await probeRoutes({
    baseUrl: `http://127.0.0.1:${port}/`,
    routes: [{ id: 'R-1', targetPath: '/page' }],
    mode: 'hash',
    mountSelector: '#app',
  });
  assert.equal(report.mode, 'hash');
  assert.match(report.routes[0].url, /#\/page$/);
  assert.equal(report.routes[0].status, 'passed');
  assert.match(report.routes[0].note, /浏览器审计/);
});

test('路由地址拼接保留部署子路径', () => {
  assert.equal(routeUrl('http://127.0.0.1:4175/app/', '/login', 'history'), 'http://127.0.0.1:4175/app/login');
  assert.equal(routeUrl('http://127.0.0.1:4175/app', '/login', 'history'), 'http://127.0.0.1:4175/app/login');
  assert.equal(routeUrl('http://127.0.0.1:4175/app/', '/login', 'hash'), 'http://127.0.0.1:4175/app/#/login');
  assert.equal(routeUrl('http://127.0.0.1:4175/', '/', 'history'), 'http://127.0.0.1:4175/');
});
