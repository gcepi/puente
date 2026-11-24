// The real push-to-talk path (providers, engine factory, turn engine) with the network simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.OPENAI_API_KEY = 'sk-test';
process.env.ELEVENLABS_API_KEY = 'el-test';
process.env.ELEVENLABS_VOICE_ID = 'pNInz6obpgDQGcFmaJgB';
process.env.TTS_SPEED = '1.15x';
const { createEngine, voiceName } = await import('../server/engines/index.js');

const tone = (s) => {
  const b = Buffer.alloc(Math.floor(s * 24000) * 2);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * 0.2 * 32767), i * 2);
  return b;
};
const sse = (text) =>
  new Response(text.split(' ').map((w, i) => `data: ${JSON.stringify({ choices: [{ delta: { content: (i ? ' ' : '') + w } }] })}\n\n`).join('') + 'data: [DONE]\n\n');

function network({ elevenStatus = 200 } = {}) {
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/audio/transcriptions')) {
      seen.push({ kind: 'stt', model: opts.body.get('model') });
      return new Response(JSON.stringify({ text: 'Good morning team. Hessel will visit unit 204 today.' }));
    }
    if (u.includes('/chat/completions')) {
      const body = JSON.parse(opts.body);
      seen.push({ kind: 'translate', model: body.model, system: body.messages[0].content });
      return sse('Buenos días, equipo. Hessel visitará el departamento 204 hoy.');
    }
    if (u.includes('elevenlabs.io')) {
      const body = JSON.parse(opts.body);
      seen.push({ kind: 'eleven', url: u, body, key: opts.headers['xi-api-key'] });
      if (elevenStatus !== 200) return new Response('{"detail":"voice_not_found"}', { status: elevenStatus });
      return new Response(Buffer.alloc(24000 * 2)); // 1 s of PCM
    }
    if (u.includes('/audio/speech')) {
      seen.push({ kind: 'openai-voice', body: JSON.parse(opts.body) });
      return new Response(Buffer.alloc(24000));
    }
    throw new Error(`unexpected request ${u}`);
  };
  return seen;
}

async function turn() {
  const out = { cues: [], audio: 0, errors: [], captions: [] };
  const engine = createEngine('turn', {
    caption: (c) => out.captions.push(c),
    cue: (c) => out.cues.push(c),
    audio: (b) => (out.audio += b.length),
    error: (e) => out.errors.push(e),
  });
  engine.audio(tone(2));
  engine.flush();
  await engine.chain;
  return out;
}

test('ElevenLabs is the voice when both keys are set', () => assert.equal(voiceName(), 'ElevenLabs'));

test('full turn: gpt-4o-transcribe -> gpt-4.1 (with names) -> ElevenLabs, per sentence', async () => {
  const seen = network();
  const out = await turn();
  assert.deepEqual(out.errors, []);
  assert.equal(seen.find((s) => s.kind === 'stt').model, 'gpt-4o-transcribe');
  const tr = seen.find((s) => s.kind === 'translate');
  assert.equal(tr.model, 'gpt-4.1');
  assert.match(tr.system, /Hessel/);
  const el = seen.filter((s) => s.kind === 'eleven');
  assert.equal(el.length, 2, 'one voice request per sentence');
  assert.match(el[0].url, /\/v1\/text-to-speech\/pNInz6obpgDQGcFmaJgB\/stream\?output_format=pcm_24000$/);
  assert.equal(el[0].key, 'el-test');
  assert.equal(el[0].body.model_id, 'eleven_flash_v2_5');
  assert.equal(el[0].body.language_code, 'es');
  assert.equal(el[0].body.voice_settings.speed, 1.15, "'1.15x' read as 1.15");
  assert.deepEqual(out.cues.map((c) => c.text), ['Buenos días, equipo.', 'Hessel visitará el departamento 204 hoy.', '']);
  assert.equal(out.audio, 2 * 48000, 'both sentences voiced');
  assert.ok(!seen.some((s) => s.kind === 'openai-voice'), 'OpenAI voice not used');
});

test('ElevenLabs refuses (bad voice ID, key, credits): OpenAI voice takes over and the host is told once', async () => {
  const seen = network({ elevenStatus: 404 });
  const out = await turn();
  assert.equal(seen.filter((s) => s.kind === 'openai-voice').length, 2, 'every sentence still voiced');
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /ElevenLabs voice failed .*used the OpenAI voice/);
  assert.ok(out.audio > 0);
});
