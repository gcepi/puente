import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.ROOM_CODE = '750';
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
