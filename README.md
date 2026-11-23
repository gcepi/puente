# Puente

Live English → Mexican Spanish translation for in-person meetings. The speaker talks. Everyone else scans a QR code and gets **captions and a natural voice** on their own phone, with earbuds. Crew members can **hold a button to reply in Spanish**, and the speaker hears English.

Works on iPhone and Android as a web page. No app, no accounts for listeners.

- **Why and how, holes, cost, timeline:** [docs/SCOPE.md](docs/SCOPE.md)
- **Go live in about an hour, no command line:** [docs/SETUP.md](docs/SETUP.md)

## Engines

| Engine | What | Keys |
|---|---|---|
| `mock` | Demo: scripted captions plus a tone "voice". Exercises everything with no keys. | none |
| `openai-translate` | OpenAI `gpt-realtime-translate`: simultaneous speech-to-speech | `OPENAI_API_KEY` |
| `pipeline` | Deepgram speech recognition → Claude (Haiku 5.5, glossary, Mexican Spanish) → ElevenLabs or OpenAI voice | `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, voice key |

The host picks the engine per meeting. Translation runs once on the server and fans out to every phone, so cost doesn't grow with listeners.

## Run locally

```bash
npm install
cp .env.example .env   # add keys, or leave ENGINE=mock
npm start              # http://localhost:3000/host
```

Phones need **https** to use the mic (for replies). Captions and voice work over plain http on your LAN.

## Tests

```bash
npm test           # phrase segmentation, ordering, failure handling (no network)
npm run test:e2e   # host + 3 phone listeners in Chromium with a fake mic; writes test/screenshots/
```

## Layout

```
server/index.js            HTTP + WebSocket server, room API, QR codes
server/room.js             a meeting: host, listeners, reply floor, transcript, fan-out
server/engines/            mock | openai-translate | pipeline (same interface)
server/providers/          Deepgram STT, Claude translation, ElevenLabs/OpenAI TTS
server/glossary.json       trade terms (EN → es-MX); edit freely
public/                    listener page (/ and /j/CODE), host page (/host), PWA bits
```

## Verify on first live run

Engine A's endpoint and event names (`session.update` → `audio.output.language`, `session.input_audio_buffer.append`, `session.output_audio.delta`, `session.output_transcript.delta`) come from OpenAI's cookbook and third-party docs. The official reference couldn't be fetched when this was built. Unknown events are logged once to the server log so a mismatch is quick to fix.
