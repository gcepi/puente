import { test } from 'node:test';
import assert from 'node:assert/strict';

// Exercise the real engine factory and request builders with local provider responses.
Object.assign(process.env, {
  OPENAI_API_KEY: 'test-only',
  ELEVENLABS_API_KEY: 'test-only',
  ELEVENLABS_VOICE_ID: 'base-fixture',
  ELEVENLABS_SPANISH_VOICE_ID: 'spanish-fixture',
  ELEVENLABS_REPLY_VOICE_ID: '',
  ANTHROPIC_API_KEY: 'test-only',
  TTS_PROVIDER: 'elevenlabs',
  TTS_SPEED: '1.08',
  ELEVENLABS_MODEL: 'eleven_flash_v2_5',
});
const { createEngine } = await import('../server/engines/index.js');
const { config } = await import('../server/config.js');

test('Spanish and English independently select their configured ElevenLabs voices', async (t) => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    requests.push({ url: new URL(url), body: JSON.parse(body) });
    return new Response(Buffer.alloc(2));
  });
  const spanish = config.elevenSpanishVoiceId;
  assert.equal(spanish, 'spanish-fixture');
  t.after(() => {
    config.elevenSpanishVoiceId = spanish;
    config.elevenReplyVoiceId = '';
  });
  for (const [spanishOverride, replyOverride] of [[spanish, ''], [spanish, 'reply-fixture'], ['', 'reply-fixture'], ['', '']]) {
    config.elevenSpanishVoiceId = spanishOverride;
    config.elevenReplyVoiceId = replyOverride;
    for (const engineName of ['turn', 'pipeline']) {
      for (const [direction, lang, expected] of [
        ['en-es', 'es', spanishOverride ? 'spanish-fixture' : 'base-fixture'],
        ['es-en', 'en', replyOverride || 'base-fixture'],
      ]) {
        const engine = createEngine(engineName, { error: assert.fail }, direction);
        await engine.deps.speak(lang === 'es' ? 'La llave del 204.' : 'The key to 204.', () => {});
        const { url, body } = requests.at(-1);
        assert.equal(url.pathname, `/v1/text-to-speech/${expected}/stream`);
        assert.equal(body.language_code, lang);
        assert.equal(body.model_id, 'eleven_flash_v2_5');
        assert.equal(body.voice_settings.speed, 1.08);
      }
    }
  }
  assert.equal(requests.length, 16);
});
