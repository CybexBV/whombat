/**
 * The desk display in Settings (Whombat desk-display.md DK-02…DK-09, DK-16…DK-20, DK-26…DK-28, DK-72, DK-74; app
 * desk-display-web.md AP-3000…, AP-3100…, AP-3300…, AP-3600…): what This Whombat's SCREEN section shows the person —
 * the switch *Show Whombat on this screen* with what the screen is (runtimes that say so, 0.101), unpaired with Pair the
 * screen, or paired since when, the PIN (or none yet), what a locked screen shows, quiet hours, Talk, the voice
 * it answers with (0.105), *Lock again* (0.107; before it *Stay unlocked while you’re here*, 0.103) and *Use the camera
 * to see when you’re here* (0.107) — the pairing and PIN forms' checks (4 to 6 digits, none too easy), the ops' errors
 * in words, Listen's sample, and the screen's unlock request with its time left. Shared by the web and the phone; pure
 * (the clock is passed in).
 */
import { deskWords } from '@whombat/core/domain';
import { interpolate } from '@whombat/core/i18n';
import { formatClock, formatDate } from '@whombat/core/text';
import { normalizeClaimCode } from '@whombat/protocol/claim';
import { clientTree } from '../i18n/catalog';
import { DESK_WORDS as DESK_TEXT_WORDS } from '../i18n/messages/desk';
import { OperationError } from '../session/managed-ops';
import { fromBase64 } from '../svg';
import {
  DESK_ERROR_CODES,
  DESK_LOCK_AGAIN,
  DESK_PIN_MAX,
  DESK_PIN_RE,
  DESK_VOICE_SAMPLE_WAV_MAX_BYTES,
  DESK_WORDS,
  type DeskDisplay,
  type DeskLockAgain,
  type DeskLockedView,
  type DeskNight,
  type DeskQuietHours,
  type DeskScreen,
  type DeskVoice,
  type DeskVoiceSample,
  deskLockAgainOf,
  deskPinTooEasy,
  fillDeskWords,
  knownDeskVoices,
} from './contract';

/** “Unpair the screen?” and what follows it, from the one sentence of the desk's words. */
function splitUnpair(sentence: string): [string, string] {
  const at = sentence.indexOf('? ');
  return at < 0 ? [sentence, ''] : [sentence.slice(0, at + 1), sentence.slice(at + 2)];
}

/**
 * Every word of the SCREEN section, its dialogs and the unlock request in a locale (English when none is given): the
 * desk's own words where it has them.
 */
export function deskText(locale?: string | null) {
  const desk = locale === undefined || locale === null ? DESK_WORDS : deskWords(locale);
  const W = desk.settings;
  const E = desk.errors;
  const own = clientTree(locale, DESK_TEXT_WORDS);
  const [unpairTitle, unpairLead] = splitUnpair(W.unpairConfirm);
  const lockedHints = own.lockedHints;
  return {
    section: W.screen.toUpperCase(),
    pair: W.pairTheScreen,
    unpairedTitle: own.unpairedTitle,
    unpairedMeta: W.intro,
    pairingShown: (until: string) => interpolate(own.pairingShown, { until }),
    pairedYou: (since: string) => fillDeskWords(W.pairedWith, { name: own.pairedYouName, date: since }),
    pairedMine: own.pairedMine,
    pairedMineNoPin: own.pairedMineNoPin,
    unpair: W.unpair,
    pin: W.pin,
    pinMeta: own.pinMeta,
    changePin: W.changePin,
    noPin: W.noPin,
    choosePin: W.choosePinButton,
    /* The switch, on runtimes that report their `display`. */
    showOnScreen: W.showOnScreen,
    screenNamed: (name: string) => fillDeskWords(W.screenNamed, { name }),
    builtIn: W.builtIn,
    connectedUnnamed: W.connectedUnnamed,
    noScreenNow: W.noScreenNow,
    virtualHint: W.virtualHint,
    offHint: W.offHint,
    /** On, and not paired yet: the runtime pairs it within a minute, or the person pairs it with its letters. */
    pairsItself: own.pairsItself,
    lockedShows: W.whileLocked,
    lockedViews: W.lockedViews as Record<DeskLockedView, string>,
    lockedHints: {
      time: (assistant: string) => interpolate(lockedHints.time, { assistant }),
      summary: (assistant: string) => interpolate(lockedHints.summary, { assistant }),
      everything: (assistant: string) => interpolate(lockedHints.everything, { assistant }),
    } as Record<DeskLockedView, (assistant: string) => string>,
    quietHours: W.quietHours,
    quietOn: (start: string, end: string, night: DeskNight) =>
      interpolate(night === 'black' ? own.quietOnBlack : own.quietOnDim, { start, end }),
    quietOff: own.quietOff,
    from: W.from,
    to: W.to,
    inZone: (timeZone: string) => interpolate(own.inZone, { timeZone }),
    atNight: W.atNight,
    nights: W.nights as Record<DeskNight, string>,
    talkTo: (assistant: string) => fillDeskWords(W.talkTo, { assistant }),
    talkOn: own.talkOn,
    talkOff: own.talkOff,
    noMicrophone: W.noMicrophone,
    noVoice: W.noVoice,
    /* Stay unlocked while you’re here, where the box has a camera the presence service reads (older runtimes). */
    presence: W.presence,
    presenceHint: W.presenceHint,
    /* Lock again, where the runtime lists its choices; `{assistant}` in `never`'s hint. */
    lockAgain: W.lockAgain,
    lockAgainChoices: W.lockAgainChoices as Record<DeskLockAgain, string>,
    lockAgainHints: (choice: DeskLockAgain, assistant: string) =>
      fillDeskWords((W.lockAgainHints as Record<DeskLockAgain, string>)[choice], { assistant }),
    /* Use the camera to see when you’re here, where the runtime says the camera works for it. */
    cameraWake: W.cameraWake,
    cameraWakeHint: W.cameraWakeHint,
    /* The voice the screen answers with, under Talk while it is on. */
    voice: W.voice,
    voiceHint: (assistant: string) => fillDeskWords(W.voiceHint, { assistant }),
    voiceNames: W.voices as Record<DeskVoice, string>,
    voiceKinds: W.voiceKinds as Record<DeskVoice, string>,
    listen: W.listen,
    playing: W.listening,
    sampleFailed: W.sampleFailed,
    dialog: {
      title: W.pairTheScreen,
      lead: own.dialog.lead,
      showLetters: own.dialog.showLetters,
      letters: W.typeLetters,
      lettersPlaceholder: 'ABCD',
      changesIn: (minutes: number) =>
        minutes < 1 ? own.dialog.changesSoon : interpolate(own.dialog.changesIn, { minutes }),
      expired: own.dialog.expired,
      newLetters: own.dialog.newLetters,
      pin: W.choosePin,
      pinAgain: W.repeatPin,
      submit: own.dialog.submit,
      busy: own.dialog.busy,
      done: own.dialog.done,
      cancel: own.dialog.cancel,
    },
    pinDialog: {
      title: W.changePin,
      lead: own.pinDialog.lead,
      submit: W.changePin,
      busy: own.pinDialog.busy,
      done: own.pinDialog.done,
    },
    /** The first PIN of a screen that paired itself or was turned on. */
    firstPinDialog: {
      title: W.choosePinButton,
      lead: own.firstPinDialog.lead,
      submit: own.firstPinDialog.submit,
      busy: own.firstPinDialog.busy,
      done: own.firstPinDialog.done,
    },
    /** Turning the screen off while it is paired: it ends the pairing and its PIN. */
    offDialog: {
      title: own.offDialog.title,
      lead: (hasPin: boolean) =>
        interpolate(hasPin ? own.offDialog.leadPin : own.offDialog.lead, { offHint: W.offHint }),
      submit: own.offDialog.submit,
      done: own.offDialog.done,
    },
    unpairDialog: {
      title: unpairTitle,
      lead: unpairLead,
      submit: W.unpair,
      done: own.unpairDialog.done,
    },
    problems: {
      letters: own.problems.letters,
      pin: own.problems.pin,
      easy: E.easy_pin,
      pinAgain: W.pinsDiffer,
    },
    errors: {
      /** Five wrong tries: the screen already shows new letters. */
      newLetters: own.errors.newLetters,
      forbidden: own.errors.forbidden,
      failed: own.errors.failed,
      /** An older runtime refuses a PIN shorter than six digits as malformed. */
      sixDigits: own.errors.sixDigits,
    },
    unlock: {
      notice: W.unlockRequest,
      title: W.unlockRequest.replace(/\.$/, ''),
      meta: (secondsLeft: number) =>
        interpolate(own.unlock.meta, {
          ends:
            secondsLeft >= 60
              ? interpolate(own.unlock.endsMin, { n: Math.ceil(secondsLeft / 60) })
              : interpolate(own.unlock.endsSec, { n: secondsLeft }),
        }),
      unlock: W.unlock,
      no: W.no,
      unlocked: own.unlock.unlocked,
      keptLocked: own.unlock.keptLocked,
    },
  };
}

/** The SCREEN section's words in English. */
export type DeskTextWords = ReturnType<typeof deskText>;

export const DESK_TEXT: DeskTextWords = deskText('en');

/** The English words without building them again; another locale's when one is given. */
function textIn(locale?: string | null): DeskTextWords {
  return locale === undefined || locale === null || locale === 'en' ? DESK_TEXT : deskText(locale);
}

/* The SCREEN section --------------------------------------------------------------------------------------------- */

/** SCREEN shows where a screen is connected, or one is paired (a box without a display shows nothing). */
export function deskSectionShown(screen: Pick<DeskScreen, 'paired' | 'display'>): boolean {
  return screen.display.connected || screen.paired !== null;
}

/** The screen line (DK-16): “DELL U2720Q · connected”, “Built-in screen”, “A screen is connected”, or none now. */
export function deskScreenLine(display: DeskDisplay, locale?: string | null): string {
  const T = textIn(locale);
  if (!display.connected) return T.noScreenNow;
  if (display.name) return T.screenNamed(display.name);
  return display.builtIn ? T.builtIn : T.connectedUnnamed;
}

/** The switch's row: on, the screen line and the hint under it (DK-16, DK-20). */
export interface DeskSwitchView {
  title: string;
  on: boolean;
  line: string;
  /** A virtual machine's screen nobody turned on, else what off means; null while on. */
  hint: string | null;
}

/**
 * The switch (DK-20). A connected screen that isn't a real one and that nobody chose for gets the virtual-machine hint
 * (it already says the screen stays off); otherwise off says what off means.
 */
export function deskSwitchView(
  screen: Pick<DeskScreen, 'display' | 'on' | 'onChosen'>,
  locale?: string | null,
): DeskSwitchView {
  const T = textIn(locale);
  const display = screen.display;
  const on = screen.on;
  const virtual = display.connected && !display.real && !screen.onChosen;
  return {
    title: T.showOnScreen,
    on,
    line: deskScreenLine(display, locale),
    hint: virtual && !on ? T.virtualHint : on ? null : T.offHint,
  };
}

export interface DeskOption<T extends string> {
  value: T;
  label: string;
}

/**
 * *Lock again* (DK-74): the choices the runtime offers (`idle` and `never`, `away` where the camera works), the one
 * chosen and its hint.
 */
export interface DeskLockAgainView {
  title: string;
  value: DeskLockAgain;
  options: DeskOption<DeskLockAgain>[];
  /** What the chosen one means (`{assistant}` filled). */
  meta: string;
}

/** *Use the camera to see when you’re here* (DK-72). */
export interface DeskCameraWakeView {
  title: string;
  on: boolean;
  meta: string;
}

/** One of the screen's voices as Settings offers it: its name (“Heart”) and its kind (“American · woman”). */
export interface DeskVoiceOption {
  value: DeskVoice;
  label: string;
  kind: string;
}

/** The Voice row (DK-50): the voices the box has that this client knows, and the one chosen. */
export interface DeskVoiceView {
  title: string;
  meta: string;
  /** The chosen voice; null when the runtime chose one this client doesn't know (none shows as chosen). */
  value: DeskVoice | null;
  options: DeskVoiceOption[];
}

export interface DeskSectionView {
  /** First, *Show Whombat on this screen* (DK-20). */
  onScreen: DeskSwitchView;
  /** Unpaired: the one row and its button, while the switch is on (or letters show). */
  unpaired: null | { title: string; meta: string };
  /** Paired: since when, and how it unlocks. */
  paired: null | { title: string; meta: string };
  /** The paired screen's rows (PIN, the choices); null while it isn't paired. */
  mine: null | {
    /** A PIN (Change PIN), or none yet (DK-18: Choose a PIN). */
    pin: { has: boolean; meta: string; action: string };
    lockedView: DeskLockedView;
    lockedOptions: DeskOption<DeskLockedView>[];
    lockedHint: string;
    quietHours: DeskQuietHours;
    quietMeta: string;
    night: DeskNight;
    nightOptions: DeskOption<DeskNight>[];
    talk: { title: string; on: boolean; disabled: boolean; meta: string };
    /** The voice Talk answers with, under it while Talk is on (0.105: runtimes that list their `voices`). */
    voice: DeskVoiceView | null;
  };
  /** After Talk, while the screen is paired. */
  lockAgain: DeskLockAgainView | null;
  /** Right after *Lock again*, where the runtime says the camera works for it (0.107). */
  cameraWake: DeskCameraWakeView | null;
}

const LOCKED_VIEWS: readonly DeskLockedView[] = ['time', 'summary', 'everything'];
const NIGHTS: readonly DeskNight[] = ['dim', 'black'];

/** `20 Oct` (the year when it isn't this one). */
function sinceText(at: string, now: number, timeZone: string, locale?: string | null): string {
  return formatDate(at, timeZone, { year: 'auto', now }, locale);
}

/** What Talk's switch says (DK-07): off by itself without a microphone or speech on the box. */
export function deskTalkView(
  screen: Pick<DeskScreen, 'settings' | 'hasMicrophone' | 'voiceAvailable'>,
  assistant: string,
  locale?: string | null,
): { title: string; on: boolean; disabled: boolean; meta: string } {
  const T = textIn(locale);
  const title = T.talkTo(assistant);
  if (!screen.hasMicrophone) return { title, on: false, disabled: true, meta: T.noMicrophone };
  if (!screen.voiceAvailable) return { title, on: false, disabled: true, meta: T.noVoice };
  const on = screen.settings.voice;
  return { title, on, disabled: false, meta: on ? T.talkOn : T.talkOff };
}

/**
 * The voice the screen answers with (DK-50), under Talk while it is on: where the box lists two or more voices this
 * client knows (`DeskScreen.voices`, absent from runtimes before 0.105, which serve no `desk.voiceSample` either), in
 * `DESK_VOICES` order. With Talk off the screen doesn't speak, so there is nothing to choose, as quiet hours' times
 * go with quiet hours.
 */
export function deskVoiceView(
  screen: Pick<DeskScreen, 'settings' | 'hasMicrophone' | 'voiceAvailable' | 'voices'>,
  assistant: string,
  locale?: string | null,
): DeskVoiceView | null {
  if (!deskTalkView(screen, assistant, locale).on) return null;
  const T = textIn(locale);
  const known = knownDeskVoices(screen.voices ?? []);
  if (known.length < 2) return null;
  return {
    title: T.voice,
    meta: T.voiceHint(assistant),
    value: known.find((v) => v === screen.settings.speechVoice) ?? null,
    options: known.map((value) => ({
      value,
      label: T.voiceNames[value],
      kind: T.voiceKinds[value],
    })),
  };
}

/**
 * *Lock again* (DK-74), where the screen is paired: the choices the box lists (`lockAgain`) that this client knows, in `DESK_LOCK_AGAIN` order (the runtime's), each with its words, and the chosen one's hint. The value
 * is `deskLockAgainOf(settings)`; a choice the runtime doesn't offer now (*When you leave* with the camera gone) shows
 * as *After 2 minutes*, which is what the screen then does (DK-28: without a camera, DK-04's rule). Fewer than two
 * known choices: no row.
 */
export function deskLockAgainView(
  screen: Pick<DeskScreen, 'paired' | 'settings' | 'lockAgain'>,
  assistant: string,
  locale?: string | null,
): DeskLockAgainView | null {
  if (!screen.paired) return null;
  const listed = screen.lockAgain;
  const offered = DESK_LOCK_AGAIN.filter((c) => listed.includes(c));
  if (offered.length < 2) return null;
  const chosen = deskLockAgainOf(screen.settings);
  const value = offered.includes(chosen) ? chosen : 'idle';
  const T = textIn(locale);
  return {
    title: T.lockAgain,
    value,
    options: offered.map((c) => ({ value: c, label: T.lockAgainChoices[c] })),
    meta: T.lockAgainHints(value, assistant),
  };
}

/**
 * *Use the camera to see when you’re here* (DK-72), where the screen is paired and the camera works
 * (`cameraWakeAvailable`).
 */
export function deskCameraWakeView(
  screen: Pick<DeskScreen, 'paired' | 'settings' | 'cameraWakeAvailable'>,
  locale?: string | null,
): DeskCameraWakeView | null {
  if (!screen.paired || !screen.cameraWakeAvailable) return null;
  const T = textIn(locale);
  return {
    title: T.cameraWake,
    on: screen.settings.cameraWake,
    meta: T.cameraWakeHint,
  };
}

/** Quiet hours in a sentence (DK-09). */
export function deskQuietText(quiet: DeskQuietHours, night: DeskNight, locale?: string | null): string {
  const T = textIn(locale);
  return quiet.enabled ? T.quietOn(quiet.start, quiet.end, night) : T.quietOff;
}

/**
 * The SCREEN section (DK-02, DK-03, DK-07, DK-09): the screen is the person's (CT-1510), so they pair, unpair and
 * choose.
 */
export function deskSectionView(
  screen: DeskScreen,
  context: { assistant: string; timeZone: string; now: number; locale?: string | null },
): DeskSectionView {
  const { assistant, timeZone, now, locale } = context;
  const T = textIn(locale);
  const onScreen = deskSwitchView(screen, locale);
  if (!screen.paired) {
    const pairing =
      screen.pairing && Date.parse(screen.pairing.expiresAt) > now
        ? T.pairingShown(formatClock(screen.pairing.expiresAt, timeZone))
        : null;
    // Off says it all; on and nobody paired is the minute before it pairs itself (DK-17).
    const row = onScreen.on || pairing !== null;
    return {
      onScreen,
      unpaired: row ? { title: T.unpairedTitle, meta: pairing ?? T.pairsItself } : null,
      paired: null,
      mine: null,
      lockAgain: null,
      cameraWake: null,
    };
  }
  const p = screen.paired;
  const hasPin = p.hasPin;
  const since = sinceText(p.pairedAt, now, timeZone, locale);
  const s = screen.settings;
  return {
    onScreen,
    unpaired: null,
    paired: {
      title: T.pairedYou(since),
      meta: hasPin ? T.pairedMine : T.pairedMineNoPin,
    },
    mine: {
      pin: hasPin
        ? { has: true, meta: T.pinMeta, action: T.changePin }
        : { has: false, meta: T.noPin, action: T.choosePin },
      lockedView: s.lockedView,
      lockedOptions: LOCKED_VIEWS.map((value) => ({ value, label: T.lockedViews[value] })),
      lockedHint: T.lockedHints[s.lockedView](assistant),
      quietHours: s.quietHours,
      quietMeta: deskQuietText(s.quietHours, s.night, locale),
      night: s.night,
      nightOptions: NIGHTS.map((value) => ({ value, label: T.nights[value] })),
      talk: deskTalkView(screen, assistant, locale),
      voice: deskVoiceView(screen, assistant, locale),
    },
    lockAgain: deskLockAgainView(screen, assistant, locale),
    cameraWake: deskCameraWakeView(screen, locale),
  };
}

/* Forms ------------------------------------------------------------------------------------------------------------ */

/** A PIN as it is typed: digits only, at most six (DK-26). */
export function formatDeskPinInput(raw: string): string {
  return raw.replace(/\D/g, '').slice(0, DESK_PIN_MAX);
}

export type DeskFormField = 'letters' | 'pin' | 'pinAgain';

/**
 * Why a new PIN (typed twice) can't be sent yet, or null: 4 to 6 digits (DK-26), not one that is too easy to guess
 * (DK-27, before anything is sent; Whombat refuses it too), then the same twice.
 */
export function deskPinProblem(
  pin: string,
  again: string,
  locale?: string | null,
): { field: DeskFormField; text: string } | null {
  const P = textIn(locale).problems;
  if (!DESK_PIN_RE.test(pin)) return { field: 'pin', text: P.pin };
  if (deskPinTooEasy(pin)) return { field: 'pin', text: P.easy };
  if (pin !== again) return { field: 'pinAgain', text: P.pinAgain };
  return null;
}

/** The four letters as `desk.pair` takes them, or null when they aren't four letters of the claim alphabet. */
export function deskLetters(typed: string): string | null {
  const n = normalizeClaimCode(typed);
  return n.kind === 'letters' ? n.letters : null;
}

/** Why the pairing form can't be sent yet, or null (the letters first, then the PIN). */
export function deskPairProblem(
  form: {
    letters: string;
    pin: string;
    pinAgain: string;
  },
  locale?: string | null,
): { field: DeskFormField; text: string } | null {
  if (!deskLetters(form.letters)) return { field: 'letters', text: textIn(locale).problems.letters };
  return deskPinProblem(form.pin, form.pinAgain, locale);
}

/** Whole minutes until the letters change (rounded down), or null once they have. */
export function deskLettersMinutes(expiresAt: string, now: number): number | null {
  const ms = Date.parse(expiresAt) - now;
  return ms > 0 ? Math.floor(ms / 60_000) : null;
}

/* Errors ----------------------------------------------------------------------------------------------------------- */

/**
 * Why a desk op refused: the contracts' `error.details.code` (`DESK_ERROR_CODES`; the error's own code is the generic
 * one, `forbidden`, `expired`, `conflict`), else the error's code; null for anything but a refusal.
 */
export function deskErrorCode(error: unknown): string | null {
  if (!(error instanceof OperationError)) return null;
  const code = (error.details as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : error.code;
}

/**
 * A runtime from before 0.103 takes six digits only: a shorter PIN fails its schema (`validation_failed` on `pin`, no
 * desk code), DK-34.
 */
function sixDigitsOnly(error: unknown): boolean {
  if (deskErrorCode(error) !== 'validation_failed') return false;
  const fields = ((error as OperationError).details as { fields?: unknown } | undefined)?.fields;
  return typeof fields === 'object' && fields !== null && 'pin' in fields;
}

function triesLeftOf(error: unknown): number {
  const left = ((error as OperationError).details as { triesLeft?: unknown } | undefined)?.triesLeft;
  return typeof left === 'number' ? left : 0;
}

/** What a refused desk op means, in words (the desk's own error words). */
export function deskErrorText(error: unknown, locale?: string | null): string {
  const code = deskErrorCode(error);
  const T = textIn(locale);
  const E = locale === undefined || locale === null ? DESK_WORDS.errors : deskWords(locale).errors;
  switch (code) {
    case 'wrong_code': {
      const left = triesLeftOf(error);
      if (left === 0) return T.errors.newLetters;
      // The desk's sentence says “tries”; one try left has its own.
      if (left === 1) return clientTree(locale, DESK_TEXT_WORDS).errors.wrongCodeOne;
      return fillDeskWords(E.wrong_code, { n: left });
    }
    case 'pairing_expired':
    case 'not_paired':
    case 'request_expired':
    case 'no_screen':
    case 'no_pin':
    case 'easy_pin':
    case 'no_voice':
      return E[code];
    case 'forbidden':
      return T.errors.forbidden;
    default:
      return sixDigitsOnly(error) ? T.errors.sixDigits : T.errors.failed;
  }
}

/** Whether a refused `desk.pair` or `desk.setPin` is about the PIN (too easy, or too short for an older Whombat). */
export function deskPinRefused(error: unknown): boolean {
  return deskErrorCode(error) === 'easy_pin' || sixDigitsOnly(error);
}

/** Whether a refused `desk.pair` is about the letters (wrong, or no longer on the screen). */
export function deskLettersRefused(error: unknown): boolean {
  const code = deskErrorCode(error);
  return code === 'wrong_code' || code === 'pairing_expired';
}

/** Whether a refused `desk.pair` asks for new letters (none left to try, or they ran out). */
export function deskNeedsNewLetters(error: unknown): boolean {
  const code = deskErrorCode(error);
  return code === 'pairing_expired' || (code === 'wrong_code' && triesLeftOf(error) === 0);
}

/* Listen ------------------------------------------------------------------------------------------------------------ */

/**
 * The WAV in `desk.voiceSample`'s answer (base64, at most 1 MiB): its bytes, or an error when they aren't base64 or a
 * WAV (Listen says it couldn't play).
 */
export function deskSampleWav(sample: DeskVoiceSample): Uint8Array {
  const bytes = fromBase64(sample.audioWav);
  const tag = (at: number) => String.fromCharCode(...(bytes?.subarray(at, at + 4) ?? []));
  if (!bytes || bytes.byteLength > DESK_VOICE_SAMPLE_WAV_MAX_BYTES || tag(0) !== 'RIFF' || tag(8) !== 'WAVE')
    throw new Error('The voice sample isn’t a WAV.');
  return bytes;
}

/**
 * Why Listen didn't play: a desk refusal's words (`no_voice`: the box can't say it now), anything else (the sample
 * didn't arrive, or the device couldn't play it) “The voice couldn’t play. Try again.”.
 */
export function deskListenErrorText(error: unknown, locale?: string | null): string {
  const code = deskErrorCode(error);
  return code !== null && (DESK_ERROR_CODES as readonly string[]).includes(code)
    ? deskErrorText(error, locale)
    : textIn(locale).sampleFailed;
}

/* The unlock request ----------------------------------------------------------------------------------------------- */

export interface DeskUnlockRequest {
  id: string;
  expiresAt: string;
  /** Whole seconds left (at least 1 while it shows). */
  secondsLeft: number;
}

/**
 * The screen's unlock request the person can answer (DK-04), only until it expires (the notice and the NEEDS YOU row go
 * by the clock, not just by `desk.changed`).
 */
export function deskUnlockRequest(
  screen: Pick<DeskScreen, 'paired' | 'unlockRequest'> | null | undefined,
  now: number,
): DeskUnlockRequest | null {
  const r = screen?.unlockRequest;
  if (!screen?.paired || !r) return null;
  const ms = Date.parse(r.expiresAt) - now;
  if (!(ms > 0)) return null;
  return { id: r.id, expiresAt: r.expiresAt, secondsLeft: Math.max(1, Math.ceil(ms / 1000)) };
}

/** What answering said: unlocked, kept locked, or why it couldn't. */
export function deskUnlockAnswerText(unlock: boolean, error?: unknown, locale?: string | null): string {
  if (error !== undefined) return deskErrorText(error, locale);
  const T = textIn(locale);
  return unlock ? T.unlock.unlocked : T.unlock.keptLocked;
}
