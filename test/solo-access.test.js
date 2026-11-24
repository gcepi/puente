import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSoloAccess } from '../server/solo-access.js';

const settings = { openaiKey: 'test-provider', hostPasscode: 'host-test' };

test('the device grant survives restart and expires or is revoked on credential rotation', (t) => {
  const access = createSoloAccess(settings);
  const header = access.grant(true);
  assert.match(header, /HttpOnly; SameSite=Strict; Secure/);
  const cookie = header.split(';')[0];
  assert.ok(createSoloAccess(settings).authorized('other=1; ' + cookie));
  assert.equal(createSoloAccess({ ...settings, hostPasscode: 'changed' }).authorized(cookie), false);
  assert.equal(createSoloAccess({ ...settings, openaiKey: 'changed' }).authorized(cookie), false);
  assert.equal(access.authorized(), false);
  const later = Date.now() + 31 * 86400_000;
  t.mock.method(Date, 'now', () => later);
  assert.equal(access.authorized(cookie), false);
});

test('solo requires both a configured host passcode and a translation provider', () => {
  for (const missing of ['hostPasscode', 'openaiKey']) {
    const access = createSoloAccess({ ...settings, [missing]: '' });
    assert.equal(access.available, false);
    assert.equal(access.authorized(access.grant(false).split(';')[0]), false);
  }
});
