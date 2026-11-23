# Go live in about an hour (no command line)

You'll do five things in a browser. Paste keys only into Render's dashboard, never into chat or a file.

## 1. Repo (1 min)

On GitHub, create a new **private** repository named `puente` under `gcepi`. Leave it **empty**: no README, no license. Tell Claude it exists, and Claude will push the code.

## 2. API keys (20–30 min)

Start with OpenAI. It alone runs Engine A and the OpenAI voice.

| Service | Where | Notes |
|---|---|---|
| **OpenAI** (required) | platform.openai.com → Settings → Billing (add ~$10) → API keys → Create | Powers Engine A and the OpenAI voice |
| Deepgram (Engine B) | console.deepgram.com → sign up → API Keys | New accounts usually get free credit |
| Anthropic (Engine B) | console.anthropic.com → Billing (add ~$5) → API Keys | Claude does the translation |
| ElevenLabs (optional) | elevenlabs.io → Voices → Voice Library, filter Spanish / Mexico, add one → copy its Voice ID; Profile → API key | Only if the OpenAI voice isn't good enough |

Copy each key into a password manager as you go.

## 3. Deploy on Render (10 min)

1. render.com → sign in with GitHub.
2. **New → Blueprint** → choose `gcepi/puente`. Render reads `render.yaml`.
3. Fill in the keys it asks for. Also set `HOST_PASSCODE` to something short, so only you can start meetings. Leave keys blank for services you didn't sign up for.
4. Deploy. You get an address like `https://puente-xxxx.onrender.com`.

Plan: **Starter ($7/mo)** stays awake. Free works for testing but takes about a minute to wake after 15 idle minutes.

## 4. Smoke test (10 min)

1. On your laptop, open `https://…onrender.com/host`. Pick **Demo** and start. On your phone, scan the QR code and tap *Entrar con voz*. You should see scripted captions and hear a tone "voice". That proves rooms, captions, and audio on your phone.
2. End it. Start again with **OpenAI live interpreter**, tap Start translating, and talk. Spanish should appear and play on your phone.
3. Try replying: on the phone, hold *Mantén presionado para responder*, say a sentence in Spanish, and release.

Note anything odd, especially on iPhone: silent switch on/off, screen dimming, Bluetooth vs. wired earbuds. Send the notes to Claude.

## 5. First real meeting

- You: wear an earbud (to hear replies) and use a clip-on mic if you have one.
- Crew: earbuds in, screen on. Text-only works too.
- Speak in short paragraphs and pause between points.
- For anything safety-related, ask someone to repeat it back.

## Settings you might tune later (Render → Environment)

| Setting | Default | What it does |
|---|---|---|
| `ENGINE` | `openai-translate` | Default engine (the host can still pick per meeting) |
| `ENDPOINTING_MS` | `700` | Pause that ends a phrase in "When I pause" mode. Lower is faster and choppier. |
| `TTS_PROVIDER` | `openai` | `elevenlabs` for a chosen Mexican voice |
| `TTS_SPEED` | `1.08` | Voice speed (ElevenLabs) |
| `MAX_SESSION_MINUTES` | `120` | Auto-stop safety for cost |

Glossary: edit `server/glossary.json` (or ask Claude to). It feeds both speech recognition and translation.
