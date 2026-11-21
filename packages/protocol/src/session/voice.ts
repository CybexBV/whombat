/**
 * Voice typing over the session (contracts 3.1; Whombat docs/decisions/dictation.md): session-native ops `voice.*` on
 * the `app` channel, and the `dictation` upload that turns a recording into text. Each change answers voice typing as
 * Settings sees it (`VoiceTyping` of `@whombat/core/domain`); the runtime announces every change, and a model
 * download's progress at most every 2 seconds, with the realtime event `voice.changed` (topic `me`). A box without them
 * answers `unknown_op`: the app shows no mic.
 *
 * - `voice.get` → `VoiceTyping`.
 * - `voice.update {on?, model?, language?}` → `VoiceTyping`. Turning voice typing on, or choosing a model, asks the box to
 *   download what the settings need.
 * - `voice.fetchModel {model}` → `VoiceTyping`: *Download* and *Try again*.
 * - `voice.removeModel {model}` → `VoiceTyping`: *Remove*, only for a model the settings don't need (`inUse` false,
 *   else `conflict` with `details.code: 'in_use'`).
 *
 * A recording (16 kHz mono 16-bit WAV, at most `VOICE_TYPING_MAX_SECONDS`) goes up as an upload without a reservation:
 * `open{stream, spec: {kind: 'upload', target: {type: 'dictation', burrow}, size, sha256, chunkSize}}`, its chunks, then
 * END. The box keeps it in memory only, never resumes it (`opened.meta.received` is 0) and answers
 * `stream_done{output: DictationOutput}` once it is text, or `error{stream, details: {code: DictationErrorCode}}`. A size
 * over `VOICE_TYPING_MAX_BYTES` is refused at `open` (`stream_refused`, `details.code: 'too_long'`).
 */
import { VoiceSttModel, VoiceTypingPatch } from '@whombat/core/domain';
import { z } from 'zod';

export const VoiceGetInput = z.strictObject({});
export const VoiceUpdateInput = VoiceTypingPatch;
export type VoiceUpdateInput = z.infer<typeof VoiceUpdateInput>;
export const VoiceModelInput = z.strictObject({ model: VoiceSttModel });
export type VoiceModelInput = z.infer<typeof VoiceModelInput>;

/** `error.details.code` of `voice.removeModel` for a model the settings need. */
export const VOICE_IN_USE = 'in_use';
