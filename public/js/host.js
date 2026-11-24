import { connect, CaptionPane, Revealer, keepAwake, openMic, audioContext, micHelp, $ } from './common.js';
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
  const reveal = { en: new Revealer(en), es: new Revealer(es) };

  // Caption size for a cast screen (A- / A+), remembered on this computer.
  let monSize = Number(store.get('puente.monSize')) || 32;
  const applyMon = () => document.documentElement.style.setProperty('--mon-size', `${monSize}px`);
  applyMon();
  const resizeMon = (d) => {
    monSize = Math.max(18, Math.min(72, monSize + d));
    applyMon();
    store.set('puente.monSize', monSize, true);
  };
  $('#monSmaller').onclick = () => resizeMon(-4);
  $('#monBigger').onclick = () => resizeMon(4);
  let mic = null;
  let talking = false;
  let tailUntil = 0;
  let dropped = 0;
  let frames = 0; // frames this page sent during the current press, checked by the server

  const conn = connect(
    { role: 'host', room: s.code, token: s.hostToken },
    {
      onOpen: () => conn.send({ t: 'mode', mode: 'ptt' }),
      onStatus: (st) => {
        if (st === 'offline') $('#hostErr').textContent = 'Connection lost. Reconnecting…';
        if (st === 'online') $('#hostErr').textContent = '';
      },
      onGone: (code) => {
        if (code === 4001) {
          // Another host window took over. Stop here instead of fighting it for the meeting.
          mic?.stop();
          mic = null;
          $('#hostErr').innerHTML = 'This meeting is now open in another window. <button class="icon-btn" id="takeBack">Use it here</button>';
          $('#takeBack').onclick = () => {
            $('#hostErr').textContent = '';
            conn.reopen();
          };
          return;
        }
        store.set('puente.session', '');
        location.reload();
      },
      onMessage: (m) => {
        if (m.t === 'cap') {
          if (m.text !== '…') $('#hostErr').textContent = '';
          (m.lang === 'en' ? en : es).set(m.id, m.text, m.final, m.who);
        } else if (m.t === 'turn') {
          // One-line check after every turn: how much speech arrived and how many words came back.
          const voice = m.voiceIn != null ? ` · voice after ${(m.voiceIn / 1000).toFixed(1)} s` : '';
          const q = `token=${s.hostToken}&t=${Date.now()}`;
          $('#turnInfo').innerHTML = `Last turn: heard ${m.speechSeconds.toFixed(1)} s of speech · ${m.words} words${voice}<br>` +
            `<a href="/api/rooms/${s.code}/heard.wav?${q}" target="_blank" rel="noopener">What it heard</a> · ` +
            `<a href="/api/rooms/${s.code}/voice.wav?${q}" target="_blank" rel="noopener">Voice it sent</a>`;
        } else if (m.t === 'cuelen') {
          reveal[m.lang]?.setLength(m.id, m.seconds);
        } else if (m.t === 'cue') {
          if (m.text) $('#hostErr').textContent = '';
          // Replies play on this screen, so they sync to its audio; the briefing is paced to match the phones.
          reveal[m.lang]?.add(m, m.to === 'host' ? player.startIn() : null);
        } else if (m.t === 'state') {
          $('#who').textContent = m.floor ? `${m.floor} is replying…` : `${m.listeners} listening`;
          $('#dot').className = `dot ${m.floor || talking ? 'live' : 'online'}`;
        } else if (m.t === 'error') $('#hostErr').textContent = m.message;
      },
      onAudio: (buf) => player.play(buf),
    }
  );
  // Browsers only allow sound after a tap; the first tap anywhere unlocks reply audio.
  document.addEventListener('pointerdown', () => !player.ctx && player.unlock().catch(() => {}), { once: true });

  // Live English can be switched off if dictation ever misbehaves in a browser.
  const lt = $('#liveToggle');
  // Off unless switched on: browser dictation is the least proven piece.
  lt.checked = store.get('puente.live') === 'on';
  lt.disabled = !(window.SpeechRecognition || window.webkitSpeechRecognition);
  lt.onchange = () => store.set('puente.live', lt.checked ? 'on' : 'off', true);

  // ---- live English while holding: the browser's own dictation (Chrome; Safari where available) ----
  // The accurate transcript replaces it when the button is released.
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let liveBase = '';
  let liveSession = '';
  let liveSentAt = 0;
  let liveTimer = null;
  const joinText = (a, b) => [a, b].filter(Boolean).join(' ').trim();
  const sendLive = () => {
    clearTimeout(liveTimer);
    const wait = 150 - (Date.now() - liveSentAt);
    if (wait > 0) return void (liveTimer = setTimeout(sendLive, wait));
    liveSentAt = Date.now();
    if (talking) conn.send({ t: 'live', text: joinText(liveBase, liveSession) });
  };
  function startLive() {
    if (!SR || !$('#liveToggle').checked) return;
    liveBase = '';
    liveSession = '';
    try {
      rec = new SR();
      rec.lang = 'en-US';
      rec.continuous = true;
      rec.interimResults = true;
      rec.onresult = (e) => {
        liveSession = Array.from(e.results, (r) => r[0].transcript).join('');
        sendLive();
      };
      rec.onend = () => {
        // Dictation stops on its own after a pause; keep going while the button is held.
        liveBase = joinText(liveBase, liveSession);
        liveSession = '';
        if (talking && rec) {
          try {
            rec.start();
          } catch {}
        }
      };
      rec.onerror = () => {};
      rec.start();
    } catch {
      rec = null;
    }
  }
  function stopLive() {
    const r = rec;
    rec = null;
    try {
      r?.stop();
    } catch {}
  }

  // ---- push to talk: hold, speak, release; the Spanish voice repeats it ----
  const pb = $('#pttBtn');
  const paint = () => {
    pb.classList.toggle('down', talking);
    $('#pttLabel').textContent = talking ? 'Listening… release to translate' : 'Hold to talk';
  };
  async function down() {
    if (talking) return;
    audioContext(); // Safari: start audio inside the tap, before any await
    if (!player.ctx) player.unlock().catch(() => {});
    talking = true;
    paint();
    player.skip(); // stop any reply audio so it isn't recorded
    dropped = 0;
    frames = 0;
    $('#turnInfo').textContent = '';
    conn.send({ t: 'ptt', down: true });
    startLive();
    if (!mic) {
      try {
        mic = await Promise.race([
          openMic(
            (pcm) => {
              if (!talking && Date.now() >= tailUntil) return;
              // Only a badly stalled connection drops audio, and the host is told.
              if (conn.buffered < 4 * 1024 * 1024) conn.send(pcm);
              else dropped++;
              frames++;
            },
            (level) => ($('#meter').style.width = `${talking ? Math.min(100, level * 400) : 0}%`)
          ),
          new Promise((_, reject) => setTimeout(() => reject(new Error('it did not start within 5 seconds; check the browser allows the microphone for this site')), 5000)),
        ]);
        $('#hostErr').textContent = '';
      } catch (e) {
        talking = false;
        paint();
        conn.send({ t: 'ptt', down: false });
        $('#hostErr').textContent = micHelp(e, 'en');
      }
    }
  }
  function up() {
    if (!talking) return;
    talking = false;
    paint();
    stopLive();
    // Keep the last syllable: send a beat of audio after release.
    tailUntil = Date.now() + 250;
    setTimeout(() => {
      conn.send({ t: 'ptt', down: false, dropped, frames });
      dropped = 0;
      frames = 0;
    }, 250);
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
