// Push-to-talk interpreter: the speaker holds a button and talks; on release
// the whole turn is transcribed, translated, and spoken. The voice never talks
// over the speaker. Captions show both languages once the turn is processed.

const RATE = 24000;
const MIN_SECONDS = 0.4; // ignore accidental taps
const MAX_SECONDS = 120; // a single turn is capped so memory stays bounded
// Speech check: transcription models invent words (or echo old text) when given
// silence, so a turn must contain at least MIN_VOICED_SECONDS of voice-level audio.
const FRAME = 720; // 30 ms
const VOICE_RMS = 0.02;
const MIN_VOICED_SECONDS = 0.3;

export function voicedSeconds(pcm) {
  let voiced = 0;
  for (let off = 0; off + FRAME * 2 <= pcm.length; off += FRAME * 2) {
    let sum = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = pcm.readInt16LE(off + i * 2) / 32768;
      sum += s * s;
    }
    if (Math.sqrt(sum / FRAME) > VOICE_RMS) voiced++;
  }
  return (voiced * FRAME) / RATE;
}

/**
 * Cuts streamed text into sentences. A sentence is emitted once the next one
 * starts (so "3.5" or a trailing period mid-stream never splits early).
 */
export class SentenceSplitter {
  constructor(onSentence, maxLen = 240) {
    this.onSentence = onSentence;
    this.maxLen = maxLen;
    this.buf = '';
    this.streamed = false;
  }
  push(delta) {
    this.streamed = true;
    this.buf += delta;
    let m;
    while ((m = this.buf.match(/^([\s\S]*?[.!?…]+["»”')\]]*)\s+(?=\S)/))) {
      this.emit(m[1]);
      this.buf = this.buf.slice(m[0].length);
    }
    if (this.buf.length > this.maxLen) {
      const cut = Math.max(this.buf.lastIndexOf(', '), this.buf.lastIndexOf('; '));
      if (cut > 40) {
        this.emit(this.buf.slice(0, cut + 1));
        this.buf = this.buf.slice(cut + 2);
      }
    }
  }
  /** @param {string} full the complete text, used when nothing was streamed */
  end(full) {
    if (!this.streamed && full) this.buf = full;
    this.emit(this.buf);
    this.buf = '';
  }
  emit(text) {
    const s = text.trim();
    if (s) this.onSentence(s);
  }
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

  /** Id the next turn will get, so live captions shown while holding land on the same line. */
  peekId() {
    return `t${this.seq}`;
  }

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
    if (!pcm.length) return;
    if (pcm.length < MIN_SECONDS * RATE * 2 || voicedSeconds(pcm) < MIN_VOICED_SECONDS) {
      this.hooks.caption({ lang: this.src, id: this.peekId(), text: '', final: true }); // clear any live text
      this.hooks.error("Didn't catch any speech. Hold the button the whole time you talk.");
      return;
    }
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

    // Translate as a stream; each finished sentence is voiced right away, in order.
    let speech = Promise.resolve();
    const splitter = new SentenceSplitter((sentence) => {
      speech = speech.then(() => this.say(id, sentence));
    });
    let out;
    try {
      out = await this.deps.translate(text, this.context.slice(-4), (d) => splitter.push(d));
    } catch (e) {
      const label = this.dst === 'es' ? '(sin traducción)' : '(no translation)';
      await speech;
      this.hooks.cue({ id, lang: this.dst, text: `${label} ${text}`, seconds: 0, last: true });
      throw e;
    }
    splitter.end(out);
    await speech;
    this.hooks.cue({ id, lang: this.dst, text: '', seconds: 0, last: true });
    this.context.push({ src: text, dst: out });
  }

  /**
   * Voice one sentence. Its text goes out just before its audio, with the exact audio
   * length, so phones can reveal the words in step with the voice.
   */
  async say(id, sentence) {
    const chunks = [];
    try {
      await this.deps.speak(sentence, (b) => chunks.push(b));
    } catch (e) {
      // Still show the words if the voice fails.
      this.hooks.cue({ id, lang: this.dst, text: sentence, seconds: 0, last: false });
      this.hooks.error(`Voice: ${e.message}`);
      return;
    }
    const audio = Buffer.concat(chunks);
    this.hooks.cue({ id, lang: this.dst, text: sentence, seconds: audio.length / 2 / RATE, last: false });
    for (let o = 0; o < audio.length; o += 9600) this.hooks.audio(audio.subarray(o, o + 9600));
  }

  async stop() {
    this.flush();
    await this.chain;
  }
}
