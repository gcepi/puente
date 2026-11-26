// Run with npm run test:solo after npx playwright install chromium.
// Only provider HTTP is simulated. The browser records real frames through the
// mic worklet and receives them back through the application's private turn engine.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { chromium, devices } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pcmToWav } from '../server/providers/openai.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'puente-solo-test-'));
const fakeMic = path.join(profile, 'microphone.wav');
const micSamples = Buffer.alloc(2 * 24000);
for (let i = 0; i < 24000; i++) micSamples.writeInt16LE(Math.round(5000 * Math.sin(2 * Math.PI * 330 * i / 24000)), 2 * i);
await fs.writeFile(fakeMic, pcmToWav(micSamples));
const port = Number(process.env.SOLO_TEST_PORT || 3942);
const base = `http://localhost:${port}`;
const passcode = 'solo-browser-test';
const server = spawn(process.execPath, ['--import', './test/fixtures/solo-providers.mjs', 'server/index.js'], {
  cwd: root,
  env: { ...process.env, PORT: String(port), HOST_PASSCODE: passcode, ENGINE: 'turn', ROOM_CODE: '750',
    OPENAI_API_KEY: 'test-only', ELEVENLABS_API_KEY: 'test-only', ELEVENLABS_VOICE_ID: 'solo-test-es',
    ELEVENLABS_REPLY_VOICE_ID: 'solo-test-en', ANTHROPIC_API_KEY: '', DEEPGRAM_API_KEY: '' },
  stdio: ['ignore', 'pipe', 'inherit'],
});

let context;
const pageErrors = [];
async function launchPhone() {
  context = await chromium.launchPersistentContext(path.join(profile, 'browser'), {
    ...devices['Pixel 7'], permissions: ['microphone'],
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fakeMic}`],
  });
  await context.addInitScript(() => {
    window.soloSockets = [];
    const BrowserSocket = window.WebSocket;
    window.WebSocket = class extends BrowserSocket {
      constructor(...args) {
        super(...args);
        if (new URL(this.url).searchParams.get('role') === 'solo') window.soloSockets.push(this);
      }
    };
    window.speechBuffers = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...args) {
      if (this.buffer?.duration > 0.02 && this.buffer.getChannelData(0).some((sample) => Math.abs(sample) > 0.01)) window.speechBuffers++;
      return start.apply(this, args);
    };
  });
  const page = context.pages()[0];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  return page;
}

async function spokenTurn(page, button, source, translated) {
  const oldBuffers = await page.evaluate(() => window.speechBuffers);
  await button.click();
  await page.locator('#soloApp[data-state=recording]').waitFor();
  // A full second of real mic worklet frames passes the production silence gate.
  await page.waitForTimeout(1300);
  await button.click();
  const transcript = page.locator('#transcript');
  await transcript.getByText(source, { exact: true }).last().waitFor();
  await transcript.getByText(translated, { exact: true }).last().waitFor();
  await page.waitForFunction((previous) => window.speechBuffers > previous, oldBuffers);
  await page.locator('#soloApp[data-state=ready]').waitFor();
}

try {
  await Promise.race([
    once(server.stdout, 'data'),
    once(server, 'exit').then(([code]) => { throw new Error(`Solo test server stopped on startup (${code})`); }),
  ]);
  let page = await launchPhone();
  await page.goto(`${base}/host`);
  const hostManifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  const hostManifest = await (await context.request.get(new URL(hostManifestHref, base).href)).json();
  assert.equal(hostManifest.id, '/host');
  assert.equal(hostManifest.start_url, '/host');
  assert.equal(hostManifest.display, 'standalone');
  assert.equal(await page.locator('meta[name="apple-mobile-web-app-title"]').getAttribute('content'), 'Puente Host');
  await context.close();
  page = await launchPhone();
  await page.goto(new URL(hostManifest.start_url, base).href);
  const oneOnOne = page.locator('#setup a[href="/solo"]');
  await oneOnOne.waitFor();
  await oneOnOne.click();
  await page.locator('#auth').waitFor();
  await page.goto(base);
  assert.equal(await page.locator('link[rel="manifest"]').getAttribute('href'), '/manifest.webmanifest');
  assert.equal(await page.locator('a[href="/solo"]').count(), 0, 'no host link on crew join page');
  await page.goto(`${base}/solo`);
  await page.locator('#auth').waitFor({ state: 'visible' });
  const denied = await context.request.post(`${base}/api/solo/access`, { data: { passcode: 'incorrect' } });
  assert.equal(denied.status(), 401);
  assert.equal((await (await context.request.get(`${base}/api/solo/access`)).json()).authorized, false);
  await page.locator('#passcode').fill(passcode);
  await page.locator('#auth button[type=submit]').click();
  await page.waitForFunction(() => document.querySelector('#speakEn')?.disabled === false);

  const manifestHref = await page.locator('link[rel="manifest"]').getAttribute('href');
  const manifest = await (await context.request.get(new URL(manifestHref, base).href)).json();
  const launchUrl = new URL(manifest.start_url, base);
  assert.equal(launchUrl.pathname, '/solo');
  assert.equal(manifest.display, 'standalone');

  // Keep a separate meeting open with a crew member; both turns must stay private.
  const crewContext = await context.browser().newContext();
  const roomResponse = await context.request.post(`${base}/api/rooms`, { data: { engine: 'mock', passcode } });
  assert.ok(roomResponse.ok());
  const room = await roomResponse.json();
  const crew = await crewContext.newPage();
  await crew.goto(`${base}/j/${room.code}`);
  assert.equal(await crew.locator('a[href="/solo"]').count(), 0);
  await crew.click('#joinAudio');
  await crew.locator('#live').waitFor({ state: 'visible' });
  const outsider = await crewContext.newPage();
  await outsider.goto(`${base}/solo`);
  await outsider.locator('#auth').waitFor({ state: 'visible' });
  const access = await (await crewContext.request.get(`${base}/api/solo/access`)).json();
  assert.equal(access.authorized, false, 'joining the team meeting grants no solo access');
  const closed = await outsider.evaluate(() => new Promise((resolve) => {
    const socket = new WebSocket(`ws://${location.host}/ws?role=solo`);
    socket.onclose = (event) => resolve(event.code);
    socket.onmessage = () => { resolve('unexpected private session'); socket.close(); };
  }));
  assert.equal(closed, 4003, 'solo connection requires host access');

  await spokenTurn(page, page.locator('#speakEn'), 'Please check the sink in unit 204.', 'Por favor, revisa el lavabo del departamento 204.');
  await spokenTurn(page, page.locator('#speakEs'), '¿A qué hora llega el plomero?', 'What time does the plumber arrive?');
  assert.equal(await crew.locator('#enPane .line, #esPane .line').count(), 0, 'no private speech appears on a crew phone');
  const transcript = await context.request.get(`${base}/api/rooms/${room.code}/transcript`, { params: { token: room.hostToken } });
  assert.ok(transcript.ok());
  assert.doesNotMatch(await transcript.text(), /sink|lavabo|plomero|plumber/);
  await fs.mkdir(path.join(root, 'test/screenshots'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'test/screenshots/solo-mobile.png'), scale: 'css' });
  // A shorter phone can only show a few lines. Follow new turns until someone scrolls up to reread.
  await page.setViewportSize({ width: 375, height: 650 });
  const history = page.locator('#transcript');
  await history.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await spokenTurn(page, page.locator('#speakEn'), 'Please check the sink in unit 204.', 'Por favor, revisa el lavabo del departamento 204.');
  assert.ok(await history.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop < 4), 'follow the latest translation');
  await history.evaluate((el) => { el.scrollTop = 0; });
  await spokenTurn(page, page.locator('#speakEs'), '¿A qué hora llega el plomero?', 'What time does the plumber arrive?');
  assert.equal(await history.evaluate((el) => el.scrollTop), 0, 'preserve scroll position while reviewing earlier turns');
  const granted = (await context.cookies()).filter((cookie) => cookie.httpOnly && cookie.expires > Date.now() / 1000);
  assert.ok(granted.some((cookie) => cookie.name === 'puente_solo'), 'a persistent HTTP-only cookie remembers host access');

  // Fully close Chromium, then reopen the same phone profile at the installed app's launch URL.
  await context.close();
  page = await launchPhone();
  await page.goto(launchUrl.href);
  await page.waitForFunction(() => document.querySelector('#speakEn')?.disabled === false);
  assert.equal(await page.locator('#auth').isVisible(), false, 'host authorization survives a cold launch');
  assert.doesNotMatch(await page.locator('#transcript').textContent(), /lavabo|plomero/, 'private history ends with the previous session');
  // An accidental tap ends cleanly and neither schedules voice nor pollutes the conversation.
  await page.evaluate(() => {
    const app = document.querySelector('#soloApp');
    const stopBeforeFirstFrame = new MutationObserver(() => {
      if (app.dataset.state !== 'recording') return;
      stopBeforeFirstFrame.disconnect();
      document.querySelector('#speakEs').click();
      window.instantTurnStopped = true;
    });
    stopBeforeFirstFrame.observe(app, { attributes: true, attributeFilter: ['data-state'] });
  });
  await page.locator('#speakEs').click();
  await page.waitForFunction(() => window.instantTurnStopped && document.querySelector('#soloApp').dataset.state === 'ready');
  assert.equal(await page.evaluate(() => window.speechBuffers), 0);
  assert.doesNotMatch(await page.locator('#transcript').textContent(), /lavabo|plomero/);
  // The network drops while the mic is open. The next turn must work without submitting the abandoned audio.
  await page.locator('#speakEn').click();
  await page.locator('#soloApp[data-state=recording]').waitFor();
  await page.waitForTimeout(650);
  await context.setOffline(true);
  await page.evaluate(() => window.soloSockets.at(-1).close(4002, 'simulated disconnect'));
  await page.waitForFunction(() => document.querySelector('#speakEn').disabled);
  await context.setOffline(false);
  await page.waitForFunction(() => window.soloSockets.length > 1 && window.soloSockets.at(-1).readyState === 1 && !document.querySelector('#speakEn').disabled);
  assert.equal(await page.evaluate(() => window.speechBuffers), 0);
  assert.doesNotMatch(await page.locator('#transcript').textContent(), /lavabo|plomero/);
  await spokenTurn(page, page.locator('#speakEs'), '¿A qué hora llega el plomero?', 'What time does the plumber arrive?');
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await context.setOffline(true);
  await page.reload();
  await page.getByText('Connect to Wi-Fi or cellular data to translate.').waitFor();
  assert.equal(await page.locator('#transcript').count(), 0);
  await context.setOffline(false);
  await page.getByRole('link', { name: /Try again/ }).click();
  await page.locator('#soloApp[data-state=ready]').waitFor();
  assert.deepEqual(pageErrors, []);
  console.log('Solo mobile E2E passed: host access, bilingual voice and captions, meeting isolation, cold home-screen relaunch, and disconnect recovery.');
} finally {
  await context?.close();
  server.kill();
  await fs.rm(profile, { recursive: true, force: true });
}
