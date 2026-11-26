import { config } from '../config.js';
import { MockEngine } from './mock.js';
import { OpenAiTranslateEngine } from './openai-translate.js';
import { PipelineEngine } from './pipeline.js';
import { TurnEngine } from './turn.js';
import { createOpenAiTranscriber, createOpenAiTranslator } from '../providers/openai.js';
import { createDeepgramStt } from '../providers/deepgram.js';
import { createClaudeTranslator } from '../providers/translate-claude.js';
import { createElevenLabsTts, createOpenAiTts } from '../providers/tts.js';

export const ENGINES = ['turn', 'openai-translate', 'pipeline', 'mock'];

export const voiceName = () => (config.elevenKey && config.elevenVoiceId ? 'ElevenLabs' : 'OpenAI');

function elevenVoiceFor(dst) {
  const override = dst === 'es' ? config.elevenSpanishVoiceId : config.elevenReplyVoiceId;
  return createElevenLabsTts({
    apiKey: config.elevenKey,
    voiceId: override || config.elevenVoiceId,
    model: config.elevenModel,
    speed: config.ttsSpeed,
    language: dst,
  });
}

/**
 * The voice for the push-to-talk engine: ElevenLabs when its keys are set, with the
 * OpenAI voice as an automatic backup so a refused request never means silence.
 */
function voiceFor(dst, hooks) {
  const openai = createOpenAiTts({ apiKey: config.openaiKey, model: config.openaiTtsModel, voice: config.openaiTtsVoice, language: dst, speed: config.ttsSpeed });
  if (voiceName() !== 'ElevenLabs') return openai;
  const eleven = elevenVoiceFor(dst);
  return withBackupVoice(eleven, openai, (e) => hooks.error(`ElevenLabs voice failed (${e.message.slice(0, 120)}); used the OpenAI voice.`));
}

export function withBackupVoice(primary, backup, onFallback) {
  let warned = false;
  return async function speak(text, onAudio) {
    const chunks = [];
    try {
      await primary(text, (b) => chunks.push(b));
    } catch (e) {
      if (!warned) {
        warned = true; // say it once per turn engine, not once per sentence
        onFallback(e);
      }
      return backup(text, onAudio);
    }
    for (const c of chunks) onAudio(c);
  };
}

/**
 * @param {string} name engine name
 * @param {{caption:Function, audio:Function, error:Function}} hooks
 * @param {'en-es'|'es-en'} direction en-es = the briefing; es-en = a reply from the team
 */
export function createEngine(name, hooks, direction = 'en-es', { oneOnOne = false } = {}) {
  const [src, dst] = direction.split('-');
  if (name === 'turn') {
    // One OpenAI key does it all; Claude translates instead if an Anthropic key is set.
    const translate = config.anthropicKey
      ? createClaudeTranslator({ apiKey: config.anthropicKey, model: config.translateModel, glossary: config.glossary, direction, oneOnOne })
      : createOpenAiTranslator({
          apiKey: config.openaiKey,
          model: config.openaiTranslateModel,
          fallbackModel: config.openaiTranslateFallback,
          glossary: config.glossary,
          direction,
          oneOnOne,
          log: (m) => console.log(`[translate] ${m}`),
        });
    return new TurnEngine(
      hooks,
      {
        transcribe: createOpenAiTranscriber({
          apiKey: config.openaiKey,
          model: config.openaiSttModel,
          fallbackModel: 'whisper-1',
          names: (config.glossary.names ?? []).map((n) => n.name),
          log: (m) => console.log(`[transcribe] ${m}`),
        }),
        translate,
        speak: voiceFor(dst, hooks),
      },
      { src, dst, speed: config.ttsSpeed }
    );
  }
  if (name === 'openai-translate') {
    return new OpenAiTranslateEngine(hooks, {
      apiKey: config.openaiKey,
      url: config.openaiTranslateUrl,
      sourceLanguage: src,
      targetLanguage: dst,
    });
  }
  if (name === 'pipeline') {
    const speak =
      config.ttsProvider === 'openai'
        ? createOpenAiTts({ apiKey: config.openaiKey, model: config.openaiTtsModel, voice: config.openaiTtsVoice, language: dst })
        : elevenVoiceFor(dst);
    return new PipelineEngine(
      hooks,
      {
        connectStt: createDeepgramStt({
          apiKey: config.deepgramKey,
          sampleRate: config.sampleRate,
          endpointingMs: config.endpointingMs,
          language: src === 'en' ? 'en-US' : 'es-419',
          keyterms: config.glossary.terms.map((t) => (src === 'en' ? t.en : t.es)),
        }),
        translate: createClaudeTranslator({
          apiKey: config.anthropicKey,
          model: config.translateModel,
          glossary: config.glossary,
          direction,
        }),
        speak,
      },
      { maxPhraseWords: config.maxPhraseWords, src, dst }
    );
  }
  return new MockEngine(hooks, direction);
}
