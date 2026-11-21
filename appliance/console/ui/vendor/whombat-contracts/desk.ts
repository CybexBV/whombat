/**
 * The desk display (0.100, CT-517…CT-522; Whombat docs/decisions/desk-display.md DK-01…DK-15): the box's own screen,
 * paired to one person, shows Whombat — a glance while locked, asks to answer and a voice to talk to once that person
 * unlocks it. These are the shapes Settings reads and writes (`desk.*` session ops), the rule for which asks the screen
 * may answer (`deskMayDecide`), and the words the console page, the web app and the phone share (`DESK_WORDS`).
 *
 * The runtime is the one authority for what the screen shows and does; the console page draws what it is given (the
 * desk socket, `@whombat/control-contracts/local`). Pure: no I/O.
 */
import { z } from 'zod';
import { classifyCommand, type ShellSimpleCommand, shellSimpleCommands } from '../commands/classify.js';
import type { CommandCategory } from '../commands/commands.js';
import { PrincipalId } from '../ids.js';
import { keyTierRowOf } from '../keys/grants.js';
import { formatBytes, hostDiskUsedPct } from '../text/host.js';
import { type DateInput, formatClock } from '../text/time.js';
import type { Approval, ConnectionCallAction } from './approval.js';
import { Timestamp } from './common.js';
import { deletesByName } from './connections-catalog.js';
import {
  type DeskCalmInput,
  type DeskCalmView,
  type DeskCalmWords,
  deskAttention,
  deskCalm,
} from './desk-calm.js';
import {
  applyDeskShowPatch,
  DEFAULT_DESK_SHOW,
  type DESK_UPDATE_STATES,
  type DeskBarItem,
  type DeskCalm,
  type DeskClock,
  type DeskPreviewScenario,
  DeskShow,
  type DeskShowLevel,
  DeskShowOption,
  DeskShowPatch,
  DeskWhombatName,
} from './desk-glance.js';

type DeskUpdateStateName = (typeof DESK_UPDATE_STATES)[number];

import type { DeskAttention, DeskPopups } from './desk-screens.js';
import { ClockTime, inQuietWindow } from './notify.js';
import { HUMAN_TONES } from './principal.js';
import { TASK_CARD_WORDS } from './task-card.js';

/* Settings (DK-03, DK-06, DK-09) ------------------------------------------------------------------------------- */

/**
 * What the screen shows while locked (DK-03): `time` the clock and one line (“All fine.” or “Something needs you.”),
 * `summary` (the default) counts, servers, home tiles and power without titles or message words, `everything` also the
 * asks' titles, what the assistant is working on, Done today and its own status line.
 */
export const DESK_LOCKED_VIEWS = ['time', 'summary', 'everything'] as const;
export const DeskLockedView = z.enum(DESK_LOCKED_VIEWS);
export type DeskLockedView = z.infer<typeof DeskLockedView>;

/** In quiet hours (DK-09): a dim clock, or a black screen with the backlight off. */
export const DESK_NIGHTS = ['dim', 'black'] as const;
export const DeskNight = z.enum(DESK_NIGHTS);
export type DeskNight = z.infer<typeof DeskNight>;

/** Quiet hours every day in the paired person's time zone (DK-09); `start` = `end` is quiet all day. */
export const DeskQuietHours = z.object({
  enabled: z.boolean(),
  start: ClockTime,
  end: ClockTime,
});
export type DeskQuietHours = z.infer<typeof DeskQuietHours>;

export const DEFAULT_DESK_QUIET_HOURS: DeskQuietHours = { enabled: true, start: '23:00', end: '07:00' };

/**
 * The voices the screen can answer with (0.105, CT-610; DK-50): Kokoro v1.0's, two American women, two American men,
 * a British woman and a British man. `heart` is the default, the voice the box spoke with before there was a choice
 * (DK-36).
 */
export const DESK_VOICES = ['heart', 'bella', 'michael', 'fenrir', 'emma', 'george'] as const;
export const DeskVoice = z.enum(DESK_VOICES);
export type DeskVoice = z.infer<typeof DeskVoice>;
export const DEFAULT_DESK_VOICE: DeskVoice = 'heart';
/**
 * A voice's name as answers carry it (`DeskSettings.speechVoice`, `DeskScreen.voices`): any name, so a client older
 * than a runtime that has more voices still reads the screen; it shows only the voices of its `DESK_VOICES`.
 */
export const DeskVoiceName = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export type DeskVoiceName = z.infer<typeof DeskVoiceName>;

/** The voices of `names` this client knows, in `DESK_VOICES` order. */
export function knownDeskVoices(names: readonly string[]): DeskVoice[] {
  return DESK_VOICES.filter((v) => names.includes(v));
}

/** The paired person's choices for the screen. Missing members take the defaults. */
export const DeskSettings = z.object({
  lockedView: DeskLockedView.default('summary'),
  quietHours: DeskQuietHours.default(() => ({ ...DEFAULT_DESK_QUIET_HOURS })),
  night: DeskNight.default('dim'),
  /** Talk to the assistant (DK-06, DK-07); on by default, off by itself on a machine without a microphone. */
  voice: z.boolean().default(true),
  /**
   * *Stay unlocked while you’re here* (0.103, CT-592; DK-28): while the screen is unlocked, the camera checks that
   * someone is in front of it. Off until the paired person turns it on; Settings shows it only where
   * `DeskScreen.presenceAvailable`.
   */
  presence: z.boolean().default(false),
  /**
   * The voice the screen answers with (0.105, CT-610; DK-50), one of `DeskScreen.voices`; `heart` until the paired
   * person chooses. A `DeskVoiceName`: a voice this client doesn't know doesn't break it.
   */
  speechVoice: DeskVoiceName.default(DEFAULT_DESK_VOICE),
  /**
   * *Lock again: When you press Lock* (0.107, CT-640; DK-74): an unlock lasts until the Lock button, another choice, the
   * screen turned off, unpaired or paired again, or a reboot (DK-75). Wins over `presence` when both are on (DK-76).
   * Read and written as one choice with `presence`: `deskLockAgainOf`, `deskLockAgainPatch`.
   */
  stayUnlocked: z.boolean().default(false),
  /**
   * *Use the camera to see when you’re here* (0.107, CT-641; DK-72): the camera looks while the screen is on outside
   * quiet hours, locked or unlocked, and the screen shows the glance while it sees someone and only the clock when
   * nobody is there (DK-70, DK-71). Off until the paired person turns it on; Settings shows it only where
   * `DeskScreen.cameraWakeAvailable`.
   */
  cameraWake: z.boolean().default(false),
  /**
   * What the screen shows (3.2, CT-1621; DK-102): the top bar's items, each thing's *Always*, *When it matters* or
   * *Off*, the strip's order, the clock, *Welcome back* and *Done today* (`DeskShow` of `desk-glance.ts`).
   */
  show: DeskShow.default(() => ({
    ...DEFAULT_DESK_SHOW,
    bar: { ...DEFAULT_DESK_SHOW.bar },
    items: {},
    order: [],
  })),
});
export type DeskSettings = z.infer<typeof DeskSettings>;

export const DEFAULT_DESK_SETTINGS: DeskSettings = {
  lockedView: 'summary',
  quietHours: DEFAULT_DESK_QUIET_HOURS,
  night: 'dim',
  voice: true,
  presence: false,
  speechVoice: DEFAULT_DESK_VOICE,
  stayUnlocked: false,
  cameraWake: false,
  show: DEFAULT_DESK_SHOW,
};

/** `desk.update`'s input: any of the settings, each whole (`quietHours` with all three members). */
export const DeskSettingsPatch = z.strictObject({
  lockedView: DeskLockedView.optional(),
  quietHours: z.strictObject(DeskQuietHours.shape).optional(),
  night: DeskNight.optional(),
  voice: z.boolean().optional(),
  presence: z.boolean().optional(),
  /** 0.105 (CT-610): one of `DESK_VOICES` that the screen's `voices` lists, else `no_voice`. */
  speechVoice: DeskVoice.optional(),
  /** 0.107 (CT-640): only where `DeskScreen.lockAgain` lists `never`. */
  stayUnlocked: z.boolean().optional(),
  /** 0.107 (CT-641): only where `DeskScreen.cameraWakeAvailable`. */
  cameraWake: z.boolean().optional(),
  /** 3.2 (CT-1621; DK-102): what the screen shows, any part (`applyDeskShowPatch`). */
  show: DeskShowPatch.optional(),
});
export type DeskSettingsPatch = z.infer<typeof DeskSettingsPatch>;

/**
 * The settings after `desk.update`'s `patch` (3.2, CT-1621): each setting given replaces it, `show` changes only the
 * parts it names (`applyDeskShowPatch`). Pure: Settings shows it before the answer, the runtime keeps it.
 */
export function applyDeskSettingsPatch(settings: DeskSettings, patch: DeskSettingsPatch): DeskSettings {
  const { show, ...rest } = patch;
  return {
    ...settings,
    ...rest,
    ...(rest.quietHours ? { quietHours: { ...rest.quietHours } } : {}),
    show: show ? applyDeskShowPatch(settings.show, show) : settings.show,
  };
}

/**
 * *Lock again* (0.107, CT-642; DK-74): `idle` 2 minutes after the last touch (DK-04, the default), `away` 30 seconds
 * after the camera last saw the person (DK-28, `presence`), `never` when the person presses Lock (`stayUnlocked`).
 */
export const DESK_LOCK_AGAIN = ['idle', 'away', 'never'] as const;
export const DeskLockAgain = z.enum(DESK_LOCK_AGAIN);
export type DeskLockAgain = z.infer<typeof DeskLockAgain>;

/** The settings' *Lock again* (DK-74): `stayUnlocked` wins over `presence` (DK-76). */
export function deskLockAgainOf(s: Pick<DeskSettings, 'presence' | 'stayUnlocked'>): DeskLockAgain {
  if (s.stayUnlocked) return 'never';
  return s.presence ? 'away' : 'idle';
}

/** The `desk.update` patch that chooses `choice` (DK-74): both members, so one can't contradict the other. */
export function deskLockAgainPatch(choice: DeskLockAgain): { presence: boolean; stayUnlocked: boolean } {
  return { presence: choice === 'away', stayUnlocked: choice === 'never' };
}

/** Whether the screen is in its quiet hours at `now`, in the paired person's `timeZone` (DK-09). */
export function deskQuietNow(
  settings: Pick<DeskSettings, 'quietHours'>,
  now: DateInput,
  timeZone: string,
): boolean {
  return inQuietWindow(settings.quietHours, now, timeZone);
}

/* Pairing and unlocking (DK-02, DK-04) ------------------------------------------------------------------------- */

/**
 * 4 to 6 digits (0.103, CT-590; DK-26): whoever chooses the PIN chooses its length. ASCII digits written out (`[0-9]`, not `\d`): the same pattern crosses to Go (CT-529).
 */
export const DESK_PIN_MIN = 4;
export const DESK_PIN_MAX = 6;
export const DESK_PIN_RE = /^[0-9]{4,6}$/;
export const DeskPin = z.string().regex(DESK_PIN_RE);
export type DeskPin = z.infer<typeof DeskPin>;
/** A PIN's length (DK-26): the pad shows that many dots and unlocks at the last. */
export const DeskPinDigits = z.number().int().min(DESK_PIN_MIN).max(DESK_PIN_MAX);
export type DeskPinDigits = z.infer<typeof DeskPinDigits>;

/** A PIN of `ab` repeated (1212, 12121, 121212) or `abc` repeated (123123): the same digits every 2 or 3. */
function repeatsEvery(pin: string, period: number): boolean {
  if (pin.length < 2 * period) return false;
  for (let i = period; i < pin.length; i++) if (pin[i] !== pin[i - period]) return false;
  return true;
}

/** Each digit `step` more than the one before (−1: one less), 9 and 0 next to each other. */
function runs(pin: string, step: 1 | -1): boolean {
  for (let i = 1; i < pin.length; i++)
    if ((Number(pin[i - 1]) + step + 10) % 10 !== Number(pin[i])) return false;
  return true;
}

/**
 * Too easy to guess (0.103, CT-591; DK-27): one digit repeated (0000, 11111); a run where each digit is one more, or
 * each one less, than the one before, 9 and 0 next to each other (1234, 7890, 8901, 4321, 0987, 123456); a pair or
 * three digits repeated (1212, 6969, 12121, 123123). Whombat refuses these (`easy_pin`); Settings says so before it
 * sends anything. Only judges a PIN (`DESK_PIN_RE`): anything else is false, the schema's to refuse.
 */
export function deskPinTooEasy(pin: string): boolean {
  if (!DESK_PIN_RE.test(pin)) return false;
  return runs(pin, 1) || runs(pin, -1) || [1, 2, 3].some((period) => repeatsEvery(pin, period));
}

/** How long the pairing letters stay on the screen (DK-02). */
export const DESK_PAIRING_TTL_S = 600;
/** Wrong letters in Settings before the screen shows new ones, and wrong PINs before a wait (DK-02, DK-04). */
export const DESK_TRIES = 5;
/** An unlocked screen locks this long after the last touch (DK-04). */
export const DESK_UNLOCKED_IDLE_S = 120;
/** How long *Confirm on your phone* waits for Unlock or No (DK-04). */
export const DESK_PHONE_UNLOCK_TTL_S = 120;
/** The wait after five wrong PINs, doubling with each wrong PIN after it, at most an hour (DK-04). */
export const DESK_PIN_BACKOFF_FIRST_S = 60;
export const DESK_PIN_BACKOFF_MAX_S = 3_600;
/** A talk within this long of the last one may continue its Chat thread (DK-06). */
export const DESK_TALK_CONTINUE_S = 120;
/**
 * The open conversation on the screen (0.108, CT-661; DK-64) ends when nothing was said in it for this long, or when the
 * person closes it.
 */
export const DESK_TALK_SESSION_IDLE_S = 1_800;
/**
 * A talk without an answer after this long is `working` (0.116, CT-893; Whombat task-feedback.md TF-16, amending
 * DK-T06): it keeps waiting for the turn to end…
 */
export const DESK_TALK_WORKING_S = 90;
/** …at most this long after the question, then it is `failed` with `slow` (the answer still lands in Chat). */
export const DESK_TALK_WAIT_MAX_S = 1_800;

/**
 * Stay unlocked while you’re here (0.103, CT-592; DK-28…DK-30). Once the camera has seen a face since this unlock, the
 * screen locks `DESK_PRESENCE_GONE_S` after the last face or touch; until then, and whenever the camera can't tell,
 * `DESK_UNLOCKED_IDLE_S` after the last touch (or face) as before. Never more than `DESK_PRESENCE_MAX_S` unlocked in a
 * row this way. The runtime asks the presence service every `DESK_PRESENCE_CHECK_S` while it wants the camera. A face
 * never unlocks (DK-29).
 */
export const DESK_PRESENCE_GONE_S = 30;
export const DESK_PRESENCE_MAX_S = 14_400;
export const DESK_PRESENCE_CHECK_S = 2;

/**
 * Only the clock when nobody's there (0.107, CT-643; DK-70, DK-71). Without the camera the screen is idle
 * `DESK_IDLE_S` after the last touch; with the camera watching, `DESK_AWAY_S` after the last face and the last touch,
 * whichever is later (`DeskPresence.here` is a face within `DESK_AWAY_S`). A new ask by day keeps the glance up
 * `DESK_IDLE_S` (DK-08's 10 minutes).
 */
export const DESK_IDLE_S = 600;
export const DESK_AWAY_S = 60;

/** Tries left after `wrong` wrong PINs (or wrong pairing letters) in a row. */
export function deskTriesLeft(wrong: number): number {
  return Math.max(0, DESK_TRIES - wrong);
}

/**
 * The wait after `wrong` wrong PINs in a row (DK-04): none below five, then 1 minute, doubling with each wrong PIN
 * after it (2, 4, 8, … minutes), at most an hour. A right PIN starts the count again.
 */
export function deskPinBackoffS(wrong: number): number {
  if (wrong < DESK_TRIES) return 0;
  return Math.min(DESK_PIN_BACKOFF_MAX_S, DESK_PIN_BACKOFF_FIRST_S * 2 ** Math.min(wrong - DESK_TRIES, 12));
}

/** A phone unlock request (DK-04), what `desk.answerUnlock` names. */
export const DeskUnlockRequestId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export type DeskUnlockRequestId = z.infer<typeof DeskUnlockRequestId>;

/**
 * The screen as the runtime sees it (0.101, CT-538; DK-16). `connected` is `DeskScreen.hasDisplay`: a DRM connector
 * reads `connected`. `real`: connected, its card's driver isn't a virtual machine's and it has an EDID whose maker isn't
 * a virtual display's (a monitor or a laptop's own panel); every VM has a connected virtual display, so `connected`
 * alone can't tell a desk from a cupboard.
 */
export const DeskDisplay = z.object({
  connected: z.boolean(),
  /** A real monitor or a built-in panel: connected, not a virtual driver, an EDID not from a virtual maker. */
  real: z.boolean(),
  /** A laptop's own panel (eDP, LVDS, DSI). */
  builtIn: z.boolean(),
  /** The EDID's monitor name (“DELL U2720Q”); null when it names none. Plain text, ≤ 60. */
  name: z.string().min(1).max(60).nullable(),
});
export type DeskDisplay = z.infer<typeof DeskDisplay>;

/**
 * The screen as Settings sees it (`desk.get` and the answer of every `desk.*` change): whether it is paired with the
 * person, their settings, a pairing or a phone unlock waiting, and what the machine has. `settings` are the defaults
 * while it isn't paired. `display`, the switch `on` with `onChosen`, and `paired.hasPin` and `paired.self`: 0.101
 * (CT-538, CT-539; DK-16…DK-20). Since 3.0 (CT-1510) the screen is always the person's: `paired.you` went.
 */
export const DeskScreen = z.object({
  paired: z
    .object({
      /** The person's principal. */
      personId: PrincipalId,
      name: z.string().min(1).max(80),
      pairedAt: Timestamp,
      /** False: no PIN was chosen, only the phone unlocks (DK-18). */
      hasPin: z.boolean(),
      /** It paired itself (DK-17) or was turned on in Settings (DK-20), rather than by its letters (DK-02). */
      self: z.boolean(),
    })
    .nullable(),
  settings: DeskSettings,
  /** The screen shows pairing letters until then (`desk.startPairing`). */
  pairing: z.object({ expiresAt: Timestamp }).nullable(),
  /** *Confirm on your phone* was pressed; Unlock or No until then (`desk.answerUnlock`). */
  unlockRequest: z.object({ id: DeskUnlockRequestId, expiresAt: Timestamp }).nullable(),
  /** A screen is connected (DRM connector status). */
  hasDisplay: z.boolean(),
  hasMicrophone: z.boolean(),
  hasSpeaker: z.boolean(),
  hasBattery: z.boolean(),
  /** Speech works here (the voice service answers, with a microphone): Talk can be turned on. */
  voiceAvailable: z.boolean(),
  /** What the screen is (DK-16). */
  display: DeskDisplay,
  /**
   * *Show Whombat on this screen* now (DK-20): what the person chose (`desk.setScreen`), else `display.real`. Off: nothing
   * pairs itself and the console shows the plain claimed screen.
   */
  on: z.boolean(),
  /** The person chose `on`; false is the default, where DK-20's virtual-screen hint applies when `!display.real`. */
  onChosen: z.boolean(),
  /**
   * The presence service answers and has a camera it can read (0.103, CT-593; DK-28, DK-31): *Stay unlocked while
   * you’re here* can be shown.
   */
  presenceAvailable: z.boolean(),
  /**
   * The voices this box can answer with (0.105, CT-611; DK-50), its default first: Settings offers the ones it knows
   * (`knownDeskVoices`) with *Listen* (`desk.voiceSample`). Absent (a voice service that can't choose) or fewer than
   * two: no Voice row.
   */
  voices: z.array(DeskVoiceName).max(32).optional(),
  /**
   * The *Lock again* choices this runtime offers (0.107, CT-644; DK-74), in `DESK_LOCK_AGAIN` order: `idle` and `never`
   * always, `away` where `presenceAvailable`.
   */
  lockAgain: z.array(DeskLockAgain).max(3),
  /**
   * *Use the camera to see when you’re here* can be shown (0.107, CT-645; DK-72): this runtime knows it and the camera
   * works (as `presenceAvailable`).
   */
  cameraWakeAvailable: z.boolean(),
  /**
   * What the person can choose to show (3.2, CT-1622; DK-106), Settings → Screen's lists: the assistant's work and
   * what's coming up, the connections and devices, Home's widgets, the servers in the strip's order, This Whombat.
   * Absent from a runtime before 3.2, and while the screen isn't paired.
   */
  showOptions: z.array(DeskShowOption).max(200).optional(),
  /** The name the top bar shows (3.2, CT-1623; DK-119), as the app last gave it (`desk.setName`); null before. */
  whombatName: DeskWhombatName.nullable().optional(),
});
export type DeskScreen = z.infer<typeof DeskScreen>;

/** The paired person's avatar tone as the screen draws it: 1…5, the position in `HUMAN_TONES` (1 when not one). */
export function deskToneOf(tone: string): 1 | 2 | 3 | 4 | 5 {
  const i = HUMAN_TONES.findIndex((t) => t.toLowerCase() === tone.toLowerCase());
  return (i < 0 ? 1 : i + 1) as 1 | 2 | 3 | 4 | 5;
}

/* What the screen may answer (DK-05) --------------------------------------------------------------------------- */

/**
 * Why an ask stays on the phone (DK-05): money, a release (deploying, merging, pushing to main), deleting, giving keys,
 * messaging people outside. (`share` went with sharing skills in 3.0, CT-1573.)
 */
export const DESK_PHONE_REASONS = ['money', 'release', 'delete', 'keys', 'outside'] as const;
export const DeskPhoneReason = z.enum(DESK_PHONE_REASONS);
export type DeskPhoneReason = z.infer<typeof DeskPhoneReason>;

export type DeskDecision = { ok: true } | { ok: false; reason: DeskPhoneReason };

/** The reason for each risk row (`KEY_TIER_ROWS`) and for the keys of what goes outside or deletes. */
const ROW_REASONS: Readonly<Record<string, DeskPhoneReason>> = {
  deploy: 'release',
  merge: 'release',
  'branch.main.push': 'release',
  'commands.destructive': 'delete',
  'messages.external': 'outside',
  'refunds.issue': 'money',
};
const KEY_REASONS: Readonly<Record<string, DeskPhoneReason>> = {
  'mail.send': 'outside',
  'calendar.invite': 'outside',
  'files.share': 'outside',
  'files.delete': 'delete',
  'mail.delete': 'delete',
  'agents.manage': 'keys',
};

/**
 * The reason each command category keeps its card on the phone (`COMMAND_CATEGORIES`): every shell command's needs a key
 * and none is everyday. A web lookup or the browser at Ask (`web`, `browser`, CT-1236) may be answered on the screen.
 */
const COMMAND_REASONS: Readonly<Record<CommandCategory, DeskPhoneReason | null>> = {
  deploy: 'release',
  deploy_production: 'release',
  merge: 'release',
  push_main: 'release',
  destructive: 'delete',
  message_external: 'outside',
  web: null,
  browser: null,
};

/** Connection tools that run a shell command on a server (`args.command`): never judged without the command. */
const COMMAND_TOOLS: readonly string[] = ['server_command'];

/** Tools that delete, wipe or repartition whatever they're given (`mkfs*` too). */
const REMOVING_TOOLS = new Set([
  'rm',
  'rmdir',
  'shred',
  'unlink',
  'truncate',
  'wipefs',
  'sgdisk',
  'sfdisk',
  'fdisk',
  'parted',
  'lvremove',
  'vgremove',
  'pvremove',
]);
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const DOCKER_GROUPS = new Set(['container', 'image', 'volume', 'network', 'system']);
const DOCKER_GROUP_REMOVING = new Set(['rm', 'remove', 'prune']);
const HELM_REMOVING = new Set(['uninstall', 'delete', 'del', 'un']);
/** Options that take the next word as their value, per tool, so it isn't read as the subcommand. */
const VALUED = {
  docker: new Set([
    '-c',
    '--context',
    '--config',
    '-H',
    '--host',
    '-l',
    '--log-level',
    '--url',
    '--connection',
  ]),
  compose: new Set([
    '-f',
    '--file',
    '-p',
    '--project-name',
    '--project-directory',
    '--env-file',
    '--profile',
  ]),
  kubectl: new Set([
    '-n',
    '--namespace',
    '--context',
    '--kubeconfig',
    '-s',
    '--server',
    '--cluster',
    '--user',
  ]),
  helm: new Set(['-n', '--namespace', '--kube-context', '--kubeconfig']),
  virsh: new Set(['-c', '--connect']),
  incus: new Set(['--project']),
} as const;
const NOTHING_VALUED: ReadonlySet<string> = new Set();
const SQL_DELETING = /\b(drop|truncate)\b/i;
const REDIS_FLUSH = /\bflush(all|db)\b/i;

/** The words that aren't options (`-x`, `--long`, `--long=v`, and each `valued` option's next word); `--` ends them. */
function operandsOf(args: readonly string[], valued: ReadonlySet<string> = NOTHING_VALUED): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--') {
      out.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('-') && a.length > 1) {
      if (valued.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/** `docker compose …` and `docker-compose …`: `rm`, or `down` taking volumes or images with it. */
function composeDeletes(args: readonly string[]): boolean {
  const sub = operandsOf(args, VALUED.compose)[0];
  if (sub === 'rm') return true;
  if (sub !== 'down') return false;
  return args
    .slice(args.indexOf('down') + 1)
    .some((a) => /^-[a-z]*v/i.test(a) || /^--(volumes|rmi)(=|$)/.test(a));
}

/** Whether one simple command deletes something, wherever it runs (CT-535). `text` is the whole command. */
function simpleCommandDeletes(c: ShellSimpleCommand, text: string): boolean {
  const { name, args } = c;
  if (c.truncates.length > 0) return true;
  if (REMOVING_TOOLS.has(name) || name.startsWith('mkfs')) return true;
  const ops = () => operandsOf(args);
  switch (name) {
    case 'find':
      return args.some(
        (a, i) => a === '-delete' || (FIND_EXEC.has(a) && REMOVING_TOOLS.has(basename(args[i + 1] ?? ''))),
      );
    case 'dd':
      return args.some((a) => a.startsWith('of='));
    case 'zfs':
      return ['destroy', 'rollback'].includes(ops()[0] ?? '');
    case 'zpool':
      return ['destroy', 'labelclear'].includes(ops()[0] ?? '');
    case 'btrfs': {
      // btrfs takes unambiguous prefixes: `btrfs sub del`.
      const [group = '', verb = ''] = ops();
      return group.length >= 3 && 'subvolume'.startsWith(group) && verb !== '' && 'delete'.startsWith(verb);
    }
    case 'docker':
    case 'podman': {
      const [sub = '', verb = ''] = operandsOf(args, VALUED.docker);
      if (sub === 'rm' || sub === 'rmi') return true;
      if (sub === 'compose') return composeDeletes(args.slice(args.indexOf('compose') + 1));
      return DOCKER_GROUPS.has(sub) && DOCKER_GROUP_REMOVING.has(verb);
    }
    case 'docker-compose':
    case 'podman-compose':
      return composeDeletes(args);
    case 'kubectl':
      return operandsOf(args, VALUED.kubectl)[0] === 'delete';
    case 'helm':
      return HELM_REMOVING.has(operandsOf(args, VALUED.helm)[0] ?? '');
    case 'pct':
    case 'qm':
      return ops()[0] === 'destroy';
    case 'virsh':
      return operandsOf(args, VALUED.virsh)[0] === 'undefine';
    case 'incus':
    case 'lxc':
      // `incus delete web`, `incus snapshot delete web s0`, `incus storage volume delete default data`.
      return operandsOf(args, VALUED.incus).slice(0, 3).includes('delete');
    case 'pvesm':
      return ops()[0] === 'free';
    case 'psql':
    case 'mysql':
    case 'mariadb':
      return SQL_DELETING.test(text);
    case 'redis-cli':
      return REDIS_FLUSH.test(text);
    default:
      return false;
  }
}

const basename = (word: string) => word.slice(word.lastIndexOf('/') + 1);

/**
 * Whether a shell command a connection call runs on a server deletes something (DK-05, CT-535): the desk's own reading,
 * stricter than the guard's `destructive` (which `classifyCommand` keeps narrow for commands on the person's Whombat). Any of its
 * simple commands (`shellSimpleCommands`: through `sudo`, after `&&`, inside `bash -c`, …): `rm`, `rmdir`, `shred`,
 * `unlink`, `truncate`; `find … -delete` or `-exec rm`; `dd of=…`; `mkfs*`, `wipefs`, `sgdisk`, `sfdisk`, `fdisk`,
 * `parted`; `zfs destroy|rollback`, `zpool destroy|labelclear`; `lvremove`, `vgremove`, `pvremove`; `btrfs subvolume
 * delete`; `docker|podman rm|rmi`, `… container|image|volume|network|system rm|prune`; compose `rm`, or `down` with
 * `-v`, `--volumes` or `--rmi`; `kubectl delete`; `helm uninstall`; `pct destroy`, `qm destroy`; `virsh undefine`;
 * `incus|lxc … delete`; `pvesm free`; `psql`, `mysql` or `mariadb` with DROP or TRUNCATE in the command; `redis-cli`
 * with FLUSHALL or FLUSHDB; and a redirection that writes a file over (`> file`; not `>>`, not `/dev/null`).
 */
function commandDeletes(command: string): boolean {
  return shellSimpleCommands(command).some((c) => simpleCommandDeletes(c, command));
}

/**
 * Why the shell command a connection call runs keeps it on the phone (DK-05, CT-535), or null when it may be answered
 * on the screen. A string `command` among the deferred call's arguments (`server_command`'s, or any other tool's that
 * runs one) runs on the server: deleting comes first (`commandDeletes`) — whatever else the command does, that is what
 * can't be undone — then `classifyCommand` with `runsOn` (the server the call names), so its destructive commands
 * count as over ssh, and its category gives the reason. A tool that runs a command without the command to read (no
 * arguments, or no string `command`) is `delete`: the screen can't tell it isn't one.
 */
function connectionCallCommand(
  params: Pick<ConnectionCallAction['params'], 'tool' | 'server'>,
  args: Readonly<Record<string, unknown>> | null | undefined,
): DeskPhoneReason | null {
  const command = typeof args?.command === 'string' ? args.command : null;
  if (command === null) return COMMAND_TOOLS.includes(params.tool) ? 'delete' : null;
  if (commandDeletes(command)) return 'delete';
  const named = [params.server?.name, args?.server].find((s) => typeof s === 'string' && s.trim() !== '');
  const runsOn = typeof named === 'string' ? named : 'server';
  const found = classifyCommand(command, { productionServers: [], runsOn });
  return found ? COMMAND_REASONS[found.category] : null;
}

/** Servers tools that destroy for good whatever they're called with: a guest turned into a template stays one. */
const DESTROYING_TOOLS: readonly string[] = ['guest_template'];
/** An `action` (Servers tools) or socket method that deletes, or restores over what is there. */
const DESTROYING_ACTION = /^(delete|destroy|remove|erase|purge|wipe|trash|restore|rollback)$/i;
/** The server's own words for a call (CT-347) that delete or restore over something. */
const DESTROYING_WORDS =
  /(^|[^a-z])(delete|deletes|deleting|remove|destroy|erase|purge|wipe|trash|restore|roll back)([^a-z]|$)/i;

/**
 * Whether a `connection_call` deletes or destroys something (DK-05): a tool named for deleting (`guest_delete`,
 * `deletesByName`), a tool that destroys whatever it's called with (`guest_template`), the server's words for the call
 * saying it deletes or restores over something (“Delete the snapshot before-upgrade of web”), and — when the caller
 * has the deferred call's arguments — a `DELETE` request, a socket method named for deleting, or an `action` that
 * deletes or restores (`guest_snapshot`, `guest_backup`, `storage_volume`, …). Errs towards the phone.
 */
export function connectionCallDestroys(
  params: Pick<ConnectionCallAction['params'], 'tool' | 'words'>,
  args?: Readonly<Record<string, unknown>> | null,
): boolean {
  if (deletesByName(params.tool) || DESTROYING_TOOLS.includes(params.tool)) return true;
  if (params.words && DESTROYING_WORDS.test(params.words)) return true;
  if (!args) return false;
  const method = typeof args.method === 'string' ? args.method : '';
  if (method.toUpperCase() === 'DELETE' || (method && deletesByName(method))) return true;
  return typeof args.action === 'string' && DESTROYING_ACTION.test(args.action);
}

/**
 * Whether the desk screen may approve an ask without more (DK-05), or why it is risky. Whombat enforces it: the page
 * only shows the buttons the runtime allows. Since 0.108 (DK-62) a risky ask may be approved on the screen only with
 * the PIN typed again for it (on a screen without a PIN: on the phone), and denied or put off there without. Risky: a Vault use; money (a refund); a release (a deploy, a
 * merge, a push to main, a command that deploys, reaches production, merges or pushes to main); deleting (a file to
 * the trash, a destructive command, a connection call that deletes or destroys, `connectionCallDestroys`); a key
 * given to the agent; a message, mail, invite or share to people outside; and any ask whose key is a risk row
 * (`keyTierRowOf`: Deploy, Merge into main, Push to main, Destructive commands, Message people outside, Money) or one
 * of the keys that send outside or delete. Everything else may be answered on the screen: an ordinary connection
 * call (`server_command` running `docker restart plex`, “Restart Plex”), a `custom` ask about a key
 * outside those.
 *
 * Every shell command's `run_command` category is consequential (`COMMAND_CATEGORIES`), so every command stays on the
 * phone; a web lookup or the browser at Ask (`web`, `browser`, CT-1236) may be answered on the screen.
 * A connection call that runs a shell command (`server_command`, or any call whose arguments carry a string
 * `command`) is judged by that command as well, as running on the server (CT-535): one that deletes something —
 * the desk's own, wider reading (`rm`, `docker rm`, `zfs destroy`, `kubectl delete`, `> file`, …) or a destructive
 * command `classifyCommand` finds there — is `delete`, one that messages outside `outside`, one that deploys, merges
 * or pushes to main `release`. Pass the deferred call's arguments (`call.args`) when the caller has them; without them a connection
 * call is judged by its tool and words only — except `server_command`, which then stays on the phone as `delete`: the
 * screen can't tell its command isn't a destructive one.
 */
export function deskMayDecide(
  approval: Pick<Approval, 'action' | 'keyId'>,
  call?: { args?: Readonly<Record<string, unknown>> | null },
): DeskDecision {
  const no = (reason: DeskPhoneReason): DeskDecision => ({ ok: false, reason });
  const { action } = approval;
  switch (action.type) {
    case 'refund':
      return no('money');
    case 'deploy':
    case 'merge_pr':
      return no('release');
    // To the default branch; any other branch goes by its key below.
    case 'push_shared_branch':
      if (action.params.branch === 'main' || action.params.branch === 'master') return no('release');
      break;
    case 'run_command': {
      const reason = COMMAND_REASONS[action.params.category];
      if (reason) return no(reason);
      return { ok: true };
    }
    case 'files_trash':
      return no('delete');
    case 'connection_call': {
      if (connectionCallDestroys(action.params, call?.args)) return no('delete');
      const ran = connectionCallCommand(action.params, call?.args);
      if (ran) return no(ran);
      break;
    }
    case 'grant_key':
      return no('keys');
    case 'message_external':
    case 'mail_send':
    case 'calendar_invite':
    case 'files_share':
      return no('outside');
    default:
      break;
  }
  if (approval.keyId) {
    const row = keyTierRowOf(approval.keyId);
    const reason = (row && ROW_REASONS[row]) ?? KEY_REASONS[approval.keyId];
    if (reason) return no(reason);
  }
  return { ok: true };
}

/* Words (DK-13) ------------------------------------------------------------------------------------------------ */

const NBSP = '\u00a0';

/**
 * The words of the desk screen and its Settings, shared by the console page (which copies them: it can't import), the
 * web app and the phone. `{name}`, `{n}`, `{m}`, `{assistant}`, … are filled with `fillDeskWords`; a number and `%`
 * are joined by a no-break space. The assistant's name always comes from the runtime, never written in.
 */
export const DESK_WORDS = {
  /* The lock (mockups 1–3). */
  locked: 'Locked · touch to use',
  unlockedAs: 'Unlocked as {name} · locks in {n} min',
  /** While the camera sees someone (0.103, DK-28, DK-30). */
  unlockedHere: 'Unlocked as {name} · stays unlocked while you’re here',
  /** The camera mark's label while the camera is on (DK-30). */
  cameraOn: 'The camera is on while the screen is unlocked',
  /** The chip of a screen that stays unlocked until Lock (0.107, DK-74): no minutes. */
  unlockedStays: 'Unlocked as {name}',
  /** The camera mark's label on the glance and the clock while the camera looks for someone (0.107, DK-73). */
  cameraLooking: 'The camera is on to see when you’re here',
  lock: 'Lock',
  /* The glance (mockup 1). */
  needsYou: 'Needs you',
  touchToAnswer: 'Touch to answer',
  workingOn: 'Working on',
  doneToday: 'Done today',
  steps: { done: 'Done', now: 'Now', next: 'Next' },
  cpu: 'CPU',
  memory: 'Memory',
  temp: 'Temp',
  moreServers: '+{n} more',
  /**
   * A server card's three lines (0.115, DK-80): the labels, `none` for a figure the runtime doesn't send (DK-88),
   * and `open` the card's label as a button (DK-83).
   */
  card: { cpu: 'CPU', memory: 'MEM', disk: 'DISK', none: '–', open: 'Open {name}' },
  /** The runtime's note for a server whose hottest sensor is warm or hot (0.115, DK-81). */
  hot: 'hot · {n}°',
  /** All the servers (0.115, DK-86): opened by “+N more” (`moreServers`); `more` counts those beyond `DESK_SERVERS`. */
  servers: { title: 'Servers', more: '{n} more in the app' },
  /** `deskStatusLine`. */
  status: {
    fine: 'Everything’s fine.',
    needsYouOne: '1 thing needs you.',
    needsYouMany: '{n} things need you.',
    look: '{server} needs a look.',
    down: '{server} is down.',
    doing: 'I’m {doing}.',
    decision: '{title} needs a decision.',
    /** *Only the time* and the quiet hours' dim clock (DK-03, mockup 4). */
    allFine: 'All fine.',
    somethingNeedsYou: 'Something needs you.',
    /** A new box (DK-23): nothing needs the person, nothing worked on, no servers, no tiles; `connectHint` its `more`. */
    ready: 'All fine. I’m ready when you are.',
    connectHint: 'Connect a server or your home, and I’ll keep an eye on it here.',
  },
  /** The calm Needs you card when nothing needs the person (DK-23). */
  nothingNeedsYou: 'Nothing needs you.',
  nothingNeedsYouHint: 'When I need a decision, it shows here.',
  /**
   * Needs you's looks (0.118, CT-971; DK-93…DK-96): a server, connection or device that is down or needs a look. Its row
   * and its card's title are `status.down` and `status.look` with `{server}` the look's name; `offer` follows that on the
   * assistant's line (DK-94), as `touchToAnswer` follows an ask's. The card (DK-95): `noticed` over what it is
   * (`kinds`), the reason or `noReason`, the buttons `fix`, `open` (a server's screen) and the page's Close, `fine` once
   * it is fine again. `question` is what *Ask {assistant} to look into it* sends as the person's words when the look
   * carries no question of its own (DK-96; the reason without its last full stop), `questionBare` without a reason.
   *
   * 0.122 (CT-1065; Whombat quiet-notices.md QN-20): `fix` asks the assistant to *look into* it (a problem only, never an
   * only-you look); `ignore` and `notNow` quiet the look (`look/quiet`, the PIN first when locked), and the card says
   * `ignored` or `snoozed` before it closes.
   */
  looks: {
    offer: 'Shall I look into it?',
    noticed: '{assistant} noticed',
    kinds: {
      server: 'A server',
      connection: 'A connection',
      device: 'A device',
    } satisfies Record<DeskLookKind, string>,
    noReason: 'I don’t know why yet.',
    fix: 'Ask {assistant} to look into it',
    open: 'Open {name}',
    fine: 'It looks fine again.',
    question: 'Please take a look at {name}: {reason}.',
    questionBare: 'Please take a look at {name}.',
    ignore: 'Ignore',
    notNow: 'Not now',
    ignored: 'Ignored. You’ll hear if it changes.',
    snoozed: 'I’ll remind you tomorrow.',
    /**
     * What the assistant found out (3.5; Whombat look-research.md): `looking` while it finds out (`lookingSoFar` with
     * the reason Whombat already knows, without its last full stop), `fixing` while it takes the step the person let it
     * take, `ask` the button that asks about it in Talk once it said what is wrong.
     */
    looking: 'I’m looking into it.',
    lookingSoFar: 'I’m looking into it. So far: {reason}.',
    fixing: 'I’m on it.',
    ask: 'Ask {assistant}',
  },
  /** This Whombat (DK-22, mockup `new-box.html`): the page fills the holes from `DeskGlance.box`. */
  box: {
    title: 'This Whombat',
    lastHour: 'Last hour',
    processor: 'Processor · {n} cores',
    memory: 'Memory · of {total}',
    storage: 'Storage',
    /** “812” big, “GB free” small. */
    free: '{unit} free',
    used: `{n}${NBSP}% used`,
    ofTotal: 'of {total}',
    temperature: 'Temperature',
    tempNote: 'Processor · {tone}',
    tones: { ok: 'cool', warn: 'warm', bad: 'hot' } satisfies Record<DeskBoxTone, string>,
    network: 'Network ↓ {down} · ↑ {up}',
    hourAgo: '1 h ago',
    now: 'now',
    /** The chart's scale lines. */
    scale: `{n}${NBSP}%`,
    hint: 'Your servers and home show here once you connect them.',
    /** The storage parts' names; the agent's is its name (`{assistant}`). */
    parts: { whombat: 'Whombat', agent: '{assistant}' } satisfies Record<DeskBoxPartKey, string>,
  },
  /**
   * A server's own screen (0.115, DK-83…DK-85, mockup 2): the page fills the holes from `DeskServerPage`. The
   * temperature's `{tone}` is one of `box.tones`; the network line and the chart's scale are `box.network` and
   * `box.scale`, the chart's last time `box.now`. A guest without a CPU figure shows its state's word (`guestStates`).
   */
  server: {
    back: 'Back',
    allFine: 'All fine',
    cores: '{n} cores',
    coresOne: '1 core',
    cpu: 'CPU',
    load: 'load {n}',
    memory: 'Memory',
    memoryOf: 'of {total}',
    disk: 'Disk',
    diskOf: '{used} of {total}',
    temperature: 'Temperature',
    tempNote: '{tone} · limit {n}°',
    ranges: { '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days' } satisfies Record<
      DeskServerRange,
      string
    >,
    rangeChips: { '1h': '1 h', '24h': '24 h', '7d': '7 d' } satisfies Record<DeskServerRange, string>,
    /** The chart's first time on 24 hours, “yesterday 14:30”. */
    yesterday: 'yesterday {time}',
    cpuPeak: `CPU · peak {n}${NBSP}% at {time}`,
    memoryAvg: `Memory · avg {n}${NBSP}%`,
    storage: 'Storage',
    guests: 'Guests',
    guestsCount: '{running} running · {off} off',
    guestStates: {
      running: 'running',
      stopped: 'off',
      unhealthy: 'needs a look',
      paused: 'paused',
    } satisfies Record<DeskGuestState, string>,
    alertsOne: '1 thing to look at',
    alertsMany: '{n} things to look at',
    ask: 'Ask {assistant} about {server}',
    off: '{server} is off.',
    unavailable: 'I can’t reach your servers right now.',
    noFigures: 'No figures yet.',
  },
  /* An ask (mockup 2). */
  /** Since 0.116 (TF-15) `{assistant}` is the ask's requester (`DeskAsk.from`) when the ask names one. */
  asks: '{assistant} asks',
  notNow: 'Not now',
  ask: 'Ask',
  approve: 'Approve',
  onPhone: 'Answer this on your phone.',
  /** 0.108 (DK-61, DK-62): the person's no; Approve of a risky ask after the PIN; on a screen without a PIN. */
  deny: 'Deny',
  approveWithPin: 'Type your PIN to approve this.',
  approveOnPhone: 'Approve this on your phone.',
  /**
   * 0.116 (CT-890; TF-14): the PIN pad's line for one of an ask's wider choices (`DeskAsk.choices`, every one needs the
   * PIN), `{choice}` its label; and the words for `not_offered` (the choice isn't the person's to make, or not any more).
   */
  choiceWithPin: 'Type your PIN for “{choice}”.',
  notOffered: 'That choice isn’t available here any more.',
  phoneReasons: {
    money: 'It’s about money.',
    release: 'It deploys or changes main.',
    delete: 'It deletes something.',
    keys: 'It gives {assistant} a key.',
    outside: 'It reaches people outside.',
  } satisfies Record<DeskPhoneReason, string>,
  /* Unlocking (mockup 2). */
  /** The pad of a screen without a PIN (DK-18): “Unlock as {name}”, only *Confirm on your phone*, and this. */
  noPinYet: 'Choose a PIN in Settings to unlock here.',
  unlockAs: 'Unlock as {name}',
  confirmOnPhone: 'Confirm on your phone',
  orConfirmOnPhone: 'or confirm on your phone',
  checkPhone: 'Check your phone',
  phoneSaidNo: 'Not unlocked.',
  wrongPin: 'Wrong PIN. {n} tries left.',
  wrongPinOne: 'Wrong PIN. 1 try left.',
  tooManyPins: 'Too many wrong PINs. Try again in {m} min.',
  cancel: 'Cancel',
  delete: 'Delete',
  /* Pairing (DK-02). */
  pairThisScreen: 'Pair this screen',
  pairHint: 'Type these letters in Settings → Screen.',
  /* Talking (mockup 3). */
  typeToAsk: 'Type to ask {assistant}',
  /**
   * 3.3 (Whombat docs/decisions/dictation.md): Talk's mic is voice typing — tap, speak, *Done*, and the words wait in
   * the box until *Send*. The recording bar's words are voice typing's (`VOICE_WORDS.composer`, `VOICE_WORDS.errors`),
   * the same strings written out so the screen can copy them.
   */
  tapToTalk: 'Tap to talk',
  wordsFirst: 'You see the words before they’re sent',
  dictation: {
    cancel: 'Cancel',
    done: 'Done',
    preparing: 'Starting…',
    recording: 'Recording {time}',
    transcribing: 'Turning speech into text…',
    send: 'Send',
    nothing: 'Nothing was heard.',
    busy: 'This Whombat is busy with another recording. Try again in a moment.',
    badAudio: 'That recording didn’t work. Try again.',
    tooLong: 'That was longer than 5 minutes. Try a shorter one.',
    failed: 'Couldn’t turn that into text. Try again.',
  },
  listening: 'Listening…',
  thinking: 'Thinking…',
  youAsked: 'You asked',
  onThisWhombat: 'Heard and spoken on this Whombat',
  notHeard: 'I didn’t catch that. Try again?',
  slow: '{assistant} is still working on it. The answer will be in Chat.',
  /**
   * 0.116 (CT-893, CT-894; TF-16, TF-17): a talk that is `working`, and the conversation's working row when it has no
   * `doing`.
   */
  working: '{assistant} is working on it…',
  /** 0.116 (CT-895; TF-17): a task row's state in the conversation, the card's labels (`TASK_CARD_WORDS.states`). */
  tasks: TASK_CARD_WORDS.states,
  voiceUnavailable: 'Talking doesn’t work right now. You can type instead.',
  talkFailed: 'That didn’t work. Try again?',
  /* Power (DK-10, mockups 1 and 4; `hostPowerText`). */
  power: {
    pluggedKept: `Plugged in · battery kept at {n}${NBSP}%`,
    pluggedCharging: `Plugged in · charging · {n}${NBSP}%`,
    plugged: `Plugged in · {n}${NBSP}%`,
    onBattery: `On battery · {n}${NBSP}% · about {time} left`,
    onBatteryNoTime: `On battery · {n}${NBSP}%`,
    outSince: 'The power has been out since {clock}.',
    outBanner: `Whombat is on battery, about {time} left. {assistant} shuts it down safely at 10${NBSP}%.`,
    outBannerNoTime: `Whombat is on battery. {assistant} shuts it down safely at 10${NBSP}%.`,
    /** The assistant's Chat messages to the person. */
    out: 'The power is out. Whombat is running on its battery, about {time} left.',
    outNoTime: 'The power is out. Whombat is running on its battery.',
    back: 'The power is back.',
    low: `The battery is at {n}${NBSP}%. I’ll shut Whombat down at 10${NBSP}% to keep your data safe.`,
  },
  /**
   * The calm glance (3.2, CT-1624; DK-101…DK-124): the sentence by the clock and its muted line, the hero's buttons,
   * the strip's words, *Welcome back*, the top bar's chips and *Try it on the screen*'s banner. `{assistant}` is the
   * assistant's name, `{clock}` a time of day, `{time}` a duration (“2 h 10 min”).
   */
  calm: {
    headline: {
      fine: 'All fine',
      wrongOne: '1 thing is wrong',
      wrongMany: '{n} things are wrong',
      lookOne: '1 thing to look at',
      lookMany: '{n} things to look at',
      askOne: '{assistant} has a question',
      askMany: '{n} questions for you',
      busy: '{assistant} is busy',
    },
    /** The muted line: what runs, and whether anything needs the person. */
    running: '{things} are running.',
    runningOne: '{things} is running.',
    and: '{a} and {b}',
    servers: { one: '1 server', many: '{n} servers' },
    services: { one: '1 service', many: '{n} services' },
    nothingNeedsYou: 'Nothing needs you.',
    /** The busy line under the work's title: how far along. */
    stepsDone: '{n} of {m} done.',
    /** The hero (DK-113). */
    since: 'Since {clock} · {ago}',
    fix: 'Ask {assistant} to fix it',
    open: 'Open {name}',
    answer: 'Answer',
    notNow: 'Not now',
    /** A look's hero offers Ignore where it offered *Not now* (3.5; look-research.md). */
    ignore: 'Ignore',
    look: 'Look',
    moreNeeds: '+{n} more',
    /** A down server's hero detail (DK-113): what runs on it. */
    runsOnOne: '{a} runs on it, so it’s down too.',
    runsOnTwo: '{a} and {b} run on it, so they’re down too.',
    runsOnMore: '{a}, {b} and {n} more run on it, so they’re down too.',
    notAnswering: '{name} isn’t answering',
    isOff: '{name} is off',
    /** A disk filling up (DK-114). */
    diskFull: `disk is {n}${NBSP}% full`,
    diskForecast: `disk is {n}${NBSP}% full; at this rate it’s full in about {days} days`,
    diskForecastSoon: `disk is {n}${NBSP}% full; at this rate it’s full within a day`,
    /** The middle (DK-115). */
    now: 'Now',
    doneOne: '{assistant} did 1 thing today',
    doneMany: '{assistant} did {n} things today',
    comingUp: 'Coming up',
    pinned: 'Pinned',
    /** The strip (DK-116, DK-117). */
    strip: {
      notAnswering: 'not answering',
      off: 'off',
      disk: `disk {n}${NBSP}%`,
      cpu: `CPU {n}${NBSP}%`,
      memory: `memory {n}${NBSP}%`,
      updating: 'updating',
      done: '✓ done',
      next: 'next',
      more: '+{n}',
    },
    /** *Welcome back* (DK-120…DK-122). */
    welcome: {
      title: 'Welcome back.',
      away: 'You were away for {time}. Meanwhile:',
      asks: '{assistant} asks: {title}',
      askOne: '{assistant} has a question for you',
      asksCount: '{n} questions wait for you',
      doneOne: '{assistant} finished 1 thing',
      doneCount: '{assistant} finished {n} things',
      /** What happened to a server or a connection while nobody was there. */
      down: '{name} went down',
      trouble: '{name} ran into trouble',
      look: '{name} needs a look',
      up: '{name} is fine again',
      back: 'Back to the glance in a minute',
    },
    /** The top bar (DK-110, DK-111). */
    bar: {
      cable: 'Cable',
      noNetwork: 'No network',
      online: 'Online',
      offline: 'No internet',
      remoteOn: 'Remote help on',
      remoteLive: 'Support is connected',
      updates: {
        downloading: 'Getting an update',
        installing: 'Updating',
        restarting: 'Restarting',
      } satisfies Record<DeskUpdateStateName, string>,
      charge: `{n}${NBSP}%`,
      onBattery: 'On battery · {time}',
      onBatteryNoTime: `On battery · {n}${NBSP}%`,
      low: `{n}${NBSP}% · plug me in`,
      locked: 'Locked',
    },
    /** The status sheet the top bar opens (DK-110). */
    sheet: {
      title: 'This Whombat',
      network: 'Network',
      internet: 'Internet',
      battery: 'Battery',
      remoteHelp: 'Remote help',
      updates: 'Updates',
      close: 'Close',
    },
    /** *Try it on the screen* (DK-124). */
    sample: 'Preview from Settings',
    /** The work in Settings' preview “{assistant} at work” (DK-123). */
    sampleWork: 'Updating your servers',
    /** What the assistant found on Settings' preview's server that isn't answering (3.5; look-research.md LR-09). */
    sampleFound: {
      title: '{name} is stuck after its updates',
      summary:
        'It installed updates and didn’t come back, so what runs on it is down too. A restart usually fixes this.',
      fix: 'Restart {name}',
    },
  },
  /* Settings → Screen (web and phone). */
  settings: {
    screen: 'Screen',
    intro: 'Show Whombat on this machine’s own screen.',
    pairTheScreen: 'Pair the screen',
    typeLetters: 'Type the 4 letters on the screen',
    /** 0.103 (DK-26); was “Choose a 6-digit PIN”. */
    choosePin: 'Choose a PIN of 4 to 6 digits',
    repeatPin: 'Type it again',
    pinsDiffer: 'The PINs don’t match.',
    replaces: 'The screen is paired with {name}. Pairing it again replaces that.',
    pairedWith: 'Paired with {name} · since {date}',
    pin: 'PIN',
    changePin: 'Change PIN',
    unpair: 'Unpair',
    unpairConfirm: 'Unpair the screen? It goes back to showing only the clock and the Whombat’s name.',
    whileLocked: 'While locked it shows',
    lockedViews: { time: 'Only the time', summary: 'A summary', everything: 'Everything' } satisfies Record<
      DeskLockedView,
      string
    >,
    quietHours: 'Quiet hours',
    from: 'From',
    to: 'To',
    atNight: 'At night',
    nights: { dim: 'Dim clock', black: 'Black' } satisfies Record<DeskNight, string>,
    talkTo: 'Talk to {assistant}',
    noMicrophone: 'This machine has no microphone.',
    noVoice: 'Talking isn’t available on this Whombat.',
    unlockRequest: 'Your desk screen wants to unlock.',
    unlock: 'Unlock',
    no: 'No',
    wrongPins: 'Someone typed a wrong PIN on your desk screen five times.',
    /* The switch and the screen line (0.101, DK-17…DK-20). */
    showOnScreen: 'Show Whombat on this screen',
    screenNamed: '{name} · connected',
    builtIn: 'Built-in screen',
    connectedUnnamed: 'A screen is connected',
    noScreenNow: 'No screen is connected right now.',
    virtualHint: 'This looks like a virtual machine’s screen, so it stays off unless you turn it on.',
    offHint: 'When it’s off, the screen shows only the Whombat’s name and goes dark after 10 minutes.',
    noPin: 'No PIN yet. Choose one to unlock the screen by touch.',
    choosePinButton: 'Choose a PIN',
    pairToMe: 'Pair to me instead',
    /** The assistant's one message in the person's DM after the screen paired itself (DK-19). */
    selfPaired:
      'I’m on this Whombat’s screen now. To unlock it by touch, choose a PIN in Settings → Screen. You can turn the screen off there too.',
    /** The log's words when the screen paired itself (DK-17): not as if the person did it. */
    pairedItself: 'The screen paired itself with {name}.',
    /* Stay unlocked while you’re here (0.103, DK-28, DK-31): only where `DeskScreen.presenceAvailable`. */
    presence: 'Stay unlocked while you’re here',
    presenceHint:
      'While the screen is unlocked, the camera checks that someone is in front of it, and the screen locks 30 seconds after you leave. It doesn’t recognize faces and keeps no pictures.',
    /*
     * Lock again (0.107, DK-74): replaces the `presence` row where `DeskScreen.lockAgain` lists the choices; `away` only
     * where it lists it (a camera that works). `{assistant}` in `never`'s hint.
     */
    lockAgain: 'Lock again',
    lockAgainChoices: {
      idle: 'After 2 minutes',
      away: 'When you leave',
      never: 'When you press Lock',
    } satisfies Record<DeskLockAgain, string>,
    lockAgainHints: {
      idle: 'The screen locks 2 minutes after you last touch it.',
      away: 'The camera checks that you’re still there, and the screen locks 30 seconds after you leave. It doesn’t recognize faces and keeps no pictures.',
      never:
        'The screen stays unlocked until you press Lock or the machine restarts. Anyone at it can see what it shows, answer everyday asks and talk to {assistant} as you.',
    } satisfies Record<DeskLockAgain, string>,
    /* Use the camera to see when you’re here (0.107, DK-72): only where `DeskScreen.cameraWakeAvailable`. */
    cameraWake: 'Use the camera to see when you’re here',
    cameraWakeHint:
      'The screen shows Whombat while you’re in front of it and only the clock when you’re not. The camera stays on outside quiet hours. It doesn’t recognize faces and keeps no pictures.',
    /* The voice (0.105, DK-50…DK-53): only where `DeskScreen.voices` has two or more this client knows. */
    voice: 'Voice',
    voiceHint: 'How {assistant} sounds when it answers out loud.',
    voices: {
      heart: 'Heart',
      bella: 'Bella',
      michael: 'Michael',
      fenrir: 'Fenrir',
      emma: 'Emma',
      george: 'George',
    } satisfies Record<DeskVoice, string>,
    voiceKinds: {
      heart: 'American · woman',
      bella: 'American · woman',
      michael: 'American · man',
      fenrir: 'American · man',
      emma: 'British · woman',
      george: 'British · man',
    } satisfies Record<DeskVoice, string>,
    listen: 'Listen',
    listening: 'Playing…',
    /** What *Listen* says, in the voice chosen (`desk.voiceSample`). */
    sample: 'Hi, I’m {assistant}. This is how I’ll sound on your desk.',
    sampleFailed: 'The voice couldn’t play. Try again.',
    /*
     * Settings → Screen (3.2, CT-1625; DK-125): the tab, its four parts and *What it shows*. A choice's three words are
     * `levels`; `{assistant}` the assistant's name.
     */
    tab: 'Screen',
    parts: { shows: 'What it shows', lock: 'Lock and PIN', night: 'Night', talk: 'Talk' },
    preview: 'Preview',
    scenarios: { now: 'Now', wrong: 'Something’s wrong', busy: '{assistant} at work' } satisfies Record<
      DeskPreviewScenario,
      string
    >,
    previewNote: 'Changes show here straight away, and on the screen within a few seconds.',
    tryOnScreen: 'Try “{scenario}” on the screen',
    trying: 'On the screen for a minute.',
    levels: { always: 'Always', matters: 'When it matters', off: 'Off' } satisfies Record<
      DeskShowLevel,
      string
    >,
    bar: 'Top bar',
    barHint: 'Always across the top. “When it matters” keeps it out of the way until something’s off.',
    barItems: {
      network: { name: 'Network', line: 'Wi-Fi name, or Cable' },
      internet: { name: 'Internet', line: 'Online, or No internet' },
      battery: { name: 'Battery', line: 'Charge, and time left during a power cut' },
      updates: { name: 'Updates', line: 'While Whombat updates itself' },
    } satisfies Record<DeskBarItem, { name: string; line: string }>,
    alwaysShown: 'Remote help and camera',
    alwaysShownHint: 'Always show while they’re on, so you know',
    middle: 'The middle',
    middleHint:
      'Questions from {assistant} and problems always come first. Your “Always” things fill the rest, then whatever’s happening; three at most.',
    groups: { assistant: '{assistant}', connection: 'From your connections', widget: 'From Home' },
    work: { name: '{assistant}’s work', line: 'What {assistant} is doing and how far along' },
    coming: { name: 'Coming up', line: 'Automations in the next few hours' },
    servers: 'Servers',
    serversHint:
      'The strip along the bottom. Drag to change the order. “When it matters” hides a server until something’s up with it.',
    moveUp: 'Move {name} up',
    moveDown: 'Move {name} down',
    box: { name: 'This Whombat', line: 'Its own processor, memory and disk' },
    around: 'Around it',
    clock: { name: 'Clock', line: 'Big when nothing’s going on, small when something is' },
    clocks: { big: 'Big', small: 'Small' } satisfies Record<DeskClock, string>,
    welcomeBack: { name: 'Welcome back', line: 'After 30 minutes away, start with what happened' },
    doneToday: { name: 'Done today', line: '“{assistant} did 3 things today”, touch to see them' },
    openScreen: 'Screen settings',
    /** The switch's line once the screen is paired: `{name}` the screen line (“Built-in screen”), then since when. */
    pairedLine: '{name} · paired with you since {date}',
  },
  /** The `desk.*` session errors' words (`DESK_ERROR_CODES` of `@whombat/protocol/session`). */
  errors: {
    wrong_code: 'Those letters don’t match the screen. {n} tries left.',
    pairing_expired: 'The letters ran out. Start again.',
    not_paired: 'The screen isn’t paired.',
    request_expired: 'The screen stopped waiting. Try again on the screen.',
    no_screen: 'No screen is connected to this Whombat.',
    no_pin: 'This screen has no PIN yet.',
    /** 0.103 (DK-27). */
    easy_pin: 'That PIN is too easy to guess. Choose another.',
    /** 0.105 (DK-52). */
    no_voice: 'That voice isn’t available on this Whombat.',
    unknown_screen: 'That screen isn’t there any more.',
    screens_full: 'This Whombat has as many screens as it can show. Remove one first.',
    bad_layout: 'That layout can’t be saved: a widget is outside the screen or on another one.',
  },
} as const;

/** The words the calm glance's planner uses (`deskCalm`, DK-112…DK-118). */
export const DESK_CALM_WORDS: DeskCalmWords = {
  ...DESK_WORDS.calm,
  down: DESK_WORDS.status.down,
  look: DESK_WORDS.status.look,
  comingAt: DESK_WORDS.calm.comingUp,
  looking: DESK_WORDS.looks.looking,
  lookingSoFar: DESK_WORDS.looks.lookingSoFar,
  fixing: DESK_WORDS.looks.fixing,
};

/** The calm glance with the desk's own words (DK-112…DK-118): `deskCalm` with `DESK_CALM_WORDS`. */
export function deskCalmFor(input: DeskCalmInput, show: DeskShow, view: DeskCalmView): DeskCalm {
  return deskCalm(input, show, view, DESK_CALM_WORDS);
}

/** What needs the person on a screen of widgets, with the desk's own words (DK-135…DK-138). */
export function deskAttentionFor(
  input: DeskCalmInput,
  show: Pick<DeskShow, 'items'>,
  view: DeskCalmView,
  popups: DeskPopups,
): DeskAttention {
  return deskAttention(input, show, view, popups, DESK_CALM_WORDS);
}

/** Fills `{name}`-style holes in one of `DESK_WORDS`; a hole without a value stays as it is. */
export function fillDeskWords(template: string, values: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{([a-z]+)\}/g, (hole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : hole,
  );
}

/** “Wrong PIN. 3 tries left.”, “Wrong PIN. 1 try left.” */
export function deskWrongPinText(triesLeft: number): string {
  return triesLeft === 1 ? DESK_WORDS.wrongPinOne : fillDeskWords(DESK_WORDS.wrongPin, { n: triesLeft });
}

/**
 * Text as the screen may show it (CT-529): any script on one line — runs of white space and every separator become one
 * space, control, format and surrogate characters go — trimmed and cut to `max` code points with “…”. What the
 * runtime puts in `DeskState`'s text members passes their patterns this way.
 */
export function deskText(text: string, max: number): string {
  const clean = text
    .replace(/[\p{Z}\s]+/gu, ' ')
    .replace(/[\p{Cc}\p{Cf}\p{Cs}]/gu, '')
    .trim();
  const points = [...clean];
  if (points.length <= max) return clean;
  return `${points
    .slice(0, Math.max(0, max - 1))
    .join('')
    .trimEnd()}…`;
}

/* The status line (DK-03, mockup 1) ---------------------------------------------------------------------------- */

export interface DeskStatusInput {
  /** What may show: the lock view, or `everything` while unlocked. */
  view: DeskLockedView;
  /** Asks and questions waiting for the paired person. */
  needsYou: number;
  /** The worst server or thing that isn't fine (`down`: unreachable or off when it should run). */
  worst?: { name: string; down: boolean } | null;
  /** The agent's own `doing` line (“updating your servers, two of four are done”), for `everything`. */
  doing?: string | null;
  /** What the first ask is about (“Plex on blackbox”), for `everything`. */
  firstAsk?: string | null;
  /**
   * A new box (0.101, CT-547; DK-23): no servers, no tiles, nothing needs the person, nothing worked on. In `summary`
   * and `everything` the line is “All fine. I’m ready when you are.” with the hint to connect something as `more`.
   */
  fresh?: boolean;
}

/** `DeskGlance.status`: the sentence and its muted second part. */
export interface DeskStatusLine {
  text: string;
  more?: string;
}

const lowerFirst = (s: string) =>
  /^\p{Lu}\p{Ll}/u.test(s) ? `${s.charAt(0).toLowerCase()}${s.slice(1)}` : s;

/**
 * The glance's status sentence (DK-03, mockup 1). `time`: “All fine.” or “Something needs you.”. `summary`: from the
 * counts and the worst server or thing — “pve-02 is down.”, “3 things need you.”, “pve-02 needs a look.” (in that
 * order, together when several hold), else “Everything’s fine.”; no titles. `everything`: the assistant's own line —
 * the worst server or “Everything’s fine.”, then “I’m {doing}.” — with the first ask's “{about} needs a decision.” as
 * the muted second part. `fresh` (DK-23): in `summary` and `everything` “All fine. I’m ready when you are.” with
 * “Connect a server or your home, …” as `more`, as long as nothing needs the person and no server is the worst (the
 * counts win over the flag). At most 200 code points each.
 */
export function deskStatusLine(input: DeskStatusInput): DeskStatusLine {
  const s = DESK_WORDS.status;
  const worst = input.worst ?? null;
  const server = worst ? fillDeskWords(worst.down ? s.down : s.look, { server: worst.name }) : null;
  if (input.view === 'time') return { text: input.needsYou > 0 || worst ? s.somethingNeedsYou : s.allFine };
  if (input.fresh && input.needsYou === 0 && !worst) return { text: s.ready, more: s.connectHint };
  const asks =
    input.needsYou === 1
      ? s.needsYouOne
      : input.needsYou > 1
        ? fillDeskWords(s.needsYouMany, { n: input.needsYou })
        : null;
  if (input.view === 'summary') {
    const parts = worst?.down ? [server, asks] : [asks, server];
    const text = parts.filter((p): p is string => p !== null).join(' ');
    return { text: deskText(text || s.fine, 200) };
  }
  const doing = input.doing?.trim().replace(/[.…]+$/, '');
  const head = server ?? s.fine;
  const text = doing ? `${head} ${fillDeskWords(s.doing, { doing: lowerFirst(doing) })}` : head;
  const about = input.firstAsk?.trim().replace(/[?.]+$/, '');
  const more = about ? fillDeskWords(s.decision, { title: about }) : (asks ?? undefined);
  return more ? { text: deskText(text, 200), more: deskText(more, 200) } : { text: deskText(text, 200) };
}

/* Power (DK-10) ------------------------------------------------------------------------------------------------ */

/** A battery reading as `HostNow.power` and `DeskPower` carry it. */
export interface DeskPowerReading {
  source: 'ac' | 'battery';
  percent: number;
  charging: boolean;
  minutesLeft: number | null;
  chargeLimit: number | null;
  since?: string | null;
}

/** The battery is held here when the machine allows a limit (DK-10). */
export const DESK_CHARGE_LIMIT = 80;
/** One message to the person at this level, and a clean shutdown at the next (DK-10). */
export const DESK_BATTERY_LOW_PERCENT = 15;
export const DESK_BATTERY_SHUTDOWN_PERCENT = 10;

/** `3 h 10 min`, `45 min`, `2 h` — minutes left on the battery (at least 1 min). */
export function formatPowerLeft(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`;
}

/**
 * The power's words (DK-10): `line` the screen's and “How it’s doing”'s short line, `banner` the screen's on-battery
 * banner (mockup 4), and the assistant's Chat messages to the person `out`, `back` and `low`.
 */
export const hostPowerText = {
  /** “Plugged in · battery kept at 80 %”, “Plugged in · charging · 64 %”, “On battery · 72 % · about 3 h left”. */
  line(p: DeskPowerReading): string {
    const w = DESK_WORDS.power;
    if (p.source === 'battery')
      return p.minutesLeft === null
        ? fillDeskWords(w.onBatteryNoTime, { n: p.percent })
        : fillDeskWords(w.onBattery, { n: p.percent, time: formatPowerLeft(p.minutesLeft) });
    if (p.charging) return fillDeskWords(w.pluggedCharging, { n: p.percent });
    if (p.chargeLimit !== null) return fillDeskWords(w.pluggedKept, { n: p.chargeLimit });
    return fillDeskWords(w.plugged, { n: p.percent });
  },
  /** “The power has been out since 02:14.” and “Whombat is on battery, about 3 h 10 min left. Neo shuts …” */
  banner(
    p: DeskPowerReading,
    at: { assistant: string; timeZone: string },
  ): { title: string | null; text: string } {
    const w = DESK_WORDS.power;
    const title = p.since ? fillDeskWords(w.outSince, { clock: formatClock(p.since, at.timeZone) }) : null;
    const text =
      p.minutesLeft === null
        ? fillDeskWords(w.outBannerNoTime, { assistant: at.assistant })
        : fillDeskWords(w.outBanner, { assistant: at.assistant, time: formatPowerLeft(p.minutesLeft) });
    return { title, text };
  },
  /** “The power is out. Whombat is running on its battery, about 3 h left.” */
  out(p: Pick<DeskPowerReading, 'minutesLeft'>): string {
    const w = DESK_WORDS.power;
    return p.minutesLeft === null
      ? w.outNoTime
      : fillDeskWords(w.out, { time: formatPowerLeft(p.minutesLeft) });
  },
  /** “The power is back.” */
  back(): string {
    return DESK_WORDS.power.back;
  },
  /** “The battery is at 15 %. I’ll shut Whombat down at 10 % to keep your data safe.” */
  low(p: Pick<DeskPowerReading, 'percent'>): string {
    return fillDeskWords(DESK_WORDS.power.low, { n: p.percent });
  },
} as const;

/* This Whombat (0.101, CT-546; DK-22, DK-24) -------------------------------------------------------------------- */

/** A figure's tone on the panel, `DeskTone` of the desk socket. */
export type DeskBoxTone = 'ok' | 'warn' | 'bad';
/** The panel's storage parts, in this order: the Whombat's own data and its history; the agent's containers and work. */
export const DESK_BOX_PARTS = ['whombat', 'agent'] as const;
export const DeskBoxPartKey = z.enum(DESK_BOX_PARTS);
export type DeskBoxPartKey = z.infer<typeof DeskBoxPartKey>;

/** Which of the manager's disk parts (`HostDiskPartKey`) each panel part adds up. */
const BOX_PART_SOURCES: Readonly<Record<DeskBoxPartKey, readonly string[]>> = {
  whombat: ['whombat', 'database'],
  agent: ['containers', 'work'],
};

/**
 * Where a figure turns `warn` and `bad`, in whole percent or °C, compared with the number the panel shows (rounded), so
 * the colour always fits the number. Processor and memory as the desk's server cards (`DeskServer`'s meters); storage
 * as the disk alerts (`HOST_DISK_ALERT_LEVELS`, BS-09); the processor's temperature by DK-24.
 */
export const DESK_BOX_TONES = {
  cpu: { warn: 75, bad: 90 },
  memory: { warn: 80, bad: 90 },
  storage: { warn: 85, bad: 95 },
  temp: { warn: 80, bad: 90 },
} as const satisfies Record<string, { warn: number; bad: number }>;

/** At most this many points in the panel's last hour, one a minute. */
export const DESK_BOX_POINTS = 60;

/* A server's own screen (0.115, CT-860…CT-866; DK-80…DK-89) ------------------------------------------------------ */

/**
 * A server's id on the desk (0.115, CT-862; DK-83, DK-85): the hosts service's id, a slug of the host name (`pve-01`,
 * `nas`, possibly with dots), so not the desk's `Id` of 8 or more. It starts with a letter or a digit (never `.` or
 * `..`) and has no slash. The card carries it, the screen asks for it, a talk names it and the runner hears it
 * (`DeskDispatchContext.server`).
 */
export const DESK_SERVER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const DeskServerId = z.string().regex(DESK_SERVER_ID_RE);

/* Needs you's looks (0.118, CT-970; DK-93) ---------------------------------------------------------------------- */

/** What a look is about: the thing's kind on Home (`ThingKind`). */
export const DESK_LOOK_KINDS = ['server', 'connection', 'device'] as const;
export const DeskLookKind = z.enum(DESK_LOOK_KINDS);
export type DeskLookKind = z.infer<typeof DeskLookKind>;

/**
 * How badly a look needs the person (DK-93): `down` off or not answering (“{name} is down.”), `bad` in trouble and
 * `look` something to look at (both “{name} needs a look.”); the screen's dot is red for the first two, amber for the
 * last. In this order on the screen.
 */
export const DESK_LOOK_STATES = ['down', 'bad', 'look'] as const;
export const DeskLookState = z.enum(DESK_LOOK_STATES);
export type DeskLookState = z.infer<typeof DeskLookState>;

/** Needs you carries at most this many looks (DK-93). */
export const DESK_LOOKS_MAX = 5;

/** How far back a server's chart looks (DK-83): the last hour, 24 hours (first) or 7 days. */
export const DESK_SERVER_RANGES = ['1h', '24h', '7d'] as const;
export const DeskServerRange = z.enum(DESK_SERVER_RANGES);
export type DeskServerRange = z.infer<typeof DeskServerRange>;

/** A guest's state on a server's screen, the hosts service's (`HostGuestState`). */
export const DESK_GUEST_STATES = ['running', 'stopped', 'unhealthy', 'paused'] as const;
export const DeskGuestState = z.enum(DESK_GUEST_STATES);
export type DeskGuestState = z.infer<typeof DeskGuestState>;

/** One measured step (`HostPoint` of `@whombat/protocol/session` has these and more). */
export interface DeskBoxPoint {
  cpuPermille: number;
  memoryUsedBytes: number;
  inBytes: number;
  outBytes: number;
}

/**
 * What `deskBox` reads: the manager's `HostMetrics` (`POST /v1/host/metrics`, range `hour`) satisfies it as it is. The
 * series' points oldest first, the last one ending now; null where nothing was measured.
 */
export interface DeskBoxInput {
  now: {
    cpuPermille: number;
    cores: number;
    memoryTotalBytes: number;
    memoryUsedBytes: number;
    /** The processor's temperature, whole °C (0.101, DK-24); absent without a sensor. */
    cpuTempC?: number | undefined;
    /** Seconds since the machine started (0.101, DK-24). */
    uptimeS?: number | undefined;
  };
  disks: {
    data: {
      totalBytes: number;
      usedBytes: number;
      freeBytes: number;
      parts: readonly { key: string; bytes: number }[] | null;
    };
  };
  series: { stepS: number; points: readonly (DeskBoxPoint | null)[] };
}

/** A figure drawn big with a small unit (“11.2” “GB”), `DeskFigure` of the desk socket. */
export interface DeskBoxFigure {
  value: string;
  unit: string;
}

/**
 * This Whombat as the screen draws it (DK-22): the shape of `DeskBox` in `@whombat/control-contracts/local`, which
 * builds on core and checks `DeskBox.parse(deskBox(…))`. Text uses plain spaces: the desk's display text has no other
 * separator (CT-529).
 */
export interface DeskBoxPanel {
  /** “up 2 h 14 min”; empty when the manager doesn't say. */
  up: string;
  cpu: { percent: number; cores: number; tone: DeskBoxTone };
  memory: { percent: number; used: DeskBoxFigure; total: string; tone: DeskBoxTone };
  /** The last hour, oldest first, one point per `stepS`, ending now; both the same length; null where unmeasured. */
  history: { stepS: number; cpu: (number | null)[]; memory: (number | null)[] };
  storage: {
    percent: number;
    free: DeskBoxFigure;
    total: string;
    tone: DeskBoxTone;
    parts: { key: DeskBoxPartKey; value: string; percent: number }[];
  };
  temp?: { value: number; tone: DeskBoxTone };
  /** Per second over the last step; null when that step wasn't measured. */
  network: { down: string; up: string } | null;
}

const boxTone = (value: number, at: { warn: number; bad: number }): DeskBoxTone =>
  value >= at.bad ? 'bad' : value >= at.warn ? 'warn' : 'ok';
const pct = (share: number): number => Math.min(100, Math.max(0, Math.round(share)));
const spaced = (text: string) => text.replace(/ /g, ' ');

/** A size as Settings → “How it’s doing” writes it (`formatBytes`), split for the screen: “11.2” “GB”, “812” “GB”. */
export function deskBoxFigure(bytes: number): DeskBoxFigure {
  const [value = '0', unit = 'B'] = formatBytes(bytes).split(NBSP);
  return { value, unit };
}

/** A size on one line as “How it’s doing” writes it, with a plain space: “64 GB”, “1.6 TB”. */
export function deskBoxSize(bytes: number): string {
  return spaced(formatBytes(bytes));
}

/** Bytes in a GiB: memory is counted as machines count it. */
const GIB = 1_073_741_824;
const trim1 = (n: number) => String(Number(n.toFixed(1)));
/** The sizes memory is sold in (GiB): the kernel keeps some, so `MemTotal` reads a little under one of them. */
const MEMORY_SIZES = [
  1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1536, 2048,
];

/**
 * Memory as machines write it (DK-22): GiB shown as “GB”, one decimal below 100 — “11.2” “GB” — so a 64 GB machine
 * doesn't read “68.7 GB” as a disk would. Below 1 GiB in MB.
 */
export function deskMemoryFigure(bytes: number): DeskBoxFigure {
  const gib = Math.max(0, bytes) / GIB;
  if (gib < 1) return { value: String(Math.round(gib * 1024)), unit: 'MB' };
  return { value: gib < 99.95 ? trim1(gib) : String(Math.round(gib)), unit: 'GB' };
}

/**
 * The memory a machine has, as its owner knows it: `MemTotal` rounded up to the size it was sold as when it is within
 * 10 % of it (62.6 GiB → “64 GB”, as the kernel and the firmware keep some), else as `deskMemoryFigure`.
 */
export function deskMemoryTotal(bytes: number): string {
  const gib = Math.max(0, bytes) / GIB;
  const size = MEMORY_SIZES.find((s) => s >= gib);
  if (size !== undefined && gib >= size * 0.9) return `${size} GB`;
  const f = deskMemoryFigure(bytes);
  return `${f.value} ${f.unit}`;
}

const RATE_UNITS = ['B/s', 'kB/s', 'MB/s', 'GB/s', 'TB/s'] as const;

/**
 * Bytes per second, decimal: “0 B/s”, “850 B/s”, “310 kB/s”, “2.4 MB/s”, “12 MB/s” — one decimal under 100 (none when
 * it's .0), none from 100, whole bytes.
 */
export function formatDeskRate(bytesPerSecond: number): string {
  let v = Number.isFinite(bytesPerSecond) ? Math.max(0, bytesPerSecond) : 0;
  let i = 0;
  while (i < RATE_UNITS.length - 1 && v >= 999.5) {
    v /= 1_000;
    i++;
  }
  const n = i === 0 || v >= 99.95 ? String(Math.round(v)) : String(Number(v.toFixed(1)));
  return `${n} ${RATE_UNITS[i]}`;
}

/** How long the box has been up, as the server cards' notes: “up 12 min”, “up 2 h 14 min”, “up 5 h”, “up 41 d”. */
export function formatDeskUptime(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  if (s >= 86_400) return `up ${Math.floor(s / 86_400)} d`;
  const m = Math.max(1, Math.floor(s / 60));
  if (m < 60) return `up ${m} min`;
  return m % 60 === 0 ? `up ${Math.floor(m / 60)} h` : `up ${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * The last hour of the series, one point a minute (a step of a minute or more stays as it is): each point the average
 * of what was measured in it, null when nothing was. Always the whole hour, ending with the last point: the hour before
 * measuring began is null, so the chart's time axis doesn't move.
 */
function boxHistory(input: DeskBoxInput): DeskBoxPanel['history'] {
  const stepS = Math.max(1, Math.round(input.series.stepS));
  const per = Math.max(1, Math.round(60 / stepS));
  const bucketS = Math.min(3_600, per * stepS);
  const count = Math.min(DESK_BOX_POINTS, Math.floor(3_600 / bucketS));
  const total = input.now.memoryTotalBytes;
  const points = input.series.points;
  const cpu: (number | null)[] = [];
  const memory: (number | null)[] = [];
  for (let b = count - 1; b >= 0; b--) {
    const end = points.length - b * per;
    const measured = points
      .slice(Math.max(0, end - per), Math.max(0, end))
      .filter((p): p is DeskBoxPoint => p !== null);
    if (measured.length === 0) {
      cpu.push(null);
      memory.push(null);
      continue;
    }
    const mean = (f: (p: DeskBoxPoint) => number) => measured.reduce((a, p) => a + f(p), 0) / measured.length;
    cpu.push(pct(mean((p) => p.cpuPermille) / 10));
    memory.push(total > 0 ? pct((mean((p) => p.memoryUsedBytes) / total) * 100) : null);
  }
  return { stepS: bucketS, cpu, memory };
}

/**
 * This Whombat for the glance while it has no servers and no home tiles (DK-22, mockup `new-box.html`): processor and
 * memory now with the last hour, storage of the data disk with what the Whombat and the agent use, the processor's
 * temperature where there is a sensor, the network now and how long it has been up. Disk sizes as “How it’s doing”
 * (`formatBytes`, decimal), memory as machines count it (`deskMemoryFigure`, `deskMemoryTotal`); tones by `DESK_BOX_TONES`. `DeskBox` of `@whombat/control-contracts/local` accepts it.
 */
export function deskBox(input: DeskBoxInput): DeskBoxPanel {
  const { now } = input;
  const data = input.disks.data;
  const cpuPct = pct(now.cpuPermille / 10);
  const memPct = now.memoryTotalBytes > 0 ? pct((now.memoryUsedBytes / now.memoryTotalBytes) * 100) : 0;
  const room = data.usedBytes + data.freeBytes;
  const diskPct = pct(hostDiskUsedPct(data));
  const parts: DeskBoxPanel['storage']['parts'] = [];
  if (data.parts) {
    for (const key of DESK_BOX_PARTS) {
      const mine = data.parts.filter((p) => BOX_PART_SOURCES[key].includes(p.key));
      if (mine.length === 0) continue;
      const bytes = mine.reduce((a, p) => a + p.bytes, 0);
      parts.push({ key, value: deskBoxSize(bytes), percent: room > 0 ? pct((bytes / room) * 100) : 0 });
    }
  }
  const last = input.series.points.at(-1) ?? null;
  const stepS = input.series.stepS;
  const box: DeskBoxPanel = {
    up: typeof now.uptimeS === 'number' ? formatDeskUptime(now.uptimeS) : '',
    cpu: { percent: cpuPct, cores: now.cores, tone: boxTone(cpuPct, DESK_BOX_TONES.cpu) },
    memory: {
      percent: memPct,
      used: deskMemoryFigure(now.memoryUsedBytes),
      total: deskMemoryTotal(now.memoryTotalBytes),
      tone: boxTone(memPct, DESK_BOX_TONES.memory),
    },
    history: boxHistory(input),
    storage: {
      percent: diskPct,
      free: deskBoxFigure(data.freeBytes),
      total: deskBoxSize(data.totalBytes),
      tone: boxTone(diskPct, DESK_BOX_TONES.storage),
      parts,
    },
    network:
      last && stepS > 0
        ? { down: formatDeskRate(last.inBytes / stepS), up: formatDeskRate(last.outBytes / stepS) }
        : null,
  };
  if (typeof now.cpuTempC === 'number' && Number.isFinite(now.cpuTempC)) {
    const c = Math.round(now.cpuTempC);
    box.temp = { value: c, tone: boxTone(c, DESK_BOX_TONES.temp) };
  }
  return box;
}
