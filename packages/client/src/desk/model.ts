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
import { formatClock, formatDate } from '@whombat/core/text';
import { normalizeClaimCode } from '@whombat/protocol/claim';
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

const W = DESK_WORDS.settings;
const E = DESK_WORDS.errors;

/** “Unpair the screen?” and what follows it, from the one sentence of `DESK_WORDS`. */
const [UNPAIR_TITLE, UNPAIR_LEAD] = (() => {
  const at = W.unpairConfirm.indexOf('? ');
  return at < 0 ? [W.unpairConfirm, ''] : [W.unpairConfirm.slice(0, at + 1), W.unpairConfirm.slice(at + 2)];
})();

/** Every word of the SCREEN section, its dialogs and the unlock request: `DESK_WORDS` where it has them. */
export const DESK_TEXT = {
  section: W.screen.toUpperCase(),
  pair: W.pairTheScreen,
  unpairedTitle: 'The screen isn’t paired',
  unpairedMeta: W.intro,
  pairingShown: (until: string) => `The screen shows pairing letters until ${until}.`,
  pairedYou: (since: string) => fillDeskWords(W.pairedWith, { name: 'you', date: since }),
  pairedMine: 'Unlock it with your PIN or your phone.',
  pairedMineNoPin: 'Unlock it with your phone.',
  unpair: W.unpair,
  pin: W.pin,
  pinMeta: '4 to 6 digits that unlock the screen.',
  changePin: W.changePin,
  noPin: W.noPin,
  choosePin: W.choosePinButton,
  /* The switch (DK-20, runtimes with `display`). */
  showOnScreen: W.showOnScreen,
  screenNamed: (name: string) => fillDeskWords(W.screenNamed, { name }),
  builtIn: W.builtIn,
  connectedUnnamed: W.connectedUnnamed,
  noScreenNow: W.noScreenNow,
  virtualHint: W.virtualHint,
  offHint: W.offHint,
  /** On, and not paired yet: the runtime pairs it within a minute (DK-17), or the person pairs it with its letters. */
  pairsItself: 'It pairs itself with you in a moment.',
  lockedShows: W.whileLocked,
  lockedViews: W.lockedViews as Record<DeskLockedView, string>,
  lockedHints: {
    time: () => 'The clock, and whether something needs you.',
    summary: () => 'How many things need you, your servers and home. No titles or messages.',
    everything: (assistant: string) =>
      `Also what needs you and what ${assistant} is doing, by name. Anyone walking past can read it.`,
  } as Record<DeskLockedView, (assistant: string) => string>,
  quietHours: W.quietHours,
  quietOn: (start: string, end: string, night: DeskNight) =>
    night === 'black'
      ? `From ${start} to ${end} the screen is black and makes no sound.`
      : `From ${start} to ${end} the screen shows a dim clock and makes no sound.`,
  quietOff: 'The screen may wake for something new at any hour.',
  from: W.from,
  to: W.to,
  inZone: (timeZone: string) => `In your time zone, ${timeZone}.`,
  atNight: W.atNight,
  nights: W.nights as Record<DeskNight, string>,
  talkTo: (assistant: string) => fillDeskWords(W.talkTo, { assistant }),
  talkOn: 'Hold to talk on the unlocked screen. What you say stays on this Whombat.',
  talkOff: 'The screen doesn’t listen.',
  noMicrophone: W.noMicrophone,
  noVoice: W.noVoice,
  /* Stay unlocked while you’re here (DK-28), where the box has a camera the presence service reads (before 0.107). */
  presence: W.presence,
  presenceHint: W.presenceHint,
  /* Lock again (0.107, DK-74), where the runtime lists its choices; `{assistant}` in `never`'s hint. */
  lockAgain: W.lockAgain,
  lockAgainChoices: W.lockAgainChoices as Record<DeskLockAgain, string>,
  lockAgainHints: (choice: DeskLockAgain, assistant: string) =>
    fillDeskWords((W.lockAgainHints as Record<DeskLockAgain, string>)[choice], { assistant }),
  /* Use the camera to see when you’re here (0.107, DK-72), where the runtime says the camera works for it. */
  cameraWake: W.cameraWake,
  cameraWakeHint: W.cameraWakeHint,
  /* The voice the screen answers with (0.105, DK-50, DK-51), under Talk while it is on. */
  voice: W.voice,
  voiceHint: (assistant: string) => fillDeskWords(W.voiceHint, { assistant }),
  voiceNames: W.voices as Record<DeskVoice, string>,
  voiceKinds: W.voiceKinds as Record<DeskVoice, string>,
  listen: W.listen,
  playing: W.listening,
  sampleFailed: W.sampleFailed,
  dialog: {
    title: W.pairTheScreen,
    lead: 'The screen shows 4 letters now. Type them here and choose a PIN to unlock it with.',
    showLetters: 'Show the letters',
    letters: W.typeLetters,
    lettersPlaceholder: 'ABCD',
    changesIn: (minutes: number) =>
      minutes < 1 ? 'They change in less than a minute.' : `They change in ${minutes} min.`,
    expired: 'The letters ran out of time.',
    newLetters: 'Show new letters',
    pin: W.choosePin,
    pinAgain: W.repeatPin,
    submit: 'Pair',
    busy: 'Pairing…',
    done: 'The screen is paired with you.',
    cancel: 'Cancel',
  },
  pinDialog: {
    title: W.changePin,
    lead: 'The new PIN unlocks the screen from now on.',
    submit: W.changePin,
    busy: 'Saving…',
    done: 'PIN changed.',
  },
  /** The first PIN of a screen that paired itself or was turned on (DK-18). */
  firstPinDialog: {
    title: W.choosePinButton,
    lead: 'Type it on the screen to unlock it by touch. Your phone still works too.',
    submit: 'Save PIN',
    busy: 'Saving…',
    done: 'PIN saved.',
  },
  /** Turning the screen off while it is paired: it ends the pairing and its PIN (DK-20). */
  offDialog: {
    title: 'Turn the screen off?',
    lead: (hasPin: boolean) => `This unpairs it${hasPin ? ' and removes its PIN' : ''}. ${W.offHint}`,
    submit: 'Turn off',
    done: 'The screen is off.',
  },
  unpairDialog: {
    title: UNPAIR_TITLE,
    lead: UNPAIR_LEAD,
    submit: W.unpair,
    done: 'The screen is unpaired.',
  },
  problems: {
    letters: 'Type the 4 letters from the screen.',
    pin: 'The PIN is 4 to 6 digits.',
    easy: E.easy_pin,
    pinAgain: W.pinsDiffer,
  },
  errors: {
    /** Five wrong tries: the screen already shows new letters. */
    newLetters: 'Those weren’t the letters. The screen shows new ones now.',
    forbidden: 'You can’t change this.',
    failed: 'That didn’t work. Try again.',
    /** A runtime from before 0.103 refused a PIN shorter than six digits as malformed (DK-34). */
    sixDigits: 'This Whombat takes a 6-digit PIN until it’s updated.',
  },
  unlock: {
    notice: W.unlockRequest,
    title: W.unlockRequest.replace(/\.$/, ''),
    meta: (secondsLeft: number) =>
      `Unlock it only if you’re at your desk. ${
        secondsLeft >= 60
          ? `Ends in ${Math.ceil(secondsLeft / 60)}\u00a0min.`
          : `Ends in ${secondsLeft}\u00a0s.`
      }`,
    unlock: W.unlock,
    no: W.no,
    unlocked: 'The screen is unlocked.',
    keptLocked: 'The screen stays locked.',
  },
} as const;

/* The SCREEN section --------------------------------------------------------------------------------------------- */

/** SCREEN shows where a screen is connected, or one is paired (a box without a display shows nothing). */
export function deskSectionShown(screen: Pick<DeskScreen, 'paired' | 'display'>): boolean {
  return screen.display.connected || screen.paired !== null;
}

/** The screen line (DK-16): “DELL U2720Q · connected”, “Built-in screen”, “A screen is connected”, or none now. */
export function deskScreenLine(display: DeskDisplay): string {
  if (!display.connected) return DESK_TEXT.noScreenNow;
  if (display.name) return DESK_TEXT.screenNamed(display.name);
  return display.builtIn ? DESK_TEXT.builtIn : DESK_TEXT.connectedUnnamed;
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
export function deskSwitchView(screen: Pick<DeskScreen, 'display' | 'on' | 'onChosen'>): DeskSwitchView {
  const display = screen.display;
  const on = screen.on;
  const virtual = display.connected && !display.real && !screen.onChosen;
  return {
    title: DESK_TEXT.showOnScreen,
    on,
    line: deskScreenLine(display),
    hint: virtual && !on ? DESK_TEXT.virtualHint : on ? null : DESK_TEXT.offHint,
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
function sinceText(at: string, now: number, timeZone: string): string {
  return formatDate(at, timeZone, { year: 'auto', now });
}

/** What Talk's switch says (DK-07): off by itself without a microphone or speech on the box. */
export function deskTalkView(
  screen: Pick<DeskScreen, 'settings' | 'hasMicrophone' | 'voiceAvailable'>,
  assistant: string,
): { title: string; on: boolean; disabled: boolean; meta: string } {
  const title = DESK_TEXT.talkTo(assistant);
  if (!screen.hasMicrophone) return { title, on: false, disabled: true, meta: DESK_TEXT.noMicrophone };
  if (!screen.voiceAvailable) return { title, on: false, disabled: true, meta: DESK_TEXT.noVoice };
  const on = screen.settings.voice;
  return { title, on, disabled: false, meta: on ? DESK_TEXT.talkOn : DESK_TEXT.talkOff };
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
): DeskVoiceView | null {
  if (!deskTalkView(screen, assistant).on) return null;
  const known = knownDeskVoices(screen.voices ?? []);
  if (known.length < 2) return null;
  return {
    title: DESK_TEXT.voice,
    meta: DESK_TEXT.voiceHint(assistant),
    value: known.find((v) => v === screen.settings.speechVoice) ?? null,
    options: known.map((value) => ({
      value,
      label: DESK_TEXT.voiceNames[value],
      kind: DESK_TEXT.voiceKinds[value],
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
): DeskLockAgainView | null {
  if (!screen.paired) return null;
  const listed = screen.lockAgain;
  const offered = DESK_LOCK_AGAIN.filter((c) => listed.includes(c));
  if (offered.length < 2) return null;
  const chosen = deskLockAgainOf(screen.settings);
  const value = offered.includes(chosen) ? chosen : 'idle';
  return {
    title: DESK_TEXT.lockAgain,
    value,
    options: offered.map((c) => ({ value: c, label: DESK_TEXT.lockAgainChoices[c] })),
    meta: DESK_TEXT.lockAgainHints(value, assistant),
  };
}

/**
 * *Use the camera to see when you’re here* (DK-72), where the screen is paired and the camera works
 * (`cameraWakeAvailable`).
 */
export function deskCameraWakeView(
  screen: Pick<DeskScreen, 'paired' | 'settings' | 'cameraWakeAvailable'>,
): DeskCameraWakeView | null {
  if (!screen.paired || !screen.cameraWakeAvailable) return null;
  return {
    title: DESK_TEXT.cameraWake,
    on: screen.settings.cameraWake,
    meta: DESK_TEXT.cameraWakeHint,
  };
}

/** Quiet hours in a sentence (DK-09). */
export function deskQuietText(quiet: DeskQuietHours, night: DeskNight): string {
  return quiet.enabled ? DESK_TEXT.quietOn(quiet.start, quiet.end, night) : DESK_TEXT.quietOff;
}

/**
 * The SCREEN section (DK-02, DK-03, DK-07, DK-09): the screen is the person's (CT-1510), so they pair, unpair and
 * choose.
 */
export function deskSectionView(
  screen: DeskScreen,
  context: { assistant: string; timeZone: string; now: number },
): DeskSectionView {
  const { assistant, timeZone, now } = context;
  const onScreen = deskSwitchView(screen);
  if (!screen.paired) {
    const pairing =
      screen.pairing && Date.parse(screen.pairing.expiresAt) > now
        ? DESK_TEXT.pairingShown(formatClock(screen.pairing.expiresAt, timeZone))
        : null;
    // Off says it all; on and nobody paired is the minute before it pairs itself (DK-17).
    const row = onScreen.on || pairing !== null;
    return {
      onScreen,
      unpaired: row ? { title: DESK_TEXT.unpairedTitle, meta: pairing ?? DESK_TEXT.pairsItself } : null,
      paired: null,
      mine: null,
      lockAgain: null,
      cameraWake: null,
    };
  }
  const p = screen.paired;
  const hasPin = p.hasPin;
  const since = sinceText(p.pairedAt, now, timeZone);
  const s = screen.settings;
  return {
    onScreen,
    unpaired: null,
    paired: {
      title: DESK_TEXT.pairedYou(since),
      meta: hasPin ? DESK_TEXT.pairedMine : DESK_TEXT.pairedMineNoPin,
    },
    mine: {
      pin: hasPin
        ? { has: true, meta: DESK_TEXT.pinMeta, action: DESK_TEXT.changePin }
        : { has: false, meta: DESK_TEXT.noPin, action: DESK_TEXT.choosePin },
      lockedView: s.lockedView,
      lockedOptions: LOCKED_VIEWS.map((value) => ({ value, label: DESK_TEXT.lockedViews[value] })),
      lockedHint: DESK_TEXT.lockedHints[s.lockedView](assistant),
      quietHours: s.quietHours,
      quietMeta: deskQuietText(s.quietHours, s.night),
      night: s.night,
      nightOptions: NIGHTS.map((value) => ({ value, label: DESK_TEXT.nights[value] })),
      talk: deskTalkView(screen, assistant),
      voice: deskVoiceView(screen, assistant),
    },
    lockAgain: deskLockAgainView(screen, assistant),
    cameraWake: deskCameraWakeView(screen),
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
export function deskPinProblem(pin: string, again: string): { field: DeskFormField; text: string } | null {
  if (!DESK_PIN_RE.test(pin)) return { field: 'pin', text: DESK_TEXT.problems.pin };
  if (deskPinTooEasy(pin)) return { field: 'pin', text: DESK_TEXT.problems.easy };
  if (pin !== again) return { field: 'pinAgain', text: DESK_TEXT.problems.pinAgain };
  return null;
}

/** The four letters as `desk.pair` takes them, or null when they aren't four letters of the claim alphabet. */
export function deskLetters(typed: string): string | null {
  const n = normalizeClaimCode(typed);
  return n.kind === 'letters' ? n.letters : null;
}

/** Why the pairing form can't be sent yet, or null (the letters first, then the PIN). */
export function deskPairProblem(form: {
  letters: string;
  pin: string;
  pinAgain: string;
}): { field: DeskFormField; text: string } | null {
  if (!deskLetters(form.letters)) return { field: 'letters', text: DESK_TEXT.problems.letters };
  return deskPinProblem(form.pin, form.pinAgain);
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

/** What a refused desk op means, in words (`DESK_WORDS.errors`). */
export function deskErrorText(error: unknown): string {
  const code = deskErrorCode(error);
  switch (code) {
    case 'wrong_code': {
      const left = triesLeftOf(error);
      if (left === 0) return DESK_TEXT.errors.newLetters;
      const text = fillDeskWords(E.wrong_code, { n: left });
      return left === 1 ? text.replace('1 tries', '1 try') : text;
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
      return DESK_TEXT.errors.forbidden;
    default:
      return sixDigitsOnly(error) ? DESK_TEXT.errors.sixDigits : DESK_TEXT.errors.failed;
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
export function deskListenErrorText(error: unknown): string {
  const code = deskErrorCode(error);
  return code !== null && (DESK_ERROR_CODES as readonly string[]).includes(code)
    ? deskErrorText(error)
    : DESK_TEXT.sampleFailed;
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
export function deskUnlockAnswerText(unlock: boolean, error?: unknown): string {
  if (error !== undefined) return deskErrorText(error);
  return unlock ? DESK_TEXT.unlock.unlocked : DESK_TEXT.unlock.keptLocked;
}
