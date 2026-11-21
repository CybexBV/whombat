import { describe, expect, it } from 'vitest';
import { MAX_HEAR_SECONDS } from './dictation';
import { encodeWav, level, Recording, readWav, resample, toBase64, WAV_RATE } from './wav';

const sine = (rate: number, seconds: number, freq = 440) =>
  Float32Array.from(
    { length: Math.round(rate * seconds) },
    (_, i) => 0.5 * Math.sin((2 * Math.PI * freq * i) / rate),
  );

describe('encodeWav', () => {
  it('writes a 16 kHz mono 16-bit PCM WAV the voice service reads', () => {
    const wav = encodeWav(sine(WAV_RATE, 0.25));
    expect(readWav(wav)).toEqual({ rate: 16_000, channels: 1, bits: 16, samples: 4000 });
    expect(wav.length).toBe(44 + 4000 * 2);
  });

  it('clips to the 16-bit range', () => {
    const wav = encodeWav(Float32Array.from([2, -2, 0]));
    const v = new DataView(wav.buffer);
    expect(v.getInt16(44, true)).toBe(32767);
    expect(v.getInt16(46, true)).toBe(-32768);
    expect(v.getInt16(48, true)).toBe(0);
  });

  it('readWav refuses what isn’t a PCM WAV', () => {
    expect(readWav(new Uint8Array(10))).toBeNull();
    expect(readWav(new TextEncoder().encode('x'.repeat(60)))).toBeNull();
  });
});

describe('resample', () => {
  it('takes 48 kHz and 44.1 kHz down to 16 kHz with the right length', () => {
    expect(resample(sine(48_000, 1), 48_000, WAV_RATE).length).toBe(16_000);
    expect(resample(sine(44_100, 1), 44_100, WAV_RATE).length).toBe(16_000);
  });

  it('keeps a speech-band tone’s loudness and quiets one above the new Nyquist', () => {
    const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length);
    const speech = resample(sine(48_000, 0.5, 300), 48_000, WAV_RATE);
    expect(rms(speech)).toBeGreaterThan(0.3);
    const hiss = resample(sine(48_000, 0.5, 12_000), 48_000, WAV_RATE);
    expect(rms(hiss)).toBeLessThan(0.05);
  });

  it('copies at the same rate', () => {
    const a = Float32Array.from([0.1, 0.2]);
    expect(Array.from(resample(a, 16_000, 16_000))).toEqual(Array.from(a));
  });
});

describe('Recording', () => {
  it('stops taking samples at its limit and encodes at 16 kHz', () => {
    const r = new Recording(48_000, 30);
    let more = true;
    let chunks = 0;
    while (more && chunks < 2000) {
      more = r.push(new Float32Array(2048));
      chunks++;
    }
    expect(r.full).toBe(true);
    expect(r.seconds).toBe(30);
    expect(r.push(new Float32Array(2048))).toBe(false);
    expect(readWav(r.wav())?.samples).toBe(30 * WAV_RATE);
  });

  it('voice typing’s five minutes fit the hear request (DESK_HEAR_BASE64_MAX)', () => {
    const r = new Recording(16_000, MAX_HEAR_SECONDS);
    r.push(new Float32Array(16_000 * MAX_HEAR_SECONDS));
    expect(r.full).toBe(true);
    const base64 = toBase64(r.wav()).length;
    expect(base64).toBe(4 * Math.ceil((44 + MAX_HEAR_SECONDS * 16_000 * 2) / 3));
    expect(base64).toBeLessThanOrEqual(12_800_060);
  });
});

describe('level and toBase64', () => {
  it('is 0 for silence and grows with loudness, at most 1', () => {
    expect(level(new Float32Array(256))).toBe(0);
    expect(level(sine(16_000, 0.01))).toBeGreaterThan(level(sine(16_000, 0.01).map((x) => x / 10)));
    expect(level(Float32Array.from({ length: 64 }, () => 1))).toBe(1);
  });

  it('matches Node’s base64', () => {
    const bytes = encodeWav(sine(WAV_RATE, 0.1));
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
  });
});
