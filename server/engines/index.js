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

/**
 * @param {string} name engine name
 * @param {{caption:Function, audio:Function, error:Function}} hooks
 * @param {'en-es'|'es-en'} direction en-es = the briefing; es-en = a reply from the team
 */
export function createEngine(name, hooks, direction = 'en-es') {
  const [src, dst] = direction.split('-');
  if (name === 'turn') {
    // One OpenAI key does it all; Claude translates instead if an Anthropic key is set.
    const translate = config.anthropicKey
      ? createClaudeTranslator({ apiKey: config.anthropicKey, model: config.translateModel, glossary: config.glossary, direction })
      : createOpenAiTranslator({ apiKey: config.openaiKey, model: config.openaiTranslateModel, glossary: config.glossary, direction });
    return new TurnEngine(
      hooks,
      {
        transcribe: createOpenAiTranscriber({ apiKey: config.openaiKey, model: config.openaiSttModel, glossary: config.glossary }),
        translate,
        // ElevenLabs gives the most natural, consistent voice when its keys are set.
        speak:
          config.elevenKey && config.elevenVoiceId
            ? createElevenLabsTts({
                apiKey: config.elevenKey,
                voiceId: dst === 'es' ? config.elevenVoiceId : config.elevenReplyVoiceId || config.elevenVoiceId,
                model: config.elevenModel,
                speed: config.ttsSpeed,
                language: dst,
              })
            : createOpenAiTts({ apiKey: config.openaiKey, model: config.openaiTtsModel, voice: config.openaiTtsVoice, language: dst, speed: config.ttsSpeed }),
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
        : createElevenLabsTts({
            apiKey: config.elevenKey,
            voiceId: dst === 'es' ? config.elevenVoiceId : config.elevenReplyVoiceId || config.elevenVoiceId,
            model: config.elevenModel,
            speed: config.ttsSpeed,
            language: dst,
          });
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
