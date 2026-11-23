// A room is one meeting: one host (the speaker) and any number of listeners.
// Audio is translated once on the server and fanned out, so cost does not
// grow with the number of listeners.
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { config, engineProblems } from './config.js';
import { createEngine } from './engines/index.js';

const rooms = new Map();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O

function newCode() {
  for (;;) {
    const code = Array.from({ length: 4 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
    if (!rooms.has(code)) return code;
  }
}

export function createRoom(engineName = config.engine) {
  const room = new Room(newCode(), crypto.randomBytes(16).toString('hex'), engineName);
  rooms.set(room.code, room);
  return room;
}

export const getRoom = (code) => rooms.get(String(code || '').toUpperCase());

const send = (ws, obj) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));

class Room {
  constructor(code, hostToken, engineName) {
    this.code = code;
    this.hostToken = hostToken;
    this.engineName = engineName;
    this.host = null;
    this.listeners = new Map(); // ws -> { name, audio }
    this.engine = null;
    this.mode = 'auto';
    this.pttDown = false;
    this.lines = new Map(); // id -> { en, es, who, at }
    this.reply = null; // { ws, engine, name } while a team member holds "talk"
    this.replyCount = 0;
    this.replyAudioUntil = 0;
    this.createdAt = Date.now();
    this.micSeconds = 0;
    this.touch();
  }

  touch() {
    this.lastActive = Date.now();
  }

  // ---- host ----
  attachHost(ws) {
    if (this.host && this.host !== ws) this.host.close(4000, 'replaced');
    this.host = ws;
    clearTimeout(this.hostGoneTimer);
    this.sendState();
    this.sendHistory(ws, 30);
    ws.on('message', (data, isBinary) => (isBinary ? this.onHostAudio(data) : this.onHostMessage(data)));
    ws.on('close', () => {
      if (this.host !== ws) return;
      this.host = null;
      // Allow a quick reconnect (phone screen lock, network blip) before stopping.
      this.hostGoneTimer = setTimeout(() => this.stopEngine(), 20_000);
    });
  }

  onHostMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    this.touch();
    if (msg.t === 'mic') msg.on ? this.startEngine() : this.stopEngine();
    else if (msg.t === 'mode' && ['auto', 'ptt', 'manual'].includes(msg.mode)) {
      this.mode = msg.mode;
      this.engine?.setMode(msg.mode);
      this.sendState();
    } else if (msg.t === 'ptt') {
      this.pttDown = !!msg.down;
      if (!this.pttDown) this.engine?.flush();
    } else if (msg.t === 'flush') this.engine?.flush();
    else if (msg.t === 'end') this.end();
  }

  onHostAudio(buf) {
    if (!this.engine) return;
    if (this.mode === 'ptt' && !this.pttDown) return;
    // While a team member is replying, or their translated reply is playing on the
    // host's speaker, ignore the host mic so the reply is not translated back.
    if (this.reply || Date.now() < this.replyAudioUntil) return;
    this.micSeconds += buf.length / 2 / config.sampleRate;
    this.engine.audio(buf);
  }

  startEngine() {
    if (this.engine) return;
    const missing = engineProblems(this.engineName);
    if (missing.length) {
      send(this.host, { t: 'error', message: `Server is missing: ${missing.join(', ')}` });
      return;
    }
    this.engine = createEngine(this.engineName, {
      caption: (c) => this.onCaption(c),
      audio: (buf) => this.onAudio(buf),
      error: (message) => {
        console.error(`[${this.code}] ${message}`);
        send(this.host, { t: 'error', message });
      },
    });
    this.engine.setMode(this.mode);
    this.engine.start();
    clearTimeout(this.sessionTimer);
    this.sessionTimer = setTimeout(() => {
      send(this.host, { t: 'error', message: `Session limit of ${config.maxSessionMinutes} min reached. Tap the mic to continue.` });
      this.stopEngine();
    }, config.maxSessionMinutes * 60_000);
    this.sendState();
  }

  stopEngine() {
    clearTimeout(this.sessionTimer);
    const engine = this.engine;
    this.engine = null;
    engine?.stop().catch(() => {});
    this.sendState();
  }

  end() {
    this.stopEngine();
    this.releaseFloor();
    this.broadcast({ t: 'ended' });
    for (const ws of this.listeners.keys()) ws.close(1000, 'ended');
    this.ended = true;
  }

  // ---- listeners ----
  attachListener(ws, name) {
    this.listeners.set(ws, { name: String(name || '').slice(0, 40), audio: true });
    this.sendHistory(ws, 20);
    this.sendState();
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (this.reply?.ws === ws) this.reply.engine.audio(data);
        return;
      }
      try {
        const msg = JSON.parse(data.toString());
        if (msg.t === 'audio') this.listeners.get(ws).audio = !!msg.on;
        else if (msg.t === 'talk') msg.down ? this.takeFloor(ws) : this.reply?.ws === ws && this.releaseFloor();
      } catch {}
    });
    ws.on('close', () => {
      if (this.reply?.ws === ws) this.releaseFloor();
      this.listeners.delete(ws);
      this.sendState();
    });
  }

  sendHistory(ws, n) {
    for (const [id, l] of [...this.lines].slice(-n)) {
      if (l.en) send(ws, { t: 'cap', lang: 'en', id, text: l.en, final: true, who: l.who });
      if (l.es) send(ws, { t: 'cap', lang: 'es', id, text: l.es, final: true, who: l.who });
    }
  }

  // ---- replies: one team member at a time speaks Spanish, the host hears English ----
  takeFloor(ws) {
    if (this.reply) return send(ws, { t: 'error', message: 'Otra persona está hablando.' });
    const missing = engineProblems(this.engineName);
    if (missing.length) return send(ws, { t: 'error', message: 'Las respuestas no están configuradas.' });
    const name = this.listeners.get(ws)?.name || 'Equipo';
    const tag = `r${++this.replyCount}-`;
    const engine = createEngine(
      this.engineName,
      {
        caption: (c) => this.onCaption({ ...c, id: tag + c.id }, name),
        audio: (buf) => {
          // Replies are spoken to the host only.
          this.replyAudioUntil = Math.max(this.replyAudioUntil, Date.now()) + (buf.length / 2 / config.sampleRate) * 1000 + 300;
          if (this.host?.readyState === WebSocket.OPEN) this.host.send(buf, { binary: true });
        },
        error: (message) => {
          console.error(`[${this.code}] reply: ${message}`);
          send(this.host, { t: 'error', message: `Reply: ${message}` });
        },
      },
      'es-en'
    );
    engine.setMode('ptt');
    engine.start();
    this.reply = { ws, engine, name };
    this.replyTimer = setTimeout(() => this.releaseFloor(), 60_000);
    this.sendState();
  }

  releaseFloor() {
    if (!this.reply) return;
    clearTimeout(this.replyTimer);
    const { engine } = this.reply;
    this.reply = null;
    engine.flush();
    engine.stop().catch(() => {});
    this.sendState();
  }

  // ---- fan-out ----
  onCaption({ lang, id, text, final }, who) {
    const line = this.lines.get(id) ?? { en: '', es: '', who, at: Date.now() };
    line[lang] = text;
    this.lines.set(id, line);
    if (this.lines.size > 2000) this.lines.delete(this.lines.keys().next().value);
    this.broadcast({ t: 'cap', lang, id, text, final, who });
  }

  onAudio(buf) {
    for (const [ws, l] of this.listeners) {
      // Skip a slow phone rather than let audio pile up behind it.
      if (l.audio && ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 1_000_000) ws.send(buf, { binary: true });
    }
  }

  broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const ws of [this.host, ...this.listeners.keys()]) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(data);
    }
  }

  sendState() {
    this.broadcast({
      t: 'state',
      code: this.code,
      listeners: this.listeners.size,
      live: !!this.engine,
      mode: this.mode,
      engine: this.engineName,
      hostConnected: !!this.host,
      floor: this.reply?.name ?? null,
    });
  }

  transcriptMarkdown() {
    const date = new Date(this.createdAt).toLocaleString('en-US', { timeZone: 'America/New_York' });
    const rows = [...this.lines.values()].filter((l) => l.en || l.es);
    return `# Meeting transcript (${this.code})\n\n${date} · engine: ${this.engineName}\n\n${rows
      .map((l) =>
        l.who
          ? `- **${l.who} (ES):** ${l.es}\n  **EN:** ${l.en}`
          : `- **EN:** ${l.en}\n  **ES:** ${l.es}`
      )
      .join('\n')}\n`;
  }
}

// Clean up rooms nobody has touched in 6 hours.
setInterval(() => {
  const cutoff = Date.now() - 6 * 3600_000;
  for (const [code, room] of rooms) {
    if ((room.ended || room.lastActive < cutoff) && !room.host && room.listeners.size === 0) {
      room.stopEngine();
      rooms.delete(code);
    }
  }
}, 10 * 60_000).unref();
