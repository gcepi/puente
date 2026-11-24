import { connect, CaptionPane, Revealer, keepAwake, openMic, micPossible, audioContext, micHelp, $ } from './common.js';
import { PcmPlayer } from './player.js';

const player = new PcmPlayer();

/** A random id kept on this phone, so a second tab replaces the first instead of doubling the voice. */
function deviceId() {
  try {
    let id = localStorage.getItem('puente.device');
    if (!id) {
      id = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('puente.device', id);
    }
    return id;
  } catch {
    return '';
  }
}
window.__puente = { player }; // for tests and on-device debugging

const pathCode = location.pathname.match(/^\/j\/(\d{3})$/)?.[1];
if (pathCode) $('#code').value = pathCode;
try {
  $('#name').value = localStorage.getItem('puente.name') || '';
} catch {}

let size = 30;
try {
  size = Number(localStorage.getItem('puente.size')) || 30;
} catch {}
const applySize = () => {
  document.documentElement.style.setProperty('--es-size', `${size}px`);
  document.documentElement.style.setProperty('--en-size', `${Math.round(size * 0.58)}px`);
};
applySize();

async function join(withAudio) {
  const code = $('#code').value.replace(/\D/g, '');
  const name = $('#name').value.trim();
  $('#joinErr').textContent = '';
  if (!/^\d{3}$/.test(code)) return ($('#joinErr').textContent = 'El código tiene 3 números.');
  // Unlock audio first, while we are still inside the tap.
  if (withAudio) await player.unlock().catch(() => {});
  const r = await fetch(`/api/rooms/${code}`).catch(() => null);
  if (!r?.ok) return ($('#joinErr').textContent = 'No encontramos esa junta. Revisa el código.');
  try {
    localStorage.setItem('puente.name', name);
  } catch {}
  history.replaceState(null, '', `/j/${code}`);
  start(code, name, withAudio);
}

function start(code, name, withAudio) {
  $('#join').classList.add('hidden');
  $('#live').classList.remove('hidden');
  $('#title').textContent = `Junta ${code}`;
  keepAwake();
  const en = new CaptionPane($('#enPane'));
  const es = new CaptionPane($('#esPane'));
  const reveal = { en: new Revealer(en), es: new Revealer(es) };
  let online = false;
  let live = false;
  let hostConnected = false;
  let floor = null;
  let reply = null;
  let openingMic = false;
  let interrupted = false;
  let notice = '';
  let noticeUntil = 0;
  const talkBtn = $('#talkBtn');
  const paint = () => ($('#dot').className = `dot ${live ? 'live' : online ? 'online' : ''}`);

  function paintTalk() {
    const busy = floor && floor !== (name || 'Equipo');
    talkBtn.disabled = !online || !hostConnected || openingMic || !!reply?.tail || !!busy;
    talkBtn.classList.toggle('down', !!reply?.mic && !reply.tail);
    if (!online) talkBtn.textContent = 'Sin conexión';
    else if (!hostConnected) talkBtn.textContent = 'Esperando al presentador…';
    else if (busy) talkBtn.textContent = `Habla: ${floor}`;
    else if (openingMic) talkBtn.textContent = 'Abriendo el micrófono…';
    else if (reply?.tail) talkBtn.textContent = 'Enviando…';
    else if (reply?.mic) talkBtn.textContent = '🔴 Hablando… toca para enviar';
    else if (Date.now() < noticeUntil) talkBtn.textContent = notice;
    else talkBtn.textContent = interrupted ? '🎤 Toca para repetir tu respuesta' : '🎤 Toca para responder';
  }

  function clearReply() {
    if (!reply) return;
    clearTimeout(reply.tail);
    reply.mic?.stop();
    reply = null;
  }

  function interruptReply() {
    if (!reply) return;
    interrupted = true;
    // The host can leave while the listener socket is still open. Release its floor.
    if (online && reply.mic) conn.send({ t: 'talk', down: false });
    clearReply();
  }

  player.setEnabled(withAudio);
  $('#audioBtn').setAttribute('aria-pressed', String(withAudio));

  const conn = connect(
    { role: 'listen', room: code, name, device: deviceId() },
    {
      onOpen: () => conn.send({ t: 'audio', on: player.enabled }),
      onStatus: (s) => {
        online = s === 'online';
        if (!online) {
          hostConnected = false;
          live = false;
          floor = null;
          interruptReply();
        }
        if (s === 'offline') $('#title').textContent = `Junta ${code} · reconectando…`;
        if (s === 'online') $('#title').textContent = `Junta ${code}`;
        paint();
        paintTalk();
      },
      onGone: (code) => {
        $('#talkbar').classList.add('hidden');
        if (code === 4001) {
          // This phone opened the meeting in a newer tab; go quiet so the voice never plays twice.
          player.setEnabled(false);
          player.keeper?.pause();
          $('#title').textContent = 'Abierta en otra pestaña';
          return;
        }
        $('#title').textContent = 'La junta terminó';
      },
      onMessage: (m) => {
        if (m.t === 'cap') {
          $(m.lang === 'en' ? '#enEmpty' : '#esEmpty')?.remove();
          (m.lang === 'en' ? en : es).set(m.id, m.text, m.final, m.who);
        } else if (m.t === 'cuelen') {
          reveal[m.lang]?.setLength(m.id, m.seconds);
        } else if (m.t === 'cue') {
          $(m.lang === 'en' ? '#enEmpty' : '#esEmpty')?.remove();
          // Synced to this phone's audio clock when it plays this voice; paced otherwise.
          reveal[m.lang]?.add(m, m.to === 'listeners' ? player.startIn() : null);
        } else if (m.t === 'state') {
          live = m.live;
          hostConnected = m.hostConnected;
          floor = m.floor;
          if (!hostConnected) interruptReply();
          // The server also releases a reply when its one-minute limit expires.
          else if (reply?.hadFloor && !floor) clearReply();
          else if (reply?.mic && floor === (name || 'Equipo')) reply.hadFloor = true;
          paintTalk();
          paint();
        } else if (m.t === 'error') {
          clearReply();
          notice = m.message;
          noticeUntil = Date.now() + 3000;
          paintTalk();
          setTimeout(paintTalk, 3100);
        } else if (m.t === 'ended') {
          hostConnected = false;
          clearReply();
          paintTalk();
          $('#talkbar').classList.add('hidden');
          $('#title').textContent = 'La junta terminó';
        }
      },
      onAudio: (buf) => player.play(buf),
    }
  );

  if (micPossible()) {
    $('#live').classList.add('can-talk');
    $('#talkbar').classList.remove('hidden');
  }
  // Tap to start, tap again to send. (A long press gets cancelled by iOS.)
  const startTalk = async () => {
    audioContext(); // Safari/iOS: start audio inside the tap, before any await
    const attempt = { mic: null, tail: null, hadFloor: false };
    reply = attempt;
    openingMic = true;
    interrupted = false;
    noticeUntil = 0;
    paintTalk();
    player.skip(); // don't talk over the voice
    try {
      const mic = await openMic((pcm) => {
        if (reply === attempt && attempt.mic) conn.send(pcm);
      });
      // Permission may arrive after the connection or the meeting is gone.
      if (reply !== attempt) {
        mic.stop();
        return;
      }
      attempt.mic = mic;
      conn.send({ t: 'talk', down: true });
    } catch (e) {
      if (reply !== attempt) return;
      clearReply();
      notice = micHelp(e, 'es');
      noticeUntil = Date.now() + 12000;
      setTimeout(paintTalk, 12100);
    } finally {
      openingMic = false;
      paintTalk();
    }
  };
  talkBtn.addEventListener('click', () => {
    if (talkBtn.disabled) return;
    if (!reply) return startTalk();
    // Keep the last syllable. Disconnecting cancels this timer before a new socket opens.
    reply.tail = setTimeout(() => {
      clearReply();
      conn.send({ t: 'talk', down: false });
      paintTalk();
    }, 400);
    paintTalk();
  });

  $('#audioBtn').onclick = async () => {
    if (!player.ctx) await player.unlock().catch(() => {});
    player.setEnabled(!player.enabled);
    $('#audioBtn').setAttribute('aria-pressed', String(player.enabled));
    conn.send({ t: 'audio', on: player.enabled });
  };
  const resize = (d) => {
    size = Math.max(18, Math.min(56, size + d));
    applySize();
    try {
      localStorage.setItem('puente.size', size);
    } catch {}
  };
  $('#smaller').onclick = () => resize(-4);
  $('#bigger').onclick = () => resize(4);
}

$('#joinForm').addEventListener('submit', (e) => {
  e.preventDefault();
  join(true);
});
$('#joinText').addEventListener('click', () => join(false));

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
