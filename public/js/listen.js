import { connect, CaptionPane, keepAwake, openMic, micPossible, $ } from './common.js';
import { PcmPlayer } from './player.js';

const player = new PcmPlayer();
window.__puente = { player }; // for tests and on-device debugging

const pathCode = location.pathname.match(/^\/j\/([A-Za-z]{4})$/)?.[1];
if (pathCode) $('#code').value = pathCode.toUpperCase();
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
  const code = $('#code').value.trim().toUpperCase();
  const name = $('#name').value.trim();
  $('#joinErr').textContent = '';
  if (!/^[A-Z]{4}$/.test(code)) return ($('#joinErr').textContent = 'El código tiene 4 letras.');
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
  let online = false;
  let live = false;
  const paint = () => ($('#dot').className = `dot ${live ? 'live' : online ? 'online' : ''}`);

  player.setEnabled(withAudio);
  $('#audioBtn').setAttribute('aria-pressed', String(withAudio));

  const conn = connect(
    { role: 'listen', room: code, name },
    {
      onOpen: () => conn.send({ t: 'audio', on: player.enabled }),
      onStatus: (s) => {
        online = s === 'online';
        if (s === 'offline') $('#title').textContent = `Junta ${code} · reconectando…`;
        if (s === 'online') $('#title').textContent = `Junta ${code}`;
        paint();
      },
      onGone: () => ($('#title').textContent = 'La junta terminó'),
      onMessage: (m) => {
        if (m.t === 'cap') {
          $(m.lang === 'en' ? '#enEmpty' : '#esEmpty')?.remove();
          (m.lang === 'en' ? en : es).set(m.id, m.text, m.final, m.who);
        } else if (m.t === 'state') {
          live = m.live;
          floor = m.floor;
          paintTalk();
          paint();
        } else if (m.t === 'error') {
          $('#talkBtn').textContent = m.message;
          setTimeout(paintTalk, 2500);
        } else if (m.t === 'ended') {
          $('#title').textContent = 'La junta terminó';
        }
      },
      onAudio: (buf) => player.play(buf),
    }
  );

  // ---- hold to reply in Spanish; the host hears English ----
  let floor = null;
  let talking = false;
  let mic = null;
  const talkBtn = $('#talkBtn');
  const paintTalk = () => {
    if (talking) return;
    const busy = floor && floor !== (name || 'Equipo');
    talkBtn.disabled = !!busy;
    talkBtn.classList.remove('down');
    talkBtn.textContent = busy ? `Habla: ${floor}` : '🎤 Mantén presionado para responder';
  };
  if (micPossible()) {
    $('#live').classList.add('can-talk');
    $('#talkbar').classList.remove('hidden');
  }
  const talkDown = async (e) => {
    e.preventDefault();
    if (talking || talkBtn.disabled) return;
    talking = true;
    talkBtn.setPointerCapture?.(e.pointerId);
    talkBtn.classList.add('down');
    talkBtn.textContent = 'Hablando… suelta para enviar';
    player.skip(); // don't talk over the voice
    conn.send({ t: 'talk', down: true });
    try {
      mic = await openMic((pcm) => talking && conn.send(pcm));
      if (!talking) talkUp(); // released while the mic was opening
    } catch {
      talking = false;
      conn.send({ t: 'talk', down: false });
      talkBtn.textContent = 'Permite el micrófono para responder';
      setTimeout(paintTalk, 3000);
    }
  };
  const talkUp = () => {
    if (!talking && !mic) return;
    talking = false;
    const m = mic;
    mic = null;
    // Keep the last syllable: stop sending a beat after release.
    setTimeout(() => {
      m?.stop();
      conn.send({ t: 'talk', down: false });
      paintTalk();
    }, 350);
  };
  talkBtn.addEventListener('pointerdown', talkDown);
  talkBtn.addEventListener('pointerup', talkUp);
  talkBtn.addEventListener('pointercancel', talkUp);
  talkBtn.addEventListener('contextmenu', (e) => e.preventDefault());

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
