// Shared by host and listener pages.

export function wsUrl(params) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}/ws?${new URLSearchParams(params)}`;
}

/** WebSocket that reconnects with backoff until close() is called or the server says the room is gone. */
export function connect(params, { onOpen, onMessage, onAudio, onStatus, onGone }) {
  let ws;
  let closed = false;
  let delay = 500;
  const open = () => {
    onStatus?.('connecting');
    ws = new WebSocket(wsUrl(params));
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      delay = 500;
      onStatus?.('online');
      onOpen?.();
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') onMessage?.(JSON.parse(e.data));
      else onAudio?.(e.data);
    };
    ws.onclose = (e) => {
      if (closed) return;
      if (e.code === 4004 || e.code === 4003 || e.code === 1000) {
        onStatus?.('gone');
        onGone?.(e.code);
        return;
      }
      onStatus?.('offline');
      setTimeout(open, delay);
      delay = Math.min(delay * 2, 8000);
    };
  };
  open();
  return {
    send: (data) => ws?.readyState === 1 && ws.send(typeof data === 'string' || data instanceof ArrayBuffer ? data : JSON.stringify(data)),
    get buffered() {
      return ws?.bufferedAmount ?? 0;
    },
    close: () => {
      closed = true;
      ws?.close();
    },
  };
}

/** One scrolling caption column. Lines are keyed by id; partial lines update in place. */
export class CaptionPane {
  constructor(el) {
    this.el = el;
    this.lines = new Map();
    this.stick = true;
    el.addEventListener('scroll', () => {
      this.stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    });
  }
  set(id, text, final, who) {
    let p = this.lines.get(id);
    if (p && !text && final) {
      p.remove();
      this.lines.delete(id);
      return;
    }
    if (!p) {
      if (!text) return;
      p = document.createElement('p');
      p.className = 'line';
      this.el.appendChild(p);
      this.lines.set(id, p);
      while (this.lines.size > 200) {
        const [k, old] = this.lines.entries().next().value;
        old.remove();
        this.lines.delete(k);
      }
    }
    p.textContent = text;
    if (who) {
      const tag = document.createElement('span');
      tag.className = 'who';
      tag.textContent = who;
      p.prepend(tag);
    }
    p.classList.toggle('partial', !final);
    for (const other of this.el.querySelectorAll('.line.latest')) other.classList.remove('latest');
    p.classList.add('latest');
    if (this.stick) this.el.scrollTop = this.el.scrollHeight;
  }
  clear() {
    this.el.querySelectorAll('.line').forEach((n) => n.remove());
    this.lines.clear();
  }
}

/** Keep the screen on. iOS Safari 16.4+ and all modern Android browsers support this. */
export function keepAwake() {
  let lock = null;
  const request = async () => {
    try {
      if ('wakeLock' in navigator && document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen');
    } catch {}
  };
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && request());
  request();
  return () => lock?.release();
}

export const $ = (s) => document.querySelector(s);

/**
 * Reveals spoken sentences word by word, in step with the voice.
 * Each cue says when its audio starts (startIn seconds from now, from the audio
 * clock) and how long it lasts. Screens that aren't playing that audio pass
 * startIn = null and get the same pacing on their own clock.
 */
export class Revealer {
  constructor(pane, leadIn = 0.3) {
    this.pane = pane;
    this.leadIn = leadIn;
    this.lines = new Map(); // id -> text already fully shown
    this.items = [];
    this.clock = 0; // own clock: when the next unsynced sentence may start
    this.timer = null;
  }
  add({ id, text, seconds, last, who }, startIn) {
    const now = performance.now() / 1000;
    const dur = text ? Math.max(seconds || text.length / 14, 0.4) : 0;
    const start = startIn == null ? Math.max(now + this.leadIn, this.clock) : now + startIn;
    if (startIn == null) this.clock = start + dur;
    if (!this.lines.has(id)) this.lines.set(id, '');
    const item = { id, text, start, dur, last, who, synced: startIn != null };
    this.items.push(item);
    if (text) this.latest = item;
    this.tick();
    if (!this.timer) this.timer = setInterval(() => this.tick(), 80);
  }
  /** The exact audio length of the newest sentence, once it has been fully voiced. */
  setLength(id, seconds) {
    const it = this.latest;
    if (!it || it.id !== id || !(seconds > 0)) return;
    it.dur = seconds;
    if (!it.synced) this.clock = it.start + seconds;
  }

  tick() {
    const now = performance.now() / 1000;
    const keep = [];
    const waiting = new Set(); // lines with an earlier sentence still revealing
    for (const it of this.items) {
      // A sentence waits for the one before it on the same line, so none is ever lost or reordered.
      if (waiting.has(it.id) || now < it.start) {
        keep.push(it);
        waiting.add(it.id);
        continue;
      }
      const done = this.lines.get(it.id);
      const words = it.text.split(/\s+/).filter(Boolean);
      const frac = it.dur ? Math.min(1, (now - it.start) / it.dur) : 1;
      const shown = words.slice(0, Math.ceil(words.length * frac)).join(' ');
      const text = [done, shown].filter(Boolean).join(' ');
      if (frac >= 1) this.lines.set(it.id, text);
      else {
        keep.push(it);
        waiting.add(it.id);
      }
      if (text) this.pane.set(it.id, text, it.last && frac >= 1, it.who);
    }
    this.items = keep;
    if (!keep.length) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * One AudioContext for the whole page, used for both playback and the mic.
 * Safari and iOS only let audio start inside a tap, so call this synchronously
 * at the top of every tap handler, before any await.
 */
let sharedCtx = null;
export function audioContext() {
  if (!sharedCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    sharedCtx = new Ctx({ latencyHint: 'interactive' });
  }
  if (sharedCtx.state !== 'running') sharedCtx.resume().catch(() => {});
  return sharedCtx;
}

/** Mic -> 24 kHz PCM16 frames. Call audioContext() inside the tap first. Returns { stop }. */
export async function openMic(onFrame, onLevel) {
  const ctx = audioContext();
  // iPhone (Safari and Chrome alike): the player sets the audio session to 'playback'
  // so the voice ignores the silent switch, but 'playback' forbids the microphone and
  // getUserMedia fails without ever asking. Switch to play-and-record first.
  setAudioSession('play-and-record');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    if (e.name !== 'OverconstrainedError' && e.name !== 'TypeError') {
      setAudioSession('playback');
      throw e;
    }
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  if (!ctx.__micWorklet) {
    await ctx.audioWorklet.addModule('/js/mic-worklet.js');
    ctx.__micWorklet = true;
  }
  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, 'mic-capture');
  node.port.onmessage = ({ data }) => {
    onLevel?.(data.level);
    onFrame(data.pcm);
  };
  src.connect(node);
  // Keep the graph pulling audio without playing the mic back out loud.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(ctx.destination);
  if (ctx.state !== 'running') await ctx.resume();
  return {
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      node.port.onmessage = null;
      src.disconnect();
      node.disconnect();
      mute.disconnect();
      setAudioSession('playback');
    },
  };
}

/** iOS 17+ Audio Session API; a no-op elsewhere. */
export function setAudioSession(type) {
  try {
    if (navigator.audioSession) navigator.audioSession.type = type;
  } catch {}
}

/** Plain-language help for a mic error, in Spanish for the crew and English for the host. */
export function micHelp(e, lang = 'es') {
  const denied = e?.name === 'NotAllowedError' || e?.name === 'SecurityError';
  const ios = /iPhone|iPad/.test(navigator.userAgent);
  if (lang === 'es') {
    if (!denied) return `El micrófono no inició (${e?.name || 'error'}).`;
    return ios
      ? 'Micrófono bloqueado. Toca "aA" en la barra de dirección › Configuración del sitio › Micrófono › Permitir. En Chrome: Ajustes del iPhone › Chrome › Micrófono.'
      : 'Micrófono bloqueado. Toca el candado junto a la dirección › Micrófono › Permitir.';
  }
  if (!denied) return `Microphone didn't start (${e?.name || 'error'}: ${e?.message || ''}).`;
  return ios
    ? 'Microphone blocked. Tap "aA" in the address bar › Website Settings › Microphone › Allow.'
    : 'Microphone blocked. Click the icon left of the address › Microphone › Allow, then reload.';
}

export const micPossible = () => !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
