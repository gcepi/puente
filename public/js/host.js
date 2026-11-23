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
  'openai-translate': 'OpenAI live interpreter (fastest)',
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
  const saved = store.get('puente.engine');
  const usable = cfg.engines.filter((e) => !e.missing.length).map((e) => e.name);
  sel.value = usable.includes(saved) ? saved : usable.includes(cfg.engine) ? cfg.engine : 'mock';
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
      body: JSON.stringify({ engine: sel.value, passcode: $('#passcode').value }),
    });
    const body = await r.json();
    if (!r.ok) return ($('#setupErr').textContent = body.error || 'Could not start');
    store.set('puente.pass', $('#passcode').value, true);
    store.set('puente.engine', sel.value, true);
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
  let mode = 'auto';
  let live = false;
  let mic = null;

  const conn = connect(
    { role: 'host', room: s.code, token: s.hostToken },
    {
      onOpen: () => {
        conn.send({ t: 'mode', mode });
        if (mic) conn.send({ t: 'mic', on: true });
      },
      onStatus: (st) => {
        if (st === 'offline') $('#hostErr').textContent = 'Connection lost — reconnecting…';
        if (st === 'online') $('#hostErr').textContent = '';
      },
      onGone: () => {
        store.set('puente.session', '');
        location.reload();
      },
      onMessage: (m) => {
        if (m.t === 'cap') (m.lang === 'en' ? en : es).set(m.id, m.text, m.final, m.who);
        else if (m.t === 'state') {
          live = m.live;
          $('#who').textContent = m.floor ? `${m.floor} is replying…` : `${m.listeners} listening`;
          $('#dot').className = `dot ${live ? 'live' : 'online'}`;
        } else if (m.t === 'error') $('#hostErr').textContent = m.message;
      },
      onAudio: (buf) => player.play(buf),
    }
  );
  // Browsers only allow sound after a tap; the first tap anywhere unlocks reply audio.
  document.addEventListener('pointerdown', () => !player.ctx && player.unlock().catch(() => {}), { once: true });

  async function startMic() {
    try {
      mic = await openMic(
        (pcm) => conn.buffered < 512 * 1024 && conn.send(pcm),
        (level) => ($('#meter').style.width = `${Math.min(100, level * 400)}%`)
      );
      conn.send({ t: 'mic', on: true });
      $('#micBtn').textContent = '■ Stop translating';
      $('#micBtn').classList.add('on');
      $('#hostErr').textContent = '';
    } catch (e) {
      $('#hostErr').textContent = `Microphone unavailable: ${e.message}. On a phone, the page must be opened over https.`;
    }
  }

  function stopMic() {
    mic?.stop();
    mic = null;
    conn.send({ t: 'mic', on: false });
    $('#micBtn').textContent = '🎙 Start translating';
    $('#micBtn').classList.remove('on');
    $('#meter').style.width = '0';
  }

  $('#micBtn').onclick = () => (mic ? stopMic() : startMic());

  const setMode = (m) => {
    mode = m;
    for (const b of document.querySelectorAll('#modes button')) b.setAttribute('aria-pressed', String(b.dataset.mode === m));
    $('#pttBtn').classList.toggle('hidden', m !== 'ptt');
    $('#flushBtn').classList.toggle('hidden', m !== 'manual');
    conn.send({ t: 'mode', mode: m });
  };
  document.querySelectorAll('#modes button').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

  const ptt = (down) => {
    $('#pttBtn').classList.toggle('down', down);
    conn.send({ t: 'ptt', down });
  };
  const pb = $('#pttBtn');
  pb.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    pb.setPointerCapture(e.pointerId);
    ptt(true);
  });
  pb.addEventListener('pointerup', () => ptt(false));
  pb.addEventListener('pointercancel', () => ptt(false));
  pb.addEventListener('contextmenu', (e) => e.preventDefault());
  $('#flushBtn').onclick = () => conn.send({ t: 'flush' });

  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.repeat) return;
    if (e.code === 'Space' && mode === 'ptt') {
      e.preventDefault();
      ptt(true);
    } else if (e.code === 'Enter' && mode === 'manual') conn.send({ t: 'flush' });
  });
  document.addEventListener('keyup', (e) => e.code === 'Space' && mode === 'ptt' && ptt(false));

  $('#endBtn').onclick = () => {
    if (!confirm('End the meeting for everyone? Download the transcript first if you need it.')) return;
    stopMic();
    conn.send({ t: 'end' });
    store.set('puente.session', '');
    setTimeout(() => location.reload(), 300);
  };
}

setup();
