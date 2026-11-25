// End-to-end check with the mock engine: a host with a fake microphone starts a
// session, two phone-sized listeners join by link, and we confirm captions in
// both languages and translated voice audio reach them.
// Run: npm run test:e2e   (screenshots land in test/screenshots/)
import { spawn } from 'node:child_process';
import { chromium, devices } from 'playwright';
import assert from 'node:assert/strict';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const standingRoom = '817'; // Exercise the configured room, independent of the production default.

const server = spawn('node', ['server/index.js'], {
  cwd: path.join(here, '..'),
  env: {
    ...process.env, PORT: String(PORT), ENGINE: 'mock', HOST_PASSCODE: '', ROOM_CODE: standingRoom, PUBLIC_URL: BASE,
    OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', DEEPGRAM_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((r) => server.stdout.once('data', r));

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const phone = devices['Pixel 7'];
  async function crewPhone() {
    const context = await browser.newContext({ ...phone, permissions: ['microphone'] });
    await context.addInitScript(() => {
      const media = navigator.mediaDevices;
      const getMedia = media.getUserMedia.bind(media);
      window.micRequests = 0;
      media.getUserMedia = (...args) => { window.micRequests++; return getMedia(...args); };
    });
    return context;
  }

  // A crew member can open the public link before the meeting and retry the same button later.
  const l2Ctx = await crewPhone();
  const l2 = await l2Ctx.newPage();
  await l2.goto(BASE);
  const entry = l2.locator('#joinForm button');
  assert.equal(await entry.count(), 1, 'one bilingual join action');
  assert.match(await entry.textContent(), /Enter Meeting/i);
  assert.match(await entry.textContent(), /Entrar a la reunión/i);
  assert.equal(await l2.locator('#code').count(), 0, 'no room code to type');
  await entry.click();
  await l2.getByText(/Todavía no hay una reunión activa/i).waitFor();
  assert.equal(await l2.locator('#live').isVisible(), false);
  assert.equal(await l2.evaluate(() => window.micRequests), 0);

  // Host on a laptop-sized screen.
  const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone'] });
  const host = await hostCtx.newPage();
  const presses = [];
  host.on('websocket', (ws) => ws.on('framesent', ({ payload }) => {
    if (typeof payload !== 'string') return;
    const msg = JSON.parse(payload);
    if (msg.t === 'ptt') presses.push(msg.down);
  }));
  host.on('pageerror', (e) => fail(`host page error: ${e.message}`));
  await host.goto(`${BASE}/host`);
  await host.click('button[type=submit]');
  await host.waitForFunction(() => document.querySelector('#joinUrl')?.textContent.includes('/j/'));
  const joinUrl = (await host.textContent('#joinUrl')).trim();
  const code = new URL(joinUrl).pathname.split('/').at(-1);
  assert.equal(joinUrl, `${BASE}/j/${standingRoom}`);
  const expectedQr = await QRCode.toString(joinUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  const qrMatchesLink = await host.locator('#qr svg').evaluate((qr, expected) => {
    const compare = new DOMParser().parseFromString(expected, 'image/svg+xml');
    return qr.querySelector('path[stroke]').getAttribute('d') === compare.querySelector('path[stroke]').getAttribute('d');
  }, expectedQr);
  assert.ok(qrMatchesLink, 'the QR encodes the displayed meeting-specific join URL');
  console.log(`room ${code}`);

  // A link for a different room must never silently join the live standing room.
  const l1Ctx = await crewPhone();
  const l1 = await l1Ctx.newPage();
  l1.on('pageerror', (e) => fail(`listener page error: ${e.message}`));
  await l1.goto(`${BASE}/j/999`);
  await l1.click('#joinAudio');
  await l1.getByText(/Esta reunión no está activa/i).waitFor();
  assert.equal(await l1.locator('#live').isVisible(), false);
  await l1.goto(joinUrl);
  await l1.screenshot({ path: path.join(shots, 'listener-join.png') });
  await l1.fill('#name', 'Pedro');
  await l1.click('#joinAudio');
  await l1.waitForSelector('#live:not(.hidden)');
  assert.equal(l1.url(), joinUrl);
  const lookup = l2.waitForResponse((res) => new URL(res.url()).pathname === '/api/rooms/current');
  await entry.click();
  assert.equal((await (await lookup).json()).code, code, 'public link resolves the active standing room');
  await l2.waitForSelector('#live:not(.hidden)');
  await host.waitForSelector('#who:text("2 listening")', { timeout: 5000 });
  for (const listener of [l1, l2]) {
    assert.equal(await listener.evaluate(() => window.micRequests), 0, 'hearing the manager does not open the crew microphone');
    assert.equal(await listener.getAttribute('#audioBtn', 'aria-pressed'), 'true', 'voice starts enabled');
  }
  await l2.click('#audioBtn');
  assert.equal(await l2.getAttribute('#audioBtn', 'aria-pressed'), 'false', 'voice can be muted in the meeting');

  // Simulate a first visit where permission takes longer than five seconds.
  await host.evaluate(() => {
    const media = navigator.mediaDevices;
    const getMedia = media.getUserMedia.bind(media);
    const permission = new Promise((resolve) => { window.allowMic = resolve; });
    window.micRequests = 0;
    media.getUserMedia = async (constraints) => {
      window.micRequests++;
      await permission;
      const stream = await getMedia(constraints);
      window.lastMicTrack = stream.getAudioTracks()[0];
      return stream;
    };
  });
  await host.keyboard.down('Space');
  await host.waitForSelector('#pttLabel:text("Opening microphone")');
  await host.keyboard.up('Space');
  await host.keyboard.down('Space');
  await host.waitForTimeout(5100);
  if ((await host.textContent('#pttLabel')).includes('Listening') || presses.length) fail('claimed to listen before microphone permission');
  await host.keyboard.up('Space');
  await host.evaluate(() => window.allowMic());
  await host.waitForFunction(() => window.lastMicTrack?.readyState === 'ended');
  if ((await host.evaluate(() => window.micRequests)) !== 1) fail('opened duplicate microphone requests');
  console.log('late microphone permission cleaned up without an empty turn');

  // Push to talk: nothing happens until the host holds the button.
  const hold = async (page, sel, ms) => {
    const b = await (await page.$(sel)).boundingBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(ms);
    await page.mouse.up();
  };
  await host.waitForTimeout(800);
  if ((await l1.$$eval('#enPane .line', (n) => n.length)) !== 0) fail('captions appeared before anyone talked');
  // Hold long enough for the mock to "hear" the first sentence, release, then the voice speaks.
  await hold(host, '#pttBtn', 3600);
  // Spanish is revealed word by word with the voice, not dumped all at once.
  await l1.waitForFunction(() => document.querySelector('#esPane .line'), null, { timeout: 15000 });
  const early = (await l1.textContent('#esPane .line')).split(' ').length;
  await l1.waitForFunction(() => document.querySelectorAll('#esPane .line:not(.partial)').length >= 1, null, { timeout: 15000 });
  const full = (await l1.textContent('#esPane .line')).split(' ').length;
  console.log(`reveal: ${early} words at first, ${full} when the voice finished`);
  if (early >= full) fail('Spanish appeared all at once instead of with the voice');
  await hold(host, '#pttBtn', 2500);
  await l1.waitForFunction(() => document.querySelectorAll('#esPane .line:not(.partial)').length >= 2, null, { timeout: 15000 });
  const es = await l1.$$eval('#esPane .line', (n) => n.map((x) => x.textContent));
  const en = await l1.$$eval('#enPane .line', (n) => n.map((x) => x.textContent));
  console.log('EN:', en.slice(0, 2));
  console.log('ES:', es.slice(0, 2));
  if (!es[0]?.startsWith('Buenos días')) fail('first Spanish caption missing');
  if (!en[0]?.startsWith('Good morning')) fail('English caption missing');
  await l1.waitForTimeout(1500);
  const voice = await l1.evaluate(() => window.__puente.player.stats);
  console.log('listener 1 voice:', voice);
  if (voice.chunks < 5 || voice.seconds < 1) fail('listener with voice received no audio');
  const textOnly = await l2.evaluate(() => window.__puente.player.stats);
  if (textOnly.chunks !== 0) fail('text-only listener should not play audio');
  const l2es = await l2.$$eval('#esPane .line', (n) => n.length);
  if (l2es < 2) fail('text-only listener missing captions');
  const idle = await l1.$$eval('#enPane .line', (n) => n.length);
  await host.waitForTimeout(1500);
  if ((await l1.$$eval('#enPane .line', (n) => n.length)) !== idle) fail('audio leaked while the button was up');
  console.log('push-to-talk turns delivered');

  // The crew microphone opens only when a listener taps to reply.
  await l1.click('#talkBtn');
  await host.waitForSelector('#who:text("Pedro is replying")', { timeout: 5000 });
  assert.equal(await l1.evaluate(() => window.micRequests), 1);
  assert.equal(await l2.evaluate(() => window.micRequests), 0);
  const l2Talk = await l2.$('#talkBtn');
  if (l2Talk && (await l2Talk.isVisible()) && !(await l2Talk.isDisabled())) fail('second listener could talk over the first');
  await l1.waitForTimeout(3600);
  await l1.click('#talkBtn');
  await host.waitForFunction(() => [...document.querySelectorAll('#enPane .line')].some((l) => l.textContent.includes('What time do you need 204')), null, { timeout: 8000 });
  const replyRow = await host.$$eval('#esPane .line', (n) => n.map((x) => x.textContent).find((t) => t.includes('¿A qué hora')));
  if (!replyRow?.startsWith('Pedro')) fail(`reply not labeled with speaker: ${replyRow}`);
  await host.waitForTimeout(1200);
  const hostVoice = await host.evaluate(() => window.__puente.player.stats);
  console.log('host heard reply:', hostVoice);
  if (hostVoice.chunks < 3) fail('host did not hear the reply');
  await host.waitForSelector('#who:text("listening")', { timeout: 5000 });
  console.log('reply round-trip delivered');

  // Diagnostics: the host can hear what the server heard and the voice it sent.
  await host.waitForSelector('#turnInfo a');
  for (const href of await host.$$eval('#turnInfo a', (a) => a.map((x) => x.getAttribute('href')))) {
    const r = await fetch(`${BASE}${href}`);
    const n = (await r.arrayBuffer()).byteLength;
    if (r.status !== 200 || r.headers.get('content-type') !== 'audio/wav' || n < 1000) fail(`diagnostic ${href} -> ${r.status} ${n} bytes`);
  }
  console.log('diagnostic audio links work');

  // A second tab on the same phone replaces the first, so the voice never plays twice.
  const l1b = await l1Ctx.newPage();
  await l1b.goto(joinUrl);
  await l1b.click('#joinAudio');
  await l1.waitForSelector('#title:text("Abierta en otra pestaña")', { timeout: 5000 });
  if (await l1.evaluate(() => window.__puente.player.enabled)) fail('old tab still plays the voice');
  await host.waitForSelector('#who:text("2 listening")', { timeout: 5000 });
  console.log('second tab on the same phone silenced the first');

  // A second host window takes over once and the first stops; they must not trade the meeting back and forth.
  const host2 = await hostCtx.newPage();
  await host2.goto(`${BASE}/host`);
  await host2.click('button[type=submit]');
  await host2.waitForFunction((url) => document.querySelector('#joinUrl')?.textContent === url, joinUrl);
  await host.waitForSelector('#takeBack', { timeout: 5000 });
  let flips = 0;
  host2.on('websocket', () => flips++);
  // The crew speaks first on this host. Starting the meeting should be enough to hear the reply.
  await l1b.click('#talkBtn');
  await host2.waitForSelector('#who:text("is replying")');
  await l1b.waitForTimeout(1500);
  await l1b.click('#talkBtn');
  await host2.waitForFunction(() => window.__puente.player.stats.seconds > 0);
  console.log('new host heard the crew before touching its mic');
  await host2.waitForTimeout(3000);
  if (flips) fail(`host windows kept trading the meeting (${flips} reconnects)`);
  const before = await l1b.$$eval('#enPane .line', (n) => n.length);
  await hold(host2, '#pttBtn', 2500);
  await l1b.waitForFunction((n) => document.querySelectorAll('#enPane .line').length > n, before, { timeout: 10000 });
  await host.click('#takeBack');
  await host2.waitForSelector('#takeBack', { timeout: 5000 });
  console.log('second host window took over cleanly, and "Use it here" takes it back');

  await host.screenshot({ path: path.join(shots, 'host.png') });
  await l1b.screenshot({ path: path.join(shots, 'listener-live.png') });

  // Transcript download works for the host.
  const href = await host.getAttribute('#transcriptBtn', 'href');
  const md = await (await fetch(`${BASE}${href}`)).text();
  if (!md.includes('**ES:** Buenos días')) fail('transcript missing Spanish');
  if (!md.includes('**Pedro (ES):**')) fail('transcript missing reply');
  console.log(md.split('\n').slice(0, 12).join('\n'));

  // A late joiner sees recent history.
  const l3 = await (await browser.newContext({ ...phone })).newPage();
  await l3.goto(joinUrl);
  await l3.click('#joinAudio');
  await l3.waitForFunction(() => document.querySelectorAll('#esPane .line').length >= 2, null, { timeout: 5000 });
  console.log('late joiner got history');

  // Re-press before the audio tail expires. The old release must precede the new press.
  const start = presses.length;
  await host.keyboard.down('Space');
  await host.waitForSelector('#pttLabel:text("Listening")');
  await host.keyboard.up('Space');
  await host.keyboard.down('Space');
  await host.waitForTimeout(300);
  await host.keyboard.up('Space');
  await host.waitForTimeout(350);
  if (JSON.stringify(presses.slice(start)) !== '[true,false,true,false]') fail('quick presses mixed turn boundaries');
  console.log('back-to-back press and release events kept in order');

  host.once('dialog', (dialog) => dialog.accept());
  await host.click('#endBtn');
  await l2.getByText('La junta terminó').waitFor();
  await l2.goto(BASE);
  await l2.click('#joinAudio');
  await l2.getByText(/Todavía no hay una reunión activa/i).waitFor();
  assert.equal(await l2.locator('#live').isVisible(), false);
  console.log('public entry handles meetings that have not started or have ended');
  if (!process.exitCode) console.log('E2E PASS');
} catch (e) {
  fail(e.stack || e.message);
} finally {
  await browser.close();
  server.kill();
}
