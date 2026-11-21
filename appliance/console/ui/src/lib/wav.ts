/**
 * Speech for Talk's mic (DK-07; appliance CG-44, CG-360): the microphone's samples, taken at the audio device's own
 * rate, become a 16 kHz mono 16-bit PCM WAV in the page (what the voice service reads, §2.4), at most voice typing's
 * five minutes. Pure: the capture hands in Float32 chunks, the encoder returns bytes.
 */

export const WAV_RATE = 16_000;

/** Zero crossings of the resampling filter on each side, and its table's steps per input sample. */
const ZEROS = 8;
const STEPS = 256;

/**
 * Resamples `input` from `from` Hz to `to` Hz with a windowed-sinc low-pass (Hann, 8 zero crossings): going down to
 * 16 kHz it cuts what sits above 7.4 kHz instead of folding it into the speech band; the gain at 0 Hz is exactly 1.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input.slice();
  const ratio = from / to;
  // The filter's width in input samples; going down, the cutoff sits a little under the new Nyquist.
  const c = Math.min(1, to / from) * 0.92;
  const width = ZEROS / c;
  const table = new Float32Array(Math.ceil(width * STEPS) + 2);
  for (let k = 0; k < table.length; k++) {
    const x = k / STEPS;
    const y = Math.PI * c * x;
    const sinc = x === 0 ? 1 : Math.sin(y) / y;
    table[k] = x >= width ? 0 : sinc * 0.5 * (1 + Math.cos((Math.PI * x) / width));
  }
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i * ratio;
    const j0 = Math.max(0, Math.ceil(t - width));
    const j1 = Math.min(input.length - 1, Math.floor(t + width));
    let sum = 0;
    let weight = 0;
    for (let j = j0; j <= j1; j++) {
      const h = table[Math.round(Math.abs(j - t) * STEPS)] ?? 0;
      sum += (input[j] ?? 0) * h;
      weight += h;
    }
    out[i] = weight === 0 ? 0 : sum / weight;
  }
  return out;
}

/** A WAV file (RIFF, PCM, mono, 16-bit little-endian) of `samples` in −1…1 at `rate` Hz. */
export function encodeWav(samples: Float32Array, rate = WAV_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // bytes per second
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    v.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return bytes;
}

/** A WAV's format and length, or null when it isn't the PCM WAV the encoder writes (tests, the demo). */
export function readWav(
  bytes: Uint8Array,
): { rate: number; channels: number; bits: number; samples: number } | null {
  if (bytes.length < 44) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data') return null;
  if (v.getUint16(20, true) !== 1) return null;
  const channels = v.getUint16(22, true);
  const bits = v.getUint16(34, true);
  return {
    rate: v.getUint32(24, true),
    channels,
    bits,
    samples: v.getUint32(40, true) / (channels * (bits / 8)),
  };
}

/** The loudness of a chunk, 0…1 (RMS, scaled so ordinary speech fills most of the bars). */
export function level(chunk: Float32Array): number {
  if (chunk.length === 0) return 0;
  let sum = 0;
  for (const s of chunk) sum += s * s;
  const rms = Math.sqrt(sum / chunk.length);
  return Math.min(1, rms * 6);
}

/** Base64 of `bytes` (the talk request's `audioWav`). */
export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/**
 * Collects the microphone's chunks while the mic records. `full` turns true at `maxSeconds` (the page stops there and
 * sends what it has); `wav()` resamples once and encodes.
 */
export class Recording {
  private chunks: Float32Array[] = [];
  private length = 0;

  constructor(
    readonly rate: number,
    readonly maxSeconds: number,
  ) {}

  /** Adds a chunk; false once `maxSeconds` are in (the rest is dropped). */
  push(chunk: Float32Array): boolean {
    const max = this.rate * this.maxSeconds;
    if (this.length >= max) return false;
    const part = chunk.length + this.length > max ? chunk.subarray(0, max - this.length) : chunk;
    this.chunks.push(part.slice());
    this.length += part.length;
    return this.length < max;
  }

  get seconds(): number {
    return this.length / this.rate;
  }

  get full(): boolean {
    return this.length >= this.rate * this.maxSeconds;
  }

  wav(): Uint8Array {
    const all = new Float32Array(this.length);
    let at = 0;
    for (const c of this.chunks) {
      all.set(c, at);
      at += c.length;
    }
    return encodeWav(resample(all, this.rate, WAV_RATE), WAV_RATE);
  }
}
