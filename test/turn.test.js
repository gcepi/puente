import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnEngine, voicedSeconds } from '../server/engines/turn.js';
import { pcmToWav } from '../server/providers/openai.js';

const tone = (seconds, amp = 0.2) => {
  const n = Math.floor(seconds * 24000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * amp * 32767), i * 2);
  return b;
};

function harness(over = {}) {
  const out = { captions: [], audio: [], errors: [], calls: [] };
  const engine = new TurnEngine(
    { caption: (c) => out.captions.push(c), audio: (b) => out.audio.push(b.toString()), error: (e) => out.errors.push(e) },
    {
      transcribe: async (pcm, lang) => (out.calls.push(`stt:${lang}`), over.text ?? `said ${out.calls.length}`),
      translate: async (t, ctx, onDelta) => (out.calls.push('mt'), onDelta?.('…'), `ES(${t})|ctx=${ctx.length}`),
      speak: async (t, onAudio) => {
        await new Promise((r) => setTimeout(r, over.speakMs ?? 0));
        out.calls.push('tts');
        onAudio(Buffer.from(`voice:${t}`));
      },
    }
  );
  return { engine, out };
}
const finals = (out, lang) => out.captions.filter((c) => c.lang === lang && c.final).map((c) => c.text);

test('nothing is translated until release; then transcribe -> translate -> speak', async () => {
  const { engine, out } = harness();
  engine.audio(tone(1));
  assert.equal(out.calls.length, 0, 'no work while the button is held');
  engine.flush();
  await engine.chain;
  assert.deepEqual(out.calls, ['stt:en', 'mt', 'tts']);
  assert.deepEqual(finals(out, 'en'), ['said 1']);
  assert.deepEqual(finals(out, 'es'), ['ES(said 1)|ctx=0']);
  assert.deepEqual(out.audio, ['voice:ES(said 1)|ctx=0']);
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
});

test('speech check counts voiced time, not just loudness of a click', () => {
  assert.ok(voicedSeconds(tone(1, 0.2)) > 0.9);
  assert.equal(voicedSeconds(tone(1, 0.001)), 0);
  const click = Buffer.concat([tone(0.06, 0.5), tone(1.5, 0.001)]); // a bump, then silence
  assert.ok(voicedSeconds(click) < 0.3);
});

test('turns are spoken strictly in order and carry context', async () => {
  const { engine, out } = harness({ speakMs: 30 });
  engine.audio(tone(1));
  engine.flush();
  engine.audio(tone(1));
  engine.flush();
  await engine.chain;
  assert.equal(out.audio.length, 2);
  assert.match(out.audio[0], /said 1/);
  assert.match(out.audio[1], /ctx=1/);
});

test('replies run Spanish to English', async () => {
  const out = [];
  const engine = new TurnEngine(
    { caption: () => {}, audio: () => {}, error: () => {} },
    { transcribe: async (p, lang) => (out.push(lang), 'hola'), translate: async () => 'hello', speak: async () => {} },
    { src: 'es', dst: 'en' }
  );
  engine.audio(tone(1));
  engine.flush();
  await engine.chain;
  assert.deepEqual(out, ['es']);
});

test('WAV header is valid for 24 kHz mono PCM16', () => {
  const wav = pcmToWav(Buffer.alloc(4800));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(40), 4800);
  assert.equal(wav.length, 44 + 4800);
});
