# Puente: scope, holes, cost, timeline

*Live English → Mexican Spanish meeting translation for a property manager and a maintenance crew. Written 2026-11-23.*

This original design brief predates the default push-to-talk engine. Its model choices, timing and cost estimates, voice settings and screen descriptions reflect that earlier design. For the current behavior and setup, see the [README](../README.md) and [meeting setup guide](SETUP.md).

## Bottom line

- **Build it.** The engine you're picturing already exists as an API. In May 2026 OpenAI shipped `gpt-realtime-translate`, a model built to interpret speech while the speaker is still talking, for about $2 an hour. The rest is glue: rooms, a QR code, captions, audio playback on phones. That glue is now built and tested.
- **Confidence that it's buildable: high (>90%).** A working MVP exists in this repo, with tests. The open question is not *can it be built* but *does it feel good in your shop with your crew*. Only a pilot answers that.
- **Expect 1.5–3 seconds of lag, not zero.** That's the physics of translation (Spanish often needs the end of an English sentence before it can start). Human interpreters lag about the same. Today's devices feel bad mostly because of how they *chunk* speech, not because of raw lag. Chunking is the part this design controls.
- **Running cost: roughly $20–45 a month** at 10 hours of talking. It doesn't grow with headcount, because the voice is generated once and sent to every phone.

## Did you miss an existing product?

Mostly no. One product is close, and you should know about it.

| Option | Fits? | Why not (for you) |
|---|---|---|
| **[Wordly](https://wordly.ai/meeting-translation)** | Closest match: QR join, no app, captions + audio per phone | Enterprise, quote-only pricing sold in blocks of hours (e.g. 240/480/720 hrs a year). No glossary control for trade slang. Worth one email to get a quote as a benchmark. |
| Microsoft Translator "conversation" (join code) | Was the free version of this | Being wound down; one source puts the end at June 30, 2026 ([WhistleOut](https://www.whistleout.com/CellPhones/Apps/is-microsoft-translator-worth-downloading); unconfirmed by Microsoft) |
| Google Meet / Teams live translation | Good for *video* calls | Not for a room of people on their own phones |
| AirPods Live Translation, Timekettle | One-to-one conversation | One person per device, robotic voice, pauses, $$$ per seat |

## How it works

```
 Your phone/laptop (host)                     Server (one small web service)                 Crew phones (listeners)
 ┌──────────────────┐   mic audio   ┌──────────────────────────────────────────┐   captions   ┌──────────────────┐
 │ QR code + code   │ ────────────▶ │ Room "482"                                 │ ───────────▶ │ English (small)  │
 │ Start/Stop mic   │               │  Engine A: OpenAI live interpreter        │   voice      │ Español (big)    │
 │ When voice speaks│ ◀──────────── │  Engine B: speech→Claude→voice + glossary │ ───────────▶ │ 🔊  A−  A+       │
 │ Live monitor     │  English      │  Replies: Spanish → English, to host      │ ◀─────────── │ Hold to reply 🎤 │
 └──────────────────┘  replies      └──────────────────────────────────────────┘   replies    └──────────────────┘
```

- **Joining** works like Kahoot: scan the QR code or go to the site and type a 3-digit code. No app, no account. It works the same on iPhone and Android because it's a web page (it can be added to the home screen as an app).
- **API keys stay on the server.** Phones never see them.

### Two engines, chosen per meeting

| | **A. OpenAI live interpreter** (`gpt-realtime-translate`) | **B. Pipeline** (Deepgram → Claude → ElevenLabs/OpenAI voice) |
|---|---|---|
| Feel | Truly simultaneous: speaks while you talk, no pause logic | Speaks after each phrase ends (pause, button release, or tap) |
| Measured lag | ~2.65 s EN→ES in one benchmark ([LiveLingo](https://www.livelingo.io/guides/gpt-live-translation), a competitor, so take with salt) | ~1–2 s after the phrase ends (estimate: recognition + translation + first audio) |
| Mexican Spanish | No regional setting, no glossary, no custom prompt ([DataCamp test](https://www.datacamp.com/tutorial/gpt-realtime-2-api)) | Told explicitly: Mexican Spanish, "ustedes", trade vocabulary, your glossary |
| Voice | Fixed OpenAI voice, no choice | Pick any voice, including a Mexican-accented one, or clone your own |
| Cost per hour of talking | ~$2.04 ([pricing](https://opper.ai/openai/gpt-realtime-translate)) | ~$0.35–0.50 recognition + ~$0.05 Claude + $0.90–3.00 voice |
| Keys needed | 1 (OpenAI) | 3 (Deepgram, Anthropic, and ElevenLabs or OpenAI) |

**Recommendation:** pilot A first (one key, and it best fixes the robot-pause problem). Put B on the same server and run one meeting on each. Keep whichever the crew prefers. The engines sit behind one interface, so switching costs nothing.

### Your three ideas for when the voice speaks: all built (Engine B)

- **When I pause.** A phrase ends after ~0.7 s of silence (`ENDPOINTING_MS`, tunable). This is your fixed-count idea, but driven by your actual pauses instead of a clock.
- **Hold to talk.** The mic is live only while you hold the button (or Space). Releasing sends the phrase. Most reliable in a noisy shop.
- **When I tap.** The mic is always live, and the voice speaks only when you tap "Translate now" (or Enter).
- **Safety valve in every mode.** A long monologue is broken at ~35 words, so the voice never falls more than a sentence behind.

## The experience

**You (host).** Open `/host` on a laptop or phone and tap Start session. A big QR code and room code appear. Tap 🎙 Start translating and talk. Your screen shows what you said and what they're hearing, so you can catch a bad translation live. When someone replies, you see "Pedro is replying…" and hear English in your earbuds. At the end, download the bilingual transcript.

**Crew member.** Plug in earbuds, scan the QR code, and tap "🎧 Entrar con voz". English appears small on top and Spanish large on the bottom, with the voice in their ears. They can make the text bigger, mute the voice, or join text-only. To ask a question, they hold "🎤 Mantén presionado para responder", speak Spanish, and release. Everyone sees the question in both languages, labeled with their name.

Screenshots from the automated test: `test/screenshots/` (run `npm run test:e2e`).

## Holes, limits, dependencies

Ranked by how likely each is to bite.

| # | Risk | Why it matters | Mitigation | Status |
|---|---|---|---|---|
| 1 | **Voice falls behind the speaker** | Spanish runs ~20–25% longer than English. A fast talker outpaces the voice. | Voice plays at 1.08× speed. Phrases are capped. The player jumps to live if it falls >8 s behind. Coaching: pause between points. | Built; tune in pilot |
| 2 | **Speaker's mic quality** | A phone on the table in a loud shop gives bad recognition and therefore bad translation. Biggest accuracy lever. | Speak into a clip-on mic or AirPods mic, not a phone on the table | Hardware ($30–60) |
| 3 | **iPhone web quirks** | iOS mutes web audio on the silent switch, needs a tap before sound, and suspends audio when the screen locks | Silent-switch workaround, tap-to-join unlock, Screen Wake Lock (iOS 16.4+). Instruction: "keep the screen on". | Built; **needs a real-iPhone test** (can't emulate) |
| 4 | **Trade jargon, names, unit numbers** | "Make-ready", "GFCI", "el 204", people's names | Glossary (`server/glossary.json`) feeds recognition and translation. Prompt keeps numbers and names exact. | Built for B. **A has no glossary.** |
| 5 | **Mexican vs. generic Spanish** | Register and vocabulary ("departamento", "boiler", "tablaroca") | B is prompted for Mexican trade Spanish. A outputs generic Spanish. | Needs a native speaker on the crew to judge |
| 6 | **Literacy and language** | Some crew may read slowly, or speak an Indigenous language first | Audio-first design, big adjustable text | Ask the crew |
| 7 | **Echo loops** | Your speaker plays an English reply → your mic hears it → it gets re-translated | Host mic is ignored while someone replies and while the reply plays. You should still wear earbuds. | Built |
| 8 | **Wi-Fi / cell dead zones** | Basements, boiler rooms | Auto-reconnect. Late joiners get recent history. A slow phone gets skipped instead of stalling the room. | Built |
| 9 | **Accuracy and liability** | Safety instructions (chemicals, electrical) mistranslated | Your screen shows what they hear. For safety items, ask for a repeat-back. The transcript is a record. | Process |
| 10 | **Privacy and consent** | Meeting audio goes to OpenAI / Deepgram / Anthropic. These APIs don't train on API data by default, but check Dwell's policy. | Transcripts live in server memory only and vanish on restart unless you download them. Tell the crew it's being translated by AI. | **Your decision** |
| 11 | **Runaway cost** | A forgotten open mic bills by the minute | Auto-stop at 120 min (`MAX_SESSION_MINUTES`). The mic stops when you tap Stop. A replying listener is cut off at 60 s. | Built |
| 12 | **Vendor drift** | APIs rename events, models retire | Engines are swappable modules. Engine A's event names came from OpenAI's cookbook plus third-party docs (the official reference was blocked from the build box) and get **verified on first live run**. | First live run |
| 13 | **Ownership** | You don't want to maintain a custom app, and tinkering is your named failure mode | Small (~2,000 lines including UI), three dependencies, tests included. Changes go through an agent. Re-evaluate Wordly if upkeep exceeds ~1 hr/month. | Watch it |

**Hard dependencies:** OpenAI (Engine A) or Deepgram + Anthropic + a voice provider (Engine B); a host with WebSockets and https (Render); crew phones with a modern browser and earbuds. Phones need https to use a mic. Captions and voice work anywhere.

## Cost (excluding hardware)

Assumes **10 hours of talking a month** (about 30 min of meetings each weekday). Replies add a little on top.

| Line | Engine A | Engine B (OpenAI voice) | Engine B (ElevenLabs voice) |
|---|---|---|---|
| Speech | OpenAI translate $0.034/min → **$20** | Deepgram Nova-3 ~$0.005–0.008/min → **$3–5** | same **$3–5** |
| Translation | included | Claude Haiku 5.5 → **<$1** | **<$1** |
| Voice | included | gpt-4o-mini-tts → **~$9** *(estimate)* | ~650k chars × ~$0.05/1k → **~$30** |
| Hosting | Render $7 | $7 | $7 |
| **Monthly** | **~$28** | **~$20** | **~$43** |

- **Year one: ~$250–520**, under the $800 hardware budget, before reusing any of it.
- **Listeners are free.** 3 crew or 30, same cost.
- **Price sources** (aggregators, Nov 2026; confirm on each vendor's page): [OpenAI translate](https://opper.ai/openai/gpt-realtime-translate), [Deepgram](https://deepgram.com/pricing), [ElevenLabs](https://elevenlabs.io/pricing/api). Claude Haiku 5.5 is $0.10 / $0.50 per million tokens.

### Suggested use of the $800 (about $150–300 of it)

- **Clip-on mic for the speaker** (USB-C/Lightning lav, ~$30–60). Biggest accuracy win.
- **6–8 wired USB-C earbuds** (~$10–15 each) plus 2 for Lightning iPhones. Wired avoids pairing every shared earbud to a different phone each morning.
- **Optional: a cheap Android tablet** (~$150) on the table as a big caption screen for anyone without a phone or data.

## Timeline: how far AI goes, how fast

| Phase | Who | Time |
|---|---|---|
| Scope, architecture, MVP (both engines, replies, tests, deploy config) | Claude | **Done this session** |
| Create repo, get API keys, deploy on Render | **You**, with `docs/SETUP.md` | **45–60 min, no command line** |
| First live run: verify Engine A events, real iPhone + Android test | You + Claude | 1 short session |
| Pilot: 2–3 real meetings, pick engine and voice, tune pause length and glossary | You (+ a bilingual crew member's opinion) | ~1 week |
| Polish from pilot notes | Claude | hours per round |
| **Reliable daily tool** | | **~2 weeks calendar, ~3–5 hours of your time** |

**What AI can't do for you:** hold keys or billing, sign in to GitHub and Render, judge whether the Spanish *sounds* right to your crew, test real acoustics and real iPhones, and decide policy on recording and consent.

## Decisions for you

1. **Repo:** create an empty private repo `gcepi/puente` (one click). Claude pushes the code. *(This session can't create repos itself.)*
2. **Whose card and whose policy:** is this a Dwell expense and a Dwell tool? That decides who owns the API accounts and whether IT needs to bless sending audio to AI vendors.
3. **Pilot order:** recommended Engine A first. Then B with the OpenAI voice. Add ElevenLabs only if the voice is the complaint.
4. **Wordly quote:** recommended: one 10-minute email as a benchmark and backstop. Don't wait on it.

## Roadmap after the pilot (not built)

- Per-person language (beyond Spanish), if the team grows
- Auto-summary of each meeting in both languages into Notion or Todoist
- Voice clone of you speaking Spanish (ElevenLabs)
- Saved transcripts (today they live in memory only, by design)
