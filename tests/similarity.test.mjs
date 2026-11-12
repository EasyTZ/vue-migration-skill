import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { imageSimilarity, decodePng } from '../scripts/lib/png.mjs';
import {
  normalizeText, tokenize, textSimilarity, layoutSimilarity, combineSimilarity,
  normalizeEndpoint, matchEndpoint, isLocalAddress, endpointKey,
} from '../scripts/lib/similarity.mjs';

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}
function encodePng(width, height, pixel) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x++) {
      const [red, green, blue] = pixel(x, y);
      const offset = y * stride + 1 + x * 3;
      raw[offset] = red; raw[offset + 1] = green; raw[offset + 2] = blue;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('PNG 解码与截图相似度可用纯 Node 计算', () => {
  const red = encodePng(8, 8, () => [255, 0, 0]);
  const blue = encodePng(8, 8, () => [0, 0, 255]);
  const half = encodePng(8, 8, x => (x < 4 ? [255, 0, 0] : [0, 0, 255]));
  assert.equal(decodePng(red).width, 8);
  assert.deepEqual([...decodePng(red).data.subarray(0, 4)], [255, 0, 0, 255]);
  assert.equal(imageSimilarity(red, red).similarity, 1);
  assert.ok(imageSimilarity(red, blue).similarity < 0.4);
  const partial = imageSimilarity(red, half).similarity;
  assert.ok(partial > 0.4 && partial < 0.8, `部分差异应在中间区间，实际 ${partial}`);
  // 尺寸不同也应可比较，不能被解码器拒绝
  assert.doesNotThrow(() => imageSimilarity(red, encodePng(16, 4, () => [255, 0, 0])));
  assert.throws(() => decodePng(Buffer.from('not png')), /PNG/);
});

test('文本相似度掩码数字并对空输入给出确定结果', () => {
  assert.equal(normalizeText('  合计 12.50 元\n'), '合计 # 元');
  const first = tokenize('合计 12.50 元 已保存');
  const second = tokenize('合计 99.00 元 已保存');
  assert.equal(textSimilarity(first, second), 1);
  assert.equal(textSimilarity(first, tokenize('完全不同')), 0);
  assert.equal(textSimilarity([], []), 1);
  assert.equal(textSimilarity(first, []), 0);
});

test('布局相似度比较结构与控件数量而非 class', () => {
  const first = {
    nodes: [{ tag: 'div', role: '', w: 100, h: 40 }, { tag: 'button', role: 'button', w: 80, h: 32 }],
    controls: { inputs: 1, buttons: 2 },
  };
  const same = JSON.parse(JSON.stringify(first));
  const moved = { nodes: [{ tag: 'section', role: '', w: 900, h: 400 }], controls: { inputs: 0, buttons: 0 } };
  assert.equal(layoutSimilarity(first, same), 1);
  assert.ok(layoutSimilarity(first, moved) < 0.3);
  assert.equal(combineSimilarity({ pixels: 1, text: 1, layout: 1 }), 1);
  assert.ok(combineSimilarity({ pixels: 0, text: 0, layout: 0 }) === 0);
  assert.ok(combineSimilarity({ text: 0.5 }) === 0.5);
  assert.equal(combineSimilarity({}), null);
});

test('接口路径归一与匹配支持参数、UUID、日期和前缀改写', () => {
  assert.equal(normalizeEndpoint('GET', '/api/users/123?page=1&size=10').path, '/api/users/:param');
  assert.deepEqual(normalizeEndpoint('GET', '/api/users/123?page=1&size=10').queryKeys, ['page', 'size']);
  assert.equal(normalizeEndpoint('POST', '/api/orders/2026-01-02').path, '/api/orders/:param');
  assert.equal(normalizeEndpoint('get', 'https://example.test/api/x').path, '/api/x');
  assert.equal(normalizeEndpoint('GET', '/api/users/${userId}').path, '/api/users/:param');
  assert.equal(endpointKey('get', '/api/x/1'), 'GET /api/x/:param');

  const observed = [{ method: 'GET', path: '/users/42', status: 200 }];
  assert.equal(matchEndpoint({ method: 'GET', path: '/api/users/:id' }, observed).matched, true);
  assert.equal(matchEndpoint({ method: 'POST', path: '/api/users/:id' }, observed).matched, false);
  assert.equal(matchEndpoint({ method: 'ANY', path: '/api/users/:id' }, observed).matched, true);
  assert.equal(matchEndpoint({ method: 'GET', path: '/other' }, observed).matched, false);
});

test('只允许本机回环地址被验收工具访问', () => {
  for (const value of ['http://localhost:4175', 'http://127.0.0.1:4175/', 'http://[::1]:4175/', 'https://127.0.0.1:8443/']) {
    assert.equal(isLocalAddress(value), true, value);
  }
  for (const value of ['http://example.com', 'https://10.0.0.5', 'ftp://127.0.0.1', '不是地址']) {
    assert.equal(isLocalAddress(value), false, value);
  }
});
