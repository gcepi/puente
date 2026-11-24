// End-to-end check with the mock engine: a host with a fake microphone starts a
// session, two phone-sized listeners join by code, and we confirm captions in
// both languages and translated voice audio reach them.
// Run: npm run test:e2e   (screenshots land in test/screenshots/)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require('/opt/node-tools/node_modules/playwright');
}
const { chromium, devices } = playwright;

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.join(here, 'screenshots');
fs.mkdirSync(shots, { recursive: true });
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;

const server = spawn('node', ['server/index.js'], {
  cwd: path.join(here, '..'),
  env: { ...process.env, PORT: String(PORT), ENGINE: 'mock', HOST_PASSCODE: '' },
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
  // Host on a laptop-sized screen.
  const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ['microphone'] });
  const host = await hostCtx.newPage();
  host.on('pageerror', (e) => fail(`host page error: ${e.message}`));
  await host.goto(`${BASE}/host`);
  await host.click('button[type=submit]');
  await host.waitForSelector('#roomCode:not(:text("---"))');
  const code = (await host.textContent('#roomCode')).trim();
  console.log(`room ${code}`);

  // Two listeners on phones: one with voice, one text only.
  const phone = devices['Pixel 7'];
  const l1Ctx = await browser.newContext({ ...phone, permissions: ['microphone'] });
  const l1 = await l1Ctx.newPage();
  l1.on('pageerror', (e) => fail(`listener page error: ${e.message}`));
  await l1.goto(`${BASE}/j/${code}`);
  await l1.screenshot({ path: path.join(shots, 'listener-join.png') });
  await l1.fill('#name', 'Pedro');
  await l1.click('#joinAudio');
  await l1.waitForSelector('#live:not(.hidden)');

  const l2Ctx = await browser.newContext({ ...phone });
  const l2 = await l2Ctx.newPage();
  await l2.goto(BASE);
  await l2.fill('#code', code);
  await l2.click('#joinText');
  await l2.waitForSelector('#live:not(.hidden)');

  await host.waitForSelector('#who:text("2 listening")', { timeout: 5000 });

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

  // Reply: listener 1 holds the talk button and speaks Spanish; the host sees and hears English.
  await l1.click('#talkBtn');
  await host.waitForSelector('#who:text("Pedro is replying")', { timeout: 5000 });
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

  await host.screenshot({ path: path.join(shots, 'host.png') });
  await l1.screenshot({ path: path.join(shots, 'listener-live.png') });

  // Transcript download works for the host.
  const href = await host.getAttribute('#transcriptBtn', 'href');
  const md = await (await fetch(`${BASE}${href}`)).text();
  if (!md.includes('**ES:** Buenos días')) fail('transcript missing Spanish');
  if (!md.includes('**Pedro (ES):**')) fail('transcript missing reply');
  console.log(md.split('\n').slice(0, 12).join('\n'));

  // A late joiner sees recent history.
  const l3 = await (await browser.newContext({ ...phone })).newPage();
  await l3.goto(`${BASE}/j/${code}`);
  await l3.click('#joinText');
  await l3.waitForFunction(() => document.querySelectorAll('#esPane .line').length >= 2, null, { timeout: 5000 });
  console.log('late joiner got history');

  if (!process.exitCode) console.log('E2E PASS');
} catch (e) {
  fail(e.stack || e.message);
} finally {
  await browser.close();
  server.kill();
}
