/**
 * A phone composer's voice typing (docs/decisions/dictation.md DT-01, DT-08): `useVoiceTyping` with the phone's
 * microphone (asked for on the first press), the Whombat's `VoiceApi` and the composer's text and cursor. Going to the
 * background stops a recording and drops it, as the microphone is the app's only while it shows.
 */
import type { VoiceApi } from '@whombat/client/voice';
import { useVoiceTyping, type VoiceTypingView } from '@whombat/client/voice/react';
import { useEffect } from 'react';
import { AppState } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { nativeRecorder, requestMicrophone } from './nativeRecorder';
import { useVoiceApi } from './useVoiceApi';

/** Where a composer's recordings go: the Whombat's voice typing and the burrow. Null: no mic. */
export interface VoiceSource {
  api: VoiceApi | null;
  burrow: string;
}

/** This screen's voice typing, for the composers on it. */
export function useVoiceSource(): VoiceSource {
  const api = useVoiceApi();
  const { slug } = useBurrowBase();
  return { api, burrow: slug };
}

export interface ComposerVoiceOptions {
  /** Which draft the composer holds: a new one drops what goes on. */
  ownerKey: string;
  text: string;
  selection(): { start: number; end: number };
  commit(text: string, selection: { start: number; end: number }): void;
}

export function useComposerVoice(source: VoiceSource | null, options: ComposerVoiceOptions): VoiceTypingView {
  const voice = useVoiceTyping({
    api: source?.api ?? null,
    burrow: source?.burrow ?? null,
    recorder: source ? nativeRecorder() : null,
    requestPermission: requestMicrophone,
    ...options,
  });
  const { interrupt } = voice;
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') interrupt();
    });
    return () => sub.remove();
  }, [interrupt]);
  return voice;
}
