/**
 * The desk screen's settings over the session (0.100, CT-523…CT-526; 0.101, CT-540, CT-541; 0.103, CT-590…CT-594;
 * Whombat docs/decisions/desk-display.md DK-02, DK-04, DK-12, DK-26…DK-28): session-native ops `desk.*` on the `app` channel, behind feature `desk`. Each change answers the
 * screen as Settings sees it (`DeskScreen` of `@whombat/core/domain`); the runtime announces every change with the
 * realtime event `desk.changed` (topic `me`). Since 3.0 (CT-1510) every op is the person's: no owners, no other paired
 * person.
 *
 * - `desk.get` → `DeskScreen`.
 * - `desk.startPairing` → `{expiresAt}`: the screen shows four letters for 10 minutes.
 * - `desk.pair {code, pin}` (secret) → `DeskScreen`: the letters on the screen and a PIN of 4 to 6 digits
 *   pair it to the caller; pairing again replaces the last pairing.
 * - `desk.setPin {pin}` (secret) → `DeskScreen`. The runtime refuses a PIN that is too easy to guess
 *   (core `deskPinTooEasy`) with `easy_pin`, in `desk.pair` before the letters are used; the schema doesn't.
 * - `desk.update` any of the settings → `DeskScreen`, `presence` (*Stay unlocked while you’re here*,
 *   DK-28) among them.
 * - `desk.unpair` → `DeskScreen`. It means `desk.setScreen {on: false}` (DK-20): the switch replaces Unpair,
 *   and an Unpair that the screen undid by pairing itself a minute later would be a trick.
 * - `desk.setScreen {on}` (0.101, CT-540) → `DeskScreen`: *Show Whombat on this screen*. On pairs the screen to
 *   the caller, without letters or a PIN (DK-18), when a screen is connected (else `no_screen`); off ends the pairing
 *   and its PIN, and nothing pairs itself while it is off (DK-20).
 * - `desk.answerUnlock {id, unlock}` → `{ok: true}`: Unlock or No for *Confirm on your phone*.
 * - `desk.voiceSample {voice}` (0.105, CT-612) → `DeskVoiceSample {audioWav}`: Settings' *Listen*,
 *   the screen's sample sentence (`DESK_WORDS.settings.sample`) said by that voice on the box. Not a change (nothing is
 *   kept), so read through an export stream (`open{spec: {kind: 'export', op: 'desk.voiceSample', input}}`), the answer
 *   being larger than a message; a voice the screen doesn't list, or a box that can't speak now, is `no_voice`.
 *   Offered where `DeskScreen.voices` is (CT-615).
 *
 * - `desk.preview {scenario, show?}` (3.2, CT-1626; DK-123) → `DeskPreview`: Settings' preview, the calm glance as the
 *   screen would draw it with `show` (the saved choices when absent) for `scenario`. Reads only.
 * - `desk.tryOnScreen {scenario, show?}` (3.2, CT-1627; DK-124) → `{until}`: the screen shows that preview for
 *   `DESK_TRY_S`, with a banner that says it's one. Nothing is kept.
 * - `desk.setName {name}` (3.2, CT-1628; DK-119) → `DeskScreen`: the Whombat's name for the top bar. The box doesn't
 *   know it (control's directory has it), so the app gives it whenever it knows a different one.
 *
 * Refusals carry `DeskErrorDetails` in `error.details` (CT-525); their words are `DESK_WORDS.errors`.
 */
import type { ErrorCode } from '@whombat/core/contracts';
import {
  DeskPin,
  DeskPreviewScenario,
  DeskSettingsPatch,
  DeskShow,
  DeskUnlockRequestId,
  DeskVoice,
  DeskWhombatName,
  Timestamp,
} from '@whombat/core/domain';
import { z } from 'zod';
import { ClaimLetters } from '../claim/code.js';
import { OkOutput } from './enrollment.js';

export const DeskGetInput = z.strictObject({});
export const DeskStartPairingInput = z.strictObject({});
/** Until when the screen shows the letters (`DESK_PAIRING_TTL_S` after the call). */
export const DeskStartPairingOutput = z.object({ expiresAt: Timestamp });
export type DeskStartPairingOutput = z.infer<typeof DeskStartPairingOutput>;
/** The four letters on the screen and the PIN the caller chose (DK-02), 4 to 6 digits since 0.103 (DK-26). */
export const DeskPairInput = z.strictObject({ code: ClaimLetters, pin: DeskPin });
export type DeskPairInput = z.infer<typeof DeskPairInput>;
export const DeskSetPinInput = z.strictObject({ pin: DeskPin });
export type DeskSetPinInput = z.infer<typeof DeskSetPinInput>;
/** Any of the settings, each whole; an empty patch changes nothing. */
export const DeskUpdateInput = DeskSettingsPatch;
export type DeskUpdateInput = z.infer<typeof DeskUpdateInput>;
export const DeskUnpairInput = z.strictObject({});
/** *Show Whombat on this screen* (0.101, CT-540; DK-20). */
export const DeskSetScreenInput = z.strictObject({ on: z.boolean() });
export type DeskSetScreenInput = z.infer<typeof DeskSetScreenInput>;
/** Settings' preview and *Try it on the screen* (3.2, CT-1626, CT-1627; DK-123, DK-124). */
export const DeskPreviewInput = z.strictObject({ scenario: DeskPreviewScenario, show: DeskShow.optional() });
export type DeskPreviewInput = z.infer<typeof DeskPreviewInput>;
export const DeskTryOnScreenInput = DeskPreviewInput;
export type DeskTryOnScreenInput = DeskPreviewInput;
/** Until when the screen shows the preview. */
export const DeskTryOnScreenOutput = z.object({ until: Timestamp });
export type DeskTryOnScreenOutput = z.infer<typeof DeskTryOnScreenOutput>;
/** The Whombat's name for the top bar (3.2, CT-1628; DK-119). */
export const DeskSetNameInput = z.strictObject({ name: DeskWhombatName });
export type DeskSetNameInput = z.infer<typeof DeskSetNameInput>;
/** `unlock: false` is No: the screen stays locked. */
export const DeskAnswerUnlockInput = z.strictObject({ id: DeskUnlockRequestId, unlock: z.boolean() });
export type DeskAnswerUnlockInput = z.infer<typeof DeskAnswerUnlockInput>;
export const DeskAnswerUnlockOutput = OkOutput;
/** *Listen* (0.105, CT-612; DK-51): one of the voices. */
export const DeskVoiceSampleInput = z.strictObject({ voice: DeskVoice });
export type DeskVoiceSampleInput = z.infer<typeof DeskVoiceSampleInput>;
/** The sample's WAV (16-bit mono at the voice's rate), at most 1 MiB, in base64. */
export const DESK_VOICE_SAMPLE_WAV_MAX_BYTES = 1_048_576;
export const DeskVoiceSample = z.object({
  audioWav: z
    .string()
    .min(60)
    .max(4 * Math.ceil(DESK_VOICE_SAMPLE_WAV_MAX_BYTES / 3))
    .regex(/^[A-Za-z0-9+/]*={0,2}$/),
});
export type DeskVoiceSample = z.infer<typeof DeskVoiceSample>;

/**
 * Why a `desk.*` op refused (CT-525), in `error.details.code`, on the generic `ErrorCode` of `DESK_ERROR_STATUS`:
 * - `wrong_code`: the letters don't match the screen's (`details.triesLeft`; after five wrong tries the screen shows
 *   new letters);
 * - `pairing_expired`: no letters on the screen any more (10 minutes, or a runtime restart): start again;
 * - `not_paired`: the op needs a paired screen;
 * - `request_expired`: the phone unlock request is gone (2 minutes, answered, or the screen was locked again);
 * - `no_screen` (0.101): `desk.setScreen {on: true}` with no screen connected;
 * - `no_pin` (0.101): an unlock with a PIN on a screen that has none (DK-18). The desk socket's code (the console's
 *   `POST /v1/desk/unlock`), listed here so its words live with the others in `DESK_WORDS.errors`;
 * - `easy_pin` (0.103, CT-594): `desk.pair` or `desk.setPin` with a PIN `deskPinTooEasy` refuses (DK-27), on
 *   `validation_failed` as other well-formed values Whombat won't take (`invalid_passphrase`, `password_too_short`).
 * - `no_voice` (0.105, CT-613): `desk.update {speechVoice}` or `desk.voiceSample` with a voice the screen's `voices`
 *   doesn't list, or a sample when the box can't speak now (DK-52), on `conflict`.
 * - `unknown_screen` (3.6): no screen with that id (removed, or a monitor never seen); `screens_full` (3.6):
 *   `desk.screen.add` beyond `DESK_SCREENS_MAX`; `bad_layout` (3.6): a layout `deskLayoutProblem` refuses. With
 *   `desk.screen.add`, `wrong_code` and `pairing_expired` say the letters are wrong or gone.
 */
export const DESK_ERROR_CODES = [
  'wrong_code',
  'pairing_expired',
  'not_paired',
  'request_expired',
  'no_screen',
  'no_pin',
  'easy_pin',
  'no_voice',
  'unknown_screen',
  'screens_full',
  'bad_layout',
] as const;
export const DeskErrorCode = z.enum(DESK_ERROR_CODES);
export type DeskErrorCode = z.infer<typeof DeskErrorCode>;

export const DESK_ERROR_STATUS: Readonly<Record<DeskErrorCode, z.infer<typeof ErrorCode>>> = {
  wrong_code: 'forbidden',
  pairing_expired: 'expired',
  not_paired: 'conflict',
  request_expired: 'expired',
  no_screen: 'conflict',
  no_pin: 'conflict',
  easy_pin: 'validation_failed',
  no_voice: 'conflict',
  unknown_screen: 'not_found',
  screens_full: 'conflict',
  bad_layout: 'validation_failed',
};

/** `error.details` of a `desk.*` refusal; `triesLeft` with `wrong_code`. */
export const DeskErrorDetails = z.object({
  code: DeskErrorCode,
  triesLeft: z.number().int().min(0).max(5).optional(),
});
export type DeskErrorDetails = z.infer<typeof DeskErrorDetails>;
