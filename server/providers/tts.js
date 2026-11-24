// Text-to-speech. Every provider streams raw PCM16, 24 kHz, mono, so the
// listener's player has one format to handle.

async function streamPcm(res, onAudio, label) {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${label} TTS ${res.status}: ${body.slice(0, 200)}`);
  }
  let carry = null; // PCM16 needs even-length chunks
  for await (const chunk of res.body) {
    let buf = Buffer.from(chunk);
    if (carry) {
      buf = Buffer.concat([carry, buf]);
      carry = null;
    }
    if (buf.length % 2) {
      carry = buf.subarray(buf.length - 1);
      buf = buf.subarray(0, buf.length - 1);
    }
    if (buf.length) onAudio(buf);
  }
}

export function createElevenLabsTts({ apiKey, voiceId, model, speed, language = 'es' }) {
  return async function speak(text, onAudio) {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: model,
        language_code: language,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, speed },
      }),
    });
    await streamPcm(res, onAudio, 'ElevenLabs');
  };
}

const OPENAI_STYLE = {
  es: 'Speak warm, clear Mexican Spanish with a natural Mexican accent, like a friendly bilingual supervisor briefing a maintenance crew. Brisk but unhurried pace.',
  en: 'Speak clear, natural American English at a brisk, friendly pace.',
};

export function createOpenAiTts({ apiKey, model, voice, language = 'es' }) {
  return async function speak(text, onAudio) {
    const res = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        voice,
        input: text,
        response_format: 'pcm',
        // Only the gpt-* speech models take style instructions.
        ...(model.startsWith('gpt-') ? { instructions: OPENAI_STYLE[language] ?? OPENAI_STYLE.es } : {}),
      }),
    });
    await streamPcm(res, onAudio, 'OpenAI');
  };
}
