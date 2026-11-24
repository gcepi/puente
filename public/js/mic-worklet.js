// Runs on the audio thread. Converts the mic stream to 24 kHz PCM16 and posts
// 40 ms frames plus a level reading. Works at any device rate: 44.1/48 kHz are
// averaged down; lower rates (a Bluetooth headset at 16 kHz) are interpolated up.
const TARGET = 24000;
const FRAME = 960; // 40 ms at 24 kHz

class MicCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET; // input samples per output sample
    this.phase = 0;
    this.acc = 0;
    this.cnt = 0;
    this.pos = 0; // upsampling: position of the next output sample, in input samples (prev = -1)
    this.prev = 0;
    this.out = new Int16Array(FRAME);
    this.n = 0;
    this.sq = 0;
  }
  emit(s) {
    s = Math.max(-1, Math.min(1, s));
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
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    if (this.ratio >= 1) {
      // Downsample: average the input samples that fall in each output slot.
      for (let i = 0; i < ch.length; i++) {
        this.acc += ch[i];
        this.cnt++;
        this.phase += 1;
        if (this.phase >= this.ratio) {
          this.emit(this.acc / this.cnt);
          this.acc = 0;
          this.cnt = 0;
          this.phase -= this.ratio;
        }
      }
    } else {
      // Upsample: linear interpolation between neighbouring input samples.
      const at = (i) => (i < 0 ? this.prev : ch[i]);
      while (this.pos < ch.length - 1) {
        const i = Math.floor(this.pos);
        const f = this.pos - i;
        this.emit(at(i) + (at(i + 1) - at(i)) * f);
        this.pos += this.ratio;
      }
      this.pos -= ch.length;
      this.prev = ch[ch.length - 1];
    }
    return true;
  }
}
registerProcessor('mic-capture', MicCapture);
