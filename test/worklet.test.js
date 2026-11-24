import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Runs the real mic-worklet.js in a sandbox that imitates the browser's audio thread.
function runWorklet(deviceRate, seconds, freq = 440) {
  const frames = [];
  let Processor;
  const sandbox = {
    sampleRate: deviceRate,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (m) => frames.push(new Int16Array(m.pcm)) };
      }
    },
    registerProcessor: (_, cls) => (Processor = cls),
    Math,
    Int16Array,
  };
  vm.runInNewContext(fs.readFileSync(new URL('../public/js/mic-worklet.js', import.meta.url), 'utf8'), sandbox);
  const p = new Processor();
  const total = Math.round(deviceRate * seconds);
  for (let off = 0; off < total; off += 128) {
    const block = new Float32Array(Math.min(128, total - off));
    for (let i = 0; i < block.length; i++) block[i] = 0.5 * Math.sin((2 * Math.PI * freq * (off + i)) / deviceRate);
    p.process([[block]]);
  }
  const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) out.set(f, (o += f.length) - f.length);
  return out;
}

const zeroCrossingsPerSecond = (pcm) => {
  let z = 0;
  for (let i = 1; i < pcm.length; i++) if ((pcm[i - 1] < 0) !== (pcm[i] < 0)) z++;
  return z / (pcm.length / 24000);
};

for (const rate of [48000, 44100, 24000, 16000]) {
  test(`mic at ${rate / 1000} kHz comes out as true 24 kHz audio`, () => {
    const pcm = runWorklet(rate, 2);
    assert.ok(Math.abs(pcm.length - 48000) <= 960, `2 s of audio -> ${pcm.length} samples, expected ~48000`);
    const zc = zeroCrossingsPerSecond(pcm);
    assert.ok(Math.abs(zc - 880) < 20, `a 440 Hz tone keeps its pitch (got ${zc.toFixed(0)} crossings/s, expected 880)`);
  });
}
