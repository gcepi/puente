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

const countWords = (t) => (t.match(/[\p{L}\p{N}']+/gu) ?? []).length;
const norm = (t) => t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

/**
 * Speech to text with safety nets:
 * - every request has a time limit and is retried once on a network or server error;
 * - names are given as spelling hints, and a transcript that is just the hint echoed back is dropped;
 * - if the transcript is far too short for the amount of speech (a known failure of the
 *   gpt-4o transcribe models on long audio with pauses), it is redone with whisper-1 and
 *   the longer transcript is kept.
 */
export function createOpenAiTranscriber({ apiKey, model, fallbackModel = 'whisper-1', names = [], log = () => {} }) {
  const hint = names.length ? `${names.join(', ')}.` : '';
  const hintWords = new Set(norm(hint).split(' ').filter(Boolean));
  const isEcho = (text) => {
    const words = norm(text).split(' ').filter(Boolean);
    return words.length > 1 && words.every((w) => hintWords.has(w));
  };

  async function once(pcm, language, m) {
    const form = new FormData();
    form.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'turn.wav');
    form.append('model', m);
    form.append('language', language);
    form.append('response_format', 'json');
    if (hint) form.append('prompt', hint);
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(25_000),
    });
    const json = await check(res, `OpenAI transcription (${m})`);
    const text = (json.text ?? '').trim();
    return isEcho(text) ? '' : text;
  }

  async function withRetry(pcm, language, m) {
    try {
      return await once(pcm, language, m);
    } catch (e) {
      if (/ 4\d\d:/.test(e.message) && !/ 429:/.test(e.message)) throw e; // bad request: retrying won't help
      return once(pcm, language, m);
    }
  }

  return async function transcribe(pcm, language, voicedSecs = 0) {
    let text;
    try {
      text = await withRetry(pcm, language, model);
    } catch (e) {
      // The main model refused or kept failing: use the fallback rather than lose the turn.
      if (!fallbackModel || fallbackModel === model) throw e;
      log(`${model} failed (${e.message}); using ${fallbackModel}`);
      return withRetry(pcm, language, fallbackModel);
    }
    const words = countWords(text);
    const tooShort = voicedSecs >= 0.8 && (words === 0 || (voicedSecs >= 2 && words < voicedSecs));
    if (tooShort && fallbackModel && fallbackModel !== model) {
      try {
        const alt = await withRetry(pcm, language, fallbackModel);
        log(`transcript check: ${voicedSecs.toFixed(1)}s of speech gave ${words} words; ${fallbackModel} gave ${countWords(alt)}`);
        if (countWords(alt) > words) text = alt;
      } catch (e) {
        log(`fallback transcription failed: ${e.message}`);
      }
    }
    return text;
  };
}

export function createOpenAiTranslator({ apiKey, model, fallbackModel, glossary, direction, log = () => {} }) {
  let useModel = model;
  const system = buildSystemPrompt(glossary, direction);
  return async function translate(text, context, onDelta) {
    const ctx = context.length
      ? `Earlier in this meeting (context only):\n${context.map((c) => `SAID: ${c.src}\nTRANSLATED: ${c.dst}`).join('\n')}\n\n`
      : '';
    const request = (m) =>
      fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({
          model: m,
          stream: true,
          temperature: 0.2,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: `${ctx}<speech>${text}</speech>` },
          ],
        }),
      });
    let res = await request(useModel);
    if (!res.ok && (res.status === 404 || res.status === 400 || res.status === 403) && fallbackModel && useModel !== fallbackModel) {
      log(`translation model ${useModel} refused (${res.status}); using ${fallbackModel}`);
      useModel = fallbackModel;
      res = await request(useModel);
    }
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
