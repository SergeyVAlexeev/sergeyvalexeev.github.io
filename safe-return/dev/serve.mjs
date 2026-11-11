#!/usr/bin/env node
// Local PRIVATE preview server for /safe-return/. Not deployed.
//   node safe-return/tools/build-private-chapter.mjs   (once)
//   node safe-return/dev/serve.mjs [port] [--public]   (--public previews exactly what would be deployed)
// Serves the repo root, overrides /safe-return/config.js to switch on the private chapter,
// the PDF link and a local feedback endpoint backed by the real Worker code with in-memory KV.
import http from 'node:http';
import { readFileSync, existsSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, extname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../feedback-worker/src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_MODE = process.argv.includes('--public'); // serve the real public config.js: chapter and feedback off
const PORT = Number(process.argv.find((a) => /^\d+$/.test(a)) || 4173);
const ORIGIN = `http://localhost:${PORT}`;
import { privatePaths } from '../tools/paths.mjs';
const PDF_SRC = privatePaths().pdf;
const priv = join(root, 'safe-return', '_private');
mkdirSync(priv, { recursive: true });

const kv = new Map();
const env = {
  FEEDBACK: {
    get: async (k) => (kv.has(k) ? kv.get(k) : null),
    put: async (k, v) => { kv.set(k, v); },
    delete: async (k) => { kv.delete(k); },
    list: async ({ prefix = '' } = {}) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }),
  },
  ALLOWED_ORIGINS: ORIGIN, DEV: '1', ADMIN_TOKEN: 'local-dev-token', RATE_SALT: 'local', RATE_LIMIT_PER_HOUR: '50',
};

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.pdf': 'application/pdf', '.txt': 'text/plain', '.xml': 'application/xml', '.mp3': 'audio/mpeg', '.webm': 'audio/webm', '.vtt': 'text/vtt' };

const server = http.createServer(async (req, res) => {
  const hostOk = [`localhost:${PORT}`, `127.0.0.1:${PORT}`].includes(req.headers.host || '');
  if (!hostOk) { res.writeHead(421); return res.end('Misdirected request'); } // blocks DNS rebinding
  const url = new URL(req.url, ORIGIN);
  if (url.pathname.startsWith('/api/')) {
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });
    const headers = new Headers(req.headers); headers.set('cf-connecting-ip', '127.0.0.1');
    const r = await worker.fetch(new Request(ORIGIN + url.pathname.slice(4) + url.search, { method: req.method, headers, body }), env);
    res.writeHead(r.status, Object.fromEntries(r.headers)); return res.end(Buffer.from(await r.arrayBuffer()));
  }
  if (url.pathname === '/safe-return/config.js' && !PUBLIC_MODE) {
    const hasCh = existsSync(join(priv, 'chapter-1.html'));
    const cfg = { chapterUrl: '/safe-return/chapter-1.html', pdfUrl: '', feedbackEndpoint: '/api/feedback', turnstileSiteKey: '', previewBanner: '', video: { src: '' } };
    res.writeHead(200, { 'content-type': types['.js'], 'cache-control': 'no-store' });
    return res.end('window.SAFE_RETURN=' + JSON.stringify(cfg) + ';');
  }
  let p; try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('Bad request'); }
  if (p.endsWith('/')) p += 'index.html';
  if (p.includes('\\')) { res.writeHead(400); return res.end('Bad request'); }
  if (PUBLIC_MODE && url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end('Not found'); }
  const file = resolve(root, '.' + p);
  const lf = file.toLowerCase();
  const blocked = lf.includes(`${sep}.git${sep}`) || lf.endsWith(`${sep}.git`) || (PUBLIC_MODE && lf.startsWith(priv.toLowerCase() + sep));
  if (!lf.startsWith(root.toLowerCase() + sep) || blocked || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
  const type = types[extname(file)] || 'application/octet-stream';
  const buf = readFileSync(file);
  // Single byte ranges, as GitHub Pages serves them, so audio can seek in the preview.
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let a = m[1] ? Number(m[1]) : buf.length - Number(m[2]);
    let b = m[1] && m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
    if (a < 0) a = 0;
    if (a > b || a >= buf.length) { res.writeHead(416, { 'content-range': `bytes */${buf.length}` }); return res.end(); }
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${buf.length}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
    return res.end(buf.subarray(a, b + 1));
  }
  res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
  res.end(buf);
});
server.listen(PORT, '127.0.0.1', () => console.log(`Safe Return PRIVATE preview: ${ORIGIN}/safe-return/   (admin token for /api/admin/feedback: local-dev-token)`));
