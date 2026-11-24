// OpenAI speech-to-text and text translation, for the push-to-talk engine.
// One OpenAI key covers the whole turn: transcribe -> translate -> speak.
import { buildSystemPrompt } from './translate-claude.js';

const RATE = 24000;

/** Wrap raw PCM16 / 24 kHz / mono in a WAV header so the transcription API accepts it. */
export function pcmToWav(pcm, sampleRate = RATE) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function check(res, label) {
  if (res.ok) return res.json();
  const body = await res.text().catch(() => '');
  throw new Error(`${label} ${res.status}: ${body.slice(0, 200)}`);
}

export function createOpenAiTranscriber({ apiKey, model }) {
  return async function transcribe(pcm, language) {
    const form = new FormData();
    form.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'turn.wav');
    form.append('model', model);
    form.append('language', language);
    form.append('response_format', 'json');
    // No 'prompt' hint: on near-silent audio the model echoes the hint back as if it were speech.
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    });
    const json = await check(res, 'OpenAI transcription');
    return (json.text ?? '').trim();
  };
}

export function createOpenAiTranslator({ apiKey, model, glossary, direction }) {
  const system = buildSystemPrompt(glossary, direction);
  return async function translate(text, context, onDelta) {
    const ctx = context.length
      ? `Earlier in this meeting (context only):\n${context.map((c) => `SAID: ${c.src}\nTRANSLATED: ${c.dst}`).join('\n')}\n\n`
      : '';
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `${ctx}<speech>${text}</speech>` },
        ],
      }),
    });
    if (!res.ok) await check(res, 'OpenAI translation');
    // Server-sent events: lines of "data: {json}", ending with "data: [DONE]".
    let out = '';
    let pending = '';
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        const data = line.trim().replace(/^data:\s*/, '');
        if (!data || data === '[DONE]' || !line.trim().startsWith('data:')) continue;
        try {
          const delta = JSON.parse(data).choices?.[0]?.delta?.content;
          if (delta) {
            out += delta;
            onDelta?.(delta);
          }
        } catch {}
      }
    }
    return out.trim();
  };
}
