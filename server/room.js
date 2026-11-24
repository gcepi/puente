// A room is one meeting: one host (the speaker) and any number of listeners.
// Audio is translated once on the server and fanned out, so cost does not
// grow with the number of listeners.
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { config, engineProblems } from './config.js';
import { createEngine } from './engines/index.js';

const rooms = new Map();
const REPLY_ECHO_GUARD_MS = 300;
// Room codes are 3 digits (100-999): easy to say out loud and type on a number pad.
function newCode() {
  if (rooms.size >= 900) throw new Error('No free room codes');
  for (;;) {
    const code = String(crypto.randomInt(100, 1000));
    if (!rooms.has(code)) return code;
  }
}

export function createRoom(engineName = config.engine) {
  if (config.roomCode) {
    // Standing room: reuse the live one so connected listeners stay put.
    const existing = rooms.get(config.roomCode);
    if (existing && !existing.ended) {
      if (!existing.engine) existing.engineName = engineName;
      return existing;
    }
    if (existing) rooms.delete(config.roomCode);
  }
  const code = config.roomCode || newCode();
  const room = new Room(code, crypto.randomBytes(16).toString('hex'), engineName);
  rooms.set(room.code, room);
  return room;
}

export const getRoom = (code) => rooms.get(String(code || '').trim());

const send = (ws, obj) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(obj));
const hostLineId = (generation, id) => `h${generation}-${id}`;

class Room {
  constructor(code, hostToken, engineName) {
    this.code = code;
    this.hostToken = hostToken;
    this.engineName = engineName;
    this.host = null;
    this.listeners = new Map(); // ws -> { name, audio }
    this.engine = null;
    this.hostEngineCount = 0;
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
    // A newer host window takes over; the old one is told and stops (it must not reconnect and fight back).
    const previous = this.host;
    this.host = ws;
    if (previous && previous !== ws) {
      previous.close(4001, 'moved');
      this.discardHostHold();
      this.releaseFloor({ discard: true });
    }
    clearTimeout(this.hostGoneTimer);
    this.sendState();
    this.sendHistory(ws, 30);
    ws.on('message', (data, isBinary) => {
      if (this.host !== ws) return;
      if (isBinary) this.onHostAudio(data);
      else this.onHostMessage(data);
    });
    ws.on('close', () => {
      if (this.host !== ws) return;
      this.host = null;
      this.discardHostHold();
      this.releaseFloor({ discard: true });
      this.sendState();
      // Allow a quick reconnect (phone screen lock, network blip) before stopping.
      this.hostGoneTimer = setTimeout(() => this.stopEngine(), 20_000);
    });
  }

  discardHostHold() {
    if (!this.pttDown) return;
    this.pttDown = false;
    this.liveOpen = false;
    this.pressAudio = [];
    // The turn engine resets only the open recording. Released turns stay in its queue.
    this.engine?.reset?.();
    if (this.engine?.peekId) {
      const id = hostLineId(this.hostEngineCount, this.engine.peekId());
      if (this.lines.delete(id)) this.broadcast({ t: 'cap', id, lang: 'en', text: '', final: true });
    }
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
      if (this.pttDown && !this.engine) this.startEngine();
      this.liveOpen = this.pttDown;
      if (this.pttDown) this.pressAudio = [];
      if (!this.pttDown) {
        this.engine?.flush();
        this.lastHeard = Buffer.concat(this.pressAudio ?? []);
        this.pressAudio = [];
        // Did everything the page recorded actually arrive?
        const sentSecs = (msg.frames ?? 0) * 0.04;
        const gotSecs = this.lastHeard.length / 2 / config.sampleRate;
        if (sentSecs > 1 && gotSecs < sentSecs * 0.8) {
          console.warn(`[${this.code}] only ${gotSecs.toFixed(1)}s of ${sentSecs.toFixed(1)}s of audio arrived`);
          send(this.host, { t: 'error', message: `Only ${gotSecs.toFixed(1)} of ${sentSecs.toFixed(1)} s of what you said reached the server. Check the connection.` });
        }
      }
    } else if (msg.t === 'live') {
      // Browser dictation while the host holds the button: show it on the line this turn will use.
      if (this.liveOpen && this.engine?.peekId && typeof msg.text === 'string') {
        const id = hostLineId(this.hostEngineCount, this.engine.peekId());
        this.onCaption({ lang: 'en', id, text: msg.text.slice(0, 4000), final: false });
      }
    } else if (msg.t === 'flush') this.engine?.flush();
    else if (msg.t === 'end') this.end();
  }

  onHostAudio(buf) {
    if (!this.engine) return;
    if (this.mode === 'ptt' && !this.pttDown) return;
    // While a team member is replying, or their translated reply is playing on the
    // host's speaker, ignore the host mic so the reply is not translated back.
    if (this.reply || Date.now() < this.replyAudioUntil + REPLY_ECHO_GUARD_MS) return;
    this.micSeconds += buf.length / 2 / config.sampleRate;
    if (this.pressAudio && this.pressAudio.length < 3000) this.pressAudio.push(buf); // up to 2 min, for "what it heard"
    this.engine.audio(buf);
  }

  startEngine() {
    if (this.engine) return;
    const missing = engineProblems(this.engineName);
    if (missing.length) {
      send(this.host, { t: 'error', message: `Server is missing: ${missing.join(', ')}` });
      return;
    }
    this.turnVoice = [];
    // Engines restart their line counters. Even late callbacks from an old engine need its original prefix.
    const generation = ++this.hostEngineCount;
    const withRoomId = (event) => ({ ...event, id: hostLineId(generation, event.id) });
    this.engine = createEngine(this.engineName, {
      caption: (c) => this.onCaption(withRoomId(c)),
      cue: (c) => {
        this.onCue(withRoomId(c), undefined, 'listeners');
        if (c.last) {
          this.lastVoice = Buffer.concat(this.turnVoice ?? []);
          this.turnVoice = [];
        }
      },
      cueLength: (c) => this.broadcast({ t: 'cuelen', ...withRoomId(c), to: 'listeners' }),
      stats: (s) => {
        const turn = withRoomId(s);
        console.log(`[${this.code}] turn ${turn.id}: ${s.speechSeconds.toFixed(1)}s speech, ${s.parts} part(s), ${s.words} words, transcript ${s.transcribedIn}ms, voice ${s.voiceIn ?? '-'}ms after release`);
        send(this.host, { t: 'turn', ...turn });
      },
      audio: (buf) => {
        if (this.turnVoice.length < 3000) this.turnVoice.push(buf);
        this.onAudio(buf);
      },
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
    this.releaseFloor({ discard: true });
    this.broadcast({ t: 'ended' });
    for (const ws of this.listeners.keys()) ws.close(1000, 'ended');
    this.ended = true;
  }

  // ---- listeners ----
  attachListener(ws, name, device) {
    // One page per phone: an older tab on the same phone is closed, so the voice never plays twice.
    if (device) {
      for (const [other, l] of this.listeners) if (l.device === device && other !== ws) other.close(4001, 'moved');
    }
    this.listeners.set(ws, { name: String(name || '').slice(0, 40), audio: true, device: String(device || '').slice(0, 64) });
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
      if (this.reply?.ws === ws) this.releaseFloor({ discard: true });
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
    const host = this.host;
    if (host?.readyState !== WebSocket.OPEN) return send(ws, { t: 'error', message: 'Espera a que vuelva el presentador.' });
    if (this.reply) return send(ws, { t: 'error', message: 'Otra persona está hablando.' });
    const missing = engineProblems(this.engineName);
    if (missing.length) return send(ws, { t: 'error', message: 'Las respuestas no están configuradas.' });
    const name = this.listeners.get(ws)?.name || 'Equipo';
    const tag = `r${++this.replyCount}-`;
    const reply = { ws, name, discarded: false };
    // A provider may finish after the phone disconnects or a different host window takes over.
    const deliver = (callback) => (value) => {
      if (!reply.discarded && !this.ended && this.host === host) callback(value);
    };
    const engine = createEngine(
      this.engineName,
      {
        caption: deliver((c) => this.onCaption({ ...c, id: tag + c.id }, name)),
        cue: deliver((c) => this.onCue({ ...c, id: tag + c.id }, name, 'host')),
        cueLength: deliver((c) => this.broadcast({ t: 'cuelen', ...c, id: tag + c.id, to: 'host' })),
        audio: deliver((buf) => {
          // Replies are spoken to the host only.
          this.replyAudioUntil = Math.max(this.replyAudioUntil, Date.now()) + (buf.length / 2 / config.sampleRate) * 1000;
          if (this.host?.readyState === WebSocket.OPEN) this.host.send(buf, { binary: true });
        }),
        error: deliver((message) => {
          console.error(`[${this.code}] reply: ${message}`);
          send(this.host, { t: 'error', message: `Reply: ${message}` });
        }),
      },
      'es-en'
    );
    engine.setMode('ptt');
    engine.start();
    reply.engine = engine;
    this.reply = reply;
    this.replyTimer = setTimeout(() => this.releaseFloor(), 60_000);
    this.sendState();
  }

  releaseFloor({ discard = false } = {}) {
    if (!this.reply) return;
    clearTimeout(this.replyTimer);
    const { engine } = this.reply;
    this.reply.discarded = discard;
    this.reply = null;
    if (!discard) engine.flush();
    engine.stop({ discard }).catch(() => {});
    if (!discard) this.sendState(); // disconnect, takeover and end publish their own state
  }

  // ---- fan-out ----
  /** One spoken sentence: its text, sent just ahead of its audio, with the audio's length. */
  onCue({ id, lang, text, seconds, last }, who, to) {
    const line = this.lines.get(id) ?? { en: '', es: '', who, at: Date.now() };
    if (text) line[lang] = line[lang] ? `${line[lang]} ${text}` : text;
    this.lines.set(id, line);
    this.broadcast({ t: 'cue', id, lang, text, seconds, last, who, to });
  }

  onCaption({ lang, id, text, final }, who) {
    const prev = this.lines.get(id);
    if (!final && text === '…' && prev?.[lang]) return; // keep live text instead of a placeholder
    const line = prev ?? { en: '', es: '', who, at: Date.now() };
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
