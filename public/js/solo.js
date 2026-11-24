import { $, audioContext, micHelp, micPossible, openMic, wsUrl } from './common.js';
import { PcmPlayer } from './player.js';

const player = new PcmPlayer();
const buttons = { en: $('#speakEn'), es: $('#speakEs') };
const idleLabels = Object.fromEntries(Object.entries(buttons).map(([lang, button]) =>
  [lang, button.querySelector('.action-label')?.textContent]));
const names = { en: 'English', es: 'Español' };
const messages = {
  connecting: 'Connecting… / Conectando…',
  ready: 'Ready / Listo',
  opening: 'Opening microphone. Wait to speak. / Abriendo el micrófono. Espera para hablar.',
  recording: 'Listening. Tap again to send. / Escuchando. Toca otra vez para enviar.',
  processing: 'Translating… / Traduciendo…',
  playing: 'Playing translation… / Reproduciendo la traducción…',
  offline: 'Connection lost. Reconnecting… / Se perdió la conexión. Reconectando…',
  locked: 'Enter the host passcode. / Ingresa la clave del anfitrión.',
  unavailable: 'One-on-one translation is unavailable. / La traducción individual no está disponible.',
};
let phase;
let socket = null;
let turn = null;
let openingMic = false;
let revision = 0;
let retry = null;
let retryMs = 700;
let suspended = false;
let triedSavedPasscode = false;

function show(state, message = messages[state]) {
  phase = state;
  $('#soloApp').dataset.state = state;
  $('#status').textContent = message;
  $('#auth').hidden = state !== 'locked';
  $('#controls').hidden = state === 'locked';
  for (const [lang, button] of Object.entries(buttons)) {
    const active = turn?.from === lang && (state === 'opening' || state === 'recording');
    button.disabled = state !== 'ready' && !active;
    button.setAttribute('aria-pressed', String(active));
    const label = button.querySelector('.action-label');
    if (!label) continue;
    if (!active) label.textContent = idleLabels[lang];
    else if (state === 'opening') label.textContent = lang === 'en' ? 'Cancel' : 'Cancelar';
    else label.textContent = lang === 'en' ? 'Tap to send' : 'Toca para enviar';
  }
}

function closeMic() {
  clearTimeout(turn?.limit);
  turn?.mic?.stop();
  if (turn) turn.mic = null;
}

function clearTurn() {
  clearTimeout(turn?.playbackTimer);
  closeMic();
  turn = null;
  player.skip();
  player.next = 0; // Discard the scheduling cursor along with the queued audio.
}

function send(type, data = {}) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: type, ...data }));
}

// Caption snapshots replace a language's text. A cue is one translated sentence.
function writeCaption(msg) {
  if (!msg.text || msg.text === '…' || !Object.hasOwn(names, msg.lang)) return;
  const transcript = $('#transcript');
  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 48;
  if (!turn.text) {
    const article = document.createElement('article');
    article.className = 'solo-turn';
    turn.text = {};
    for (const lang of [turn.from, turn.from === 'en' ? 'es' : 'en']) {
      const line = document.createElement('div');
      line.className = 'solo-line';
      line.lang = lang;
      const label = document.createElement('strong');
      label.textContent = names[lang];
      const p = document.createElement('p');
      line.append(label, p);
      article.append(line);
      turn.text[lang] = { p, sentences: [], final: false };
    }
    transcript.append(article);
  }
  const field = turn.text[msg.lang];
  if (msg.t === 'cue') {
    field.sentences.push(msg.text);
    if (!field.final) field.p.textContent = field.sentences.join(' ');
  } else {
    field.final = !!msg.final;
    if (field.final || !field.sentences.length) field.p.textContent = msg.text;
  }
  if (atBottom) transcript.scrollTop = transcript.scrollHeight;
}

function endPlayback() {
  if (player.lag > 0 && player.ctx.state === 'running' && performance.now() < turn.playbackDeadline) {
    turn.playbackTimer = setTimeout(endPlayback, Math.min(1000, player.lag * 1000 + 20));
    return;
  }
  const notice = turn.notice || (player.lag > 0 ? 'Audio paused. Read the translation. / Audio en pausa. Lee la traducción.' : '');
  clearTurn();
  show('ready', notice || messages.ready);
}

function onMessage(msg) {
  if (msg.t === 'ready') {
    retryMs = 700;
    show('ready');
    return;
  }
  if (!turn) return;
  if (msg.t === 'started' && phase === 'opening' && turn.mic && msg.from === turn.from) {
    show('recording');
    turn.limit = setTimeout(finish, 115_000); // Finish before the 120-second server cap.
  } else if (msg.t === 'cap' || msg.t === 'cue') {
    writeCaption(msg);
  } else if (msg.t === 'error') {
    const detail = msg.message || '';
    if (/used the OpenAI voice|backup voice/i.test(detail)) {
      turn.notice = 'Using a backup voice. / Se está usando una voz alternativa.';
    } else if (/speech|nothing heard|no audio/i.test(detail)) {
      turn.notice = 'Please say that again. / Por favor, repítelo.';
    } else if (/too slow for audio|^Voice:/i.test(detail)) {
      turn.notice = 'Voice unavailable. Read the translation. / Voz no disponible. Lee la traducción.';
    } else {
      turn.notice = 'There was a problem with this turn. Please try again. / Hubo un problema. Inténtalo de nuevo.';
    }
    if (phase === 'opening') {
      const notice = turn.notice;
      clearTurn();
      show('ready', notice);
      return;
    }
    $('#status').textContent = turn.notice;
  } else if (msg.t === 'done') {
    closeMic();
    // Some mobile audio interruptions freeze currentTime even when state still says running.
    turn.playbackDeadline = performance.now() + player.lag * 1000 + 2000;
    endPlayback();
  }
}

function finish() {
  if (phase !== 'recording') return;
  closeMic();
  show('processing');
  send('finish');
}

function cancelOpening() {
  const sent = !!turn.mic;
  closeMic();
  if (sent) {
    show('processing', 'Canceling… / Cancelando…');
    send('cancel');
  } else {
    clearTurn();
    show('ready');
  }
}

async function tap(lang) {
  if (turn?.from === lang && phase === 'recording') return finish();
  if (turn?.from === lang && phase === 'opening') return cancelOpening();
  if (phase !== 'ready') return;
  if (!micPossible()) {
    return show('unavailable', 'Open this page over HTTPS to use the microphone. / Abre esta página con HTTPS para usar el micrófono.');
  }
  turn = { from: lang };
  show('opening');
  if (openingMic) return; // Share one outstanding browser permission request.
  openingMic = true;
  try {
    audioContext(); // iOS requires audio activation inside the original tap.
    if (!player.ctx) player.unlock().catch(() => {});
    const mic = await openMic((pcm) => {
      if (phase !== 'recording' || socket?.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 512 * 1024) {
        closeMic();
        show('processing', 'Connection too slow. / La conexión es demasiado lenta.');
        turn.notice = 'Connection too slow. Please repeat. / Conexión lenta. Por favor, repítelo.';
        send('cancel');
        return;
      }
      socket.send(pcm);
    });
    if (phase !== 'opening' || !turn) return mic.stop();
    turn.mic = mic;
    send('start', { from: turn.from });
  } catch (error) {
    if (phase === 'opening') {
      const help = micHelp(error, turn.from);
      clearTurn();
      show('ready', help);
    }
  } finally {
    openingMic = false;
  }
}
for (const [lang, button] of Object.entries(buttons)) button.addEventListener('click', () => tap(lang));

function reconnect() {
  clearTurn();
  show('offline');
  clearTimeout(retry);
  retry = setTimeout(checkAccess, retryMs);
  retryMs = Math.min(8000, retryMs * 2);
}

function connectSocket() {
  show('connecting');
  const ws = new WebSocket(wsUrl({ role: 'solo' }));
  ws.binaryType = 'arraybuffer';
  socket = ws;
  ws.onmessage = ({ data }) => {
    if (socket !== ws) return;
    if (typeof data === 'string') onMessage(JSON.parse(data));
    else if (turn && (phase === 'processing' || phase === 'playing')) {
      if (phase !== 'playing') show('playing', turn.notice || messages.playing);
      player.play(data);
    }
  };
  ws.onclose = ({ code }) => {
    if (socket !== ws) return;
    socket = null;
    if (code === 4003) {
      clearTurn();
      show('locked');
    } else reconnect();
  };
}

async function unlock(passcode) {
  return fetch('/api/solo/access', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ passcode }),
  });
}

async function checkAccess() {
  if (suspended) return;
  const id = ++revision;
  show('connecting');
  try {
    const result = await fetch('/api/solo/access', { cache: 'no-store' });
    if (!result.ok) throw Error();
    const { authorized, available } = await result.json();
    if (id !== revision) return;
    if (!available) return show('unavailable');
    if (!authorized) {
      let saved;
      if (!triedSavedPasscode) {
        triedSavedPasscode = true;
        try { saved = localStorage.getItem('puente.pass'); } catch {}
      }
      if (!saved) return show('locked');
      const savedResult = await unlock(saved);
      if (id !== revision) return;
      if (!savedResult.ok) return show('locked');
    }
    connectSocket();
  } catch {
    if (id === revision) reconnect();
  }
}

$('#auth').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = ++revision;
  $('#authError').textContent = '';
  try {
    const res = await unlock($('#passcode').value.trim());
    if (id !== revision) return;
    if (res.status === 401) {
      $('#authError').textContent = 'Incorrect passcode. / Clave incorrecta.';
      $('#passcode').select();
      return;
    }
    if (!res.ok) throw Error();
    $('#passcode').value = '';
    connectSocket();
  } catch {
    if (id === revision) reconnect();
  }
});

function suspend() {
  suspended = true;
  revision++;
  clearTimeout(retry);
  const ws = socket;
  socket = null;
  ws?.close();
  clearTurn();
  player.keeper?.pause();
  show('offline');
}
function resume() {
  if (!suspended || document.hidden) return;
  suspended = false;
  checkAccess();
}
document.addEventListener('visibilitychange', () => document.hidden ? suspend() : resume());
window.addEventListener('pagehide', suspend);
window.addEventListener('pageshow', resume);

checkAccess();
if ('serviceWorker' in navigator) {
  const register = () => navigator.serviceWorker.register('/sw.js').catch(() => {});
  if ('requestIdleCallback' in window) window.requestIdleCallback(register);
  else setTimeout(register, 0);
}
