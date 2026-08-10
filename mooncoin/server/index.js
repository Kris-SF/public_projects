/**
 * Local dev server.
 *
 * Serves public/ and routes /api/game to the same handler the Vercel function
 * calls, so what runs on your machine is what runs in production.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { handle } from './handler.js';
import { configured } from './store.js';

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const PUBLIC_DIR = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/game') return api(req, res, url);
  if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });

  return serveStatic(url.pathname, res);
});

async function api(req, res, url) {
  let body = {};
  if (req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 65536) return json(res, 413, { error: 'Payload too large' });
    }
    try { body = raw ? JSON.parse(raw) : {}; }
    catch { return json(res, 400, { error: 'Invalid JSON' }); }
  }

  const { status, body: payload } = await handle({
    method: req.method,
    query: Object.fromEntries(url.searchParams),
    body,
  });
  return json(res, status, payload);
}

async function serveStatic(pathname, res) {
  const rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = join(PUBLIC_DIR, rel);

  // Anything without an extension renders the app shell, so /ABCD is a
  // shareable join link. Mirrors the rewrite in vercel.json.
  if (!extname(file)) file = join(PUBLIC_DIR, 'index.html');
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'Forbidden' });

  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
      'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'max-age=300',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

server.listen(PORT, () => {
  console.log(`Mooncoin terminal listening on http://localhost:${PORT}`);
  if (!configured) {
    console.log('[store] no Redis configured — games live in this process only');
  }
});

export { server };
