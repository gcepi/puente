import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiTranslator } from '../server/providers/openai.js';

const translate = createOpenAiTranslator({ apiKey: 'test', model: 'test', glossary: {} });
const event = (choice) => `data: ${JSON.stringify({ choices: [choice] })}\r\n\r\n`;
const first = event({ delta: { content: 'Revisa el desagüe.' } });

test('translation streams words immediately and accepts a final marker without a trailing newline', async (t) => {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  t.mock.method(globalThis, 'fetch', async () => new Response(body));
  let firstDelta;
  const received = new Promise((resolve) => { firstDelta = resolve; });
  const deltas = [];
  const result = translate('Check the drain.', [], (delta) => {
    deltas.push(delta);
    firstDelta();
  });
  const bytes = Buffer.from(first);
  const split = bytes.indexOf(Buffer.from('ü')) + 1;
  controller.enqueue(bytes.subarray(0, split));
  controller.enqueue(bytes.subarray(split));
  await received;
  assert.deepEqual(deltas, ['Revisa el desagüe.']);
  controller.enqueue(Buffer.from(event({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]'));
  controller.close();
  assert.equal(await result, 'Revisa el desagüe.');
});

for (const [name, body, message] of [
  ['premature EOF', first, /closed early/],
  ['output length limit', first + event({ delta: {}, finish_reason: 'length' }) + 'data: [DONE]', /stopped before/],
  ['provider error', first + 'data: {"error":{"message":"upstream error"}}', /reported an error/],
  ['malformed data', first + 'data: {"choices":\n\ndata: [DONE]', /unreadable/],
  ['empty reply', 'data: [DONE]\n\n', /No translation/],
]) {
  test(`translation reports ${name} instead of accepting a partial result`, async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response(body));
    await assert.rejects(translate('Check the drain.', []), message);
  });
}
