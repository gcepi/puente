import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnEngine, SentenceSplitter, voicedSeconds } from '../server/engines/turn.js';
import { pcmToWav } from '../server/providers/openai.js';

const tone = (seconds, amp = 0.2) => {
  const n = Math.floor(seconds * 24000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * amp * 32767), i * 2);
  return b;
};

// The fake translator streams its answer in small pieces, like the real one.
function harness({ translation = (t) => `Hola. ${t}. Adiós.`, speakMs = 0 } = {}) {
  const out = { captions: [], cues: [], events: [], errors: [], calls: [] };
  const engine = new TurnEngine(
    {
      caption: (c) => out.captions.push(c),
      cue: (c) => (out.cues.push(c), out.events.push(`cue:${c.text}`)),
      audio: (b) => out.events.push(`audio:${b.length}`),
      error: (e) => out.errors.push(e),
    },
    {
      transcribe: async (pcm, lang) => (out.calls.push(`stt:${lang}`), `said ${out.calls.length}`),
      translate: async (t, ctx, onDelta) => {
        out.calls.push(`mt:ctx=${ctx.length}`);
        const full = translation(t);
        for (let i = 0; i < full.length; i += 4) onDelta(full.slice(i, i + 4));
        return full;
      },
      speak: async (t, onAudio) => {
        await new Promise((r) => setTimeout(r, speakMs));
        out.calls.push(`tts:${t}`);
        onAudio(Buffer.alloc(48000)); // 1 second of audio
      },
    }
  );
  return { engine, out };
}

test('nothing happens while held; on release: transcript, then each sentence voiced in order', async () => {
  const { engine, out } = harness();
  engine.audio(tone(1));
  assert.equal(out.calls.length, 0, 'no work while the button is held');
  engine.flush();
  await engine.chain;
  assert.deepEqual(out.captions.filter((c) => c.final).map((c) => c.text), ['said 1']);
  assert.deepEqual(out.cues.map((c) => c.text), ['Hola.', 'said 1.', 'Adiós.', '']);
  assert.ok(out.cues.at(-1).last, 'an end marker closes the line');
  assert.ok(out.cues.slice(0, 3).every((c) => c.seconds === 1), 'each cue carries its audio length');
  // Every sentence's text is sent just before its own audio.
  assert.deepEqual(out.events.slice(0, 4), ['cue:Hola.', 'audio:9600', 'audio:9600', 'audio:9600']);
});

test('the first sentence is voiced before the translation has finished', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const spoken = [];
  const engine = new TurnEngine(
    { caption: () => {}, cue: () => {}, audio: () => {}, error: () => {} },
    {
      transcribe: async () => 'hi',
      translate: async (t, ctx, onDelta) => {
        onDelta('Primera frase. Segunda');
        await gate; // the model is still writing
        onDelta(' frase.');
        return 'Primera frase. Segunda frase.';
      },
      speak: async (t) => spoken.push(t),
    }
  );
  engine.audio(tone(1));
  engine.flush();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(spoken, ['Primera frase.']);
  release();
  await engine.chain;
  assert.deepEqual(spoken, ['Primera frase.', 'Segunda frase.']);
});

test('accidental taps and silence are never sent to transcription, and the host is told', async () => {
  const { engine, out } = harness();
  engine.audio(tone(0.2));
  engine.flush();
  engine.audio(tone(1.5, 0.001)); // room noise
  engine.flush();
  await engine.chain;
  assert.equal(out.calls.length, 0);
  assert.equal(out.errors.length, 2);
  assert.match(out.errors[0], /Didn't catch any speech/);
  assert.ok(out.captions.every((c) => c.text === '' && c.final), 'clears any live text');
});

test('turns stay in order and carry context', async () => {
  const { engine, out } = harness({ speakMs: 10 });
  engine.audio(tone(1));
  engine.flush();
  engine.audio(tone(1));
  engine.flush();
  await engine.chain;
  assert.deepEqual(out.calls.filter((c) => c.startsWith('mt')), ['mt:ctx=0', 'mt:ctx=1']);
  const ends = out.cues.map((c, i) => (c.last ? i : -1)).filter((i) => i >= 0);
  assert.equal(ends.length, 2);
  assert.ok(out.cues.slice(0, ends[0]).every((c) => c.id === 't0'));
});

test('peekId names the line the next turn will use', () => {
  const { engine } = harness();
  assert.equal(engine.peekId(), 't0');
});

test('sentence splitter: waits for the next sentence, never splits decimals, flushes the rest', () => {
  const got = [];
  const s = new SentenceSplitter((x) => got.push(x));
  for (const piece of ['Son 3.5 hor', 'as. ¿Lis', 'tos? Va', 'mos']) s.push(piece);
  assert.deepEqual(got, ['Son 3.5 horas.', '¿Listos?']);
  s.end('ignored because text was streamed');
  assert.deepEqual(got, ['Son 3.5 horas.', '¿Listos?', 'Vamos']);
  const whole = [];
  const t = new SentenceSplitter((x) => whole.push(x));
  t.end('Sin streaming.');
  assert.deepEqual(whole, ['Sin streaming.']);
});

test('replies run Spanish to English', async () => {
  const langs = [];
  const engine = new TurnEngine(
    { caption: () => {}, cue: () => {}, audio: () => {}, error: () => {} },
    { transcribe: async (p, lang) => (langs.push(lang), 'hola'), translate: async () => 'hello', speak: async () => {} },
    { src: 'es', dst: 'en' }
  );
  engine.audio(tone(1));
  engine.flush();
  await engine.chain;
  assert.deepEqual(langs, ['es']);
});

test('speech check counts voiced time, not a single click', () => {
  assert.ok(voicedSeconds(tone(1, 0.2)) > 0.9);
  assert.equal(voicedSeconds(tone(1, 0.001)), 0);
  assert.ok(voicedSeconds(Buffer.concat([tone(0.06, 0.5), tone(1.5, 0.001)])) < 0.3);
});

test('WAV header is valid for 24 kHz mono PCM16', () => {
  const wav = pcmToWav(Buffer.alloc(4800));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.length, 44 + 4800);
});
