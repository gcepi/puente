// OpenAI gpt-realtime-translate: one streaming speech-to-speech model.
// It interprets while the speaker is still talking (no waiting for pauses),
// costs ~$0.034/min of input audio, but offers no glossary, no voice choice,
// and no Mexican-Spanish-specific setting.
//
// VERIFY ON FIRST LIVE RUN: the endpoint and event names below come from
// OpenAI's cookbook and third-party write-ups (Nov 2026); the official API
// reference could not be fetched from the build environment. Unknown event
// types are logged once so mismatches are easy to spot.
import WebSocket from 'ws';

const LINE_GAP_MS = 1400;

export class OpenAiTranslateEngine {
  constructor(hooks, { apiKey, url, targetLanguage = 'es', sourceLanguage = 'en' }) {
    this.hooks = hooks;
    this.srcLang = sourceLanguage;
    this.apiKey = apiKey;
    this.url = url;
    this.target = targetLanguage;
    this.lines = {};
    this.seen = new Set();
    this.queue = [];
    this.n = 0;
  }

  setMode() {}

  start() {
    this.ws = new WebSocket(this.url, { headers: { Authorization: `Bearer ${this.apiKey}` } });
    this.ws.on('open', () => {
      this.send({ type: 'session.update', session: { audio: { output: { language: this.target } } } });
      for (const m of this.queue.splice(0)) this.ws.send(m);
    });
    this.ws.on('message', (raw) => this.onEvent(raw));
    this.ws.on('error', (e) => this.hooks.error(`OpenAI: ${e.message}`));
    this.ws.on('close', (code, reason) => {
      if (code !== 1000 && !this.stopping) this.hooks.error(`OpenAI closed (${code}) ${reason}`);
    });
  }

  send(obj) {
    const data = JSON.stringify(obj);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(data);
    else this.queue.push(data);
  }

  audio(buf) {
    this.send({ type: 'session.input_audio_buffer.append', audio: buf.toString('base64') });
  }

  flush() {}

  onEvent(raw) {
    let ev;
    try {
      ev = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const type = ev.type ?? '';
    if (type.endsWith('output_audio.delta')) {
      this.hooks.audio(Buffer.from(ev.delta, 'base64'));
    } else if (type.endsWith('output_transcript.delta')) {
      this.caption(this.target, ev.delta ?? '');
    } else if (type.includes('input') && type.endsWith('transcript.delta')) {
      this.caption(this.srcLang, ev.delta ?? '');
    } else if (type === 'error') {
      this.hooks.error(`OpenAI: ${ev.error?.message ?? JSON.stringify(ev).slice(0, 200)}`);
    } else if (!this.seen.has(type)) {
      this.seen.add(type);
      console.log(`[openai-translate] event: ${type}`);
    }
  }

  // The model streams one long transcript; break it into caption lines on pauses and sentence ends.
  caption(lang, delta) {
    if (!delta) return;
    const now = Date.now();
    let line = this.lines[lang];
    if (!line || now - line.at > LINE_GAP_MS || (line.text.length > 90 && /[.?!]\s*$/.test(line.text))) {
      if (line) this.finish(lang);
      line = this.lines[lang] = { id: `${lang}${this.n++}`, text: '', at: now };
    }
    line.text += delta;
    line.at = now;
    this.hooks.caption({ lang, id: line.id, text: line.text.trim(), final: false });
    clearTimeout(line.timer);
    line.timer = setTimeout(() => this.finish(lang), LINE_GAP_MS);
  }

  finish(lang) {
    const line = this.lines[lang];
    if (!line) return;
    clearTimeout(line.timer);
    this.hooks.caption({ lang, id: line.id, text: line.text.trim(), final: true });
    this.lines[lang] = null;
  }

  async stop() {
    // Give the model a moment to finish speaking the tail, then close.
    await new Promise((r) => setTimeout(r, 3000));
    this.stopping = true;
    try {
      this.send({ type: 'session.close' });
      this.ws?.close(1000);
    } catch {}
    for (const lang of Object.keys(this.lines)) this.finish(lang);
  }
}
