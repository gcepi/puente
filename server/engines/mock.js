// Mock engine: exercises the whole flow (rooms, captions, voice playback,
// push-to-talk) with no API keys. While the host's mic is sending audio it
// "hears" a scripted briefing word by word, "translates" it, and plays a
// synthetic voice-like tone sequence.

const SCRIPT = [
  ['Good morning, team. Today we have three make-ready units.', 'Buenos días, equipo. Hoy tenemos tres departamentos para preparar.'],
  ['Unit 204 needs new caulk in the bathroom and a GFCI outlet replaced.', 'El 204 necesita sellador nuevo en el baño y cambiar un contacto GFCI.'],
  ['Please check the water heater in building C before lunch.', 'Por favor revisen el boiler del edificio C antes de la comida.'],
  ['If you find a leak, take a photo and add it to the work order.', 'Si encuentran una fuga, tomen una foto y agréguenla a la orden de trabajo.'],
  ['Any questions before we start?', '¿Alguna pregunta antes de empezar?'],
];

// Replies from the team: [Spanish heard, English translation]
const REPLIES = [
  ['¿A qué hora necesitan el 204 terminado?', 'What time do you need 204 finished?'],
  ['El boiler del edificio C tiene una fuga pequeña.', 'The water heater in building C has a small leak.'],
];

const RATE = 24000;

function synthVoice(text) {
  // ~60 ms per character, syllable-like blips with varying pitch.
  const seconds = Math.min(6, Math.max(1, text.length * 0.06));
  const n = Math.floor(seconds * RATE);
  const out = Buffer.alloc(n * 2);
  const syll = Math.floor(RATE * 0.16);
  for (let i = 0; i < n; i++) {
    const k = Math.floor(i / syll);
    const pos = (i % syll) / syll;
    const f = 170 + ((k * 37) % 90);
    const env = Math.sin(Math.PI * pos) * (pos < 0.85 ? 1 : 0.2);
    const s = Math.sin((2 * Math.PI * f * i) / RATE) * 0.6 + Math.sin((4 * Math.PI * f * i) / RATE) * 0.25;
    out.writeInt16LE(Math.round(s * env * 9000), i * 2);
  }
  return out;
}

export class MockEngine {
  constructor(hooks, direction = 'en-es') {
    this.hooks = hooks;
    const reply = direction === 'es-en';
    this.script = reply ? REPLIES : SCRIPT;
    [this.src, this.dst] = direction.split('-');
    this.prefix = reply ? 'r' : 'm';
    this.mode = 'auto';
    this.line = 0;
    this.word = 0;
    this.seq = 0;
    this.lastAudioAt = 0;
  }
  setMode(m) {
    this.mode = m;
  }
  start() {
    this.timer = setInterval(() => this.tick(), 280);
  }
  audio() {
    this.lastAudioAt = Date.now();
  }
  tick() {
    if (Date.now() - this.lastAudioAt > 500) return; // nobody is talking
    const [said] = this.script[this.line % this.script.length];
    const parts = said.split(' ');
    if (this.word >= parts.length) {
      if (this.mode !== 'manual') this.commit();
      return;
    }
    this.word++;
    this.hooks.caption({ lang: this.src, id: `${this.prefix}${this.seq}`, text: parts.slice(0, this.word).join(' '), final: false });
  }
  flush() {
    if (this.word > 0) this.commit();
  }
  commit() {
    const [said, translated] = this.script[this.line % this.script.length];
    const id = `${this.prefix}${this.seq++}`;
    const heard = said.split(' ').slice(0, this.word).join(' ');
    const full = this.word >= said.split(' ').length;
    this.line++;
    this.word = 0;
    this.hooks.caption({ lang: this.src, id, text: heard, final: true });
    const t = translated.split(' ');
    const target = full ? translated : `${t.slice(0, Math.ceil(t.length / 2)).join(' ')}…`;
    // Type the translation out like a streaming model, then "speak" it.
    const tokens = target.split(' ');
    tokens.forEach((_, i) =>
      setTimeout(() => {
        const final = i === tokens.length - 1;
        this.hooks.caption({ lang: this.dst, id, text: tokens.slice(0, i + 1).join(' '), final });
        if (final) {
          const pcm = synthVoice(target);
          for (let o = 0; o < pcm.length; o += 4800) this.hooks.audio(pcm.subarray(o, o + 4800));
        }
      }, 300 + i * 45)
    );
  }
  async stop() {
    clearInterval(this.timer);
  }
}
