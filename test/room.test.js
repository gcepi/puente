import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

process.env.ROOM_CODE = '750';
const { config } = await import('../server/config.js');
const { createRoom, getRoom } = await import('../server/room.js');

test('standing room code: every meeting is 750, and a live room is reused', () => {
  const a = createRoom('mock');
  assert.equal(a.code, '750');
  assert.equal(getRoom(' 750 '), a);
  const b = createRoom('mock');
  assert.equal(b, a, 'second host start joins the live room instead of replacing it');
});

test('after the meeting ends, the next one gets a fresh 750 room', () => {
  const a = getRoom('750');
  a.end();
  const b = createRoom('mock');
  assert.notEqual(b, a);
  assert.equal(b.code, '750');
  assert.notEqual(b.hostToken, a.hostToken);
});

test('host disconnect immediately cancels the open reply and waits for the host to return', (t) => {
  const room = createRoom('mock');
  const socket = () => Object.assign(new EventEmitter(), { readyState: 1, send: t.mock.fn(), close() {} });
  const host = socket();
  const crew = socket();
  t.after(() => room.end());
  room.attachHost(host);
  room.attachListener(crew, 'Pedro');
  room.takeFloor(crew);
  const { engine } = room.reply;
  const flush = t.mock.method(engine, 'flush');
  host.emit('close');
  const state = JSON.parse(crew.send.mock.calls.at(-1).arguments[0]);
  assert.equal(state.hostConnected, false);
  assert.equal(state.floor, null);
  assert.equal(flush.mock.callCount(), 0);
  room.takeFloor(crew);
  assert.equal(room.reply, null);
  assert.equal(JSON.parse(crew.send.mock.calls.at(-1).arguments[0]).t, 'error');
  const newHost = socket();
  room.attachHost(newHost);
  const before = newHost.send.mock.callCount();
  engine.hooks.cue({ id: 'old', lang: 'en', text: 'interrupted reply', last: true });
  engine.hooks.audio(Buffer.alloc(4800));
  assert.equal(newHost.send.mock.callCount(), before);
  assert.doesNotMatch(room.transcriptMarkdown(), /interrupted reply/);
  room.takeFloor(crew);
  assert.equal(room.reply.ws, crew);
});

test('host mic resumes 300 ms after a multi-chunk reply finishes playing', (t) => {
  let now = 100_000;
  t.mock.method(Date, 'now', () => now);
  const room = createRoom('mock');
  t.after(() => room.end());
  room.host = { readyState: 1, send() {} };
  room.startEngine();
  room.takeFloor({});
  const sendReplyAudio = room.reply.engine.hooks.audio;
  room.releaseFloor();

  const chunk = Buffer.alloc(9600); // 200 ms of 24 kHz PCM16
  for (let i = 0; i < 20; i++) sendReplyAudio(chunk);
  now += 4299; // 4 s of playback plus the echo guard
  room.onHostAudio(chunk);
  assert.equal(room.micSeconds, 0);
  now += 1;
  room.onHostAudio(chunk);
  assert.equal(room.micSeconds, 0.2);
});

test('restarting the host engine preserves both bilingual turns in the room', (t) => {
  const room = createRoom('mock');
  t.after(() => room.end());
  const messages = [];
  room.host = { readyState: 1, send: (data) => messages.push(JSON.parse(data)) };
  const startTurn = (text) => {
    room.onHostMessage(JSON.stringify({ t: 'ptt', down: true }));
    room.engine.peekId = () => 't0'; // each fresh push-to-talk engine starts at t0
    room.onHostMessage(JSON.stringify({ t: 'live', text }));
    room.engine.hooks.caption({ id: 't0', lang: 'en', text, final: true });
    return room.engine.hooks;
  };
  const first = startTurn('Unit 204.');
  room.stopEngine();
  const second = startTurn('Unit 301.');
  // A turn can finish translating after the next engine has already started.
  for (const [hooks, text] of [[first, 'Departamento 204.'], [second, 'Departamento 301.']]) {
    hooks.cue({ id: 't0', lang: 'es', text, seconds: 1, last: true });
    hooks.cueLength({ id: 't0', lang: 'es', seconds: 1 });
    hooks.stats({ id: 't0', speechSeconds: 1, parts: 1, words: 2, transcribedIn: 10 });
  }
  const rows = room.transcriptMarkdown().split('\n').filter((line) => line.includes('**'));
  assert.deepEqual(rows, [
    '- **EN:** Unit 204.', '  **ES:** Departamento 204.',
    '- **EN:** Unit 301.', '  **ES:** Departamento 301.',
  ]);
  const ids = (type, final) => messages.filter((m) => m.t === type && m.final === final).map((m) => m.id);
  const expected = ids('cap', true);
  assert.equal(new Set(expected).size, 2);
  assert.deepEqual(ids('cap', false), expected);
  for (const type of ['cue', 'cuelen', 'turn']) assert.deepEqual(ids(type), expected);
});

for (const interruption of ['disconnect', 'takeover']) {
  test(`host ${interruption} discards its open hold and preserves released turns`, async (t) => {
    const savedKey = config.openaiKey;
    config.openaiKey = 'local-test';
    t.after(() => { config.openaiKey = savedKey; });
    const room = createRoom('turn');
    t.after(() => room.end());
    const socket = () => Object.assign(new EventEmitter(), { readyState: 1, send() {}, close() {} });
    const press = (ws, down) => ws.emit('message', JSON.stringify({ t: 'ptt', down }), false);
    const sound = (ws, value) => ws.emit('message', Buffer.alloc(24000, value), true);
    const firstHost = socket();
    room.attachHost(firstHost);
    firstHost.emit('message', JSON.stringify({ t: 'mode', mode: 'ptt' }), false);
    press(firstHost, true);
    let finishFirst;
    const wait = new Promise((resolve) => { finishFirst = resolve; });
    const lengths = [];
    room.engine.deps = {
      transcribe: async (pcm) => {
        lengths.push(pcm.length);
        if (pcm[0] === 10) await wait;
        return String(pcm[0]);
      },
      translate: async (text) => `Unidad ${text}.`,
      speak: async () => {},
    };
    sound(firstHost, 10);
    press(firstHost, false);
    press(firstHost, true);
    sound(firstHost, 20);
    firstHost.emit('message', JSON.stringify({ t: 'live', text: 'Interrupted' }), false);
    assert.match(room.transcriptMarkdown(), /Interrupted/);

    if (interruption === 'disconnect') firstHost.emit('close');
    const nextHost = socket();
    room.attachHost(nextHost);
    assert.equal(room.pttDown, false);
    assert.doesNotMatch(room.transcriptMarkdown(), /Interrupted/);
    press(nextHost, true);
    sound(firstHost, 40); // late frames and release from the displaced window
    press(firstHost, false);
    sound(nextHost, 30);
    press(nextHost, false);
    finishFirst();
    await room.engine.chain;

    assert.deepEqual(lengths, [24000, 24000]);
    const rows = room.transcriptMarkdown().split('\n').filter((line) => line.includes('**'));
    assert.deepEqual(rows, ['- **EN:** 10', '  **ES:** Unidad 10.', '- **EN:** 30', '  **ES:** Unidad 30.']);
  });
}
