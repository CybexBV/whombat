/**
 * The microphone's samples for voice typing (docs/decisions/dictation.md DT-07), off the page's main thread: the
 * AudioWorklet hands the first channel on in chunks of about 40 ms (`webRecorder.ts` brings them to 16 kHz). Plain
 * JavaScript, loaded as it is from the page's own origin.
 */
const CHUNK = 2048;

class WhombatCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(CHUNK);
    this.length = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let at = 0;
    while (at < channel.length) {
      const take = Math.min(CHUNK - this.length, channel.length - at);
      this.buffer.set(channel.subarray(at, at + take), this.length);
      this.length += take;
      at += take;
      if (this.length === CHUNK) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(CHUNK);
        this.length = 0;
      }
    }
    return true;
  }
}

registerProcessor('whombat-capture', WhombatCapture);
