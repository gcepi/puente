import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { config, engineProblems } from './config.js';
import { createRoom, getRoom } from './room.js';
import { ENGINES, voiceName } from './engines/index.js';
import { pcmToWav } from './providers/openai.js';
import { attachSolo } from './solo.js';
import { createSoloAccess } from './solo-access.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, '..', 'public');
const soloAccess = createSoloAccess(config);
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
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= 10_000) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > 10_000) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()) ?? {});
      } catch {
        resolve({});
      }
    });
  });
}

function requestOrigin(req) {
  const proto = req.headers['x-forwarded-proto']?.split(',')[0].trim() || (req.socket.encrypted ? 'https' : 'http');
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

  if (p === '/api/solo/access') {
    if (req.method === 'POST') {
      if (!soloAccess.available) return json(res, 503, { error: 'One-on-one translation is unavailable.' });
      const body = await readBody(req);
      if (!safeEqual(String(body.passcode ?? '').trim(), config.hostPasscode)) {
        return json(res, 401, { error: 'Incorrect host passcode.' });
      }
      res.setHeader('set-cookie', soloAccess.grant(requestOrigin(req).startsWith('https://')));
      return json(res, 200, { available: true, authorized: true });
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Method not allowed' });
    return json(res, 200, { available: soloAccess.available, authorized: soloAccess.authorized(req.headers.cookie) });
  }

  if (p === '/api/config' && req.method === 'GET') {
    return json(res, 200, {
      engine: config.engine,
      engines: ENGINES.map((name) => ({ name, missing: engineProblems(name) })),
      passcodeRequired: !!config.hostPasscode,
      voice: voiceName(),
    });
  }

  if (p === '/api/rooms' && req.method === 'POST') {
    const body = await readBody(req);
    if (config.hostPasscode && !safeEqual(String(body.passcode ?? '').trim(), config.hostPasscode)) {
      return json(res, 401, { error: 'Wrong passcode' });
    }
    const engine = ENGINES.includes(body.engine) ? body.engine : config.engine;
    const room = createRoom(engine);
    const joinBase = config.publicUrl ? config.publicUrl.replace(/\/$/, '') : requestOrigin(req);
    const joinUrl = `${joinBase}/j/${room.code}`;
    const qrSvg = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    if (soloAccess.available) res.setHeader('set-cookie', soloAccess.grant(requestOrigin(req).startsWith('https://')));
    return json(res, 200, { code: room.code, hostToken: room.hostToken, joinUrl, qrSvg, engine: room.engineName });
  }

  const tm = p.match(/^\/api\/rooms\/(\d{3})\/transcript$/);
  if (tm) {
    const room = getRoom(tm[1]);
    if (!room || !safeEqual(url.searchParams.get('token') ?? '', room.hostToken)) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="meeting-${room.code}.md"`,
    });
    return res.end(room.transcriptMarkdown());
  }

  // Diagnostics for the host: the last turn as the server heard it, and the voice it sent.
  const am = p.match(/^\/api\/rooms\/(\d{3})\/(heard|voice)\.wav$/);
  if (am) {
    const room = getRoom(am[1]);
    if (!room || !safeEqual(url.searchParams.get('token') ?? '', room.hostToken)) return json(res, 404, { error: 'Not found' });
    const pcm = am[2] === 'heard' ? room.lastHeard : room.lastVoice;
    if (!pcm?.length) return json(res, 404, { error: 'Nothing yet' });
    res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
    return res.end(pcmToWav(pcm));
  }

  const rm = p.match(/^\/api\/rooms\/(\d{3})$/);
  if (rm) {
    const room = getRoom(rm[1]);
    return room && !room.ended ? json(res, 200, { code: room.code }) : json(res, 404, { error: 'No such session' });
  }

  if (p === '/' || /^\/j\/\d{3}$/.test(p)) return serveStatic(req, res, 'listen.html');
  if (p === '/host') return serveStatic(req, res, 'host.html');
  if (p === '/solo' || p === '/solo/') return serveStatic(req, res, 'solo.html');
  return serveStatic(req, res, p.slice(1));
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 256 * 1024 });
wss.on('connection', (ws, req) => {
  const q = new URL(req.url, 'http://x').searchParams;
  ws.isAlive = true;
  ws.on('pong', () => (ws.isAlive = true));
  if (q.get('role') === 'solo') {
    if (!soloAccess.authorized(req.headers.cookie) || (req.headers.origin && req.headers.origin !== requestOrigin(req))) {
      return ws.close(4003, 'Host access required');
    }
    return attachSolo(ws);
  }
  const room = getRoom(q.get('room'));
  if (!room || room.ended) return ws.close(4004, 'No such session');
  if (q.get('role') === 'host') {
    if (!safeEqual(q.get('token') ?? '', room.hostToken)) return ws.close(4003, 'Not the host');
    room.attachHost(ws);
  } else {
    room.attachListener(ws, q.get('name'), q.get('device'));
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
