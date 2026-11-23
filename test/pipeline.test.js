import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PipelineEngine } from '../server/engines/pipeline.js';
import { buildSystemPrompt } from '../server/providers/translate-claude.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function harness({ translateDelay = () => 0, speakMs = 0 } = {}) {
  const out = { captions: [], audio: [], errors: [], sttCalls: [] };
  let stt;
  const engine = new PipelineEngine(
    {
      caption: (c) => out.captions.push(c),
      audio: (b) => out.audio.push(b.toString()),
      error: (e) => out.errors.push(e),
    },
    {
      connectStt: (h) => {
        stt = h;
        return {
          sendAudio: () => out.sttCalls.push('audio'),
          finalize: () => out.sttCalls.push('finalize'),
          close: () => out.sttCalls.push('close'),
        };
      },
      translate: async (text, ctx, onDelta) => {
        await tick(translateDelay(text));
        onDelta('ES:');
        return `ES:${text}|ctx=${ctx.length}`;
      },
      speak: async (es, onAudio) => {
        await tick(speakMs);
        onAudio(Buffer.from(`voice(${es})`));
      },
    },
    { maxPhraseWords: 6, flushTimeoutMs: 30 }
  );
  engine.start();
  return { engine, out, stt: () => stt };
}

const finals = (out, lang) => out.captions.filter((c) => c.lang === lang && c.final).map((c) => c.text);

test('auto mode: a pause (speech_final) ends the phrase and it gets translated and spoken', async () => {
  const { out, stt } = harness();
  stt().onResult({ text: 'Good morning', isFinal: false, speechFinal: false });
  stt().onResult({ text: 'Good morning team.', isFinal: true, speechFinal: true });
  await tick(20);
  assert.deepEqual(finals(out, 'en'), ['Good morning team.']);
  assert.equal(finals(out, 'es')[0], 'ES:Good morning team.|ctx=0');
  assert.deepEqual(out.audio, ['voice(ES:Good morning team.|ctx=0)']);
});

test('manual mode ignores pauses until the host taps Translate now', async () => {
  const { engine, out, stt } = harness();
  engine.setMode('manual');
  stt().onResult({ text: 'Check unit 204.', isFinal: true, speechFinal: true });
  await tick(10);
  assert.equal(finals(out, 'en').length, 0);
  engine.flush();
  assert.ok(out.sttCalls.includes('finalize'));
  stt().onResult({ text: '', isFinal: true, speechFinal: false, fromFinalize: true });
  await tick(20);
  assert.deepEqual(finals(out, 'en'), ['Check unit 204.']);
});

test('flush falls back to the interim text if recognition never confirms', async () => {
  const { engine, out, stt } = harness();
  engine.setMode('manual');
  stt().onResult({ text: 'Fix the leak', isFinal: false, speechFinal: false });
  engine.flush();
  await tick(60);
  assert.deepEqual(finals(out, 'en'), ['Fix the leak']);
});

test('long monologues are broken up so the voice never falls far behind', async () => {
  const { engine, out, stt } = harness();
  engine.setMode('manual');
  stt().onResult({ text: 'one two three four five six,', isFinal: true, speechFinal: false });
  await tick(10);
  assert.deepEqual(finals(out, 'en'), ['one two three four five six,']);
});

test('voice plays in phrase order even when a later translation finishes first', async () => {
  const { out, stt } = harness({ translateDelay: (t) => (t.startsWith('slow') ? 40 : 1) });
  stt().onResult({ text: 'slow first.', isFinal: true, speechFinal: true });
  stt().onResult({ text: 'fast second.', isFinal: true, speechFinal: true });
  await tick(80);
  assert.deepEqual(out.audio, ['voice(ES:slow first.|ctx=0)', 'voice(ES:fast second.|ctx=0)']);
});

test('earlier phrases are passed as context', async () => {
  const { out, stt } = harness();
  stt().onResult({ text: 'First.', isFinal: true, speechFinal: true });
  await tick(10);
  stt().onResult({ text: 'Second.', isFinal: true, speechFinal: true });
  await tick(10);
  assert.equal(finals(out, 'es')[1], 'ES:Second.|ctx=1');
});

test('a translation failure shows the English instead of going silent', async () => {
  const { engine, out, stt } = harness();
  engine.deps.translate = async () => {
    throw new Error('boom');
  };
  stt().onResult({ text: 'Hello.', isFinal: true, speechFinal: true });
  await tick(10);
  assert.equal(finals(out, 'es')[0], '(sin traducción) Hello.');
  assert.equal(out.audio.length, 0);
  assert.match(out.errors[0], /boom/);
});

test('system prompt carries the glossary and Mexican Spanish rules', () => {
  const p = buildSystemPrompt({ terms: [{ en: 'make-ready', es: 'preparación de unidad' }] });
  assert.match(p, /Mexican Spanish/);
  assert.match(p, /"make-ready" → "preparación de unidad"/);
  assert.match(p, /do not answer it/);
});
