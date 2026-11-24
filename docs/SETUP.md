# Set up a Puente meeting on Render

## Configure push-to-talk

If Puente already runs on Render, open the service's **Environment** tab and check these settings. For a new deployment, choose **New → Blueprint** in Render, select `gcepi/puente`, and enter `OPENAI_API_KEY` and `HOST_PASSCODE` when prompted. Enter provider keys in the dashboard.

| Setting | How Puente uses it |
|---|---|
| `ENGINE=turn` | Push-to-talk. Select **Push to talk, then it repeats in Spanish** on the host page. |
| `HOST_PASSCODE` | Protects the host controls. Crew members join with the three-digit room code. |
| `OPENAI_API_KEY` | Required for transcription. OpenAI also translates by default and provides the backup voice. |
| `ANTHROPIC_API_KEY` | Optional. Setting this key selects Claude for translation in push-to-talk mode. |
| `ELEVENLABS_API_KEY` and `ELEVENLABS_VOICE_ID` | Set both to use your cloned voice for Spanish. Copy the voice ID from your ElevenLabs voice library. |
| `ELEVENLABS_REPLY_VOICE_ID` | Optional separate voice for English replies. When empty, crew replies use the same ElevenLabs voice as the manager. |
| `ELEVENLABS_MODEL` | Defaults to `eleven_flash_v2_5` (Flash v2.5). |
| `TTS_SPEED` | Controls speaking pace for the clone and default OpenAI backup. Render uses its existing value, or `1.15` if unset. The local example sets `1.08`. Keep the current value to preserve your pace. |

The blueprint uses Render's free plan. If your service sleeps between meetings, open the host page ahead of time and wait for the mode selector to load.

## Test with two devices

1. Open the service's HTTPS address followed by `/host` on your laptop. Select **Demo**, start a session, and scan the QR code with a phone. On the phone, tap **Entrar con voz**. Hold the host's talk button, then release. Check for scripted captions and a tone in the phone's earbuds.
2. End the demo, start a **Push to talk** session, and rejoin on the phone. Hold **Hold to talk** or the Space bar while speaking, then release. Try “Hessel, please check unit 204B at 3:15.” Compare the name, unit and time in the captions and the Spanish voice.
3. On the phone, tap **Toca para responder**, allow microphone access, speak a correction in Spanish, and tap again to send it. Check the English caption and voice on the host. Try speaking another turn after the reply.
4. For a missed phrase, play **What it heard** and **Voice it sent** after a completed turn and before speaking again. The **voice after** time starts when the server receives the release and ends when it starts sending voice. The brief pause that captures your last syllable, network transit and phone playback add to the wait you hear.

## During the meeting

Keep earbuds connected and screens on. Listeners who prefer captions can choose **Solo texto**. Speak in short turns and pause for replies. Ask a crew member to repeat back safety-critical instructions and confirm any unit number or time before acting.

Anyone with the standing room code can join an active meeting and see recent captions, including replies. Use **End meeting** when finished. Download any transcript you need first. A server restart clears the room and its history.

## One-on-one on a phone

Open **One-on-one on this phone** on the host setup page, or add `/solo` to your service's HTTPS address. Enter the host passcode if prompted. Tap **English** or **Español** to speak, then tap the same button again to translate. The other person can reply on the same phone. Translation needs Wi-Fi or cellular data.

The phone sends each translation to its selected audio output. On speaker, both people can listen. If you share a pair of AirPods, both earbuds play the same translation.

- On **iPhone**, open `/solo` in Safari, tap **Share → Add to Home Screen**, then **Add**. Enable **Open as Web App** if Safari offers it.
- On **Android**, open `/solo` in Chrome, open **⋮ → Add to Home screen** or **Install app**, and confirm.

The **Puente Solo** Home Screen icon opens one-on-one mode directly. Your meeting QR code still takes crew members to the group meeting.

## Other settings

- The optional pipeline needs `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY` and the chosen voice provider's credentials. `TTS_PROVIDER` selects its voice provider (`openai` or `elevenlabs`). Push-to-talk uses the ElevenLabs key and voice ID described above.
- `ENDPOINTING_MS` controls pause detection in the pipeline and defaults to `700`.
- `MAX_SESSION_MINUTES` defaults to `120` and limits how long the host engine runs.
- Edit `server/glossary.json` to supply name spellings and preferred translations for the team's trade terms.
