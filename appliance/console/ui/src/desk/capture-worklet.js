/*
 * The microphone's samples for Talk (CG-44): the first channel, in batches of 2048 frames, to the page. Loaded with
 * audioWorklet.addModule from the page's own origin (script-src 'self'); it only copies samples, the page encodes.
 */
const BATCH = 2048;

class WhombatCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(BATCH);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      let at = 0;
      while (at < channel.length) {
        const n = Math.min(channel.length - at, BATCH - this.filled);
        this.buffer.set(channel.subarray(at, at + n), this.filled);
        this.filled += n;
        at += n;
        if (this.filled === BATCH) {
          this.port.postMessage(this.buffer);
          this.buffer = new Float32Array(BATCH);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('whombat-capture', WhombatCapture);
