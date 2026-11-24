// Push-to-talk interpreter: the speaker holds a button and talks; on release
// the whole turn is transcribed, translated, and spoken. The voice never talks
// over the speaker. Captions show both languages once the turn is processed.

const RATE = 24000;
const MIN_SECONDS = 0.4; // ignore accidental taps
const MAX_SECONDS = 120; // a single turn is capped so memory stays bounded
const SILENCE_RMS = 0.006; // below this the turn is treated as silence (avoids made-up transcripts)

function rms(pcm) {
  let sum = 0;
  const n = pcm.length / 2;
  for (let i = 0; i < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i) / 32768;
    sum += s * s;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

export class TurnEngine {
  /**
   * @param {{caption:Function, audio:Function, error:Function}} hooks
   * @param {{transcribe:Function, translate:Function, speak:Function}} deps
   * @param {{src?:string, dst?:string}} opts
   */
  constructor(hooks, deps, { src = 'en', dst = 'es' } = {}) {
    this.hooks = hooks;
    this.deps = deps;
    this.src = src;
    this.dst = dst;
    this.chunks = [];
    this.bytes = 0;
    this.seq = 0;
    this.context = [];
    this.chain = Promise.resolve();
  }

  setMode() {}
  start() {}

  audio(buf) {
    if (this.bytes > MAX_SECONDS * RATE * 2) return;
    this.chunks.push(buf);
    this.bytes += buf.length;
  }

  /** The speaker released the button: process this turn. */
  flush() {
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    this.bytes = 0;
    if (pcm.length < MIN_SECONDS * RATE * 2 || rms(pcm) < SILENCE_RMS) return;
    const id = `t${this.seq++}`;
    this.hooks.caption({ lang: this.src, id, text: '…', final: false });
    // Turns are handled strictly in order, so voices never overlap.
    this.chain = this.chain.then(() => this.process(id, pcm)).catch((e) => this.hooks.error(e.message));
  }

  async process(id, pcm) {
    let text;
    try {
      text = await this.deps.transcribe(pcm, this.src);
    } catch (e) {
      this.hooks.caption({ lang: this.src, id, text: '(no se pudo escuchar / could not transcribe)', final: true });
      throw e;
    }
    if (!text) {
      this.hooks.caption({ lang: this.src, id, text: '(nothing heard)', final: true });
      return;
    }
    this.hooks.caption({ lang: this.src, id, text, final: true });
    let out;
    try {
      out = await this.deps.translate(text, this.context.slice(-4), (d) =>
        this.hooks.caption({ lang: this.dst, id, text: d, final: false })
      );
    } catch (e) {
      const label = this.dst === 'es' ? '(sin traducción)' : '(no translation)';
      this.hooks.caption({ lang: this.dst, id, text: `${label} ${text}`, final: true });
      throw e;
    }
    this.context.push({ src: text, dst: out });
    this.hooks.caption({ lang: this.dst, id, text: out, final: true });
    await this.deps.speak(out, (buf) => this.hooks.audio(buf));
  }

  async stop() {
    this.flush();
    await this.chain;
  }
}
