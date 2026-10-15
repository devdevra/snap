import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { dirname, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import configHandler from '../api/config.js';
import healthHandler from '../api/health.js';
import previewHandler from '../api/preview.js';
import downloadHandler from '../api/download.js';
import operatorHandler from '../api/operator.js';

const root = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i < 0 ? fallback : process.argv[i + 1]; };
const host = arg('--host', '127.0.0.1');
const port = Number(arg('--port', '4173'));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
const apiRoutes = { '/api/config': configHandler, '/api/health': healthHandler, '/api/preview': previewHandler, '/api/download': downloadHandler, '/api/operator': operatorHandler };
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  try {
    const hostname = new URL(`http://${req.headers.host || 'localhost'}`).hostname;
    if (!['localhost', 'terminal.local', '127.0.0.1', '0.0.0.0', '[::1]'].includes(hostname)) { res.writeHead(403); res.end('Host not allowed'); return; }
    const url = new URL(req.url, 'http://localhost');
    if (Object.hasOwn(apiRoutes, url.pathname)) { await apiRoutes[url.pathname](req, res); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end('Method not allowed'); return; }
    const pathname = decodeURIComponent(url.pathname);
    const candidate = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    const path = await realpath(candidate);
    if (!path.startsWith(root + sep) || /[\\/]\./.test(path.slice(root.length))) throw new Error('Invalid path');
    const info = await stat(path);
    if (!info.isFile()) throw new Error('Not a file');
    const headers = { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    const range = req.headers.range;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      let start = match?.[1] ? Number(match[1]) : 0;
      let end = match?.[2] ? Number(match[2]) : info.size - 1;
      if (match && !match[1] && match[2]) { start = Math.max(0, info.size - Number(match[2])); end = info.size - 1; }
      if (!match || start > end || start >= info.size || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
      end = Math.min(end, info.size - 1);
      res.writeHead(206, { ...headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${info.size}` });
      if (req.method === 'HEAD') res.end(); else createReadStream(path, { start, end }).on('error', () => res.destroy()).pipe(res);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': info.size });
      if (req.method === 'HEAD') res.end(); else createReadStream(path).on('error', () => res.destroy()).pipe(res);
    }
  } catch { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Not found'); }
});
server.on('error', (error) => { console.error(`STAYCUT preview: ${error.message}`); process.exitCode = 1; });
server.listen(port, host, () => console.log(`STAYCUT preview listening on ${host}:${port}`));
