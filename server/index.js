import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { config, engineProblems } from './config.js';
import { createRoom, getRoom } from './room.js';
import { ENGINES } from './engines/index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c.length < 10_000 ? c : ''));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function origin(req) {
  if (config.publicUrl) return config.publicUrl.replace(/\/$/, '');
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${req.headers.host}`;
}

function serveStatic(req, res, file) {
  const full = path.join(PUBLIC, file);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404);
    return res.end('Not found');
  }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(full)] || 'application/octet-stream',
    'cache-control': 'no-cache',
  });
  fs.createReadStream(full).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/healthz') return json(res, 200, { ok: true });

  if (p === '/api/config' && req.method === 'GET') {
    return json(res, 200, {
      engine: config.engine,
      engines: ENGINES.map((name) => ({ name, missing: engineProblems(name) })),
      passcodeRequired: !!config.hostPasscode,
    });
  }

  if (p === '/api/rooms' && req.method === 'POST') {
    const body = await readBody(req);
    if (config.hostPasscode && !safeEqual(body.passcode ?? '', config.hostPasscode)) {
      return json(res, 401, { error: 'Wrong passcode' });
    }
    const engine = ENGINES.includes(body.engine) ? body.engine : config.engine;
    const room = createRoom(engine);
    const joinUrl = `${origin(req)}/j/${room.code}`;
    const qrSvg = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    return json(res, 200, { code: room.code, hostToken: room.hostToken, joinUrl, qrSvg, engine });
  }

  const tm = p.match(/^\/api\/rooms\/([A-Za-z]{4})\/transcript$/);
  if (tm) {
    const room = getRoom(tm[1]);
    if (!room || !safeEqual(url.searchParams.get('token') ?? '', room.hostToken)) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="meeting-${room.code}.md"`,
    });
    return res.end(room.transcriptMarkdown());
  }

  const rm = p.match(/^\/api\/rooms\/([A-Za-z]{4})$/);
  if (rm) {
    const room = getRoom(rm[1]);
    return room && !room.ended ? json(res, 200, { code: room.code }) : json(res, 404, { error: 'No such session' });
  }

  if (p === '/' || /^\/j\/[A-Za-z]{4}$/.test(p)) return serveStatic(req, res, 'listen.html');
  if (p === '/host') return serveStatic(req, res, 'host.html');
  return serveStatic(req, res, p.slice(1));
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  const room = getRoom(q.get('room'));
  if (!room || room.ended) return ws.close(4004, 'No such session');
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  if (q.get('role') === 'host') {
    if (!safeEqual(q.get('token') ?? '', room.hostToken)) return ws.close(4003, 'Not the host');
    room.attachHost(ws);
  } else {
    room.attachListener(ws, q.get('name'));
  }
});

// Drop dead connections (phones that walked out of Wi-Fi without closing).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15_000).unref();

server.listen(config.port, () => {
  const missing = engineProblems();
  console.log(`Puente on http://localhost:${config.port} (engine: ${config.engine})`);
  if (missing.length) console.warn(`Engine "${config.engine}" is missing: ${missing.join(', ')}`);
});
