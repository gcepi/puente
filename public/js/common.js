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
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
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
    },
  };
}

export const micPossible = () => !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
