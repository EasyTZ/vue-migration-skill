import path from 'node:path';
import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { evaluateDomain } from './contract.mjs';
if (!process.argv[2]) throw new Error('用法：node benchmarks/evaluate.mjs <可信目标工程目录>；将执行其 src/domain.mjs');
const target = await fs.realpath(process.argv[2]);
const modulePath = path.join(target, 'src/domain.mjs');
try {
  const domain = await import(pathToFileURL(modulePath));
  const result = await evaluateDomain(domain);
  console.log(JSON.stringify({ ...result, target, note: '只验证公开领域逻辑契约；不代替浏览器、构建或智能体行为验收。' }, null, 2));
  if (result.failed) process.exitCode = 1;
} catch (error) {
  console.error(`评测失败：${error.message}`); process.exitCode = 1;
}
