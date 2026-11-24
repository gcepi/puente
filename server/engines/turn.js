// Push-to-talk interpreter: the speaker holds a button and talks; on release
// the whole turn is transcribed, translated, and spoken. The voice never talks
// over the speaker. Captions show both languages once the turn is processed.

const RATE = 24000;
const MIN_SECONDS = 0.4; // ignore accidental taps
const MAX_SECONDS = 120; // a single turn is capped so memory stays bounded
// Speech check: transcription models invent words (or echo old text) when given
// silence, so a turn must contain at least MIN_VOICED_SECONDS of voice-level audio.
const FRAME = 720; // 30 ms
const VOICE_RMS = 0.012; // a normal speaking voice on a laptop mic is well above this
const MIN_VOICED_SECONDS = 0.25;
const TURN_TIMEOUT_MS = 90_000; // a stuck turn is abandoned so later turns are never blocked

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
    if (!this.streamed && full) this.push(full); // arrived in one piece: still split into sentences
    this.emit(this.buf);
    this.buf = '';
  }
  emit(text) {
    const s = text.trim();
    if (s) this.onSentence(s);
  }
}

// While the button is held, a pause this long after enough speech closes a segment,
// which is transcribed in the background. On release only the last segment is left.
const SEGMENT_PAUSE_SECONDS = 0.7;
const SEGMENT_MIN_VOICED_SECONDS = 1.5;

function bufRms(buf) {
  let sum = 0;
  const n = buf.length >> 1;
  for (let i = 0; i < n; i++) {
    const s = buf.readInt16LE(i * 2) / 32768;
    sum += s * s;
  }
  return n ? Math.sqrt(sum / n) : 0;
}

export class TurnEngine {
  /**
   * @param {{caption:Function, cue:Function, cueLength?:Function, audio:Function, error:Function}} hooks
   * @param {{transcribe:Function, translate:Function, speak:Function}} deps
   * @param {{src?:string, dst?:string, speed?:number}} opts
   */
  constructor(hooks, deps, { src = 'en', dst = 'es', speed = 1, turnTimeoutMs = TURN_TIMEOUT_MS } = {}) {
    this.turnTimeoutMs = turnTimeoutMs;
    this.hooks = hooks;
    this.deps = deps;
    this.src = src;
    this.dst = dst;
    this.seq = 0;
    this.context = [];
    this.chain = Promise.resolve();
    this.synthRunning = 0;
    this.synthWaiters = [];
    this.reset();
  }

  reset() {
    this.chunks = []; // audio of the open segment
    this.segments = []; // transcriptions already running for earlier segments of this turn
    this.bytes = 0; // whole turn
    this.voiced = 0; // seconds of voice in the open segment
    this.quiet = 0; // seconds of quiet at the end of the open segment
    this.turnVoiced = 0;
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
    const secs = buf.length / 2 / RATE;
    if (bufRms(buf) > VOICE_RMS) {
      this.voiced += secs;
      this.turnVoiced += secs;
      this.quiet = 0;
    } else {
      this.quiet += secs;
    }
    // A natural pause after real speech: start transcribing this part now.
    if (this.voiced >= SEGMENT_MIN_VOICED_SECONDS && this.quiet >= SEGMENT_PAUSE_SECONDS) this.closeSegment();
  }

  closeSegment() {
    const pcm = Buffer.concat(this.chunks);
    const voiced = this.voiced;
    this.chunks = [];
    this.voiced = 0;
    this.quiet = 0;
    const job = this.deps.transcribe(pcm, this.src, voiced).then(
      (text) => ({ text }),
      (error) => ({ error })
    );
    this.segments.push(job);
  }

  /** The speaker released the button: process this turn. */
  flush() {
    const rest = Buffer.concat(this.chunks);
    // After earlier segments, a short closing phrase ("okay, thanks") still counts.
    const restHasSpeech = this.segments.length
      ? voicedSeconds(rest) >= 0.15
      : rest.length >= MIN_SECONDS * RATE * 2 && voicedSeconds(rest) >= MIN_VOICED_SECONDS;
    const parts = [...this.segments];
    if (restHasSpeech) {
      parts.push(this.deps.transcribe(rest, this.src, voicedSeconds(rest)).then((text) => ({ text }), (error) => ({ error })));
    }
    const hadAudio = this.bytes > 0;
    const stats = { speechSeconds: this.turnVoiced, parts: parts.length, releasedAt: Date.now() };
    this.reset();
    if (!hadAudio) return;
    if (!parts.length) {
      this.hooks.caption({ lang: this.src, id: this.peekId(), text: '', final: true }); // clear any live text
      this.hooks.error("Didn't catch any speech. Hold the button the whole time you talk.");
      return;
    }
    const id = `t${this.seq++}`;
    this.hooks.caption({ lang: this.src, id, text: '…', final: false });
    // Turns are handled strictly in order, so voices never overlap. A watchdog makes sure
    // one stuck request can never block the turns behind it.
    this.chain = this.chain
      .then(() => {
        let timer;
        const watchdog = new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('That turn took too long and was skipped. Please say it again.')), this.turnTimeoutMs);
        });
        return Promise.race([this.process(id, parts, stats), watchdog]).finally(() => clearTimeout(timer));
      })
      .catch((e) => this.hooks.error(e.message));
  }

  async process(id, parts, stats = {}) {
    const results = await Promise.all(parts);
    stats.transcribedIn = Date.now() - (stats.releasedAt ?? Date.now());
    const failed = results.find((r) => r.error);
    if (failed) {
      this.hooks.caption({ lang: this.src, id, text: '(no se pudo escuchar / could not transcribe)', final: true });
      throw failed.error;
    }
    const text = results.map((r) => r.text.trim()).filter(Boolean).join(' ');
    if (!text) {
      this.hooks.caption({ lang: this.src, id, text: '(nothing heard)', final: true });
      return;
    }
    this.hooks.caption({ lang: this.src, id, text, final: true });
    stats.words = (text.match(/[\p{L}\p{N}']+/gu) ?? []).length;
    this.firstVoiceStats = stats;

    // Translate the whole turn as a stream. Each finished sentence starts its voice right away
    // (up to 3 in parallel) and is sent in order once fully generated, so playback never stutters.
    let speech = Promise.resolve();
    const splitter = new SentenceSplitter((sentence) => {
      const audio = this.synth(sentence);
      speech = speech.then(() => this.send(id, sentence, audio));
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
    this.hooks.stats?.({ id, ...stats });
  }

  /** Generate one sentence's voice in full, retrying once. At most 3 run at the same time. */
  async synth(sentence) {
    while (this.synthRunning >= 3) await new Promise((r) => this.synthWaiters.push(r));
    this.synthRunning++;
    try {
      for (let attempt = 1; ; attempt++) {
        const chunks = [];
        try {
          await this.deps.speak(sentence, (b) => chunks.push(b));
          return { audio: Buffer.concat(chunks) };
        } catch (error) {
          if (attempt >= 2) return { error };
        }
      }
    } finally {
      this.synthRunning--;
      this.synthWaiters.shift()?.();
    }
  }

  /**
   * Send one sentence: its text with the exact audio length, then all of its audio at once.
   * Phones reveal the words in step with the voice.
   */
  async send(id, sentence, pending) {
    const { audio, error } = await pending;
    if (error) this.hooks.error(`Voice: ${error.message}`);
    if (!audio?.length) {
      this.hooks.cue({ id, lang: this.dst, text: sentence, seconds: 0, last: false }); // still show the words
      return;
    }
    const s = this.firstVoiceStats;
    if (s && s.releasedAt && s.voiceIn == null) s.voiceIn = Date.now() - s.releasedAt;
    this.hooks.cue({ id, lang: this.dst, text: sentence, seconds: audio.length / 2 / RATE, last: false });
    for (let o = 0; o < audio.length; o += 9600) this.hooks.audio(audio.subarray(o, o + 9600));
  }

  async stop() {
    this.flush();
    await this.chain;
  }
}
