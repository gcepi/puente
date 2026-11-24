import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { attachSolo } from '../server/solo.js';
import { TurnEngine } from '../server/engines/turn.js';

class Phone extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  received = [];

  send(data, opts) {
    this.received.push(opts?.binary ? Buffer.from(data) : JSON.parse(data));
  }
  message(t, fields) {
    this.emit('message', Buffer.from(JSON.stringify({ t, ...fields })), false);
  }
  pcm(data = Buffer.alloc(1920, 25)) {
    this.emit('message', data, true);
  }
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

function connect(makeEngine) {
  const phone = new Phone();
  attachSolo(phone, makeEngine);
  return phone;
}

test('a private socket interprets both directions in order, with transcript and audio only on that socket', async () => {
  const directions = [];
  const makeEngine = (name, hooks, direction, opts) => {
    assert.equal(name, 'turn');
    assert.deepEqual(opts, { oneOnOne: true });
    directions.push(direction);
    const [src, dst] = direction.split('-');
    const words = { en: 'Check unit 204.', es: 'Revisa el 204.' };
    return new TurnEngine(hooks, {
      transcribe: async () => words[src],
      translate: async () => words[dst],
      speak: async (_, emit) => emit(Buffer.alloc(4800, 42)),
    }, { src, dst });
  };
  const phone = connect(makeEngine);
  const other = connect(makeEngine);
  for (const from of ['en', 'es']) {
    const before = phone.received.length;
    phone.message('start', { from });
    phone.pcm(Buffer.alloc(48000, 25));
    phone.message('finish');
    phone.message('finish');
    await nextTick();
    const events = phone.received.slice(before);
    assert.deepEqual(events.map((m) => m.t ?? 'audio'), ['started', 'cap', 'cap', 'cue', 'audio', 'cue', 'done']);
    assert.equal(events[2].lang, from);
    assert.equal(events[2].final, true);
    assert.equal(events[3].lang, from === 'en' ? 'es' : 'en');
    assert.equal(events[3].seconds, 0.1);
    assert.deepEqual(events[4], Buffer.alloc(4800, 42));
    assert.equal(events[5].last, true);
  }
  assert.deepEqual(directions, ['en-es', 'es-en']);
  assert.deepEqual(other.received, [{ t: 'ready' }]);
});

// Record what the protocol commits to the interpreter, including stale callbacks
// deliberately invoked by a delayed provider after a cancellation.
function recorder(onStop = async () => {}) {
  const turns = [];
  const phone = connect((_, hooks) => {
    const turn = { hooks, frames: [], stops: [] };
    turns.push(turn);
    return {
      setMode() {}, start() {},
      audio: (b) => turn.frames.push(b),
      async stop({ discard = false } = {}) {
        turn.stops.push(discard ? 'discard' : 'translate');
        if (!discard) await onStop(turn);
      },
    };
  });
  return { phone, turns };
}

test('cancel, disconnect, and invalid audio discard incomplete recordings and ignore stale output', async () => {
  for (const end of ['cancel', 'disconnect', 'odd', 'oversize', 'empty']) {
    const { phone, turns } = recorder();
    phone.message('start', { from: 'es' });
    if (end !== 'empty') phone.pcm();
    if (end === 'disconnect') phone.emit('close');
    else if (end === 'cancel' || end === 'empty') phone.message(end === 'empty' ? 'finish' : 'cancel');
    else phone.pcm(Buffer.alloc(end === 'odd' ? 1 : 120 * 48_000));
    const before = phone.received.length;
    turns[0].hooks.caption({ lang: 'es', text: 'old', final: true });
    turns[0].hooks.audio(Buffer.alloc(8));
    phone.message('finish');
    await nextTick();
    assert.equal(phone.received.length, before, end);
    assert.deepEqual(turns[0].stops, ['discard'], end);
    assert.equal(phone.received.filter((m) => m.t === 'done').length, end === 'disconnect' ? 0 : 1, end);
    assert.equal(phone.received.filter((m) => m.t === 'error').length, ['odd', 'oversize', 'empty'].includes(end) ? 1 : 0, end);
  }
});

test('recording deadline discards audio without translating a partial turn', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { phone, turns } = recorder();
  phone.message('start', { from: 'en' });
  phone.pcm();
  t.mock.timers.tick(120_000);
  assert.deepEqual(turns[0].stops, ['discard']);
  assert.deepEqual(phone.received.map((m) => m.t), ['ready', 'started', 'error', 'done']);
});

test('an initialization failure releases the accepted turn', () => {
  const phone = connect(() => { throw new Error('Unavailable'); });
  phone.message('start', { from: 'en' });
  assert.deepEqual(phone.received.map((m) => m.t), ['ready', 'started', 'error', 'done']);
});

test('cancellation while processing discards late callbacks and serializes the following turn', async () => {
  let resume;
  const gate = new Promise((resolve) => { resume = resolve; });
  const { phone, turns } = recorder(async (turn) => {
    if (turn === turns[0]) await gate;
    turn.hooks.cue({ lang: 'en', text: turn === turns[0] ? 'stale' : 'new', seconds: 0, last: true });
  });
  phone.message('start', { from: 'es' });
  phone.message('start', { from: 'en' });
  assert.equal(turns.length, 1);
  phone.pcm();
  phone.message('finish');
  phone.message('cancel');
  phone.message('cancel');
  phone.message('start', { from: 'es' });
  phone.pcm(Buffer.alloc(2000, 7));
  phone.message('finish');
  assert.deepEqual(turns[1].stops, []);
  resume();
  await nextTick();
  assert.deepEqual(turns[1].stops, ['translate']);
  assert.equal(Buffer.concat(turns[1].frames).length, 2000);
  assert.deepEqual(phone.received.filter((m) => m.t === 'cue').map((m) => m.text), ['new']);
  assert.equal(phone.received.filter((m) => m.t === 'done').length, 2);
});

test('voice failures retain translated text, and a rejected completion ends the turn', async () => {
  const { phone } = recorder(async ({ hooks }) => {
    hooks.error('Voice unavailable');
    hooks.cue({ lang: 'es', text: 'Revisa el 204.', seconds: 0, last: true });
    throw new Error('Provider unavailable');
  });
  phone.message('start', { from: 'en' });
  phone.pcm();
  phone.message('finish');
  await nextTick();
  const events = phone.received;
  assert.deepEqual(events.map((m) => m.t), ['ready', 'started', 'error', 'cue', 'error', 'done']);
  assert.equal(events[3].text, 'Revisa el 204.');
});
