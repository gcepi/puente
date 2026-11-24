// Loaded only into the browser test's server process. Every provider request stays local.
import assert from 'node:assert/strict';

const english = 'Please check the sink in unit 204.';
const spanish = '¿A qué hora llega el plomero?';
const translations = new Map([
  [english, { language: 'es', text: 'Por favor, revisa el lavabo del departamento 204.' }],
  [spanish, { language: 'en', text: 'What time does the plumber arrive?' }],
]);

// A short, non-silent sound lets the browser test distinguish the translated audio
// from the silent buffer the page uses to unlock the phone's speaker.
const pcm = Buffer.alloc(24000);
for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 440 * i / 24000)), 2 * i);

globalThis.fetch = async (url, request) => {
  const { hostname, pathname } = new URL(url);
  if (hostname === 'api.openai.com' && pathname === '/v1/audio/transcriptions') {
    const source = request.body.get('language');
    assert.ok(source === 'en' || source === 'es');
    assert.ok(request.body.get('file').size > 44, 'recorded audio must reach the transcriber');
    return Response.json({ text: source === 'en' ? english : spanish });
  }
  if (hostname === 'api.openai.com' && pathname === '/v1/chat/completions') {
    const { messages } = JSON.parse(request.body);
    const source = messages.at(-1).content.match(/<speech>(.*?)<\/speech>$/s)?.[1];
    const translation = translations.get(source);
    assert.ok(translation, 'the complete recognized text must reach translation');
    const event = { choices: [{ delta: { content: translation.text }, finish_reason: 'stop' }] };
    return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`);
  }
  if (hostname === 'api.elevenlabs.io') {
    const body = JSON.parse(request.body);
    const translation = [...translations.values()].find((value) => value.text === body.text);
    assert.equal(body.language_code, translation?.language, 'voice language must match translated text');
    assert.equal(pathname, `/v1/text-to-speech/solo-test-${translation.language}/stream`);
    return new Response(pcm);
  }
  throw new Error(`Unexpected external request in solo test: ${hostname}${pathname}`);
};
