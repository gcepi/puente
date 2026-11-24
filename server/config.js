// All runtime settings come from environment variables. See .env.example.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function loadDotEnv() {
  const file = path.join(here, '..', '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
loadDotEnv();

const env = (k, d) => (process.env[k] ?? '').trim() || d;
const num = (k, d) => Number(env(k, d));

function loadGlossary() {
  const file = env('GLOSSARY_FILE', path.join(here, 'glossary.json'));
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { terms: [] };
  }
}

export const config = {
  port: num('PORT', 3000),
  publicUrl: env('PUBLIC_URL', ''), // e.g. https://puente.onrender.com — used for the QR code
  hostPasscode: env('HOST_PASSCODE', ''), // empty = anyone can start a session
  // Standing room code: every meeting uses this 3-digit code, so the crew always joins
  // the same way (and a printed QR code keeps working). Set ROOM_CODE=random for a
  // fresh random code per meeting.
  roomCode: /^\d{3}$/.test(env('ROOM_CODE', '750')) ? env('ROOM_CODE', '750') : '',
  // Which engine translates: turn | openai-translate | pipeline | mock
  engine: env('ENGINE', 'turn'),
  maxSessionMinutes: num('MAX_SESSION_MINUTES', 120),
  sampleRate: 24000, // PCM16 mono everywhere: mic in, voice out

  openaiKey: env('OPENAI_API_KEY', ''),
  openaiSttModel: env('OPENAI_STT_MODEL', 'gpt-4o-mini-transcribe'),
  openaiTranslateModel: env('OPENAI_TRANSLATE_MODEL', 'gpt-4.1-mini'),
  openaiTranslateUrl: env(
    'OPENAI_TRANSLATE_URL',
    'wss://api.openai.com/v1/realtime/translations?model=gpt-realtime-translate'
  ),

  deepgramKey: env('DEEPGRAM_API_KEY', ''),
  endpointingMs: num('ENDPOINTING_MS', 700), // pause length that ends a phrase in auto mode
  maxPhraseWords: num('MAX_PHRASE_WORDS', 35), // force a phrase break in long monologues

  anthropicKey: env('ANTHROPIC_API_KEY', ''),
  translateModel: env('TRANSLATE_MODEL', 'claude-haiku-5-5'),

  // TTS for the pipeline engine: elevenlabs | openai
  ttsProvider: env('TTS_PROVIDER', 'elevenlabs'),
  elevenKey: env('ELEVENLABS_API_KEY', ''),
  elevenVoiceId: env('ELEVENLABS_VOICE_ID', ''),
  elevenReplyVoiceId: env('ELEVENLABS_REPLY_VOICE_ID', ''), // English voice for replies; defaults to the Spanish one
  elevenModel: env('ELEVENLABS_MODEL', 'eleven_flash_v2_5'),
  ttsSpeed: num('TTS_SPEED', 1.08),
  // tts-1-hd keeps the same voice every time; gpt-4o-mini-tts is more expressive but can drift between requests.
  openaiTtsModel: env('OPENAI_TTS_MODEL', 'tts-1-hd'),
  openaiTtsVoice: env('OPENAI_TTS_VOICE', 'onyx'), // onyx: OpenAI's deepest male voice

  glossary: loadGlossary(),
};

export function engineProblems(name = config.engine) {
  const missing = [];
  if ((name === 'openai-translate' || name === 'turn') && !config.openaiKey) missing.push('OPENAI_API_KEY');
  if (name === 'pipeline') {
    if (!config.deepgramKey) missing.push('DEEPGRAM_API_KEY');
    if (!config.anthropicKey) missing.push('ANTHROPIC_API_KEY');
    if (config.ttsProvider === 'elevenlabs') {
      if (!config.elevenKey) missing.push('ELEVENLABS_API_KEY');
      if (!config.elevenVoiceId) missing.push('ELEVENLABS_VOICE_ID');
    } else if (!config.openaiKey) missing.push('OPENAI_API_KEY');
  }
  return missing;
}
