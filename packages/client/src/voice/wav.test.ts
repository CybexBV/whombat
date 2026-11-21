/**
 * A browser's recording as the box takes it (dictation.md DT-07): 16 kHz mono 16-bit WAV, brought down from the
 * microphone's rate chunk by chunk, cut at the time limit; and a chunk's loudness for the waveform.
 */
import { describe, expect, it } from 'vitest';
import {
  encodeWav,
  levelOf,
  levelOfDecibels,
  Resampler,
  readWavHeader,
  resample,
  toInt16,
  VoiceCapture,
  WAV_HEADER_BYTES,
} from './wav';

const tone = (hz: number, rate: number, seconds: number) =>
  Float32Array.from(
    { length: Math.round(rate * seconds) },
    (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate),
  );

describe('encodeWav', () => {
  it('writes a 16 kHz mono 16-bit WAV that reads back', () => {
    const wav = encodeWav(Int16Array.from([0, 1000, -1000, 32767]));
    expect(wav.byteLength).toBe(WAV_HEADER_BYTES + 8);
    expect(readWavHeader(wav)).toEqual({
      rate: 16_000,
      channels: 1,
      bits: 16,
      samples: 4,
      seconds: 4 / 16_000,
    });
    expect(new DataView(wav.buffer).getInt16(WAV_HEADER_BYTES + 2, true)).toBe(1000);
    expect(readWavHeader(new Uint8Array(10))).toBeNull();
  });

  it('clips samples to 16 bits', () => {
    expect(toInt16(2)).toBe(32767);
    expect(toInt16(-2)).toBe(-32768);
    expect(toInt16(Number.NaN)).toBe(0);
  });
});

describe('resampling', () => {
  it('brings 48 kHz and 44.1 kHz to 16 kHz, a second to about a second', () => {
    expect(resample(tone(440, 48_000, 1), 48_000)).toHaveLength(16_000);
    expect(Math.abs(resample(tone(440, 44_100, 1), 44_100).length - 16_000)).toBeLessThanOrEqual(1);
    expect(resample(tone(440, 16_000, 0.5), 16_000)).toHaveLength(8_000);
  });

  it('keeps speech-band tones and averages away what would fold back', () => {
    const speech = resample(tone(300, 48_000, 0.1), 48_000);
    const peak = Math.max(...speech.map(Math.abs));
    expect(peak).toBeGreaterThan(0.45);
    // Exactly the input rate's third: each output is the mean of a whole period, so it vanishes.
    const fold = resample(tone(16_000, 48_000, 0.1), 48_000);
    expect(Math.max(...fold.map(Math.abs))).toBeLessThan(1e-6);
  });

  it('gives the same in chunks as at once', () => {
    const input = tone(523, 44_100, 0.25);
    const whole = resample(input, 44_100);
    const parts: number[] = [];
    const r = new Resampler(44_100);
    for (let at = 0; at < input.length; at += 128) r.push(input.subarray(at, at + 128), (s) => parts.push(s));
    expect(parts).toHaveLength(whole.length);
    expect(parts[100]).toBeCloseTo(whole[100] as number, 6);
  });

  it('goes up from a slower microphone, the last step waiting for the next chunk', () => {
    const up = resample(Float32Array.from([0, 1, 0, -1]), 8_000);
    expect(up).toHaveLength(7);
    expect(up[1]).toBeCloseTo(0.5, 6);
  });
});

describe('VoiceCapture', () => {
  it('keeps a recording as a 16 kHz WAV and stops at its limit', () => {
    const capture = new VoiceCapture({ rate: 48_000, maxSeconds: 1 });
    const chunk = tone(440, 48_000, 0.4);
    expect(capture.push(chunk)).toBe(true);
    expect(capture.seconds).toBeCloseTo(0.4, 3);
    capture.push(chunk);
    expect(capture.push(chunk)).toBe(false);
    expect(capture.full).toBe(true);
    expect(capture.samples).toBe(16_000);
    expect(capture.push(chunk)).toBe(false);
    expect(readWavHeader(capture.wav())).toMatchObject({ rate: 16_000, samples: 16_000, seconds: 1 });
  });

  it('writes an empty recording as a header alone', () => {
    expect(new VoiceCapture({ rate: 48_000 }).wav().byteLength).toBe(WAV_HEADER_BYTES);
  });
});

describe('levels', () => {
  it('maps silence to 0, full scale to 1 and speech in between', () => {
    expect(levelOf(new Float32Array(128))).toBe(0);
    expect(levelOf(Float32Array.from({ length: 128 }, () => 1))).toBe(1);
    const speech = levelOf(tone(200, 48_000, 0.02).map((x) => x * 0.1));
    expect(speech).toBeGreaterThan(0.05);
    expect(speech).toBeLessThan(0.5);
    expect(levelOfDecibels(-80)).toBe(0);
    expect(levelOfDecibels(undefined)).toBe(0);
  });
});
