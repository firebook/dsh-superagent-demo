import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, StoreError } from './store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, '..', 'public');
const MAX_BODY_BYTES = 64 * 1024;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function applyHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",
  );
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, code, message) {
  sendJson(res, status, { ok: false, error: { code, message } });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new StoreError('请求内容过大', { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        reject(new StoreError('请求内容不是合法的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendError(res, 405, 'method_not_allowed', '不支持的请求方法');
    return;
  }

  let requested;
  try {
    requested = decodeURIComponent(pathname);
  } catch {
    sendError(res, 400, 'bad_request', '路径无效');
    return;
  }
  if (requested.endsWith('/')) requested += 'index.html';

  const resolved = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    sendError(res, 403, 'forbidden', '无权访问该路径');
    return;
  }

  fs.stat(resolved, (error, stats) => {
    if (error || !stats.isFile()) {
      sendError(res, 404, 'not_found', '页面不存在');
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const type = MIME_TYPES[ext] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': stats.size,
      'cache-control': 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(resolved).pipe(res);
  });
}

async function handleApi(req, res, pathname, store) {
  const method = req.method ?? 'GET';

  if (pathname === '/api/health' && method === 'GET') {
    sendJson(res, 200, { ok: true, data: { status: 'ok' } });
    return true;
  }

  if (pathname === '/api/overview' && method === 'GET') {
    sendJson(res, 200, { ok: true, data: store.snapshot() });
    return true;
  }

  if (pathname === '/api/agents' && method === 'POST') {
    const body = await readJson(req);
    const agent = store.addAgent(body);
    sendJson(res, 201, { ok: true, data: agent });
    return true;
  }

  let match = pathname.match(/^\/api\/agents\/([\w-]+)\/(start|stop)$/);
  if (match && method === 'POST') {
    const [, id, action] = match;
    const agent = action === 'start' ? store.startAgent(id) : store.stopAgent(id);
    sendJson(res, 200, { ok: true, data: agent });
    return true;
  }

  match = pathname.match(/^\/api\/agents\/([\w-]+)$/);
  if (match && method === 'DELETE') {
    store.removeAgent(match[1]);
    sendJson(res, 200, { ok: true, data: { removed: true } });
    return true;
  }

  if (pathname === '/api/tasks' && method === 'POST') {
    const body = await readJson(req);
    const task = store.addTask(body);
    sendJson(res, 201, { ok: true, data: task });
    return true;
  }

  match = pathname.match(/^\/api\/tasks\/([\w-]+)\/(cancel|retry)$/);
  if (match && method === 'POST') {
    const [, id, action] = match;
    const task = action === 'cancel' ? store.cancelTask(id) : store.retryTask(id);
    sendJson(res, 200, { ok: true, data: task });
    return true;
  }

  return false;
}

export function createServer({ store, simulate = true, tickMs = 1000 } = {}) {
  if (!store) throw new Error('createServer requires a store');

  const server = http.createServer(async (req, res) => {
    applyHeaders(res);
    let pathname;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      sendError(res, 400, 'bad_request', '请求地址无效');
      return;
    }

    try {
      if (pathname.startsWith('/api/')) {
        const handled = await handleApi(req, res, pathname, store);
        if (!handled) sendError(res, 404, 'not_found', '接口不存在');
        return;
      }
      serveStatic(req, res, pathname);
    } catch (error) {
      if (error instanceof StoreError) {
        sendError(res, error.status, error.code, error.message);
        return;
      }
      console.error('[agent-console] request failed:', error);
      sendError(res, 500, 'internal_error', '服务器内部错误');
    }
  });

  let timer = null;
  if (simulate) {
    timer = setInterval(() => {
      try {
        store.tick();
      } catch (error) {
        console.error('[agent-console] simulation tick failed:', error);
      }
    }, tickMs);
  }
  server.on('close', () => {
    if (timer) clearInterval(timer);
  });

  return server;
}

export function startServer() {
  const dataFile =
    process.env.AGENT_CONSOLE_DATA ?? path.resolve(HERE, '..', 'data', 'state.json');
  const port = Number(process.env.PORT ?? 4173);
  const host = process.env.HOST ?? '127.0.0.1';
  const store = new Store(dataFile);
  const server = createServer({ store });

  server.listen(port, host, () => {
    console.log(`Agent Console listening on http://${host}:${port}`);
    console.log(`State file: ${dataFile}`);
  });

  const shutdown = (signal) => {
    console.log(`\nReceived ${signal}, shutting down…`);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startServer();
}
