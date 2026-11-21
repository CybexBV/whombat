/**
 * A voice typing recording as the box takes it (docs/decisions/dictation.md DT-07): a 16 kHz mono 16-bit WAV of at most
 * `VOICE_TYPING_MAX_SECONDS`. A browser's microphone gives Float32 samples at its own rate (usually 48 or 44.1 kHz) in
 * small chunks; `VoiceCapture` takes them as they come, brings them to 16 kHz, keeps them as 16-bit and writes the WAV
 * at the end. The phone's recorder writes the WAV itself. `levelOf` is a chunk's loudness for the small waveform. Pure.
 */
import { VOICE_SAMPLE_RATE, VOICE_TYPING_MAX_SECONDS } from '@whombat/core/domain';

/** The WAV header before the samples. */
export const WAV_HEADER_BYTES = 44;

/** A sample in -1…1 as 16-bit, clipped. */
export function toInt16(x: number): number {
  const v = x <= -1 ? -1 : x >= 1 ? 1 : Number.isNaN(x) ? 0 : x;
  return v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
}

/** A 16-bit mono PCM WAV around `samples`. */
export function encodeWav(samples: Int16Array, rate = VOICE_SAMPLE_RATE): Uint8Array {
  const out = new Uint8Array(WAV_HEADER_BYTES + samples.length * 2);
  const v = new DataView(out.buffer);
  const tag = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) v.setInt16(WAV_HEADER_BYTES + i * 2, samples[i] as number, true);
  return out;
}

/** What a WAV says about itself: its rate, channels, bits and how many seconds it holds; null when it isn't one. */
export function readWavHeader(
  bytes: Uint8Array,
): { rate: number; channels: number; bits: number; samples: number; seconds: number } | null {
  if (bytes.byteLength < WAV_HEADER_BYTES) return null;
  const text = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (text(0) !== 'RIFF' || text(8) !== 'WAVE' || text(12) !== 'fmt ' || text(36) !== 'data') return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = v.getUint16(22, true);
  const rate = v.getUint32(24, true);
  const bits = v.getUint16(34, true);
  const size = Math.min(v.getUint32(40, true), bytes.byteLength - WAV_HEADER_BYTES);
  const samples = Math.floor(size / ((bits / 8) * channels || 1));
  return { rate, channels, bits, samples, seconds: rate ? samples / rate : 0 };
}

/**
 * Brings a stream of samples at `fromRate` to `toRate`, chunk by chunk. Going down, each new sample is the mean of the
 * ones in its span: a simple low-pass that keeps speech and drops what would fold back as noise. Going up (a microphone
 * slower than 16 kHz), each new sample lies on the line between its two neighbours.
 */
export class Resampler {
  private readonly ratio: number;
  /** Down: the running sum and count of the span, and where the span ends (in input samples). */
  private sum = 0;
  private count = 0;
  private boundary: number;
  /** Up: the last input sample and where the next output falls (in input samples). */
  private previous = 0;
  private at = 0;
  private seen = 0;

  constructor(
    readonly fromRate: number,
    readonly toRate = VOICE_SAMPLE_RATE,
  ) {
    if (!(fromRate > 0) || !(toRate > 0)) throw new RangeError('A sample rate is above zero.');
    this.ratio = fromRate / toRate;
    this.boundary = this.ratio;
  }

  /** Feeds a chunk; `emit` gets each new sample in order. */
  push(chunk: ArrayLike<number>, emit: (sample: number) => void): void {
    if (this.ratio === 1) {
      for (let i = 0; i < chunk.length; i++) emit(chunk[i] as number);
      return;
    }
    if (this.ratio > 1) {
      for (let i = 0; i < chunk.length; i++) {
        this.sum += chunk[i] as number;
        this.count += 1;
        this.seen += 1;
        if (this.seen >= this.boundary) {
          emit(this.sum / this.count);
          this.sum = 0;
          this.count = 0;
          this.boundary += this.ratio;
        }
      }
      return;
    }
    for (let i = 0; i < chunk.length; i++) {
      const x = chunk[i] as number;
      const index = this.seen;
      // The outputs between the previous sample (index - 1) and this one.
      while (this.at <= index) {
        const t = index === 0 ? 1 : this.at - (index - 1);
        emit(this.previous + (x - this.previous) * t);
        this.at += this.ratio;
      }
      this.previous = x;
      this.seen += 1;
    }
  }
}

/** A whole buffer at `fromRate`, brought to `toRate` (tests and one-off conversions). */
export function resample(
  samples: ArrayLike<number>,
  fromRate: number,
  toRate = VOICE_SAMPLE_RATE,
): Float32Array {
  const out: number[] = [];
  new Resampler(fromRate, toRate).push(samples, (s) => out.push(s));
  return Float32Array.from(out);
}

/** One second of 16 kHz samples: the capture grows by these, so a short recording holds little. */
const BLOCK = VOICE_SAMPLE_RATE;

/**
 * One recording: Float32 chunks at the microphone's rate in, the WAV out. It stops taking samples at `maxSeconds`
 * (`full`); what didn't fit is dropped.
 */
export class VoiceCapture {
  private readonly resampler: Resampler;
  private readonly limit: number;
  private readonly blocks: Int16Array[] = [];
  private length = 0;

  constructor(options: { rate: number; maxSeconds?: number }) {
    this.resampler = new Resampler(options.rate, VOICE_SAMPLE_RATE);
    this.limit = Math.round((options.maxSeconds ?? VOICE_TYPING_MAX_SECONDS) * VOICE_SAMPLE_RATE);
  }

  /** Adds a chunk; false once the recording is full. */
  push(chunk: ArrayLike<number>): boolean {
    if (this.full) return false;
    this.resampler.push(chunk, (sample) => {
      if (this.length >= this.limit) return;
      const at = this.length % BLOCK;
      if (at === 0) this.blocks.push(new Int16Array(BLOCK));
      (this.blocks[this.blocks.length - 1] as Int16Array)[at] = toInt16(sample);
      this.length += 1;
    });
    return !this.full;
  }

  /** Whole 16 kHz samples kept so far. */
  get samples(): number {
    return this.length;
  }

  get seconds(): number {
    return this.length / VOICE_SAMPLE_RATE;
  }

  get full(): boolean {
    return this.length >= this.limit;
  }

  /** The recording so far as a 16 kHz mono 16-bit WAV. */
  wav(): Uint8Array {
    const all = new Int16Array(this.length);
    let at = 0;
    for (const block of this.blocks) {
      const take = Math.min(block.length, this.length - at);
      all.set(block.subarray(0, take), at);
      at += take;
    }
    return encodeWav(all);
  }
}

/** Below this the waveform shows nothing: a room's own hum. */
const NOISE_FLOOR_DB = -60;
const NOISE_FLOOR = 10 ** (NOISE_FLOOR_DB / 20);

/** Decibels (0 at full scale) as the waveform's 0…1, steeper near the floor so speech fills it. */
export function levelOfDecibels(decibels: number | undefined | null): number {
  if (decibels === undefined || decibels === null || !Number.isFinite(decibels)) return 0;
  if (decibels <= NOISE_FLOOR_DB) return 0;
  if (decibels >= 0) return 1;
  const amplitude = 10 ** (decibels / 20);
  return Math.sqrt((amplitude - NOISE_FLOOR) / (1 - NOISE_FLOOR));
}

/** A chunk's loudness (its RMS) as the waveform's 0…1. */
export function levelOf(chunk: ArrayLike<number>): number {
  if (chunk.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < chunk.length; i++) {
    const x = chunk[i] as number;
    sum += x * x;
  }
  const rms = Math.sqrt(sum / chunk.length);
  return rms > 0 ? levelOfDecibels(20 * Math.log10(rms)) : 0;
}
