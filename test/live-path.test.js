// The real push-to-talk path (providers, engine factory, turn engine) with the network simulated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

process.env.OPENAI_API_KEY = 'sk-test';
process.env.ELEVENLABS_API_KEY = 'el-test';
process.env.ELEVENLABS_VOICE_ID = 'pNInz6obpgDQGcFmaJgB';
process.env.ELEVENLABS_SPANISH_VOICE_ID = '';
process.env.TTS_SPEED = ''; // Exercise the default even if the developer has a local .env.
const { createEngine, voiceName } = await import('../server/engines/index.js');

const tone = (s) => {
  const b = Buffer.alloc(Math.floor(s * 24000) * 2);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(Math.sin(i / 8) * 0.2 * 32767), i * 2);
  return b;
};
const sse = (text) =>
  new Response(text.split(' ').map((w, i) => `data: ${JSON.stringify({ choices: [{ delta: { content: (i ? ' ' : '') + w } }] })}\n\n`).join('') + 'data: [DONE]\n\n');

function network({ elevenStatus = 200, transcripts = [] } = {}) {
  const seen = [];
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/audio/transcriptions')) {
      seen.push({ kind: 'stt', model: opts.body.get('model'), prompt: opts.body.get('prompt') });
      return Response.json({ text: transcripts.shift() ?? 'Good morning team. Hessel will visit unit 204 today.' });
    }
    if (u.includes('/chat/completions')) {
      const body = JSON.parse(opts.body);
      seen.push({ kind: 'translate', model: body.model, system: body.messages[0].content, input: body.messages[1].content });
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

const echoedHints = 'context: ### Hessel, Dwell Communities, Clairmont, Ilion, Westside, 750. ###';

test('wrapped hints appended to speech are rechecked without a prompt before translation', async () => {
  const spoken = 'Please check unit 204.';
  const seen = network({ transcripts: [spoken + '\n' + echoedHints, spoken] });
  const out = await turn();
  assert.deepEqual(out.errors, []);
  assert.deepEqual(out.captions.filter((c) => c.final).map((c) => c.text), [spoken]);
  const [primary, second] = seen.filter((s) => s.kind === 'stt');
  assert.match(primary.prompt, /Clairmont/);
  assert.equal(second.prompt, null);
  assert.equal(seen.find((s) => s.kind === 'translate').input, `<speech>${spoken}</speech>`);
});

test('a repeated wrapped glossary is never captioned, translated or voiced', async () => {
  const seen = network({ transcripts: [echoedHints, echoedHints] });
  const out = await turn();
  assert.match(out.errors[0], /repeat that turn/);
  assert.ok(out.captions.every((c) => !c.text.includes('Clairmont')));
  assert.deepEqual(seen.map((s) => s.kind), ['stt', 'stt']);
  assert.equal(out.audio, 0);
});

test('a company name spoken on its own survives the glossary check', async () => {
  const seen = network({ transcripts: ['Dwell Communities.'] });
  const out = await turn();
  assert.deepEqual(out.errors, []);
  assert.equal(seen.filter((s) => s.kind === 'stt').length, 1);
  assert.equal(out.captions.find((c) => c.final).text, 'Dwell Communities.');
});

test('explicit pace overrides work and an unreadable pace uses the default', () => {
  const configUrl = new URL('../server/config.js', import.meta.url);
  for (const [value, expected] of [['1.0', '1'], ['1.08', '1.08'], ['1.15x', '1.15'], ['unreadable', '1.15']]) {
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      `import { config } from ${JSON.stringify(configUrl.href)}; console.log(config.ttsSpeed);`,
    ], { env: { ...process.env, TTS_SPEED: value }, encoding: 'utf8' });
    assert.equal(output.trim(), expected);
  }
});

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
  assert.ok(el.every((s) => s.body.voice_settings.speed === 1.15), 'both sentences keep the default pace');
  assert.deepEqual(out.cues.map((c) => c.text), ['Buenos días, equipo.', 'Hessel visitará el departamento 204 hoy.', '']);
  assert.equal(out.audio, 2 * 48000, 'both sentences voiced');
  assert.ok(!seen.some((s) => s.kind === 'openai-voice'), 'OpenAI voice not used');
});

test('ElevenLabs refuses (bad voice ID, key, credits): OpenAI voice takes over and the host is told once', async () => {
  const seen = network({ elevenStatus: 404 });
  const out = await turn();
  const backup = seen.filter((s) => s.kind === 'openai-voice');
  assert.equal(backup.length, 2, 'every sentence still voiced');
  assert.ok(backup.every((s) => s.body.speed === 1.15), 'the backup keeps the same default pace');
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0], /ElevenLabs voice failed .*used the OpenAI voice/);
  assert.ok(out.audio > 0);
});
