// Runs on the audio thread. Converts the mic stream (usually 44.1 or 48 kHz
// float) to 24 kHz PCM16 and posts 40 ms frames plus a level reading.
const TARGET = 24000;
const FRAME = 960; // 40 ms at 24 kHz

class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET;
    this.phase = 0;
    this.acc = 0;
    this.cnt = 0;
    this.out = new Int16Array(FRAME);
    this.n = 0;
    this.sq = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      // Box-filter decimation: average the input samples that fall in each output slot.
      this.acc += ch[i];
      this.cnt++;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        const s = Math.max(-1, Math.min(1, this.acc / this.cnt));
        this.acc = 0;
        this.cnt = 0;
        this.phase -= this.ratio;
        this.out[this.n++] = s * 32767;
        this.sq += s * s;
        if (this.n === FRAME) {
          const level = Math.sqrt(this.sq / FRAME);
          this.port.postMessage({ pcm: this.out.buffer, level }, [this.out.buffer]);
          this.out = new Int16Array(FRAME);
          this.n = 0;
          this.sq = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('mic-capture', MicCapture);
