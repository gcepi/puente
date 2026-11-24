import WebSocket from 'ws';
import { createEngine } from './engines/index.js';

const CAPTURE_MS = 120_000;
const MAX_BYTES = CAPTURE_MS * 48; // 24 kHz mono PCM16
const FRAME_BYTES = 1920; // 40 ms, just like the mic worklet

/** One private, two-direction interpreter. The caller has already authenticated the socket. */
export function attachSolo(ws, makeEngine = createEngine) {
  let current = null;
  let processing = false;
  let closed = false;
  const send = (message) => {
    if (!closed && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  };
  const error = (message) => send({ t: 'error', message });

  function discard(message) {
    const turn = current;
    if (!turn) return;
    current = null;
    clearTimeout(turn.timer);
    if (!turn.processing) turn.engine?.stop({ discard: true }).catch(() => {});
    if (message) error(message);
    send({ t: 'done' });
  }

  // An already-submitted provider request may finish after cancellation. Only one
  // finished turn per socket runs through translation and voice at any given time.
  async function processFinished() {
    const turn = current;
    if (processing || !turn?.finished) return;
    processing = turn.processing = true;
    try {
      await turn.engine.stop(); // flush once and await its ordered captions and audio
    } catch (e) {
      if (current === turn) error(e.message);
    } finally {
      processing = false;
      if (current === turn) {
        current = null;
        send({ t: 'done' });
      }
      if (current?.finished) void processFinished();
    }
  }

  function start(from) {
    if (current) return error('Please finish or cancel the current turn first.');
    if (from !== 'en' && from !== 'es') return error('Choose English or Spanish.');
    const turn = { bytes: 0, tail: Buffer.alloc(0), finished: false, processing: false };
    const hooks = {
      caption: ({ lang, text, final }) => {
        if (current === turn) send({ t: 'cap', lang, text, final });
      },
      cue: ({ lang, text, seconds, last }) => {
        if (current === turn) send({ t: 'cue', lang, text, seconds, last });
      },
      audio: (buf) => {
        if (current !== turn || ws.readyState !== WebSocket.OPEN || turn.muted) return;
        if (ws.bufferedAmount > 1_000_000) {
          turn.muted = true;
          return error('The connection is too slow for audio. Follow the translated text.');
        }
        ws.send(buf, { binary: true });
      },
      error: (message) => { if (current === turn) error(message); },
    };
    current = turn;
    send({ t: 'started', from });
    try {
      turn.engine = makeEngine('turn', hooks, from === 'en' ? 'en-es' : 'es-en', { oneOnOne: true });
      turn.engine.setMode('ptt');
      turn.engine.start();
    } catch {
      return discard('The interpreter could not start. Please try again.');
    }
    turn.timer = setTimeout(() => discard('Recording reached two minutes. Please repeat in shorter turns.'), CAPTURE_MS);
  }

  function acceptAudio(data) {
    const turn = current;
    if (!turn || turn.finished || !data.length) return;
    if (data.length % 2) return discard('Audio was interrupted. Please repeat the turn.');
    turn.bytes += data.length;
    if (turn.bytes > MAX_BYTES) return discard('Recording reached two minutes. Please repeat in shorter turns.');
    // Normalize packet sizes for pause detection and bound the number of buffers
    // retained by the engine even when a device sends unusually small packets.
    const pcm = turn.tail.length ? Buffer.concat([turn.tail, data]) : data;
    let i = 0;
    for (; i + FRAME_BYTES <= pcm.length; i += FRAME_BYTES) turn.engine.audio(pcm.subarray(i, i + FRAME_BYTES));
    turn.tail = pcm.subarray(i);
  }

  ws.on('message', (data, binary) => {
    if (closed) return;
    try {
      if (binary) return acceptAudio(data);
      const msg = JSON.parse(data.toString());
      if (msg?.t === 'start') start(msg.from);
      else if (msg?.t === 'cancel') discard();
      else if (msg?.t === 'finish' && current && !current.finished) {
        if (!current.bytes) return discard('No audio arrived. Please repeat the turn.');
        clearTimeout(current.timer);
        if (current.tail.length) current.engine.audio(current.tail);
        current.tail = null;
        current.finished = true;
        void processFinished();
      }
    } catch {
      if (current) discard('The turn was interrupted. Please repeat it.');
      else error('The interpreter could not read that message.');
    }
  });
  const close = () => {
    closed = true;
    discard();
  };
  ws.on('error', close);
  ws.once('close', close);
  send({ t: 'ready' });
}
