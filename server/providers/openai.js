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
 * - suspicious echoes of the name hints are checked against the same audio without hints;
 * - if the transcript is far too short for the amount of speech (a known failure of the
 *   gpt-4o transcribe models on long audio with pauses), it is redone with whisper-1 and
 *   the longer transcript is kept.
 */
export function createOpenAiTranscriber({ apiKey, model, fallbackModel = 'whisper-1', names = [], log = () => {} }) {
  const hint = names.length ? `${names.join(', ')}.` : '';
  const nameList = norm(hint);
  const wholeNames = new Set(names.map(norm));
  const hintWords = new Set(nameList.split(' ').filter(Boolean));
  const isEcho = (text) => {
    if (!nameList) return false;
    // The model sometimes prints this wrapper around all or part of its spelling prompt.
    if (/\bcontext(?:o)?\s*:\s*#{2,}/iu.test(text)) return true;
    const normalized = norm(text);
    if (wholeNames.has(normalized)) return false; // Someone can answer with a single property or company.
    if (wholeNames.size > 1 && ` ${normalized} `.includes(` ${nameList} `)) return true;
    const words = norm(text.replace(/^\s*(?:context|contexto)\s*:/i, '')).split(' ').filter(Boolean);
    return words.length > 1 && words.every((w) => hintWords.has(w));
  };

  async function once(pcm, language, m, prompt) {
    const form = new FormData();
    form.append('file', new Blob([pcmToWav(pcm)], { type: 'audio/wav' }), 'turn.wav');
    form.append('model', m);
    form.append('language', language);
    form.append('response_format', 'json');
    if (prompt) form.append('prompt', prompt);
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(25_000),
    });
    const json = await check(res, `OpenAI transcription (${m})`);
    return (json.text ?? '').trim();
  }

  async function withRetry(pcm, language, m, prompt) {
    try {
      return await once(pcm, language, m, prompt);
    } catch (e) {
      if (/ 4\d\d:/.test(e.message) && !/ 429:/.test(e.message)) throw e; // bad request: retrying won't help
      return once(pcm, language, m, prompt);
    }
  }

  return async function transcribe(pcm, language, voicedSecs = 0) {
    // All second opinions use the audio alone, so the same hint cannot bias both attempts.
    const recheck = () => withRetry(pcm, language, fallbackModel || model, '');
    const repeat = 'Could not confirm what was said. Please repeat that turn. / Por favor, repite lo que dijiste.';
    let text;
    try {
      text = await withRetry(pcm, language, model, hint);
    } catch (e) {
      // The main model refused or kept failing: use the fallback rather than lose the turn.
      if (!fallbackModel || fallbackModel === model) throw e;
      log(`${model} failed (${e.message}); using ${fallbackModel}`);
      const alt = await recheck();
      if (isEcho(alt)) throw new Error(repeat);
      return alt;
    }
    if (isEcho(text)) {
      const alt = await recheck().catch(() => '');
      if (!alt || isEcho(alt)) throw new Error(repeat);
      return alt;
    }
    const words = countWords(text);
    const tooShort = voicedSecs >= 0.8 && (words === 0 || (voicedSecs >= 2 && words < voicedSecs));
    if (tooShort && fallbackModel && fallbackModel !== model) {
      try {
        const alt = await recheck();
        log(`transcript check: ${voicedSecs.toFixed(1)}s of speech gave ${words} words; ${fallbackModel} gave ${countWords(alt)}`);
        if (!isEcho(alt) && countWords(alt) > words) text = alt;
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
    let done = false;
    const readLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (!data) return;
      if (data === '[DONE]') {
        done = true;
        return;
      }
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        throw new Error('Translation service sent an unreadable response. Please repeat the turn.');
      }
      if (event?.error || event?.type === 'error') {
        throw new Error('Translation service reported an error. Please repeat the turn.');
      }
      const choice = event?.choices?.[0];
      if (choice?.delta?.refusal || (choice?.finish_reason && choice.finish_reason !== 'stop')) {
        throw new Error('The translation stopped before it was complete. Please repeat the turn.');
      }
      if (choice?.delta?.content) {
        out += choice.delta.content;
        onDelta?.(choice.delta.content);
      }
    };
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        readLine(line);
        if (done) break;
      }
      if (done) break;
    }
    if (!done) readLine(pending + decoder.decode());
    if (!done) throw new Error('The translation connection closed early. Please repeat the turn.');
    if (!out.trim()) throw new Error('No translation came back. Please repeat the turn.');
    return out.trim();
  };
}
