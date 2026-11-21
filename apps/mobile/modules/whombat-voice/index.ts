/**
 * `whombat-voice` — the phone's microphone for voice typing (docs/decisions/dictation.md DT-01, DT-07): a 16 kHz mono
 * 16-bit WAV in the app's cache, with the loudness for the waveform; Android's `AudioRecord` and iOS's `AVAudioEngine`
 * (`android/`, `ios/`). The microphone is asked for when the person first presses a mic. Without the native module
 * (tests, a build from before it) `supported()` is false and the composers have no mic.
 */
import { requireOptionalNativeModule } from 'expo';
import { Platform } from 'react-native';

interface NativeWhombatVoice {
  isSupported(): boolean;
  requestPermission(): Promise<{ granted: boolean; canAskAgain: boolean }>;
  /** Android takes the recording's number and puts it on its events; iOS takes only the length. */
  start(maxSeconds: number, id?: number): Promise<void>;
  /** The WAV's `file://` URI. */
  stop(): Promise<string>;
  cancel(): Promise<void>;
  addListener(
    event: 'onLevel',
    listener: (event: { decibels: number; id?: number }) => void,
  ): { remove(): void };
  addListener(
    event: 'onEnd',
    listener: (event: { reason: 'limit' | 'error'; id?: number }) => void,
  ): {
    remove(): void;
  };
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
  /** `id` is the recording's number (`gate.ts`), which Android's events carry. */
  start(maxSeconds: number, id: number): Promise<void> {
    if (!native) return Promise.reject(new Error('No microphone here.'));
    return Platform.OS === 'android' ? native.start(maxSeconds, id) : native.start(maxSeconds);
  },
  stop(): Promise<string> {
    if (!native) return Promise.reject(new Error('Nothing is recording.'));
    return native.stop();
  },
  async cancel(): Promise<void> {
    await native?.cancel();
  },
  /** The loudness in decibels (0 at full scale), a few times a second while it records; `id` is the recording's. */
  onLevel(listener: (decibels: number, id: number | undefined) => void): () => void {
    const sub = native?.addListener('onLevel', (e) => listener(e.decibels, e.id));
    return () => sub?.remove();
  },
  /** It stopped by itself: the time is up, or the microphone went; `id` is the recording's. */
  onEnd(listener: (reason: 'limit' | 'error', id: number | undefined) => void): () => void {
    const sub = native?.addListener('onEnd', (e) => listener(e.reason, e.id));
    return () => sub?.remove();
  },
};
