import { connect, CaptionPane, keepAwake, openMic, $ } from './common.js';
import { PcmPlayer } from './player.js';

// Replies from the team are spoken to the host in English.
const player = new PcmPlayer();
window.__puente = { player };

const store = {
  get: (k) => {
    try {
      return sessionStorage.getItem(k) ?? localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v, persist) => {
    try {
      (persist ? localStorage : sessionStorage).setItem(k, v);
    } catch {}
  },
};

const LABELS = {
  mock: 'Demo (no keys, fake voice)',
  turn: 'Push to talk, then it repeats in Spanish',
  'openai-translate': 'OpenAI live interpreter (talks while you talk)',
  pipeline: 'Glossary + chosen voice (most control)',
};

async function setup() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  const sel = $('#engine');
  for (const e of cfg.engines) {
    const o = document.createElement('option');
    o.value = e.name;
    o.textContent = LABELS[e.name] + (e.missing.length ? ' — needs keys' : '');
    o.disabled = e.missing.length > 0;
    sel.appendChild(o);
  }
  const saved = store.get('puente.engine.v2');
  const usable = cfg.engines.filter((e) => !e.missing.length).map((e) => e.name);
  sel.value = [saved, 'turn', cfg.engine, 'mock'].find((n) => usable.includes(n));
  const missingNote = cfg.engines
    .filter((e) => e.missing.length)
    .map((e) => `${LABELS[e.name].split(' (')[0]}: add ${e.missing.join(', ')}`)
    .join(' · ');
  $('#engineNote').textContent = missingNote;
  if (cfg.passcodeRequired) $('#passWrap').classList.remove('hidden');
  $('#passcode').value = store.get('puente.pass') || '';

  // Resume a session after a refresh.
  const resume = store.get('puente.session');
  if (resume) {
    const s = JSON.parse(resume);
    const ok = await fetch(`/api/rooms/${s.code}`).then((r) => r.ok).catch(() => false);
    if (ok) return run(s);
  }

  $('#setupForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#setupErr').textContent = '';
    const r = await fetch('/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ engine: sel.value, passcode: $('#passcode').value.trim() }),
    });
    const body = await r.json();
    if (r.status === 401) {
      store.set('puente.pass', '', true);
      $('#passcode').value = '';
      $('#passcode').focus();
      return ($('#setupErr').textContent = 'Wrong passcode. Enter the HOST_PASSCODE set in Render.');
    }
    if (!r.ok) return ($('#setupErr').textContent = body.error || 'Could not start');
    store.set('puente.pass', $('#passcode').value, true);
    store.set('puente.engine.v2', sel.value, true);
    store.set('puente.session', JSON.stringify(body));
    run(body);
  });
}

function run(s) {
  $('#setup').classList.add('hidden');
  $('#host').classList.remove('hidden');
  $('#host').classList.add('on');
  $('#roomCode').textContent = s.code;
  $('#qr').innerHTML = s.qrSvg;
  $('#joinUrl').textContent = s.joinUrl;
  $('#engineName').textContent = LABELS[s.engine]?.split(' (')[0] ?? s.engine;
  $('#transcriptBtn').href = `/api/rooms/${s.code}/transcript?token=${s.hostToken}`;
  keepAwake();

  const en = new CaptionPane($('#enPane'));
  const es = new CaptionPane($('#esPane'));
  let mic = null;
  let talking = false;
  let tailUntil = 0;

  const conn = connect(
    { role: 'host', room: s.code, token: s.hostToken },
    {
      onOpen: () => conn.send({ t: 'mode', mode: 'ptt' }),
      onStatus: (st) => {
        if (st === 'offline') $('#hostErr').textContent = 'Connection lost. Reconnecting…';
        if (st === 'online') $('#hostErr').textContent = '';
      },
      onGone: () => {
        store.set('puente.session', '');
        location.reload();
      },
      onMessage: (m) => {
        if (m.t === 'cap') (m.lang === 'en' ? en : es).set(m.id, m.text, m.final, m.who);
        else if (m.t === 'state') {
          $('#who').textContent = m.floor ? `${m.floor} is replying…` : `${m.listeners} listening`;
          $('#dot').className = `dot ${m.floor || talking ? 'live' : 'online'}`;
        } else if (m.t === 'error') $('#hostErr').textContent = m.message;
      },
      onAudio: (buf) => player.play(buf),
    }
  );
  // Browsers only allow sound after a tap; the first tap anywhere unlocks reply audio.
  document.addEventListener('pointerdown', () => !player.ctx && player.unlock().catch(() => {}), { once: true });

  // ---- push to talk: hold, speak, release; the Spanish voice repeats it ----
  const pb = $('#pttBtn');
  const paint = () => {
    pb.classList.toggle('down', talking);
    $('#pttLabel').textContent = talking ? 'Listening… release to translate' : 'Hold to talk';
  };
  async function down() {
    if (talking) return;
    talking = true;
    paint();
    player.skip(); // stop any reply audio so it isn't recorded
    conn.send({ t: 'ptt', down: true });
    if (!mic) {
      try {
        mic = await openMic(
          (pcm) => (talking || Date.now() < tailUntil) && conn.buffered < 512 * 1024 && conn.send(pcm),
          (level) => ($('#meter').style.width = `${talking ? Math.min(100, level * 400) : 0}%`)
        );
        $('#hostErr').textContent = '';
      } catch (e) {
        talking = false;
        paint();
        conn.send({ t: 'ptt', down: false });
        $('#hostErr').textContent = `Microphone unavailable: ${e.message}. On a phone, the page must be opened over https.`;
      }
    }
  }
  function up() {
    if (!talking) return;
    talking = false;
    paint();
    // Keep the last syllable: send a beat of audio after release.
    tailUntil = Date.now() + 350;
    setTimeout(() => conn.send({ t: 'ptt', down: false }), 350);
  }
  pb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pb.setPointerCapture?.(e.pointerId);
    down();
  });
  pb.addEventListener('pointerup', up);
  pb.addEventListener('pointercancel', up);
  pb.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.repeat || e.code !== 'Space') return;
    e.preventDefault();
    down();
  });
  document.addEventListener('keyup', (e) => e.code === 'Space' && up());

  $('#endBtn').onclick = () => {
    if (!confirm('End the meeting for everyone? Download the transcript first if you need it.')) return;
    mic?.stop();
    conn.send({ t: 'end' });
    store.set('puente.session', '');
    setTimeout(() => location.reload(), 300);
  };
}

setup();
