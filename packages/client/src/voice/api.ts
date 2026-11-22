/**
 * Voice typing's session ops as one object (docs/decisions/dictation.md DT-06, DT-07): the settings (`voice.*`) and a
 * recording turned into text, sent as a `dictation` upload (no reservation; the box keeps it in memory, never resumes
 * it and answers `DictationOutput`). The same on the web and the phone, against a box or a fixture world's fake box.
 */
import {
  DictationOutput,
  type VoiceDownloadModel,
  type VoiceTyping,
  type VoiceTypingPatch,
} from '@whombat/core/domain';
import type { VoiceDutchInput } from '@whombat/protocol/session';
import { sessionOps } from '../session/managed-ops';
import { type ApplianceSession, type ChunkSource, StreamError } from '../session/types';

export interface VoiceApi {
  get(): Promise<VoiceTyping>;
  update(patch: VoiceTypingPatch): Promise<VoiceTyping>;
  /** *Download* and *Try again*. */
  fetchModel(model: VoiceDownloadModel): Promise<VoiceTyping>;
  /** *Remove*. */
  removeModel(model: VoiceDownloadModel): Promise<VoiceTyping>;
  /** Turn the opt-in Dutch voice on (with licence agreement) or off (removes its files). */
  setDutchVoice(input: VoiceDutchInput): Promise<VoiceTyping>;
  /**
   * A 16 kHz mono 16-bit WAV to text. A refusal is a `StreamError` with the box's reason in `details.code`
   * (`DictationErrorCode`).
   */
  transcribe(
    input: { burrow: string; wav: Uint8Array },
    options?: { signal?: AbortSignal },
  ): Promise<DictationOutput>;
}

/** Bytes in memory as an upload's source. */
export function bytesChunkSource(bytes: Uint8Array, name: string, type: string): ChunkSource {
  return {
    name,
    type,
    size: bytes.byteLength,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
  };
}

/** Voice typing over this session. */
export function voiceApi(session: ApplianceSession): VoiceApi {
  return {
    get: () => sessionOps.voiceGet(session),
    update: (patch) => sessionOps.voiceUpdate(session, patch),
    fetchModel: (model) => sessionOps.voiceFetchModel(session, { model }),
    removeModel: (model) => sessionOps.voiceRemoveModel(session, { model }),
    setDutchVoice: (input) => sessionOps.voiceSetDutchVoice(session, input),
    async transcribe({ burrow, wav }, options = {}) {
      const output = await session.upload(
        { type: 'dictation', burrow },
        bytesChunkSource(wav, 'dictation.wav', 'audio/wav'),
        options.signal ? { signal: options.signal } : {},
      );
      const parsed = DictationOutput.safeParse(output);
      if (!parsed.success) throw new StreamError('integrity', 'The Whombat’s answer wasn’t text.');
      return parsed.data;
    },
  };
}
