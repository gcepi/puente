import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TurnEngine } from '../server/engines/turn.js';
import { createOpenAiTranscriber } from '../server/providers/openai.js';
import { buildSystemPrompt } from '../server/providers/translate-claude.js';
import { Revealer } from '../public/js/common.js';
import fs from 'node:fs';

const tone = (seconds, amp = 0.2) => {
  const b = Buffer.alloc(Math.floor(seconds * 24000) * 2);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * amp * 32767), i * 2);
  return b;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a stuck request never blocks the turns after it', async () => {
  const errors = [];
  const spoken = [];
  let n = 0;
  const engine = new TurnEngine(
    { caption: () => {}, cue: () => {}, audio: () => {}, error: (e) => errors.push(e) },
    {
      transcribe: async () => `turn ${++n}`,
      translate: async (t) => (t === 'turn 1' ? new Promise(() => {}) : `ES ${t}.`), // turn 1 hangs forever
      speak: async (t) => spoken.push(t),
    },
    { turnTimeoutMs: 60 }
  );
  engine.audio(tone(1));
  engine.flush();
  engine.audio(tone(1));
  engine.flush();
  await sleep(150);
  assert.match(errors[0], /took too long/);
  assert.deepEqual(spoken, ['ES turn 2.'], 'the second turn still went through');
});

// ---- transcription safety nets, with OpenAI's API mocked ----
function mockFetch(replies) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    const model = opts.body.get('model');
    calls.push({ model, prompt: opts.body.get('prompt'), signal: !!opts.signal });
    const r = replies[model].shift();
    if (r instanceof Error) throw r;
    if (typeof r === 'number') return new Response('server error', { status: r });
    return new Response(JSON.stringify({ text: r }), { status: 200 });
  };
  return calls;
}
const realFetch = globalThis.fetch;
const make = () => createOpenAiTranscriber({ apiKey: 'k', model: 'gpt-4o-mini-transcribe', names: ['Hessel', 'Dwell Communities'] });

test('transcript far too short for the speech is redone with whisper-1', async () => {
  const calls = mockFetch({
    'gpt-4o-mini-transcribe': ['and that is all for today, thank you'],
    'whisper-1': ['Good morning everyone. Hessel asked me to walk through the three make-ready units and the water heater in building C, and that is all for today, thank you'],
  });
  const text = await make()(tone(1), 'en', 14); // 14 s of speech but only 7 words back
  globalThis.fetch = realFetch;
  assert.match(text, /^Good morning everyone/);
  assert.deepEqual(calls.map((c) => c.model), ['gpt-4o-mini-transcribe', 'whisper-1']);
  assert.ok(calls.every((c) => c.signal), 'every request has a time limit');
});

test('a normal transcript is not redone', async () => {
  const calls = mockFetch({ 'gpt-4o-mini-transcribe': ['Please check unit 204 before lunch today.'], 'whisper-1': [] });
  await make()(tone(1), 'en', 3);
  globalThis.fetch = realFetch;
  assert.equal(calls.length, 1);
});

test('names are sent as spelling hints, and a hint echoed back on silence is dropped', async () => {
  const calls = mockFetch({ 'gpt-4o-mini-transcribe': ['Hessel, Dwell Communities.'], 'whisper-1': [''] });
  const text = await make()(tone(1), 'en', 0.3);
  globalThis.fetch = realFetch;
  assert.equal(text, '');
  assert.equal(calls[0].prompt, 'Hessel, Dwell Communities.');
});

test('a server error or dropped connection is retried once', async () => {
  const calls = mockFetch({ 'gpt-4o-mini-transcribe': [503, 'Hessel will join us at ten.'], 'whisper-1': [] });
  const text = await make()(tone(1), 'en', 2);
  globalThis.fetch = realFetch;
  assert.equal(text, 'Hessel will join us at ten.');
  assert.equal(calls.length, 2);
});

test('glossary names reach the translator with their usual mishearings', () => {
  const glossary = JSON.parse(fs.readFileSync(new URL('../server/glossary.json', import.meta.url)));
  const p = buildSystemPrompt(glossary, 'en-es');
  assert.match(p, /Hessel \(owner of Dwell Communities/);
  assert.match(p, /"Hustle"/);
  assert.match(buildSystemPrompt(glossary, 'es-en'), /Hessel/);
});

test('word reveal keeps sentences in order even when timing overlaps', async () => {
  const shown = new Map();
  const pane = { set: (id, text, final) => shown.set(id, { text, final }) };
  const r = new Revealer(pane, 0);
  r.add({ id: 'a', text: 'Primera frase larga.', seconds: 0.15 }, 0); // audio-synced
  r.add({ id: 'a', text: 'Segunda.', seconds: 0.03 }, 0); // overlapping start time
  r.add({ id: 'a', text: '', seconds: 0, last: true }, 0);
  await sleep(1100); // each sentence shows for at least 0.4 s
  assert.deepEqual(shown.get('a'), { text: 'Primera frase larga. Segunda.', final: true });
});

test("Graham's pattern: a long turn with pauses, then a short one, then another, all complete", async () => {
  const transcribed = [];
  const spoken = [];
  const engine = new TurnEngine(
    { caption: () => {}, cue: () => {}, audio: () => {}, error: (e) => assert.fail(e) },
    {
      transcribe: async (pcm, lang, voiced) => {
        const words = Math.round(voiced * 2.5); // about how much a person says
        transcribed.push(words);
        return Array.from({ length: words }, (_, i) => `w${i}`).join(' ');
      },
      translate: async (t) => `${t.split(' ').length} palabras.`,
      speak: async (t) => spoken.push(t),
    }
  );
  const say = (pattern) => {
    for (const [secs, amp] of pattern) {
      const b = tone(secs, amp);
      for (let o = 0; o < b.length; o += 1920) engine.audio(b.subarray(o, o + 1920));
    }
    engine.flush();
  };
  say([[4, 0.2], [0.9, 0.001], [5, 0.2], [0.9, 0.001], [3, 0.2]]); // 12 s of speech, two pauses
  say([[1.2, 0.2]]); // short
  say([[2.5, 0.2], [0.3, 0.001]]); // another
  await engine.chain;
  assert.equal(spoken.length, 3, 'every turn was spoken');
  assert.equal(transcribed.length, 5, 'the long turn went out in three parts while held');
  assert.equal(spoken[0], `${[10, 13, 8].reduce((a, b) => a + b)} palabras.`, 'all parts of the long turn were kept');
});

test('voice: a failed sentence is retried once, and its words still show if it fails twice', async () => {
  const cues = [];
  const errors = [];
  let calls = 0;
  const engine = new TurnEngine(
    { caption: () => {}, cue: (c) => cues.push(c), audio: () => {}, error: (e) => errors.push(e) },
    {
      transcribe: async () => 'hello there',
      translate: async () => 'Hola. Adiós.',
      speak: async (t, onAudio) => {
        calls++;
        if (t === 'Hola.' && calls === 1) throw new Error('blip'); // first try fails, retry works
        if (t === 'Adiós.') throw new Error('down');
        onAudio(Buffer.alloc(4800));
      },
    }
  );
  engine.audio(tone(1));
  engine.flush();
  await engine.chain;
  assert.deepEqual(cues.map((c) => [c.text, c.seconds > 0]), [['Hola.', true], ['Adiós.', false], ['', false]]);
  assert.equal(errors.length, 1);
});

test('transcription model refused: the turn falls back to whisper-1 instead of failing', async () => {
  const calls = mockFetch({ 'gpt-4o-mini-transcribe': [new Error('OpenAI transcription 404: model not found'), new Error('again')], 'whisper-1': ['Good morning team.'] });
  const t = createOpenAiTranscriber({ apiKey: 'k', model: 'gpt-4o-mini-transcribe', names: [] });
  const text = await t(tone(1), 'en', 1);
  globalThis.fetch = realFetch;
  assert.equal(text, 'Good morning team.');
  assert.equal(calls.at(-1).model, 'whisper-1');
});
