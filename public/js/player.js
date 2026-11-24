// Plays the translated voice: raw PCM16 / 24 kHz / mono chunks, scheduled
// back to back on a Web Audio clock.
import { audioContext } from './common.js';

function silentWavUrl() {
  // 0.5 s of silence. Looping it through an <audio> element puts iOS in
  // "media playback" mode, so the ring/silent switch does not mute the voice.
  const rate = 8000;
  const n = rate / 2;
  const buf = new ArrayBuffer(44 + n);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, 'data');
  v.setUint32(40, n, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

export class PcmPlayer {
  constructor({ sampleRate = 24000 } = {}) {
    this.rate = sampleRate;
    this.ctx = null;
    this.next = 0;
    this.sources = new Set();
    this.enabled = true;
    this.stats = { chunks: 0, seconds: 0, skips: 0 };
  }

  /** Must run inside a tap/click handler (browser autoplay rules). */
  async unlock() {
    this.ctx = audioContext(); // synchronous: must run inside the tap
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch {}
    try {
      this.keeper = new Audio(silentWavUrl());
      this.keeper.loop = true;
      this.keeper.setAttribute('playsinline', '');
      await this.keeper.play();
    } catch {}
    const b = this.ctx.createBuffer(1, 1, 22050);
    const s = this.ctx.createBufferSource();
    s.buffer = b;
    s.connect(this.ctx.destination);
    s.start();
    await this.ctx.resume();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.ctx.resume();
        this.keeper?.play().catch(() => {});
      }
    });
  }

  play(arrayBuffer) {
    if (!this.ctx || !this.enabled || arrayBuffer.byteLength < 2) return;
    const i16 = new Int16Array(arrayBuffer);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    const buf = this.ctx.createBuffer(1, f32.length, this.rate);
    buf.copyToChannel(f32, 0);

    const now = this.ctx.currentTime;
    // The voice arrives faster than it plays, so chunks queue up and play back to back.
    // After a pause, wait a quarter second before starting so network hiccups don't
    // cause gaps mid-sentence.
    if (this.next < now + 0.02) this.next = now + 0.25;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    src.start(this.next);
    src.onended = () => this.sources.delete(src);
    this.sources.add(src);
    this.next += buf.duration;
    this.stats.chunks++;
    this.stats.seconds += buf.duration;
  }

  skip() {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {}
    }
    this.sources.clear();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.skip();
  }

  get lag() {
    return this.ctx ? Math.max(0, this.next - this.ctx.currentTime) : 0;
  }
}
