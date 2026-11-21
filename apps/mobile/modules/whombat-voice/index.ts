/**
 * `whombat-voice` — the phone's microphone for voice typing (docs/decisions/dictation.md DT-01, DT-07): a 16 kHz mono
 * 16-bit WAV in the app's cache, with the loudness for the waveform; Android's `AudioRecord` and iOS's `AVAudioEngine`
 * (`android/`, `ios/`). The microphone is asked for when the person first presses a mic. Without the native module
 * (tests, a build from before it) `supported()` is false and the composers have no mic.
 */
import { requireOptionalNativeModule } from 'expo';

interface NativeWhombatVoice {
  isSupported(): boolean;
  requestPermission(): Promise<{ granted: boolean; canAskAgain: boolean }>;
  start(maxSeconds: number): Promise<void>;
  /** The WAV's `file://` URI. */
  stop(): Promise<string>;
  cancel(): Promise<void>;
  addListener(event: 'onLevel', listener: (event: { decibels: number }) => void): { remove(): void };
  addListener(event: 'onEnd', listener: (event: { reason: 'limit' | 'error' }) => void): { remove(): void };
}

const native = requireOptionalNativeModule<NativeWhombatVoice>('WhombatVoice');

/** A refusal or a missing microphone, as the native side reports it. */
export function isMicrophoneRefusal(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === 'microphone' || code === 'ERR_MICROPHONE';
}

export const WhombatVoice = {
  supported(): boolean {
    try {
      return native?.isSupported() ?? false;
    } catch {
      return false;
    }
  },
  async requestPermission(): Promise<{ granted: boolean; canAskAgain: boolean }> {
    if (!native) return { granted: false, canAskAgain: false };
    const r = await native.requestPermission();
    return { granted: r.granted === true, canAskAgain: r.canAskAgain !== false };
  },
  start(maxSeconds: number): Promise<void> {
    if (!native) return Promise.reject(new Error('No microphone here.'));
    return native.start(maxSeconds);
  },
  stop(): Promise<string> {
    if (!native) return Promise.reject(new Error('Nothing is recording.'));
    return native.stop();
  },
  async cancel(): Promise<void> {
    await native?.cancel();
  },
  /** The loudness in decibels (0 at full scale), a few times a second while it records. */
  onLevel(listener: (decibels: number) => void): () => void {
    const sub = native?.addListener('onLevel', (e) => listener(e.decibels));
    return () => sub?.remove();
  },
  /** It stopped by itself: the time is up, or the microphone went. */
  onEnd(listener: (reason: 'limit' | 'error') => void): () => void {
    const sub = native?.addListener('onEnd', (e) => listener(e.reason));
    return () => sub?.remove();
  },
};
