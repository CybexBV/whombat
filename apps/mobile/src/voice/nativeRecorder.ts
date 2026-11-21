/**
 * The phone's microphone as voice typing's recorder (docs/decisions/dictation.md DT-07): `modules/whombat-voice` records
 * a 16 kHz WAV into the cache; Done reads it and deletes it at once, so a recording never stays on the phone. Null
 * where the app has no native module (tests, a build from before it).
 */
import { levelOfDecibels, MicrophoneError, type VoiceRecorder } from '@whombat/client/voice';
import { File } from 'expo-file-system';
import { isMicrophoneRefusal, WhombatVoice } from '../../modules/whombat-voice';
import { createRecordingGate } from '../../modules/whombat-voice/gate';

/** Reads the WAV at `uri` and deletes it. */
async function take(uri: string): Promise<Uint8Array> {
  const file = new File(uri);
  try {
    return new Uint8Array(await file.arrayBuffer());
  } finally {
    try {
      file.delete();
    } catch {
      // already gone
    }
  }
}

let recorder: VoiceRecorder | null | undefined;

/** The phone's one recorder (one recording at a time anyway), or null without the native module. */
export function nativeRecorder(): VoiceRecorder | null {
  if (recorder !== undefined) return recorder;
  if (!WhombatVoice.supported()) {
    recorder = null;
    return recorder;
  }
  let offs: (() => void)[] = [];
  // An earlier recording's last events can still arrive after the next one started: only the current one's count.
  const gate = createRecordingGate();
  const quiet = () => {
    gate.end();
    for (const off of offs) off();
    offs = [];
  };
  recorder = {
    async start({ maxSeconds, onLevel, onEnd }) {
      quiet();
      const id = gate.begin();
      offs = [
        WhombatVoice.onLevel((decibels, from) => {
          if (gate.accepts(from)) onLevel?.(levelOfDecibels(decibels));
        }),
        WhombatVoice.onEnd((reason, from) => {
          if (gate.accepts(from)) onEnd?.(reason);
        }),
      ];
      try {
        await WhombatVoice.start(maxSeconds, id);
      } catch (error) {
        quiet();
        if (isMicrophoneRefusal(error)) throw new MicrophoneError();
        throw error;
      }
    },
    async stop() {
      quiet();
      return take(await WhombatVoice.stop());
    },
    async cancel() {
      quiet();
      await WhombatVoice.cancel();
    },
  };
  return recorder;
}

/** Asks for the microphone the first time; the answer after. */
export function requestMicrophone(): Promise<{ granted: boolean; canAskAgain: boolean }> {
  return WhombatVoice.requestPermission();
}
