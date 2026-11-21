/**
 * The desk's sound (DK-06…DK-08; appliance CG-44, CG-45, CG-360): the microphone while Talk's mic records, the spoken
 * answer, and the soft new-ask chime. Browser only; the encoding is `lib/wav.ts`. The microphone is opened on the tap
 * and closed on *Done* or *Cancel* (DK-07): nothing listens in between.
 */
import type { Client } from '../lib/client';
import { level, Recording } from '../lib/wav';
import workletUrl from './capture-worklet.js?url';

export interface Capture {
  /** Stops listening and closes the microphone; the samples so far. */
  stop(): Promise<Recording>;
}

/**
 * Opens the microphone and records until `stop()`. `onLevel` gets each chunk's loudness (the bars), `onFull` fires
 * once at `maxSeconds`. Rejects when there is no microphone or the browser refuses it.
 */
export async function startCapture(
  onLevel: (l: number) => void,
  onFull: () => void,
  maxSeconds: number,
): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  const ctx = new AudioContext();
  const close = async () => {
    for (const t of stream.getTracks()) t.stop();
    await ctx.close().catch(() => {});
  };
  try {
    const recording = new Recording(ctx.sampleRate, maxSeconds);
    let full = false;
    const take = (chunk: Float32Array) => {
      if (full) return;
      onLevel(level(chunk));
      if (!recording.push(chunk)) {
        full = true;
        onFull();
      }
    };
    const source = ctx.createMediaStreamSource(stream);
    if (ctx.audioWorklet) {
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, 'whombat-capture', {
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (e: MessageEvent<Float32Array>) => take(e.data);
      // The node writes silence; connecting it keeps the graph pulling.
      source.connect(node).connect(ctx.destination);
    } else {
      const node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = (e) => take(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(node).connect(ctx.destination);
    }
    await ctx.resume();
    return {
      async stop() {
        await close();
        return recording;
      },
    };
  } catch (err) {
    await close();
    throw err;
  }
}

let shared: AudioContext | null = null;

/**
 * Starts the chime's audio on a touch or a key: Chromium lets a page play sound only after someone used it, and a
 * context started then keeps running, so a later new ask can chime without a touch.
 */
export function primeAudio(): void {
  try {
    shared ??= new AudioContext();
    if (shared.state === 'suspended') void shared.resume();
  } catch {
    // No audio here.
  }
}

/** One soft two-note chime for a new ask by day (DK-08): no file, quiet, under a second. */
export function chime(): void {
  try {
    shared ??= new AudioContext();
    const ctx = shared;
    void ctx.resume();
    const t0 = ctx.currentTime + 0.02;
    for (const [i, freq] of [784, 1046.5].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t = t0 + i * 0.16;
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.07, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.75);
    }
  } catch {
    // No audio device: the amber edge says it.
  }
}

export interface Playback {
  stop(): void;
}

/**
 * Plays a talk's spoken answer: fetched with the page's token, played from a blob URL (media-src 'self' blob:), the
 * URL dropped when it ends. The handle comes back at once (CG-52): `stop()` during the fetch means it never plays, and
 * the guard is looked at again before the element is made and before it plays. Nothing plays when Whombat has no
 * audio for it (any more). `onEnd` comes once however it ends — played, failed, stopped or nothing to play — so the
 * page knows when the screen stops speaking (DK-71, CG-172).
 */
export function playAnswer(client: Client, id: string, onEnd: () => void = () => {}): Playback {
  let stopped = false;
  let halt: (() => void) | null = null;
  let over = false;
  const end = () => {
    if (over) return;
    over = true;
    onEnd();
  };
  const run = async () => {
    const blob = await client.blob(`/api/desk/talk/audio?id=${encodeURIComponent(id)}`).catch(() => null);
    if (stopped || !blob) return end();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    let ended = false;
    const done = () => {
      if (ended) return;
      ended = true;
      // Let go of the blob before dropping its URL, so the element doesn't try to load it again.
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      end();
    };
    audio.addEventListener('ended', done, { once: true });
    audio.addEventListener('error', done, { once: true });
    halt = () => {
      audio.pause();
      done();
    };
    if (stopped) return halt();
    try {
      await audio.play();
    } catch {
      done();
    }
  };
  void run();
  return {
    stop() {
      stopped = true;
      halt?.();
    },
  };
}
