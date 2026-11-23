// Pipeline engine: speech recognition -> Claude translation -> text-to-speech.
// Slower to start speaking than a speech-to-speech model, but every stage is
// steerable: glossary, Mexican Spanish register, voice choice, phrase timing.
//
// Phrase modes (set by the host):
//   auto   - a phrase ends when the speaker pauses (ENDPOINTING_MS)
//   ptt    - mic is live only while the host holds the button; release ends the phrase
//   manual - mic always live; a phrase ends only when the host taps "Translate now"
// In every mode a very long phrase is broken at MAX_PHRASE_WORDS so audio never lags far behind.

const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const join = (a, b) => [a, b].filter(Boolean).join(' ').trim();

export class PipelineEngine {
  /**
   * @param {{caption:Function, audio:Function, error:Function}} hooks
   * @param {{connectStt:Function, translate:Function, speak:Function}} deps
   * @param {{maxPhraseWords?:number, contextSize?:number, flushTimeoutMs?:number, src?:string, dst?:string}} opts
   */
  constructor(hooks, deps, opts = {}) {
    this.hooks = hooks;
    this.deps = deps;
    this.maxWords = opts.maxPhraseWords ?? 35;
    this.contextSize = opts.contextSize ?? 4;
    this.flushTimeoutMs = opts.flushTimeoutMs ?? 1500;
    this.src = opts.src ?? 'en';
    this.dst = opts.dst ?? 'es';
    this.mode = 'auto';
    this.committed = '';
    this.interim = '';
    this.seq = 0;
    this.id = 'p0';
    this.context = [];
    this.pendingFlush = false;
    this.flushTimer = null;
    this.speechChain = Promise.resolve();
  }

  setMode(mode) {
    this.mode = mode;
  }

  start() {
    this.stt = this.deps.connectStt({
      onResult: (r) => this.onResult(r),
      onUtteranceEnd: () => {
        if (this.mode !== 'manual' && this.committed) this.commit(false);
      },
      onError: (e) => this.hooks.error(`Speech recognition: ${e.message}`),
    });
  }

  audio(buf) {
    this.stt?.sendAudio(buf);
  }

  onResult({ text, isFinal, speechFinal }) {
    if (!isFinal) {
      this.interim = text;
      this.emitEnglish(false);
      return;
    }
    this.committed = join(this.committed, text);
    this.interim = '';
    this.emitEnglish(false);
    const n = words(this.committed);
    const atBoundary = /[.?!,;:]$/.test(this.committed);
    if (
      this.pendingFlush ||
      (speechFinal && this.mode !== 'manual') ||
      (n >= this.maxWords && atBoundary) ||
      n >= this.maxWords * 1.5
    ) {
      this.commit(false);
    }
  }

  /** Host released push-to-talk or tapped "Translate now". */
  flush() {
    if (!this.committed && !this.interim) return;
    this.pendingFlush = true;
    this.stt?.finalize();
    clearTimeout(this.flushTimer);
    // If recognition never confirms, translate what we have.
    this.flushTimer = setTimeout(() => this.pendingFlush && this.commit(true), this.flushTimeoutMs);
  }

  emitEnglish(final) {
    const text = join(this.committed, this.interim);
    if (text || final) this.hooks.caption({ lang: this.src, id: this.id, text, final });
  }

  commit(includeInterim) {
    clearTimeout(this.flushTimer);
    const text = (includeInterim ? join(this.committed, this.interim) : this.committed).trim();
    this.pendingFlush = false;
    this.committed = '';
    if (includeInterim) this.interim = '';
    if (!text) return;
    const id = this.id;
    this.hooks.caption({ lang: this.src, id, text, final: true });
    this.id = `p${++this.seq}`;
    if (this.interim) this.emitEnglish(false);

    // Translation starts immediately; speech is chained so audio stays in order.
    const translation = this.translatePhrase(id, text);
    this.speechChain = this.speechChain
      .then(async () => {
        const es = await translation;
        if (es) await this.deps.speak(es, (buf) => this.hooks.audio(buf));
      })
      .catch((e) => this.hooks.error(`Voice: ${e.message}`));
  }

  async translatePhrase(id, text) {
    let acc = '';
    try {
      const es = await this.deps.translate(text, this.context.slice(-this.contextSize), (d) => {
        acc += d;
        this.hooks.caption({ lang: this.dst, id, text: acc, final: false });
      });
      this.context.push({ src: text, dst: es });
      this.hooks.caption({ lang: this.dst, id, text: es, final: true });
      return es;
    } catch (e) {
      this.hooks.error(`Translation: ${e.message}`);
      const label = this.dst === 'es' ? '(sin traducción)' : '(no translation)';
      this.hooks.caption({ lang: this.dst, id, text: `${label} ${text}`, final: true });
      return null;
    }
  }

  async stop() {
    this.flush();
    await new Promise((r) => setTimeout(r, this.flushTimeoutMs + 200));
    this.stt?.close();
    this.stt = null;
  }
}
