import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
const root = await fs.realpath(process.argv[2] ?? '.');
const port = Number(process.argv[3] ?? 4175);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const resolved = await fs.realpath(path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`));
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !(await fs.stat(resolved)).isFile()) throw new Error('越界或非文件');
    res.writeHead(200, { 'Content-Type': types[path.extname(resolved)] ?? 'application/octet-stream' });
    res.end(await fs.readFile(resolved));
  } catch { res.writeHead(404); res.end('未找到资源'); }
}).listen(port, '127.0.0.1', () => console.log(`评测预览：http://127.0.0.1:${port}`));
