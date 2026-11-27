/**
 * The desk screen's authority in the runtime (docs/decisions/desk-display.md DK-01…DK-12; desk-display-server.md
 * DK-S01…): what the screen may show and do, for the console server on the desk socket (`socket.ts`), and the
 * person's settings (`desk.*` session ops, `ops.ts`).
 *
 * - **State** (`state`): the pairing letters while the person pairs, the lock, the glance trimmed to the lock and the
 *   person's choice, the power, the latest talk while unlocked. The glance is read from Home at most every 10 s and
 *   again soon after a `home.changed` for the person; locking and unlocking only trims it differently.
 * - **Unlock** (DK-04): the PIN (scrypt), five wrong ones and the screen waits (kept in the database), the fifth told to
 *   the person in Chat; or the phone: one request at a time, two minutes, a `security` push and `desk.changed`.
 * - **Lock again** (DK-74, DK-28…DK-30): *After 2 minutes*; *When you leave*, where the watch loop (`presence.ts`) asks
 *   the presence service every 2 s while the screen is unlocked and the lock keeps the rules; or *When you press Lock*,
 *   an unlock that no time locks, kept with the machine's boot id so a runtime started again on the same boot is
 *   unlocked again (DK-75).
 * - **The camera for the clock** (DK-72, DK-73): with *Use the camera to see when you’re here*, the same loop runs by
 *   day on mains power while the console asks for the state, locked or unlocked, and the state's `presence` says
 *   whether someone is there; a face never unlocks, and an unlock or a lock doesn't turn that camera off and on.
 * - **Answer** (DK-05, DK-61, DK-62): an approval the person may see, decided as them, once, only while unlocked: Approve
 *   when `deskMayDecide` allows it, else with the PIN typed again (DK-S61); Deny and Not now always (DK-S60). A decision
 *   on an ask made in Talk's open conversation has its next words said (DK-S63).
 * - **Settings**: *Show Whombat on this screen* (DK-20), pairing (the letters on the screen), a new
 *   PIN of 4 to 6 digits (none too easy, DK-26, DK-27), what shows while locked, quiet hours, night, talk, Lock again,
 *   the camera, the voice (the paired person; one the voice service lists, DK-50, DK-52). Each change is a command
 *   through the pipeline and a `desk.changed` to the person. *Listen* (`desk.voiceSample`,
 *   DK-51) makes the sample sentence in a voice and changes nothing.
 * - **Pairing itself** (DK-17): with a real screen connected, the switch on and nobody paired, the screen pairs itself
 *   to the person (where they have their Chat, one-person.md OP-S77), checked when the console asks for the state (at
 *   most every 10 s) and every minute; their assistant tells them once. The automatic scans look at
 *   once (desk-found.md DF-02).
 * - **Found on your network** (desk-found.md DF-03…DF-07): `glance.found` from the burrow's scans as the paired person
 *   sees them (`found.ts`), and its *Not now* (`foundDismiss`, also while locked).
 * - **The servers** (DK-83…DK-86): every server as a card (`servers`) and a server's own screen (`server`,
 *   `server-page.ts`), locked too but not in *Only the time*; a talk asked from a server's screen is about it (DK-85).
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  DESK_SERVERS,
  DESK_STATE_MAX_BYTES,
  type DeskDecideAnswer,
  type DeskDecideScope,
  type DeskHeard,
  type DeskServerPage,
  type DeskServersAnswer,
  type DeskSizeRequest,
  type DeskState,
  type DeskTalk,
  type DeskTalkSession,
  type DeskUnlockAnswer,
  deskDecideNeedsPin,
  deskDecideRequestValid,
  VOICE_TTS_TEXT_MAX,
} from '@whombat/control-contracts/local';
import {
  applyDeskShowPatch,
  DESK_CALM_WORDS,
  DESK_LOCK_AGAIN,
  DESK_SCREEN_BOX,
  DESK_SCREEN_VIEWS_MAX,
  DESK_SCREENS_MAX,
  DESK_TRY_S,
  DESK_WORDS,
  type DeskCalm,
  type DeskCalmInput,
  type DeskCalmView,
  type DeskCatalog,
  type DeskCatalogGroup,
  type DeskDisplay,
  type DeskGrid,
  type DeskLayout,
  type DeskLockAgain,
  type DeskPreview,
  type DeskPreviewScenario,
  type DeskScreen,
  type DeskScreenDetail,
  type DeskScreensList,
  type DeskServerRange,
  type DeskSettings,
  type DeskSettingsPatch,
  type DeskShow,
  type DeskShowPatch,
  type DeskWidgetRef,
  type DeskWidgetSpec,
  type DeskWidgetView,
  deskAttentionFor,
  deskBox,
  deskLayoutWidgets,
  deskMayDecide,
  deskPreviewInput,
  deskQuietNow,
  deskText,
  deskWidgetSpecProblem,
  fillDeskWords,
  resolveLanguage,
  safeLocaleOrNull,
  type ThingSummary,
  topics,
} from '@whombat/core';
import {
  DESK_ERROR_STATUS,
  DESK_VOICE_SAMPLE_WAV_MAX_BYTES,
  type DeskErrorCode,
  type DeskScreenAddPageInput,
  type DeskScreenAddPageOutput,
  type DeskScreenViews,
  SCREEN_TIMES_MINOR,
} from '@whombat/protocol/session';
import { screenGrid as gridOfScreen } from '@whombat/screen';
import { eq } from 'drizzle-orm';
import { decideApproval } from '../commands/approvals';
import type { CommandDef } from '../commit/types';
import { managedAppOrigin } from '../config';
import { foundScansFor, putFoundAway } from '../connections/found-scans';
import { accounts, burrows } from '../db/schema/index';
import { zoneOf } from '../domain/notify';
import { thePerson } from '../domain/the-person';
import { personalPlace } from '../guides/place';
import { things } from '../home/overview';
import { snoozeNeedsYou } from '../home/snoozes';
import { startOfLocalDay } from '../home/time';
import { homeWidgetsNow, type WidgetNow } from '../home/widgets';
import { serversPrincipal } from '../hosts/principal';
import { HostsError, hostsFor } from '../hosts/service';
import { onLocaleChange } from '../i18n/locale';
import { ApiError, forbidden } from '../lib/errors';
import { fixLook } from '../looks/research';
import { type ControlPush, opaqueRef, PUSH_TTL_S, registerPushResolver } from '../managed/push';
import type { RemoteHelpService } from '../managed/remote-help';
import { SessionOpError } from '../managed/session-error';
import type { SessionPrincipal } from '../managed/trust';
import { loadMessageRow } from '../read/messages';
import { faceOf, loadPrincipalRow } from '../read/principals';
import { approvalByNumber, toApproval } from '../read/work';
import { approvalVisible } from '../read/work-views';
import type { Services } from '../services';
import { thingPicture } from '../things/image-route';
import { type DoorbellRing, followsDoorbell, onDoorbellRing } from '../things/kinds/home/doorbell';
import { quietThingNotice } from '../things/quiet/service';
import { DictationError, voiceTypingFor } from '../voice/service';
import { speakingVoices, voiceFor, voiceHealth } from '../voice/speech';
import { loadVoiceSettings } from '../voice/store';
import { wantsDutchVoice } from '../voice/view';
import { CALM_SOURCE_WAIT_MS, CalmReads, type CalmSample, calmNow, calmPreview, deskCalmInput } from './calm';
import { createDeskCalmSources, type DeskCalmSources } from './calm-sources';
import { dutchSpeechText } from './dutch-speech';
import { deskFoundNow, type FoundInputs, foundInputsOf } from './found';
import {
  type AskPlace,
  boxWanted,
  buildFullGlance,
  callArgsOf,
  DESK_HOSTS_WAIT_MS,
  type DeskFleet,
  type DeskPlace,
  deskFleet,
  deskOfferedScopes,
  deskPerson,
  EMPTY_GLANCE,
  type FullGlance,
  type NotNowSubject,
  notNowSnooze,
  QuestionNumbers,
  screenText,
  trimGlance,
} from './glance';
import { DisplayProbe } from './hardware';
import { DeskLock, DeskPairing, type UnlockRequest } from './lock';
import { deskShowOptions } from './options';
import { type DeskTarget, deskTarget } from './person';
import { hashPin, newPinRefusal, PIN_DIGITS_BEFORE, PIN_FREE_TRIES, pinTriesLeft, verifyPin } from './pin';
import type { HostPower } from './power';
import {
  cameraWant,
  PresenceLoop,
  type PresenceWant,
  presenceAvailable,
  presenceFor,
  presenceHealth,
} from './presence';
import { UnlockPushes, unlockPushWhat } from './push-link';
import { glanceFacts, screenDetail, screenGrid, screenSummary } from './screen-grid';
import { type AskedWidget, catalogItemFor, keepPageTimes, placePage } from './screen-pages';
import type { ScreenPinCheck } from './screen-sessions';
import {
  badLayout,
  defaultBoxRecord,
  forgetScreen,
  layoutRefusal,
  outputScreenId,
  revokeScreenDevice,
  ScreenStore,
  screenOnline,
  unknownScreen,
  updateScreen,
} from './screens';
import { deskServerPage, readServerParts, type ServerParts } from './server-page';
import type { DeskAck, DeskBox, DeskPhoneUnlockAnswer, DeskServer, DeskTouchAnswer } from './shapes';
import { ScreenSpotlights, withSpotlight } from './spotlight';
import {
  DeskBootId,
  type DeskRow,
  deskRightPin,
  deskUnlockedBoot,
  deskWrongPin,
  loadDeskRow,
  loadScreenChoice,
  loadWhombatName,
  pairDesk,
  pairDeskItself,
  setDeskName,
  setDeskPin,
  setDeskScreen,
  settingsOf,
  updateDesk,
} from './store';
import {
  createDeskTalk,
  DeskTalkError,
  type DeskTalkHost,
  type DeskTalkStart,
  type DeskTalks,
  deskHeardText,
  inConversation,
} from './talk';
import { tellPerson } from './tell';
import { DeskLookLog, DeskWelcome } from './welcome';
import { isAccountRef } from './widgets/accounts';
import { deskCatalog, homeWidgetsGroup, ownGroup, serverGroups } from './widgets/catalog';
import { type ScreenHomeWidget, screenHomeWidgets } from './widgets/home';
import { catalogFor, screenDetailFor, viewsFor, withHiddenWidgets } from './widgets/older-apps';
import { type GlanceFacts, pictureKey, screenViews, viewPictures, WidgetResolver } from './widgets/resolve';
import { createThingWidgets } from './widgets/things';
import type { Resolved, ScreenRecord, ScreensApi, ThingWidgets, WidgetCtx } from './widgets/types';

/** A `desk.*` refusal (CT-525): the generic code of `DESK_ERROR_STATUS`, the desk's own in `details.code`. */
function deskError(code: DeskErrorCode, message: string, extra: { triesLeft?: number } = {}): SessionOpError {
  return new SessionOpError(DESK_ERROR_STATUS[code], message, { code, ...extra });
}

/** The unlock push's second line (its first is `DESK_WORDS.settings.unlockRequest`). */
const UNLOCK_PUSH_BODY = 'Unlock it, or say no if it isn’t you.';

/** How old the glance may be before it is read again (DK-S10). */
export const GLANCE_MAX_AGE_MS = 10_000;
/** How often the console's asking for the state checks whether the screen should pair itself (DK-17). */
export const SELF_PAIR_EVERY_MS = 10_000;
/** The minute check (DK-17), for when the console isn't asking. */
export const SELF_PAIR_TICK_MS = 60_000;

/** A request the screen made that the runtime refuses: the desk socket answers with `status` and `code`. */
export class DeskRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DeskRefused';
  }
}

const notPaired = () => new DeskRefused(409, 'not_paired', 'Nobody paired this screen.');

/** The same pairing with the same PIN: a PIN checked against `a` may act on `b` (DK-S22). */
const samePin = (a: DeskRow, b: DeskRow) =>
  a.personId === b.personId && a.pairedAt.getTime() === b.pairedAt.getTime() && a.pinHash === b.pinHash;
const locked = () => new DeskRefused(409, 'locked', 'Unlock the screen first.');
const voiceUnavailable = () => new DeskRefused(503, 'voice_unavailable', DESK_WORDS.voiceUnavailable);

/** Why voice typing refused a recording from Talk's mic, as the desk socket says it. */
function hearRefusal(err: DictationError): DeskRefused {
  const w = DESK_WORDS.dictation;
  switch (err.code) {
    case 'busy':
      return new DeskRefused(409, 'busy', w.busy);
    case 'bad_audio':
      return new DeskRefused(400, 'bad_audio', w.badAudio);
    case 'too_long':
      return new DeskRefused(413, 'too_large', w.tooLong);
    case 'failed':
      return new DeskRefused(503, 'unavailable', w.failed);
    default:
      // No model can hear it now (still downloading, gone), or voice typing's own switch: Talk's voice isn't possible.
      return voiceUnavailable();
  }
}
/** The hosts service didn't answer (DK-S82): the page keeps what it showed and says it can't reach them. */
const serversUnavailable = () => new DeskRefused(503, 'unavailable', 'I can’t reach your servers right now.');
const noSuchServer = () => new DeskRefused(404, 'not_found', 'There is no such server.');
/** A voice the box doesn't have now, or a sample it can't make (DK-52). */
const noVoice = () => deskError('no_voice', DESK_WORDS.errors.no_voice);
const noOwnAssistant = () => new ApiError('conflict', 'You need your assistant on this Whombat first.');
/** A screen that never said its size is drawn at the Z13's (the editor's too). */
const DEFAULT_SCREEN_SIZE = { width: 1280, height: 800 } as const;
/** How long a screen's time zone is kept before it is read again. */
const ZONE_KEPT_MS = 60_000;

/** A new PIN (DK-26, DK-27): 4 to 6 digits and not too easy to guess, checked before it is hashed or anything used up. */
function checkNewPin(pin: string): void {
  const refusal = newPinRefusal(pin);
  if (refusal === 'easy_pin') throw deskError('easy_pin', DESK_WORDS.errors.easy_pin);
  if (refusal === 'shape') throw new ApiError('validation_failed', DESK_WORDS.settings.choosePin);
}

/** `DeskScreen.voices`, a member only when the box names voices it speaks with (DK-S50). */
function voicesMember(voices: readonly string[] | null): { voices?: string[] } {
  return voices ? { voices: [...voices] } : {};
}

/** Where the kernel says which boot this is (DK-75). */
export const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';

/** A boot id as the kernel (a UUID) or systemd (`%b`, 32 hex digits) writes it, in one form: 32 hex digits. */
export function bootIdOf(text: string | null | undefined): string | null {
  const id = text?.trim().toLowerCase().replaceAll('-', '') ?? '';
  return /^[0-9a-f]{32}$/.test(id) && DeskBootId.safeParse(id).success ? id : null;
}

/**
 * This boot's id, read once per runtime (DK-75, DK-S73): `WHOMBAT_BOOT_ID` when it is one (systemd's `%b`, for a
 * sandbox without `/proc/sys`), else the kernel's file; null when neither reads as one: nothing is restored.
 */
export function readBootId(fromEnv?: string, path = BOOT_ID_PATH): string | null {
  const given = bootIdOf(fromEnv);
  if (given) return given;
  try {
    return bootIdOf(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * `DeskScreen.lockAgain` (DK-74, CT-644): the choices this runtime offers, in `DESK_LOCK_AGAIN`'s order — *After 2
 * minutes* and *When you press Lock* always, *When you leave* where the camera works.
 */
export function lockAgainChoices(cameraWorks: boolean): DeskLockAgain[] {
  return DESK_LOCK_AGAIN.filter((choice) => choice !== 'away' || cameraWorks);
}

/** The camera's checks on real timers (they don't keep the process up). */
function realAfter(ms: number, fn: () => void): () => void {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

/**
 * *Show Whombat on this screen* now (DK-20, DK-S28): what the person chose, else on exactly when a real screen is
 * connected — or while the screen is paired (it paired itself and the monitor is off or unplugged for now).
 */
export function screenOn(choice: boolean | null, display: DeskDisplay, paired: boolean): boolean {
  return choice ?? (paired || display.real);
}

/** `DeskState.remoteHelp` while remote help is on (RH-S08); nothing otherwise, so older consoles see no change. */
export function remoteHelpLine(remoteHelp: Pick<RemoteHelpService, 'deskView'> | null | undefined) {
  const line = remoteHelp?.deskView();
  return line ? { remoteHelp: line } : {};
}

export interface DeskServiceOptions {
  /** The power reading (the managed runtime's); none without a manager. */
  power?: HostPower | null;
  /** Content-free pushes to the person's phones (`ControlPush.forAccounts`). */
  push?: Pick<ControlPush, 'forAccounts'> | null;
  /** Where the screen's connectors are (`/sys/class/drm`; tests point elsewhere). */
  drmDir?: string;
  /** What screen is plugged in, when a test gives its own (else a `DisplayProbe` of `drmDir`). */
  display?: Pick<DisplayProbe, 'display' | 'connected'>;
  /** The pairing letters' randomness (tests fix it). */
  random?: (n: number) => Uint8Array;
  /** Talk, when a test gives its own. */
  talk?: (services: Services, host: DeskTalkHost) => DeskTalks;
  /** The PIN check (`verifyPin`; tests slow it down to race it). */
  verifyPin?: (pin: string, stored: string) => Promise<boolean>;
  /** Runs `fn` in `ms` for the camera's checks (tests: their clock's); returns what cancels it. */
  after?: (ms: number, fn: () => void) => () => void;
  /** The boot this runtime runs on (DK-75; tests give theirs, null for none), else `readBootId` of the config's. */
  bootId?: string | null;
  /** Remote help's line (remote-help-server.md RH-S08): shown while it is on, locked or not, paired or not. */
  remoteHelp?: Pick<RemoteHelpService, 'deskView'> | null;
  /** The calm glance's sources (`calm-sources.ts`), when a test gives its own. */
  calmSources?: DeskCalmSources;
  /** How long a glance read waits for one calm source (tests shorten it). */
  calmSourceWaitMs?: number;
  /** *Welcome back*'s ids (tests fix them). */
  welcomeId?: () => string;
  /** The connections' and devices' widgets (`createThingWidgets` unless a test brings its own). */
  things?: ThingWidgets;
  /** The widgets' own reads, when a test gives its own (`WidgetResolver`). */
  widgetReads?: ConstructorParameters<typeof WidgetResolver>[2];
  /** A thing's picture once a screen may show it (`thingPicture` unless a test brings its own). */
  picture?: typeof thingPicture;
}

/** How long Settings' live preview waits for a widget never read (`desk.screen.views`); the box's state never waits. */
export const SCREEN_VIEWS_WAIT_MS = 3_000;
/** How long a screen elsewhere's state waits for a widget never read. */
export const SCREEN_DRAW_WAIT_MS = 1_500;
/** The pictures a screen was last drawn with are what it may load this long; then they're worked out again. */
export const SCREEN_PICTURES_FRESH_MS = 30_000;
/** A picture not among them is looked for again in views worked out now, at most this often per screen. */
const SCREEN_PICTURES_AGAIN_MS = 2_000;

/** An output the box's page reported: its screen, its name and size. */
interface ReportedOutput {
  key: string;
  id: string;
  main: boolean;
  name: string | null;
  size: { width: number; height: number };
}

interface GlanceCache {
  personId: string;
  place: DeskPlace | null;
  full: FullGlance | null;
  /** What is new for the person in the burrow's scans, and whether the view is away (desk-found.md DF-03, DF-04). */
  found: FoundInputs | null;
  /** What the calm glance's planner reads (DK-112…DK-118), gathered with `full`. */
  calm: DeskCalmInput | null;
  at: number;
}

export class DeskService {
  readonly lock = new DeskLock();
  readonly pairing: DeskPairing;
  readonly talk: DeskTalks;
  readonly display: Pick<DisplayProbe, 'display' | 'connected'>;
  /** The camera's watch loop (DK-28): one per runtime, for the unlock it was started for. */
  readonly presence: PresenceLoop;
  readonly #numbers = new QuestionNumbers();
  #cache: GlanceCache | null = null;
  /** Where the screen is paired, as last read (undefined before the first read): Talk's `place()` asks it often. */
  #paired: { burrowId: string; personId: string } | null | undefined = undefined;
  #dirty = false;
  #building: { personId: string; promise: Promise<GlanceCache> } | null = null;
  #serial: Promise<unknown> = Promise.resolve();
  readonly #timers = new Set<NodeJS.Timeout>();
  readonly #offFrames: () => void;
  readonly #offPush: () => void;
  readonly #offRing: () => void;
  /** The unlock pushes sent, for `push.resolve` (DK-S21). */
  readonly #unlockPushes = new UnlockPushes(PUSH_TTL_S * 1000);
  /** When the console's state last checked whether to pair itself (DK-17). */
  #selfPairAt = Number.NEGATIVE_INFINITY;
  #offTick: (() => void) | null = null;
  /** The camera works on this box (`presenceAvailable`), as the latest health said (cached a minute there). */
  #cameraWorks = false;
  /**
   * Settings being changed: a health that comes back meanwhile doesn't start the camera (the change re-checks it when
   * done), so a switch turned off while a start waits for the health wins (DK-S39).
   */
  #settling = 0;
  /** The paired row as last read (`#row`): what the camera's wanting reads at every check. */
  #last: DeskRow | null = null;
  /** When the console last asked for the state of a paired screen, and the person's zone then (DK-72). */
  #console: { at: number; timeZone: string } | null = null;
  /** The boot this runtime runs on (DK-75), read once; null restores nothing. */
  readonly #bootId: string | null;
  /** The panel made from the latest reading (made once per reading, DK-22). */
  #box: { at: number; box: DeskBox | null } | null = null;
  /** The calm sources' slow reads, kept a while (DK-S124). */
  readonly #reads: CalmReads;
  /** The looks from one glance read to the next: since when, and what changed for *Welcome back* (DK-113, DK-120). */
  readonly #looks = new DeskLookLog();
  readonly #welcome: DeskWelcome;
  /** Settings' *Try it on the screen* while it lasts (DK-124): memory only, a restart ends it. */
  #sample: CalmSample | null = null;
  /** The Whombat's name for the top bar (DK-119) as last read, read again with the glance's age. */
  #name: { value: string | null; at: number } | null = null;
  /** A recording Talk's mic is turning into text: one at a time. */
  #hearing = false;
  #closed = false;
  /** The screens of widgets (DK-126…DK-149): what screens elsewhere use. */
  readonly screens: ScreensApi;
  readonly #store: ScreenStore;
  readonly #resolver: WidgetResolver;
  readonly #things: ThingWidgets;
  /** *Try on the screen* (DK-143), per screen while it lasts: memory only, a restart ends it. */
  readonly #trying = new Map<string, { layout: DeskLayout; until: number }>();
  /** A widget taking over a screen for a moment (the doorbell), per screen while it lasts: memory only. */
  readonly #spotlights = new ScreenSpotlights();
  /** Each screen's time zone as last read (`#zoneFor`). */
  readonly #zones = new Map<string, { at: number; zone: string | null }>();
  /** Per screen, the pictures its views named when last drawn, for the lock view they were drawn for (DK-142). */
  readonly #shown = new Map<string, { view: DeskCalmView; at: number; pictures: ReadonlySet<string> }>();
  /** The outputs the box's page reported last, and the burrow its screens are in (DK-147). */
  #outputs: { burrowId: string | null; list: ReportedOutput[] } | null = null;
  /** Each burrow's screens as last read, for the state's grid (read again with the glance's age, or after a change). */
  readonly #screenLists = new Map<string, { at: number; list: ScreenRecord[] }>();
  readonly #offLocale: () => void;

  constructor(
    readonly services: Services,
    private readonly options: DeskServiceOptions = {},
  ) {
    this.pairing = new DeskPairing(options.random ?? ((n) => new Uint8Array(randomBytes(n))));
    this.display = options.display ?? new DisplayProbe(options.drmDir, () => services.clock().getTime());
    this.talk = (options.talk ?? createDeskTalk)(services, this.talkHost());
    this.#reads = new CalmReads(
      options.calmSources ?? createDeskCalmSources(services),
      options.calmSourceWaitMs,
    );
    this.#welcome = new DeskWelcome(options.welcomeId);
    this.#store = new ScreenStore(services);
    this.#things = options.things ?? createThingWidgets(services);
    this.#resolver = new WidgetResolver(services, () => this.#things, options.widgetReads);
    this.screens = {
      list: (burrowId) => this.#store.list(burrowId),
      get: (burrowId, id) => this.#store.get(burrowId, id),
      byEndpoint: (endpointId) => this.#store.byEndpoint(endpointId),
      addDevice: async (tx, input) => {
        const record = await this.#store.addDevice(tx, input);
        this.#screenLists.delete(input.burrowId);
        return record;
      },
      seen: (id, size, at) => this.#store.seen(id, size, at),
      draw: (screen, view) => this.#draw(screen, view),
      timeZone: async (screen) => (await this.#zoneFor(screen)) ?? null,
      picture: (screen, view, thing, ref) => this.#picture(screen, view, thing, ref),
    };
    // The doorbell rang: the screens that show it open it big.
    this.#offRing = onDoorbellRing(services, (ring) => {
      void this.#ring(ring).catch((err) =>
        services.log.warn({ err: String(err) }, 'desk: the doorbell didn’t reach the screens'),
      );
    });
    this.#bootId =
      options.bootId === undefined ? readBootId(services.config.WHOMBAT_BOOT_ID) : options.bootId;
    this.presence = new PresenceLoop({
      lock: this.lock,
      now: () => this.#now(),
      after: options.after ?? realAfter,
      port: () => presenceFor(services),
      wanted: () => this.cameraWanted(this.#now()),
      warn: (message, err) => services.log.warn({ err: String(err) }, message),
    });
    // Something changed on the person's Home: read the glance again soon (DK-S10).
    this.#offFrames = services.bus.onFrame((frame) => {
      const person = this.#cache?.personId;
      if (person && frame.topic === topics.me(person) && frame.event.type === 'home.changed')
        this.#dirty = true;
    });
    // Language changed: drop the cached glance so the desk screen switches immediately.
    this.#offLocale = onLocaleChange(services, () => {
      this.#cache = null;
      this.#dirty = true;
    });
    // A tap on the unlock push opens This Whombat (DK-S21).
    this.#offPush = registerPushResolver(services, async (accountId, ref) => {
      let origin: string;
      try {
        origin = managedAppOrigin(services.config);
      } catch {
        return null;
      }
      const key = services.config.WHOMBAT_MASTER_KEY;
      return this.#unlockPushes.resolve(
        ref,
        accountId,
        this.#now(),
        (what) => opaqueRef('ref', what, key),
        origin,
      );
    });
  }

  /**
   * Back to locked, the camera off, no glance, no talk: unpaired, paired to someone, the person gone. What the camera
   * read of the pairing goes too: a new pairing starts with the camera's switches off (DK-S34, DK-S70).
   */
  #reset(): void {
    this.#last = null;
    this.#console = null;
    this.presence.stop();
    this.lock.reset();
    this.#cache = null;
    this.talk.forget();
    this.#looks.forget();
    this.#welcome.forget();
    this.#sample = null;
  }

  /**
   * The minute check whether the screen should pair itself (DK-17), and an unlock that stays brought back when the
   * runtime started again on the same boot (DK-75); the desk socket's runtime starts it.
   */
  start(): void {
    if (this.#offTick || this.#closed) return;
    void this.restoreUnlock().catch((err) =>
      this.services.log.warn({ err: String(err) }, 'desk: the unlock that stays wasn’t brought back'),
    );
    this.#offTick = this.services.housekeeping.add('desk pairs itself', SELF_PAIR_TICK_MS, () =>
      this.pairItself(),
    );
  }

  /**
   * On start (DK-75, DK-S73): the paired screen with *When you press Lock* whose unlock was kept with this boot's id is
   * unlocked again, staying, and the log says so once. A boot id from another boot (a reboot, a power cut, the
   * database restored elsewhere), none here, or the choice off: that unlock ended with the machine, and its boot is
   * forgotten. In the queue (DK-S22). True when it unlocked.
   */
  restoreUnlock(): Promise<boolean> {
    return this.#queue(async () => {
      const row = await this.#row();
      if (!row?.unlockedBoot || this.#closed) return false;
      if (row.stayUnlocked && this.#bootId !== null && row.unlockedBoot === this.#bootId) {
        this.lock.unlock(this.#now(), true);
        this.services.log.info('desk: unlocked again after the restart; it stays unlocked until Lock');
        return true;
      }
      await this.#keepBoot(row, null);
      return false;
    });
  }

  close(): void {
    this.#closed = true;
    this.#offTick?.();
    this.#offFrames();
    this.#offLocale();
    this.#offPush();
    this.#offRing();
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
    this.talk.close();
    // A runtime restart turns the camera off too (DK-30); the service would within 6 s anyway. An unlock that stays
    // keeps its boot: on the same boot the next runtime unlocks again (DK-75).
    this.presence.stop();
  }

  #now(): number {
    return this.services.clock().getTime();
  }

  /**
   * The paired row, remembering where the screen is paired (only this service and cascades change it) and the
   * camera's choices (`cameraWanted`).
   */
  async #row(): Promise<DeskRow | null> {
    const row = await loadDeskRow(this.services.db);
    this.#paired = row ? { burrowId: row.burrowId, personId: row.personId } : null;
    this.#last = row;
    return row;
  }

  /* The camera -------------------------------------------------------------------------------- */

  /** What wants the camera at `now` (`cameraWant`, DK-S70), from the row as last read and the console's last ask. */
  cameraWanted(now: number): PresenceWant {
    const row = this.#last;
    return cameraWant({
      settings: row && !this.#closed ? settingsOf(row) : null,
      cameraWorks: this.#cameraWorks,
      epoch: this.lock.epoch,
      stays: this.lock.stays,
      console: this.#console,
      // The latest reading without asking: the console's state reads it again every 10 s while it asks (DK-S13).
      onBattery: this.options.power?.latest?.source === 'battery',
      now,
    });
  }

  /**
   * Re-checks whether the camera is wanted (an unlock, a lock, a setting, the console asking): the loop starts,
   * follows or stops at once; the camera's health is read again (cached a minute) and, when it says otherwise now,
   * checked again with it — unless settings are being changed, which check it themselves when done.
   */
  #camera(): void {
    if (this.#closed) return;
    this.presence.poke();
    void presenceHealth(this.services)
      .then((health) => {
        const works = presenceAvailable(health);
        if (works === this.#cameraWorks || this.#closed) return;
        this.#cameraWorks = works;
        if (this.#settling === 0) this.presence.poke();
      })
      .catch((err) => this.services.log.warn({ err: String(err) }, 'desk: the camera wasn’t started'));
  }

  /**
   * The boot an unlock that stays was made on, written with it (`boot`), or forgotten (null) at a lock of it (DK-75,
   * DK-S73): a command as the paired person, only when it changes and only with a boot id to write. A write that fails
   * is logged: the screen stays as it is (an update then locks it, or a lock isn't kept past a restart on this boot).
   */
  async #keepBoot(row: DeskRow, boot: string | null): Promise<void> {
    if (row.unlockedBoot === boot) return;
    try {
      await this.#commitAs(row, deskUnlockedBoot, { boot });
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'desk: the boot of the unlock that stays wasn’t written');
    }
  }

  /** An unlock that stays now (a PIN, the phone, the choice): its boot written (DK-75). */
  async #staysOnThisBoot(row: DeskRow): Promise<void> {
    if (this.#bootId !== null && this.lock.stays) await this.#keepBoot(row, this.#bootId);
  }

  /* The paired person ------------------------------------------------------------------------- */

  /** The person's place (burrow, them, their assistant, their zone), or null when it is gone. */
  async placeOf(row: Pick<DeskRow, 'burrowId' | 'personId'>): Promise<DeskPlace | null> {
    const place = await personalPlace(this.services.db, row.burrowId, row.personId);
    if (!place) return null;
    const [account] = await this.services.db
      .select({ preferences: accounts.preferences })
      .from(accounts)
      .where(eq(accounts.id, place.accountId));
    const prefs = account?.preferences as { timeZone?: string | null; locale?: unknown } | null;
    const own = prefs?.timeZone;
    const locale = safeLocaleOrNull(prefs?.locale) ?? undefined;
    return {
      burrow: place.burrow,
      person: place.person,
      agent: place.agent,
      accountId: place.accountId,
      timeZone: zoneOf(own, place.burrow.timeZone),
      ...(locale ? { locale } : {}),
    };
  }

  /** The glance for the paired person: the cached one (read again in the background when old), else a fresh one. */
  async glanceFor(row: Pick<DeskRow, 'burrowId' | 'personId'>): Promise<GlanceCache> {
    const cached = this.#cache;
    if (cached && cached.personId === row.personId) {
      if (this.#dirty || this.#now() - cached.at >= GLANCE_MAX_AGE_MS)
        void this.#rebuild(row).catch((err) =>
          this.services.log.warn({ err: String(err) }, 'desk: the glance wasn’t read'),
        );
      return cached;
    }
    return this.#rebuild(row);
  }

  /**
   * Reads the glance now: one read at a time per person (a read for someone paired before is waited for, then this
   * person's starts).
   */
  #rebuild(row: Pick<DeskRow, 'burrowId' | 'personId'>): Promise<GlanceCache> {
    const before = this.#building;
    if (before?.personId === row.personId) return before.promise;
    const promise = (async () => {
      if (before) await before.promise.catch(() => null);
      this.#dirty = false;
      const place = await this.placeOf(row);
      // A part of Home that fails keeps the last glance (or an empty one): the screen still shows the clock.
      const last = this.#cache?.personId === row.personId ? this.#cache.full : null;
      const now = this.services.clock();
      let read = false;
      const full = place
        ? await buildFullGlance(this.services, place, this.#numbers, now)
            .then((glance) => {
              read = true;
              return glance;
            })
            .catch((err) => {
              this.services.log.warn({ err: String(err) }, 'desk: the glance wasn’t read');
              return last ?? EMPTY_GLANCE;
            })
        : null;
      // Only a glance read now says what began or went (a kept one would say nothing changed, an empty one all went).
      if (read && full) this.#looks.observe(full.everyLook, full.keys, now.getTime());
      // The calm glance's input with it; one that can't be made keeps the last (or none: the screen draws the old glance).
      const lastCalm = this.#cache?.personId === row.personId ? this.#cache.calm : null;
      const calm =
        place && full
          ? await this.#calmInput(place, full, now).catch((err) => {
              this.services.log.warn({ err: String(err) }, 'desk: the calm glance wasn’t gathered');
              return lastCalm;
            })
          : null;
      // Found on your network (DF-03): a read that fails keeps the last one; none shows nothing found.
      const lastFound = this.#cache?.personId === row.personId ? this.#cache.found : null;
      const found = place
        ? await foundInputsOf(this.services, place).catch((err) => {
            this.services.log.warn({ err: String(err) }, 'desk: what was found wasn’t read');
            return lastFound;
          })
        : null;
      const next = { personId: row.personId, place, full, found, calm, at: this.#now() };
      this.#cache = next;
      return next;
    })().finally(() => {
      if (this.#building?.promise === promise) this.#building = null;
    });
    this.#building = { personId: row.personId, promise };
    return promise;
  }

  /** What the calm glance's planner reads for the person (DK-S122): the glance's read and the calm sources. */
  #calmInput(place: DeskPlace, full: FullGlance, now: Date): Promise<DeskCalmInput> {
    return deskCalmInput(
      full,
      this.#reads,
      {
        viewer: { burrowId: place.burrow.id, personId: place.person.id, timeZone: place.timeZone },
        assistant: screenText(place.agent.name, 40) || 'Your assistant',
      },
      now,
      (key) => this.#looks.since(key),
    );
  }

  /** The Whombat's name for the top bar (DK-119): as given by the app, read again at most every 10 s. */
  async #whombatName(): Promise<string | null> {
    const now = this.#now();
    if (this.#name && now - this.#name.at < GLANCE_MAX_AGE_MS) return this.#name.value;
    const value = await loadWhombatName(this.services.db).catch(() => this.#name?.value ?? null);
    this.#name = { value, at: now };
    return value;
  }

  /**
   * Someone at the screen (a touch, a PIN, a button): *Welcome back* knows they're here and a digest that showed goes
   * (DK-120, DK-121), and Settings' *Try it on the screen* ends (DK-124).
   */
  #touched(now = this.#now()): void {
    this.#welcome.here(now, true);
    this.#sample = null;
  }

  /** Reads the glance again now (after a decision on the screen) and waits for it. */
  async refresh(): Promise<void> {
    const row = await this.#row();
    if (!row) {
      this.#cache = null;
      return;
    }
    await this.#building?.promise.catch(() => null);
    await this.#rebuild(row);
  }

  /* The screen (desk socket) ------------------------------------------------------------------ */

  /** `GET /v1/desk/state` (§2.3). */
  async state(): Promise<DeskState> {
    const now = this.#now();
    const pairing = this.pairing.live(now);
    const power = this.options.power?.peek() ?? null;
    const row = await this.#row();
    // Nobody paired: whether the screen should pair itself, at most every 10 s (DK-17), never waited for here.
    if (!row && now - this.#selfPairAt >= SELF_PAIR_EVERY_MS) {
      this.#selfPairAt = now;
      void this.pairItself().catch((err) =>
        this.services.log.warn({ err: String(err) }, 'desk: the screen didn’t pair itself'),
      );
    }
    const name = await this.#whombatName();
    const base = {
      v: 1 as const,
      now: new Date(now).toISOString(),
      pairing: pairing ? { code: pairing.code, expiresAt: new Date(pairing.expiresAt).toISOString() } : null,
      power,
      ...remoteHelpLine(this.options.remoteHelp),
      // The Whombat's name for the top bar once the app gave it (DK-119); the org's until then.
      ...(name ? { name } : {}),
    };
    const cache = row ? await this.glanceFor(row) : null;
    const place = cache?.place ?? null;
    if (!row || !place || !cache?.full) {
      this.#console = null;
      this.#camera();
      return { ...base, paired: null, lock: { state: 'locked' }, glance: null, talk: null };
    }
    // The console shows the desk: the camera for the clock may look (DK-72); the morning or its return starts it.
    this.#console = { at: now, timeZone: place.timeZone };
    this.#camera();
    const view = this.lock.view(now, row.retryAt?.getTime() ?? null);
    const unlocked = view.state === 'unlocked';
    const settings = settingsOf(row);
    const health = row.voice ? await voiceHealth(this.services).catch(() => null) : null;
    const assistant = screenText(place.agent.name, 40) || 'Your assistant';
    // This Whombat shows only on a glance without servers, never in *Only the time* (DK-100): the box isn't read otherwise.
    const box = boxWanted(cache.full, unlocked ? 'everything' : settings.lockedView) ? this.#boxNow() : null;
    const presence = this.cameraWanted(now).clock ? this.presence.presence(now) : null;
    // A face the camera sees is someone at the screen, for *Welcome back* (DK-120).
    if (presence?.here || view.present) this.#welcome.here(now, false);
    const calm = this.#calmNow(cache, settings.show, unlocked ? 'everything' : settings.lockedView, now);
    // The screens of widgets beside the calm glance (DK-126, DK-149): the box's own and each monitor's.
    const grids = await this.#boxGrids(
      cache,
      place,
      settings.show,
      unlocked ? 'everything' : settings.lockedView,
    ).catch((err) => {
      this.services.log.warn({ err: String(err) }, 'desk: the screens’ grids weren’t made');
      return {};
    });
    return this.#fits({
      ...base,
      paired: {
        person: deskPerson(place.person),
        // Its name and face (one-agent.md OA-08).
        assistant: { name: assistant, face: faceOf(place.agent) },
        timeZone: place.timeZone,
        ...(place.locale ? { locale: place.locale } : {}),
        lockedView: settings.lockedView,
        night: settings.night,
        quiet: deskQuietNow(settings, new Date(now), place.timeZone),
        voice: !!health && health.stt && health.microphone,
        // Without a PIN only the phone unlocks (DK-18).
        hasPin: row.pinHash !== null,
        // The pad's dots (DK-26): a PIN from before 0124 is six digits.
        ...(row.pinHash !== null ? { pinDigits: row.pinDigits ?? PIN_DIGITS_BEFORE } : {}),
      },
      lock: {
        state: view.state,
        ...(view.until ? { until: new Date(view.until).toISOString() } : {}),
        // The chip's camera mark and “stays unlocked while you’re here” (DK-30, DK-28), or “Unlocked as” (DK-74).
        ...(view.camera ? { camera: true } : {}),
        ...(view.present ? { present: true } : {}),
        ...(view.stays ? { stays: true } : {}),
        ...(view.retryAt ? { retryAt: new Date(view.retryAt).toISOString() } : {}),
        ...(view.expiresAt ? { expiresAt: new Date(view.expiresAt).toISOString() } : {}),
      },
      glance: {
        ...trimGlance(
          cache.full,
          {
            unlocked,
            view: settings.lockedView,
            hasPin: row.pinHash !== null,
            inTalk: (number) => this.#inTalk(place.person.id, cache.full?.places[number]),
          },
          box,
          deskFoundNow(this.services, place.burrow.id, cache.found),
        ),
        // The calm glance beside the members an older console draws (DK-125).
        ...(calm ? { calm } : {}),
        ...grids,
      },
      talk: unlocked ? this.talk.latest() : null,
      // The camera looking for someone for the clock (DK-72, DK-S72): only while that case wants it.
      ...(presence ? { presence } : {}),
    });
  }

  /**
   * The state as the console reads it (`DESK_STATE_MAX_BYTES`): the monitors' grids go first, then the box's own, when
   * it would be larger; the calm glance and the rest stay, so the screen still draws.
   */
  #fits(state: DeskState): DeskState {
    const glance = state.glance;
    if (!glance || (!glance.grid && !glance.outputs)) return state;
    const size = (s: DeskState) => Buffer.byteLength(JSON.stringify(s));
    if (size(state) <= DESK_STATE_MAX_BYTES) return state;
    this.services.log.warn('desk: the screens’ grids made the state too large; some were left out');
    const { outputs: _o, ...withoutOutputs } = glance;
    const smaller = { ...state, glance: withoutOutputs };
    if (size(smaller) <= DESK_STATE_MAX_BYTES) return smaller;
    const { grid: _g, ...withoutGrid } = withoutOutputs;
    return { ...state, glance: withoutGrid };
  }

  /**
   * The calm glance now (DK-101…DK-124): the planner's for the person's choices and what the lock lets show, Settings'
   * scenario while it is tried on the screen, *Welcome back* when someone came back. None when the glance has no calm
   * input yet, or what came out isn't one the screen takes (logged: the screen draws the glance beside it).
   */
  #calmNow(cache: GlanceCache, show: DeskShow, view: DeskCalmView, now: number) {
    const input = cache.calm;
    const full = cache.full;
    if (!input || !full) return null;
    if (this.#sample && this.#sample.until <= now) this.#sample = null;
    const sample = this.#sample;
    // While Settings tries a scenario, *Welcome back* waits: it shows only once, and not under the banner.
    const digest = sample
      ? null
      : this.#welcome.digest(now, view, show.welcomeBack, () => ({
          assistant: input.assistant,
          asks: input.asks,
          askCount: input.askCount,
          recent: full.recent,
          changes: (from) => this.#looks.changesSince(from),
        }));
    const calm = calmNow(input, show, view, new Date(now), { digest, sample });
    if (!calm) this.services.log.warn('desk: the calm glance wasn’t one the screen takes');
    return calm;
  }

  /** *This Whombat* from the latest reading (DK-22), made once per reading; null when the manager didn't answer. */
  #boxNow(): DeskBox | null {
    const read = this.options.power?.peekBox() ?? null;
    if (!read) return null;
    if (this.#box?.at !== read.at) {
      let box: DeskBox | null = null;
      try {
        box = deskBox(read.input);
      } catch (err) {
        this.services.log.warn({ err: String(err) }, 'desk: the box’s figures weren’t made');
      }
      this.#box = { at: read.at, box };
    }
    return this.#box.box;
  }

  /**
   * Runs `fn` after every earlier PIN, phone unlock, decision, pairing, new PIN and unpairing (one at a time, so the
   * wrong PINs count right and a PIN checked for one pairing can't unlock the next; DK-S05, DK-S22).
   */
  #queue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#serial.then(fn, fn);
    this.#serial = next.catch(() => null);
    return next;
  }

  /** `POST /v1/desk/unlock` (DK-04). */
  unlock(pin: string): Promise<DeskUnlockAnswer> {
    this.#touched();
    return this.#queue(async () => {
      const checked = await this.#checkPin(pin);
      if (!checked.right) return { v: 1, ...checked.answer };
      const row = checked.row;
      const now = this.#now();
      const request = this.lock.request(now);
      // *When you press Lock*: no time locks it, and it outlives an update on this boot (DK-74, DK-75).
      this.lock.unlock(now, row.stayUnlocked);
      this.#camera();
      await this.#staysOnThisBoot(row);
      if (request) await this.#clearPush(row, request);
      return { v: 1, result: 'unlocked' };
    });
  }

  /**
   * The PIN typed on the screen, for an unlock (DK-04) or a risky ask's Approve (DK-S61), in the queue: five wrong ones
   * and the screen waits (kept in the database), the fifth told to the person. A right PIN is right only for the pairing
   * and PIN it was checked against: one that changed while scrypt ran is checked again (DK-S22).
   */
  async #checkPin(pin: string): Promise<
    | { right: true; row: DeskRow }
    | {
        right: false;
        answer: { result: 'wrong'; triesLeft: number } | { result: 'backoff'; retryAt: string };
      }
  > {
    let row = await this.#row();
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!row) throw notPaired();
      // No PIN yet: only the phone unlocks, and nothing is counted (DK-18).
      if (row.pinHash === null) throw new DeskRefused(409, 'no_pin', DESK_WORDS.errors.no_pin);
      if (row.retryAt && row.retryAt.getTime() > this.#now())
        return { right: false, answer: { result: 'backoff', retryAt: row.retryAt.toISOString() } };
      const checked = row;
      const right = await (this.options.verifyPin ?? verifyPin)(pin, row.pinHash);
      row = await this.#row();
      if (!row || !samePin(checked, row)) continue;
      if (right) {
        if (row.wrongPins > 0) await this.#commitAs(row, deskRightPin, {});
        return { right: true, row };
      }
      const counted = (await this.#commitAs(row, deskWrongPin, {})) as {
        wrongPins: number;
        retryAt: Date | null;
      };
      if (counted.wrongPins === PIN_FREE_TRIES) this.#tellWrongPins(row);
      if (counted.retryAt)
        return { right: false, answer: { result: 'backoff', retryAt: counted.retryAt.toISOString() } };
      return { right: false, answer: { result: 'wrong', triesLeft: pinTriesLeft(counted.wrongPins) } };
    }
    throw locked();
  }

  /**
   * A screen elsewhere's PIN (DK-138): the box's own, checked in the same queue with the same count and wait, kept in the
   * database: five wrong ones anywhere and the box and every screen wait, and the fifth is told to the person.
   */
  checkScreenPin(pin: string): Promise<ScreenPinCheck> {
    return this.#queue(async () => {
      try {
        const checked = await this.#checkPin(pin);
        if (checked.right) return { result: 'right' as const, pinHash: checked.row.pinHash as string };
        return checked.answer.result === 'backoff'
          ? { result: 'backoff' as const, retryAt: Date.parse(checked.answer.retryAt) }
          : { result: 'wrong' as const, triesLeft: checked.answer.triesLeft };
      } catch (err) {
        if (!(err instanceof DeskRefused)) throw err;
        // No PIN, or nobody paired the box's screen: nothing unlocks a screen elsewhere either.
        if (err.code === 'no_pin' || err.code === 'not_paired')
          throw deskError('no_pin', DESK_WORDS.errors.no_pin);
        throw new ApiError('conflict', 'The PIN changed while it was checked. Try again.');
      }
    });
  }

  /** The person hears about the fifth wrong PIN in Chat, once (DK-04). */
  #tellWrongPins(row: DeskRow): void {
    this.services.background.run('desk: wrong PINs', () =>
      tellPerson(this.services, row.burrowId, row.personId, DESK_WORDS.settings.wrongPins),
    );
  }

  /**
   * `POST /v1/desk/unlock/phone` (DK-04): asks the person's phone; a request still waiting is the answer again. In the
   * queue, so a pairing can't change between asking whose phone and the request (DK-S22).
   */
  unlockPhone(): Promise<DeskPhoneUnlockAnswer> {
    this.#touched();
    return this.#queue(async () => {
      const row = await this.#row();
      const place = row ? (await this.glanceFor(row)).place : null;
      if (!row || !place) throw notPaired();
      const now = this.#now();
      const { request, fresh } = this.lock.ask(now);
      if (fresh) {
        this.#unlockPushes.remember(request.id, place.accountId, place.burrow.slug, now);
        await this.options.push
          ?.forAccounts([place.accountId], 'security', unlockPushWhat(request.id), {
            group: unlockPushWhat(request.id),
            preview: { title: DESK_WORDS.settings.unlockRequest, body: UNLOCK_PUSH_BODY },
          })
          .catch((err) => this.services.log.warn({ err: String(err) }, 'desk: the unlock push wasn’t sent'));
        // Ran out unanswered: the phone's notice goes and Settings hears it (a later request is its own).
        this.#at(request.expiresAt - now + 50, async () => {
          if (this.lock.request(this.#now())?.id === request.id) return;
          await this.#clearPush(row, request);
          await this.#changed();
        });
        await this.#changed();
      }
      return { v: 1, expiresAt: new Date(request.expiresAt).toISOString() };
    });
  }

  /**
   * `POST /v1/desk/lock`: locked at once (an unlock that stays too, DK-74), the lock's camera off (DK-30) — the camera
   * for the clock stays on while that still wants it (DK-72: no off and on at every lock). The boot of an unlock that
   * stayed is forgotten before the answer (DK-75), after what the queue does first, so an unlock it made meanwhile is
   * written before it.
   */
  async lockNow(): Promise<DeskAck> {
    this.#touched();
    this.lock.lock();
    this.#camera();
    await this.#queue(async () => {
      const row = await this.#row();
      if (row?.unlockedBoot && !this.lock.stays) await this.#keepBoot(row, null);
    });
    return { v: 1 };
  }

  /**
   * `POST /v1/desk/found/dismiss` (desk-found.md DF-04, DF-S10): the found panel or strip's *Not now*, also while
   * locked — it shows nothing and changes nothing but what the screen shows. Final for the paired person's burrow: the
   * view is put away and the automatic scans stop. The glance drops `found` at once. 409 `not_paired` with nobody paired.
   */
  foundDismiss(): Promise<DeskAck> {
    this.#touched();
    return this.#queue(async () => {
      const row = await this.#row();
      if (!row) throw notPaired();
      if (await putFoundAway(this.services, row.burrowId))
        this.services.log.info({ burrowId: row.burrowId }, 'desk: found on your network put away (Not now)');
      const cache = this.#cache;
      if (cache?.personId === row.personId && cache.found) cache.found = { ...cache.found, putAway: true };
      this.#dirty = true;
      return { v: 1 as const };
    });
  }

  /**
   * `POST /v1/desk/touch`: keeps an unlocked screen unlocked (409 when it is locked). Locked or not, someone is there
   * (*Welcome back*, DK-120), and Settings' *Try it on the screen* ends (DK-124).
   */
  touch(): DeskTouchAnswer {
    this.#touched();
    const until = this.lock.touch(this.#now());
    if (until === null) throw locked();
    return { v: 1, until: new Date(until).toISOString() };
  }

  /**
   * `POST /v1/desk/decide` (DK-05, DK-61, DK-62; DK-S19, DK-S60, DK-S61; task-feedback.md TF-14): only while unlocked.
   * `approve` is the person's yes — once, or with one of the ask's wider choices (`scope` `task` or `agent`, as the web
   * card offers it to them now, else 403 `not_offered`). A risky ask's yes (`deskMayDecide` refuses it) and every wider
   * choice need the PIN typed again (`deskDecideNeedsPin`), checked as an unlock's; a risky ask on a screen without a
   * PIN stays on the phone. `deny` is their no, as in Chat; `decline` is the screen's *Not now*, which is Home's: the ask
   * snoozed for them until tomorrow at 09:00 (`notNowSnooze`), not a no the requester hears. A question has only *Not
   * now* here (Ask opens Talk). A yes or no to an ask made in Talk's open conversation starts a follow talk first
   * (DK-S63), named in `talk`.
   */
  decide(
    number: number,
    decision: 'approve' | 'decline' | 'deny',
    pin?: string,
    scope?: DeskDecideScope,
  ): Promise<DeskDecideAnswer> {
    this.#touched();
    return this.#queue(async () => {
      const row = await this.#row();
      if (!row) throw notPaired();
      if (!this.lock.unlocked(this.#now())) throw locked();
      if (!deskDecideRequestValid({ decision, ...(scope ? { scope } : {}) }))
        throw new DeskRefused(400, 'bad_request', 'Only a yes has a scope.');
      const place = (await this.glanceFor(row)).place;
      if (!place) throw notPaired();
      const question = this.#numbers.messageOf(number);
      const wider = scope === 'task' || scope === 'agent' ? scope : null;
      let follow: { id: string; cancel(): void } | null = null;
      if (question) {
        if (decision !== 'decline') throw new DeskRefused(404, 'not_found', 'There is no such request.');
        await this.#notNow(place, { kind: 'question', messageId: question });
      } else {
        const found = await approvalByNumber(this.services.db, place.burrow.id, number);
        const approval = found ? toApproval(found) : null;
        if (!found || !approval || !(await approvalVisible(this.services.db, place.person, approval)))
          throw new DeskRefused(404, 'not_found', 'There is no such request.');
        if (approval.state !== 'pending') throw new DeskRefused(409, 'decided', 'This was already decided.');
        if (decision === 'decline') await this.#notNow(place, { kind: 'approval', number });
        else {
          if (decision === 'approve') {
            const args = callArgsOf(this.services, found);
            const risky = !deskMayDecide({ action: approval.action, keyId: approval.keyId }, { args }).ok;
            // A wider choice is one the web card offers this person now, on a screen with a PIN (TF-14, DK-S100).
            if (
              wider &&
              (row.pinHash === null ||
                !(await deskOfferedScopes(this.services, place, found, this.services.clock())).includes(
                  wider,
                ))
            )
              throw new DeskRefused(403, 'not_offered', DESK_WORDS.notOffered);
            if (deskDecideNeedsPin({ approveWithPin: risky }, { decision, ...(scope ? { scope } : {}) })) {
              // The PIN again (DK-S61, DK-S101); a risky ask on a screen without a PIN stays on the phone (DK-62).
              if (row.pinHash === null) throw new DeskRefused(403, 'on_phone', DESK_WORDS.approveOnPhone);
              if (!pin) throw new DeskRefused(403, 'pin_needed', DESK_WORDS.approveWithPin);
              const checked = await this.#checkPin(pin);
              if (!checked.right) {
                // The wait shows where it belongs: on the locked screen.
                if (checked.answer.result === 'backoff') this.lockNow();
                return { v: 1, ...checked.answer };
              }
            }
          }
          if (await this.#askInTalk(place.person.id, found)) follow = await this.talk.follow();
          try {
            await this.#decideAs(place, number, decision === 'approve' ? 'approve' : 'decline', wider);
          } catch (err) {
            follow?.cancel();
            throw err;
          }
        }
      }
      this.lock.touch(this.#now());
      await this.refresh().catch(() => null);
      return { v: 1, result: 'decided', ...(follow ? { talk: follow.id } : {}) };
    });
  }

  /** Whether an approval was asked in Talk's open conversation, the person's (DK-S62). */
  async #askInTalk(
    personId: string,
    approval: { conversationId: string; messageId: string | null },
  ): Promise<boolean> {
    const message = approval.messageId ? await loadMessageRow(this.services.db, approval.messageId) : null;
    return this.#inTalk(personId, {
      conversationId: approval.conversationId,
      messageId: approval.messageId,
      threadRootId: message?.threadRootId ?? null,
    });
  }

  #inTalk(personId: string, at: AskPlace | undefined): boolean {
    const open = this.talk.open();
    return !!at && !!open && open.personId === personId && inConversation(open, at);
  }

  /**
   * The person's yes (once, or with a wider `scope`, never later) or no, as them. A refusal of the scope (they may not
   * change the agent's keys or the server's asks) is `not_offered`; any other refusal leaves it to the phone.
   */
  async #decideAs(
    place: DeskPlace,
    number: number,
    decision: 'approve' | 'decline',
    scope: 'task' | 'agent' | null = null,
  ): Promise<void> {
    try {
      const res = await this.services.pipeline.commit(
        decideApproval,
        { number, decision, ...(scope ? { scope } : {}) },
        { burrowId: place.burrow.id, actorId: place.person.id },
      );
      if (res.status !== 'ok') throw new DeskRefused(403, 'on_phone', DESK_WORDS.onPhone);
    } catch (err) {
      if (err instanceof DeskRefused) throw err;
      if (err instanceof ApiError && err.code === 'conflict')
        throw new DeskRefused(409, 'decided', 'This was already decided.');
      if (
        scope &&
        err instanceof ApiError &&
        (err.code === 'not_allowed' || err.code === 'forbidden' || err.code === 'validation_failed')
      )
        throw new DeskRefused(403, 'not_offered', DESK_WORDS.notOffered);
      if (err instanceof ApiError && (err.code === 'not_allowed' || err.code === 'forbidden'))
        throw new DeskRefused(403, 'on_phone', DESK_WORDS.onPhone);
      throw err;
    }
  }

  /**
   * `POST /v1/desk/look/quiet` (quiet-notices.md QN-12, QN-20; QN-S17): *Ignore* (until it changes) or *Not now* (until
   * 09:00 tomorrow) on a look, only while unlocked, as the paired person and for the whole Whombat, as `things.quiet`
   * does: the line as it is now must still be there (404 `not_found`), and the person must be allowed to quiet it
   * (403 `not_allowed`). The glance is read again: the look goes.
   */
  lookQuiet(
    key: string,
    notice: { check: string; subject?: string },
    how: 'ignore' | 'snooze',
  ): Promise<DeskAck> {
    this.#touched();
    return this.#queue(async () => {
      const row = await this.#row();
      if (!row) throw notPaired();
      if (!this.lock.unlocked(this.#now())) throw locked();
      const place = (await this.glanceFor(row)).place;
      if (!place) throw notPaired();
      try {
        await quietThingNotice(
          this.services,
          {
            accountId: place.accountId,
            burrowId: place.burrow.id,
            principal: place.person,
          },
          key,
          { notice: { check: notice.check, ...(notice.subject ? { subject: notice.subject } : {}) }, how },
          place.timeZone,
        );
      } catch (err) {
        if (err instanceof ApiError && (err.code === 'not_allowed' || err.code === 'forbidden'))
          throw new DeskRefused(403, 'not_allowed', 'Only you can quiet it.');
        if (err instanceof ApiError && err.code === 'not_found')
          throw new DeskRefused(404, 'not_found', 'This doesn’t need a look any more.');
        throw err;
      }
      this.lock.touch(this.#now());
      await this.refresh().catch(() => null);
      return { v: 1 };
    });
  }

  /**
   * `POST /v1/desk/look/fix` (look-research.md LR-08): the step the assistant offers on a look, pressed at the screen,
   * only while unlocked and as the paired person, as `looks.fix` does: their “Go ahead: …” in the look's thread and the
   * assistant woken to take it. 404 `not_found` when the look went or offers no step (any more), 403 `not_allowed` when
   * the person may not let it (Look only). The glance is read again: the look says “I’m on it.”.
   */
  lookFix(key: string): Promise<DeskAck> {
    this.#touched();
    return this.#queue(async () => {
      const row = await this.#row();
      if (!row) throw notPaired();
      if (!this.lock.unlocked(this.#now())) throw locked();
      const place = (await this.glanceFor(row)).place;
      if (!place) throw notPaired();
      try {
        const res = await this.services.pipeline.commit(
          fixLook,
          { key },
          { burrowId: place.burrow.id, actorId: place.person.id },
        );
        if (res.status !== 'ok') throw new DeskRefused(403, 'not_allowed', DESK_WORDS.onPhone);
      } catch (err) {
        if (err instanceof DeskRefused) throw err;
        if (err instanceof ApiError && (err.code === 'not_allowed' || err.code === 'forbidden'))
          throw new DeskRefused(403, 'not_allowed', 'Only you can let it take this step.');
        if (err instanceof ApiError && err.code === 'not_found')
          throw new DeskRefused(404, 'not_found', 'This doesn’t need a look any more.');
        throw err;
      }
      this.lock.touch(this.#now());
      await this.refresh().catch(() => null);
      return { v: 1 };
    });
  }

  /** Home's *Not now* as the person: the ask leaves their Needs you until tomorrow at 09:00 (DK-S19). */
  async #notNow(place: DeskPlace, subject: NotNowSubject): Promise<void> {
    await this.services.pipeline.commit(
      snoozeNeedsYou,
      notNowSnooze(subject, this.services.clock(), place.burrow.timeZone),
      { burrowId: place.burrow.id, actorId: place.person.id },
    );
  }

  /* The servers (DK-83…DK-86) ----------------------------------------------------------------- */

  /**
   * Whether the screen may show servers now (DK-84, DK-S82): paired, and not locked in *Only the time* (it has no
   * cards); the alerts' titles only unlocked or with *Everything*. Reading doesn't keep the screen unlocked: the page
   * sends its touches as on the glance (DK-S90).
   */
  async #serversView(): Promise<{ place: DeskPlace; titles: boolean }> {
    const row = await this.#row();
    if (!row) throw notPaired();
    const place = (await this.glanceFor(row)).place;
    if (!place) throw notPaired();
    const view = this.lock.unlocked(this.#now()) ? 'everything' : settingsOf(row).lockedView;
    if (view === 'time') throw locked();
    return { place, titles: view === 'everything' };
  }

  /** The fleet as cards (null: this burrow sees no servers); `unavailable` when the hosts service doesn't answer. */
  async #fleet(place: DeskPlace): Promise<DeskFleet | null> {
    try {
      return await deskFleet(this.services, place.burrow.id, DESK_HOSTS_WAIT_MS);
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'desk: the servers weren’t read');
      throw serversUnavailable();
    }
  }

  /** `POST /v1/desk/servers` (DK-86): every server as a card, worst first, the first `DESK_SERVERS` and the rest counted. */
  async servers(): Promise<DeskServersAnswer> {
    const { place } = await this.#serversView();
    const cards = (await this.#fleet(place))?.cards ?? [];
    return { v: 1, servers: cards.slice(0, DESK_SERVERS), more: Math.max(0, cards.length - DESK_SERVERS) };
  }

  /**
   * `POST /v1/desk/server` (DK-83, DK-S83): one server of the fleet (with a card, so not one still waiting to be let in)
   * as its screen; `not_found` for any other id, `unavailable` when the hosts service doesn't give its detail.
   */
  async server(id: string, range: DeskServerRange): Promise<DeskServerPage> {
    const { place, titles } = await this.#serversView();
    const fleet = await this.#fleet(place);
    const row = fleet?.rows.get(id);
    const card = fleet?.cards.find((c) => c.id === id);
    if (!row || !card) throw noSuchServer();
    const now = this.services.clock();
    let parts: ServerParts;
    try {
      parts = await readServerParts(hostsFor(this.services), id, range, now);
    } catch (err) {
      if (err instanceof HostsError && err.status === 404) throw noSuchServer();
      this.services.log.warn({ err: String(err) }, 'desk: the server wasn’t read');
      throw serversUnavailable();
    }
    return deskServerPage({ ...parts, row, card, range, now, titles });
  }

  /**
   * The server a talk is about (DK-85, DK-S89): a card of the fleet by its id — the glance's first, else the fleet's —
   * or null, and the talk goes on without it.
   */
  async #talkServer(row: DeskRow, id: string): Promise<DeskServer | null> {
    const cache = await this.glanceFor(row);
    const known = cache.full?.servers.find((s) => s.id === id);
    if (known) return known;
    if (!cache.place) return null;
    const fleet = await deskFleet(this.services, cache.place.burrow.id, DESK_HOSTS_WAIT_MS).catch(() => null);
    return fleet?.cards.find((c) => c.id === id) ?? null;
  }

  /** `POST /v1/desk/talk` (DK-06): only while unlocked; the rest is Talk's. `server`: what the person looks at (DK-85). */
  async talkStart(input: DeskTalkStart & { server?: string }): Promise<{ v: 1; id: string }> {
    this.#touched();
    const row = await this.#row();
    if (!row) throw notPaired();
    if (!this.lock.unlocked(this.#now())) throw locked();
    this.lock.touch(this.#now());
    const { server, ...talk } = input;
    const card = server ? await this.#talkServer(row, server) : null;
    try {
      return {
        v: 1,
        ...(await this.talk.start(card?.id ? { ...talk, about: { ...card, id: card.id } } : talk)),
      };
    } catch (err) {
      if (err instanceof DeskTalkError) throw new DeskRefused(err.status, err.code, err.message);
      throw err;
    }
  }

  /** `POST /v1/desk/talk/session` (DK-T15): the open conversation, only while unlocked (its words are messages, DK-03). */
  async talkSession(): Promise<DeskTalkSession> {
    if (!this.lock.unlocked(this.#now())) throw locked();
    const row = await this.#row();
    if (!row) throw notPaired();
    const open = this.talk.open();
    if (open && open.personId !== row.personId) this.talk.end();
    return this.talk.session();
  }

  /** `POST /v1/desk/talk/close` (DK-T14): ends the open conversation; its thread stays in Chat. */
  talkClose(): DeskAck {
    if (!this.lock.unlocked(this.#now())) throw locked();
    this.talk.end();
    return { v: 1 };
  }

  /** `POST /v1/desk/talk/get`: following a talk that waits or works is using the screen (TF-18, DK-S102). */
  talkGet(id: string): DeskTalk {
    if (!this.lock.unlocked(this.#now())) throw locked();
    const talk = this.talk.get(id);
    if (!talk) throw new DeskRefused(404, 'not_found', 'That talk is gone.');
    if (talk.state !== 'answered' && talk.state !== 'failed') this.lock.touch(this.#now());
    return talk;
  }

  /** `POST /v1/desk/talk/audio`: the answer's WAV while it is kept. */
  talkAudio(id: string): Uint8Array {
    if (!this.lock.unlocked(this.#now())) throw locked();
    const audio = this.talk.audio(id);
    if (!audio) throw new DeskRefused(404, 'not_found', 'That answer’s sound is gone.');
    return audio;
  }

  /**
   * `POST /v1/desk/hear` (docs/decisions/dictation.md): Talk's mic is voice typing. Only while unlocked, with Talk's
   * voice on and possible, one recording at a time; turned into text the way a composer's is (`dictate`: voice typing's
   * model and language, the names for Whisper, silence and the service's notes dropped), answered and forgotten. Words
   * that come back to a screen that locked meanwhile are refused: a locked screen shows none (DK-03).
   */
  async hear(audio: Buffer, signal?: AbortSignal): Promise<DeskHeard> {
    this.#touched();
    const row = await this.#row();
    if (!row) throw notPaired();
    if (!this.lock.unlocked(this.#now())) throw locked();
    this.lock.touch(this.#now());
    const health = row.voice ? await voiceHealth(this.services).catch(() => null) : null;
    if (!health?.stt || !health.microphone) throw voiceUnavailable();
    if (this.#hearing) throw new DeskRefused(409, 'busy', DESK_WORDS.dictation.busy);
    this.#hearing = true;
    try {
      const heard = await voiceTypingFor(this.services).dictate(audio, row.burrowId, signal, { desk: true });
      if (!this.lock.unlocked(this.#now())) throw locked();
      this.lock.touch(this.#now());
      return { v: 1, text: deskHeardText(heard.text) };
    } catch (err) {
      if (err instanceof DictationError) throw hearRefusal(err);
      throw err;
    } finally {
      this.#hearing = false;
    }
  }

  /** What Talk asks of the core (DK-S16): where the screen is paired, whether it is unlocked, Talk's switch, a server. */
  talkHost(): DeskTalkHost {
    const paired = async () => {
      const row = await this.#row();
      const cache = row ? await this.glanceFor(row) : null;
      return row && cache?.place ? { row, cache } : null;
    };
    return {
      // In memory after the first read: the notifications ask it for every reply in a desk thread (DK-T13).
      place: async () => {
        if (this.#paired === undefined) await this.#row();
        return this.#paired ?? null;
      },
      unlocked: () => this.lock.unlocked(this.#now()),
      voiceOn: async () => (await this.#row())?.voice ?? false,
      speechVoice: async () => (await this.#row())?.speechVoice ?? null,
      deskServerByName: async (name: string): Promise<DeskServer | null> => {
        const servers = (await paired())?.cache.full?.servers ?? [];
        const want = name.trim().toLowerCase();
        return servers.find((s) => s.name.toLowerCase() === want) ?? null;
      },
      // What happens in the open conversation keeps an unlocked screen unlocked; a locked one stays locked (TF-18).
      used: () => {
        this.lock.touch(this.#now());
      },
    };
  }

  /* Settings (session ops) -------------------------------------------------------------------- */

  /** The paired person's account, or null. */
  async #pairedAccount(row: DeskRow | null): Promise<string | null> {
    if (!row) return null;
    return (await loadPrincipalRow(this.services.db, row.personId))?.accountId ?? null;
  }

  /** The person's account (one-person.md OP-S77: the screen is theirs). */
  #requirePerson(principal: SessionPrincipal): string {
    if (!principal.account) throw forbidden('Only the person’s devices change the screen.');
    return principal.account.id;
  }

  /** The paired person's row. */
  async #ownRow(_principal: SessionPrincipal): Promise<DeskRow> {
    const row = await this.#row();
    if (!row) throw deskError('not_paired', DESK_WORDS.errors.not_paired);
    return row;
  }

  /** `desk.get`: what Settings shows. */
  async screen(principal: SessionPrincipal): Promise<DeskScreen> {
    const row = await this.#row();
    const pairedAccount = await this.#pairedAccount(row);
    const isPaired = !!principal.account && pairedAccount === principal.account.id;
    const now = this.#now();
    const person = row ? await loadPrincipalRow(this.services.db, row.personId) : undefined;
    const pairing = this.pairing.live(now);
    const request = isPaired ? this.lock.request(now) : null;
    const settings = settingsOf(row);
    const [display, choice, power, health, camera, name, showOptions] = await Promise.all([
      this.display.display(),
      loadScreenChoice(this.services.db),
      this.options.power?.current().catch(() => null) ?? Promise.resolve(null),
      voiceHealth(this.services).catch(() => null),
      presenceHealth(this.services),
      loadWhombatName(this.services.db).catch(() => this.#name?.value ?? null),
      // Settings' choices only while the screen is the person's (DK-106).
      isPaired && row
        ? this.#showOptions(row, settings.show).catch((err) => {
            this.services.log.warn({ err: String(err) }, 'desk: the screen’s choices weren’t read');
            return null;
          })
        : Promise.resolve(null),
    ]);
    this.#name = { value: name, at: now };
    return {
      paired:
        row && person
          ? {
              personId: person.id,
              name: screenText(person.name, 80),
              pairedAt: row.pairedAt.toISOString(),
              hasPin: row.pinHash !== null,
              self: row.pairedVia !== 'letters',
            }
          : null,
      settings,
      pairing: pairing ? { expiresAt: new Date(pairing.expiresAt).toISOString() } : null,
      unlockRequest: request
        ? { id: request.id, expiresAt: new Date(request.expiresAt).toISOString() }
        : null,
      hasDisplay: display.connected,
      display,
      on: screenOn(choice, display, row !== null),
      onChosen: choice !== null,
      hasMicrophone: !!health?.microphone,
      hasSpeaker: !!health?.speaker,
      hasBattery: power !== null,
      voiceAvailable: !!health && health.stt && health.tts,
      // The switch shows only where the camera works (DK-28, DK-31).
      presenceAvailable: presenceAvailable(camera),
      // Lock again's choices (DK-74) and the camera for the clock's switch (DK-72), where the camera works.
      lockAgain: lockAgainChoices(presenceAvailable(camera)),
      cameraWakeAvailable: presenceAvailable(camera),
      // The Voice row and Listen (DK-50, DK-51): only where the service speaks and names its voices (DK-S50).
      ...voicesMember(speakingVoices(health)),
      ...(showOptions ? { showOptions } : {}),
      whombatName: name,
    };
  }

  /**
   * Settings → Screen's lists (DK-106, DK-S123): Home's things and widgets and the fleet, read once and side by side;
   * the fleet as the glance last had it when the hosts service doesn't answer now (its servers then without a line).
   */
  async #showOptions(row: DeskRow, show: DeskShow) {
    const place = await this.placeOf(row);
    if (!place) return null;
    const viewer = { burrow: place.burrow, principal: place.person };
    const now = this.services.clock();
    const [thingList, widgets, fleet] = await Promise.all([
      things(this.services, viewer, now).catch(() => [] as ThingSummary[]),
      homeWidgetsNow(this.services.db, place.person, now).catch(() => [] as WidgetNow[]),
      deskFleet(this.services, place.burrow.id, CALM_SOURCE_WAIT_MS).catch(() => undefined),
    ]);
    const cards = fleet?.cards ?? (fleet === undefined ? (this.#cache?.full?.servers ?? []) : []);
    return deskShowOptions({
      assistant: screenText(place.agent.name, 40) || 'Your assistant',
      things: thingList,
      widgets,
      servers: cards.map((card) => ({ card, row: card.id ? fleet?.rows.get(card.id) : undefined })),
      show,
      activityLine: (catalogId) => this.#reads.sources.activityLine(catalogId),
    });
  }

  /**
   * `desk.preview` (DK-123, DK-S125): the calm glance for Settings' choices (`show`, else the saved ones) and
   * `scenario`, as the person sees it at the screen unlocked, with the top bar's name. Reads only; `not_paired` while
   * nobody paired the screen.
   */
  async preview(
    principal: SessionPrincipal,
    input: { scenario: DeskPreviewScenario; show?: DeskShow | undefined },
  ): Promise<DeskPreview> {
    const { row, cache } = await this.#calmOf(principal);
    const name = (await this.#whombatName()) ?? (screenText(cache.place.burrow.name, 40) || 'Whombat');
    return calmPreview(
      cache.calm,
      input.show ?? settingsOf(row).show,
      input.scenario,
      name,
      new Date(this.#now()),
    );
  }

  /**
   * `desk.tryOnScreen` (DK-124, DK-S126): the screen shows that preview for `DESK_TRY_S` with its banner, trimmed by the
   * lock as the glance is; kept in memory only (a restart ends it), and a touch on the screen ends it sooner.
   */
  async tryOnScreen(
    principal: SessionPrincipal,
    input: { scenario: DeskPreviewScenario; show?: DeskShow | undefined },
  ): Promise<{ until: string }> {
    const { row } = await this.#calmOf(principal);
    const until = this.#now() + DESK_TRY_S * 1_000;
    this.#sample = { scenario: input.scenario, show: input.show ?? settingsOf(row).show, until };
    return { until: new Date(until).toISOString() };
  }

  /** The paired row and its glance with the calm glance's input, or `not_paired`. */
  async #calmOf(principal: SessionPrincipal) {
    this.#requirePerson(principal);
    const row = await this.#ownRow(principal);
    const cache = await this.glanceFor(row);
    if (!cache.place) throw deskError('not_paired', DESK_WORDS.errors.not_paired);
    // A glance read whose calm part failed: gathered again for the page.
    const calm =
      cache.calm ?? (await this.#calmInput(cache.place, cache.full ?? EMPTY_GLANCE, this.services.clock()));
    return { row, cache: { ...cache, place: cache.place, calm } };
  }

  /**
   * `desk.setName` (DK-119, DK-S121): the Whombat's name for the top bar, as the app knows it from control's directory;
   * the box's, paired or not. One commit, and `desk.changed` when it changed.
   */
  async setName(principal: SessionPrincipal, input: { name: string }): Promise<DeskScreen> {
    const accountId = this.#requirePerson(principal);
    const name = input.name.trim();
    if (!name) throw new ApiError('validation_failed', 'Give the Whombat a name.');
    const res = (await this.#commit(await this.#personTarget(accountId), setDeskName, { name })) as {
      changed: boolean;
    };
    this.#name = { value: name, at: this.#now() };
    if (res.changed) await this.#changed();
    return this.screen(principal);
  }

  /** `desk.startPairing` (DK-02): four letters on the screen for 10 minutes. */
  async startPairing(principal: SessionPrincipal): Promise<{ expiresAt: string }> {
    this.#requirePerson(principal);
    const now = this.#now();
    const { expiresAt } = this.pairing.start(now);
    this.#at(expiresAt - now + 50, async () => {
      if (!this.pairing.live(this.#now())) await this.#changed();
    });
    await this.#changed();
    return { expiresAt: new Date(expiresAt).toISOString() };
  }

  /** The person who pairs the screen: theirs, where they have their Chat with the agent (OP-S77). */
  async #personTarget(accountId: string, preferBurrowId?: string): Promise<DeskTarget> {
    const person = await deskTarget(this.services.db, {
      accountId,
      ...(preferBurrowId ? { preferBurrowId } : {}),
    });
    if (!person) throw noOwnAssistant();
    return person;
  }

  /**
   * `desk.pair` (DK-02): the letters from the screen and a PIN pair it to the person who typed them. In the queue: a PIN
   * being checked for the pairing before finishes first, and the new pairing starts locked (DK-S22).
   */
  async pair(principal: SessionPrincipal, input: { code: string; pin: string }): Promise<DeskScreen> {
    const accountId = this.#requirePerson(principal);
    // A PIN too easy to guess doesn't use up the letters either (DK-27).
    checkNewPin(input.pin);
    await this.#queue(async () => {
      // Who it pairs to first: the person without an assistant here doesn't use up the letters.
      const person = await this.#personTarget(accountId);
      const checked = this.pairing.check(input.code, this.#now());
      if (!checked.ok) {
        if (checked.reason === 'expired')
          throw deskError('pairing_expired', DESK_WORDS.errors.pairing_expired);
        throw deskError('wrong_code', fillDeskWords(DESK_WORDS.errors.wrong_code, { n: checked.triesLeft }), {
          triesLeft: checked.triesLeft,
        });
      }
      const before = await this.#row();
      await this.#commit(person, pairDesk, {
        pinHash: await hashPin(input.pin),
        pinDigits: input.pin.length,
      });
      const request = this.lock.request(this.#now());
      if (before && request) await this.#clearPush(before, request);
      this.#reset();
      await this.#changed(before ? [before.personId] : []);
    });
    return this.screen(principal);
  }

  /** `desk.setPin`: the paired person's new PIN; a PIN being checked against the old one finishes first (DK-S22). */
  async setPin(principal: SessionPrincipal, input: { pin: string }): Promise<DeskScreen> {
    await this.#queue(async () => {
      const row = await this.#ownRow(principal);
      checkNewPin(input.pin);
      await this.#commit({ id: row.personId, burrowId: row.burrowId }, setDeskPin, {
        pinHash: await hashPin(input.pin),
        pinDigits: input.pin.length,
      });
      await this.#changed();
    });
    return this.screen(principal);
  }

  /**
   * `desk.update`: the paired person's settings. *Lock again* applies at once, to an unlock going on too (DK-74,
   * DK-S71): to *When you press Lock* it stays (its boot written, DK-75); from it, the change counts as a touch — the 2
   * minutes from then, or with *When you leave* the camera's rules and the camera at once. *When you leave* turned off
   * ends the lock's camera (DK-04's rule then); turned on while unlocked, it starts (DK-30, DK-S39). The camera for the
   * clock follows its switch (DK-72). In the queue (DK-S22), so the lock and the boot change in the order of the PINs
   * and the Lock button around it.
   */
  async update(principal: SessionPrincipal, input: DeskSettingsPatch): Promise<DeskScreen> {
    const row = await this.#ownRow(principal);
    // A voice the box speaks with now, else nothing changes (DK-52, DK-S51).
    if (input.speechVoice !== undefined) await this.#speakingVoice(input.speechVoice);
    this.#settling++;
    try {
      await this.#queue(async () => {
        const next = (await this.#commit(
          { id: row.personId, burrowId: row.burrowId },
          updateDesk,
          input,
        )) as DeskSettings;
        const now = this.#now();
        if (next.stayUnlocked !== this.lock.stays) this.lock.stay(next.stayUnlocked, now);
        const fresh = await this.#row();
        if (fresh) await this.#staysOnThisBoot(fresh);
      });
    } finally {
      this.#settling--;
    }
    this.#camera();
    await this.#changed();
    return this.screen(principal);
  }

  /** `voice` when the box's voice service lists it now (the health of `desk.get`'s `voices`), else `no_voice`. */
  async #speakingVoice(voice: string): Promise<void> {
    const voices = speakingVoices(await voiceHealth(this.services).catch(() => null));
    if (!voices?.includes(voice)) throw noVoice();
  }

  /**
   * `desk.voiceSample` (DK-51, DK-S54): the paired person's *Listen* — the screen's sample sentence with their
   * assistant's name, said by the box in `voice`, as a WAV in base64. Changes nothing (no command, no event); read
   * through an export stream (the answer is larger than a session message). A voice the service doesn't list, no
   * voice service, or one that is busy or fails: `no_voice`.
   */
  async voiceSample(principal: SessionPrincipal, input: { voice: string }): Promise<{ audioWav: string }> {
    const row = await this.#ownRow(principal);
    await this.#speakingVoice(input.voice);
    const port = voiceFor(this.services);
    if (!port) throw noVoice();
    const place = await this.placeOf(row);
    const assistant = screenText(place?.agent.name, 40) || 'your assistant';
    const isDutch = resolveLanguage(place?.locale) === 'nl';
    const voiceSettings = isDutch ? await loadVoiceSettings(this.services.db).catch(() => null) : null;
    const dutchReady =
      isDutch &&
      voiceSettings !== null &&
      wantsDutchVoice(voiceSettings) &&
      Boolean((await voiceHealth(this.services).catch(() => null))?.languages?.includes('nl'));
    const nlSample = `Hoi, ik ben ${assistant}. Vraag maar raak.`;
    const enSample = deskText(fillDeskWords(DESK_WORDS.settings.sample, { assistant }), VOICE_TTS_TEXT_MAX);
    let wav: Buffer;
    try {
      wav = dutchReady
        ? await port
            .tts(dutchSpeechText(nlSample), input.voice, 'nl')
            .catch(() => port.tts(enSample, input.voice))
        : await port.tts(enSample, input.voice);
    } catch (err) {
      this.services.log.warn({ err: String(err) }, 'desk: the voice sample wasn’t made');
      throw noVoice();
    }
    if (wav.length > DESK_VOICE_SAMPLE_WAV_MAX_BYTES) {
      this.services.log.warn({ bytes: wav.length }, 'desk: the voice sample is too large');
      throw noVoice();
    }
    return { audioWav: wav.toString('base64') };
  }

  /**
   * `desk.setScreen` (DK-20): *off* ends the pairing and keeps the screen off; *on* pairs it to the person without
   * letters or a PIN when a screen is connected (`no_screen` otherwise) and nobody is paired, and keeps a pairing there.
   * In the queue (DK-S22): a PIN being checked finishes first, and what follows starts locked.
   */
  async setScreen(principal: SessionPrincipal, input: { on: boolean }): Promise<DeskScreen> {
    const accountId = this.#requirePerson(principal);
    await this.#queue(async () => {
      const row = await this.#row();
      if (input.on) {
        // What is plugged in now, not a minute ago: someone just turned it on.
        if (!(await this.display.display({ fresh: true })).connected)
          throw deskError('no_screen', DESK_WORDS.errors.no_screen);
        await this.#commit(await this.#personTarget(accountId, row?.burrowId), setDeskScreen, { on: true });
        if (!row) this.#reset();
        await this.#changed();
        return;
      }
      await this.#commit(await this.#personTarget(accountId, row?.burrowId), setDeskScreen, { on: false });
      if (row) {
        const request = this.lock.request(this.#now());
        if (request) await this.#clearPush(row, request);
        this.#reset();
      }
      await this.#changed(row ? [row.personId] : []);
    });
    return this.screen(principal);
  }

  /** `desk.unpair`: now *off* (DK-20), so the screen doesn't pair itself again a minute later. */
  unpair(principal: SessionPrincipal): Promise<DeskScreen> {
    return this.setScreen(principal, { on: false });
  }

  /**
   * The screen pairs itself (DK-17) when a real screen is connected (any connected screen when the person chose *on*),
   * nobody is paired, the person didn't turn it off, and they have an assistant (`deskTarget`).
   * Signed by the burrow's Whombat signer (DK-S29); the person's assistant tells them once (DK-19). In the queue
   * (DK-S22). True when it paired.
   */
  pairItself(): Promise<boolean> {
    return this.#queue(async () => {
      // Not while a backup is restored, nor once somebody is paired.
      if (this.#closed || this.services.maintenance.paused || (await this.#row())) return false;
      const choice = await loadScreenChoice(this.services.db);
      if (choice === false) return false;
      const display = await this.display.display();
      if (!(choice === true ? display.connected : display.real)) return false;
      const target = await deskTarget(this.services.db);
      if (!target) return false;
      const signer = await serversPrincipal(this.services, target.burrowId);
      const res = await this.services.pipeline.commit(
        pairDeskItself,
        { personId: target.id },
        { burrowId: target.burrowId, actorId: signer },
      );
      if (res.status !== 'ok' || !(res.result as { paired: boolean }).paired) return false;
      this.#reset();
      await this.#changed();
      this.services.background.run('desk: paired itself', () =>
        tellPerson(this.services, target.burrowId, target.id, DESK_WORDS.settings.selfPaired),
      );
      // The moment the person has an assistant (desk-found.md DF-02): Found on your network looks now.
      foundScansFor(this.services).kick();
      return true;
    });
  }

  /** `desk.answerUnlock` (DK-04): the paired person's Unlock or No from their phone or the web (in the queue, DK-S22). */
  answerUnlock(principal: SessionPrincipal, input: { id: string; unlock: boolean }): Promise<{ ok: true }> {
    return this.#queue(async () => {
      const row = await this.#ownRow(principal);
      const now = this.#now();
      const request = this.lock.take(input.id, now);
      if (!request) throw deskError('request_expired', DESK_WORDS.errors.request_expired);
      if (input.unlock) {
        this.lock.unlock(now, row.stayUnlocked);
        this.#camera();
        await this.#staysOnThisBoot(row);
      }
      await this.#clearPush(row, request);
      await this.#changed();
      return { ok: true as const };
    });
  }

  /* The screens of widgets (DK-126…DK-149) ---------------------------------------------------------------------- */

  /** A burrow's screens: read again with the glance's age, or after a change here. */
  async #screenList(burrowId: string): Promise<ScreenRecord[]> {
    const now = this.#now();
    const kept = this.#screenLists.get(burrowId);
    if (kept && now - kept.at < GLANCE_MAX_AGE_MS) return kept.list;
    const list = await this.#store.list(burrowId);
    this.#screenLists.set(burrowId, { at: now, list });
    return list;
  }

  /** A screen was changed here: read again at the next state, and Settings hears it. */
  async #screensChanged(burrowId: string): Promise<void> {
    this.#screenLists.delete(burrowId);
    await this.#changed();
  }

  /** The draft a screen shows while *Try on the screen* lasts (DK-143), else none. */
  #tryingOf(id: string, now: number): { layout: DeskLayout; until: number } | null {
    const trying = this.#trying.get(id);
    if (trying && trying.until > now) return trying;
    if (trying) this.#trying.delete(id);
    return null;
  }

  /** Whose screen it is, as its widgets read: the person's burrow, them, their zone, their assistant's name. */
  #widgetCtx(place: DeskPlace, now: Date): WidgetCtx {
    return {
      services: this.services,
      viewer: { accountId: place.accountId, burrowId: place.burrow.id, principal: place.person },
      now,
      timeZone: place.timeZone,
      ...(place.locale ? { locale: place.locale } : {}),
      assistant: screenText(place.agent.name, 40) || 'Your assistant',
    };
  }

  #factsOf(cache: GlanceCache, place: DeskPlace, now: Date): GlanceFacts | null {
    return glanceFacts(cache.full, cache.calm, startOfLocalDay(now, place.timeZone).getTime());
  }

  /**
   * A screen's grid now (DK-142): its layout or the draft it tries, its distinct widgets resolved (never read ones waited
   * for at most `waitMs`), trimmed by the lock, what needs the person for its pop-ups. Null when it isn't one the screen
   * takes (logged).
   */
  async #gridFor(
    record: ScreenRecord,
    view: DeskCalmView,
    ctx: WidgetCtx,
    facts: GlanceFacts | null,
    calm: DeskCalmInput | null,
    waitMs: number,
  ): Promise<DeskGrid | null> {
    const trying = this.#tryingOf(record.id, ctx.now.getTime());
    const layout = trying?.layout ?? record.layout;
    const spotlight = this.#spotlights.of(record.id, ctx.now.getTime());
    const specs = withSpotlight(deskLayoutWidgets(layout), spotlight, DESK_SCREEN_VIEWS_MAX);
    const resolved =
      view === 'time' ? new Map<string, Resolved>() : await this.#resolver.resolve(ctx, specs, facts, waitMs);
    const warn = (message: string, detail: unknown) =>
      this.services.log.warn(
        { screen: record.id, detail: String(JSON.stringify(detail) ?? detail) },
        message,
      );
    const views = screenViews(specs, resolved, view, (message, id) => warn(message, id), ctx.locale);
    this.#rememberShown(record.id, view, ctx.now.getTime(), views);
    return screenGrid({
      record,
      layout,
      trying: trying?.until ?? null,
      spotlight,
      views,
      calm,
      view,
      warn,
    });
  }

  /**
   * The box's own screen and each monitor's (DK-128, DK-147) for the state: none in *Only the time* (the console draws
   * the clock). The box's choices are the paired screen's; a monitor only while the page reports it. Widgets never read
   * have no view yet: the state never waits for them.
   */
  async #boxGrids(
    cache: GlanceCache,
    place: DeskPlace,
    show: DeskShow,
    view: DeskCalmView,
  ): Promise<{ grid?: DeskGrid; outputs?: { key: string; name: string | null; grid: DeskGrid }[] }> {
    if (view === 'time') return {};
    const burrowId = place.burrow.id;
    const list = await this.#screenList(burrowId);
    const now = this.services.clock();
    const ctx = this.#widgetCtx(place, now);
    const facts = this.#factsOf(cache, place, now);
    const box = list.find((r) => r.kind === 'box') ?? defaultBoxRecord(burrowId, show, place.person.id);
    const grid = await this.#gridFor({ ...box, show }, view, ctx, facts, cache.calm, 0);
    const outputs: { key: string; name: string | null; grid: DeskGrid }[] = [];
    for (const o of this.#outputs?.list ?? []) {
      const record = !o.main ? list.find((r) => r.id === o.id) : undefined;
      if (!record) continue;
      const g = await this.#gridFor(record, view, ctx, facts, cache.calm, 0);
      if (g) outputs.push({ key: o.key, name: o.name, grid: g });
    }
    return { ...(grid ? { grid } : {}), ...(outputs.length > 0 ? { outputs } : {}) };
  }

  /**
   * `POST /v1/desk/size` (DK-129, DK-147): the outputs the page shows on. The first main one (else the first) is the
   * box's own screen, every other a monitor's, made the first time it's seen; their sizes are kept. Paired or not: the
   * screens are the box's. A write that fails keeps what the page said for the grids.
   */
  async size(outputs: DeskSizeRequest['outputs']): Promise<DeskAck> {
    const mainAt = Math.max(
      0,
      outputs.findIndex((o) => o.main),
    );
    const list: ReportedOutput[] = outputs.flatMap((o, i) => {
      const id = i === mainAt ? DESK_SCREEN_BOX : outputScreenId(o.key);
      return id ? [{ key: o.key, id, main: i === mainAt, name: o.name, size: o.size }] : [];
    });
    const row = await this.#row();
    const burrowId = row?.burrowId ?? (await deskTarget(this.services.db))?.burrowId ?? null;
    const said = (l: readonly ReportedOutput[]) =>
      JSON.stringify(l.map((o) => [o.id, o.name, o.size.width, o.size.height]));
    const moved = !this.#outputs || said(this.#outputs.list) !== said(list);
    this.#outputs = { burrowId, list };
    if (burrowId) {
      await this.#store
        .reportOutputs(burrowId, list)
        .catch((err) =>
          this.services.log.warn({ err: String(err) }, 'desk: the screens’ sizes weren’t kept'),
        );
      this.#screenLists.delete(burrowId);
      // Settings → Screens shows a monitor plugged in, and the editor the screen's new shape.
      if (moved) await this.#changed();
    }
    return { v: 1 };
  }

  /**
   * `POST /v1/desk/image` (DK-142): a picture a widget of the box's own screen or a monitor's names, as the paired
   * person may see it, only where the lock lets that widget show it. Every refusal is the same `not_found`.
   */
  async image(thing: string, ref: string): Promise<{ type: string; bytes: Uint8Array }> {
    const none = () => new DeskRefused(404, 'not_found', 'There is no such picture.');
    const row = await this.#row();
    if (!row) throw none();
    const view = this.lock.unlocked(this.#now()) ? 'everything' : settingsOf(row).lockedView;
    const list = await this.#screenList(row.burrowId).catch(() => [] as ScreenRecord[]);
    const shown = new Set([DESK_SCREEN_BOX, ...(this.#outputs?.list ?? []).map((o) => o.id)]);
    const records = list.filter((r) => shown.has(r.id));
    if (!records.some((r) => r.kind === 'box'))
      records.unshift(defaultBoxRecord(row.burrowId, settingsOf(row).show, row.personId));
    for (const record of records) {
      const picture = await this.#picture(record, view, thing, ref, row.personId).catch(() => null);
      if (picture) return picture;
    }
    throw none();
  }

  /**
   * The place a screen is drawn for: the paired person's for the box's own, else whoever added it, else the person. A
   * device's screen only ever for whoever added it: none once they're gone.
   */
  async #placeFor(
    record: ScreenRecord,
    personId?: string,
  ): Promise<{ cache: GlanceCache; place: DeskPlace } | null> {
    const who = await this.#whoFor(record, personId);
    if (!who) return null;
    const cache = await this.glanceFor({ burrowId: record.burrowId, personId: who });
    return cache.place ? { cache, place: cache.place } : null;
  }

  /** Whom a screen is drawn for (`#placeFor`'s rule): null for a device's screen whose person is gone. */
  async #whoFor(record: ScreenRecord, personId?: string): Promise<string | null> {
    if (record.kind === 'device' && !record.personId) return null;
    const paired = await this.#row();
    return (
      personId ??
      (record.kind !== 'device' && paired?.burrowId === record.burrowId ? paired.personId : null) ??
      record.personId ??
      (await thePerson(this.services.db, record.burrowId))?.id ??
      null
    );
  }

  /**
   * The time zone a screen is drawn in: its person's own, else the Whombat's; null without a person. Kept a minute per
   * screen: a screen elsewhere asks every few seconds.
   */
  async #zoneFor(record: ScreenRecord): Promise<string | null> {
    const now = this.#now();
    const kept = this.#zones.get(record.id);
    if (kept && now - kept.at < ZONE_KEPT_MS) return kept.zone;
    const who = await this.#whoFor(record);
    const zone = who
      ? ((await this.placeOf({ burrowId: record.burrowId, personId: who }))?.timeZone ?? null)
      : null;
    if (this.#zones.size >= 64) this.#zones.clear();
    this.#zones.set(record.id, { at: now, zone });
    return zone;
  }

  /**
   * The doorbell rang: each of its Whombat's screens whose choice is *Show it big* shows the doorbell's camera
   * for a minute; the box's own sees it at its next state (every second), a screen elsewhere at its next ask.
   */
  async #ring(ring: DoorbellRing): Promise<void> {
    if (this.#closed) return;
    const list = await this.#store.list(ring.burrowId);
    const shown = new Set(this.#spotlights.ring(ring, list, this.#now()));
    // The camera's picture is read now for whom the screens are drawn, so the next state has it.
    const people = new Set<string>();
    for (const record of list.filter((r) => shown.has(r.id))) {
      const who = await this.#whoFor(record);
      if (!who || people.has(who)) continue;
      people.add(who);
      const place = await this.placeOf({ burrowId: record.burrowId, personId: who });
      const spotlight = this.#spotlights.of(record.id, this.#now());
      if (place && spotlight)
        void this.#resolver
          .resolve(this.#widgetCtx(place, this.services.clock()), [spotlight.widget], null, 0)
          .catch(() => undefined);
    }
  }

  /** `ScreensApi.draw`: what a screen elsewhere draws now for what its lock lets show. */
  async #draw(record: ScreenRecord, view: DeskCalmView): Promise<{ calm: DeskCalm; grid: DeskGrid }> {
    const at = await this.#placeFor(record);
    if (!at) throw new ApiError('not_found', 'There’s nobody to show this screen for.');
    const now = this.services.clock();
    const input = at.cache.calm ?? (await this.#calmInput(at.place, at.cache.full ?? EMPTY_GLANCE, now));
    const calm = calmNow(input, record.show, view, now);
    if (!calm) throw new Error('desk: the calm glance isn’t one the screen takes');
    const ctx = this.#widgetCtx(at.place, now);
    const facts = this.#factsOf(at.cache, at.place, now);
    const grid =
      (await this.#gridFor(record, view, ctx, facts, input, SCREEN_DRAW_WAIT_MS)) ??
      (await this.#gridFor(record, 'time', ctx, null, null, 0));
    if (!grid) throw new Error('desk: the screen’s grid isn’t one the screen takes');
    return { calm, grid };
  }

  /** The pictures a screen's views name now, kept with the lock view they were drawn for. */
  #rememberShown(
    id: string,
    view: DeskCalmView,
    at: number,
    views: readonly DeskWidgetView[],
  ): ReadonlySet<string> {
    const pictures = viewPictures(views);
    if (this.#shown.size >= 64 && !this.#shown.has(id)) this.#shown.clear();
    this.#shown.set(id, { view, at, pictures });
    return pictures;
  }

  /**
   * Whether the screen's views, as its lock lets it show them now, name this picture: those it was last drawn with (for
   * the same lock view, within `SCREEN_PICTURES_FRESH_MS`), else those worked out now from what's kept.
   */
  async #shows(
    record: ScreenRecord,
    view: DeskCalmView,
    at: { cache: GlanceCache; place: DeskPlace },
    key: string,
  ): Promise<boolean> {
    const now = this.services.clock();
    const kept = this.#shown.get(record.id);
    const age = kept && kept.view === view ? now.getTime() - kept.at : Number.POSITIVE_INFINITY;
    if (kept && age < SCREEN_PICTURES_FRESH_MS && kept.pictures.has(key)) return true;
    if (age < SCREEN_PICTURES_AGAIN_MS) return false;
    const trying = this.#tryingOf(record.id, now.getTime());
    const specs = withSpotlight(
      deskLayoutWidgets(trying?.layout ?? record.layout),
      this.#spotlights.of(record.id, now.getTime()),
      DESK_SCREEN_VIEWS_MAX,
    );
    const ctx = this.#widgetCtx(at.place, now);
    const resolved = await this.#resolver.resolve(ctx, specs, this.#factsOf(at.cache, at.place, now), 0);
    return this.#rememberShown(
      record.id,
      view,
      now.getTime(),
      screenViews(specs, resolved, view, undefined, ctx.locale),
    ).has(key);
  }

  /**
   * A picture the screen shows now (DK-142): one of its views, as its lock lets it show them now, names exactly this
   * thing and ref (a locked screen's private widgets name none), the person may see the thing and the ref is signed for
   * it (`thingPicture`). Null otherwise.
   */
  async #picture(
    record: ScreenRecord,
    view: DeskCalmView,
    thing: string,
    ref: string,
    personId?: string,
  ): Promise<{ type: string; bytes: Uint8Array } | null> {
    if (view === 'time') return null;
    const at = await this.#placeFor(record, personId);
    if (!at) return null;
    if (!(await this.#shows(record, view, at, pictureKey(thing, ref)))) return null;
    const viewer = {
      accountId: at.place.accountId,
      burrowId: at.place.burrow.id,
      principal: at.place.person,
    };
    const picture = await (this.options.picture ?? thingPicture)(this.services, viewer, thing, ref).catch(
      () => null,
    );
    return picture ? { type: picture.contentType, bytes: new Uint8Array(picture.bytes) } : null;
  }

  /** The person's burrow and them, for Settings → Screens (the screens are theirs, OP-S77). */
  async #screensTarget(principal: SessionPrincipal): Promise<DeskTarget> {
    const accountId = this.#requirePerson(principal);
    return this.#personTarget(accountId, this.#paired?.burrowId);
  }

  async #recordOf(target: DeskTarget, id: string): Promise<ScreenRecord> {
    const record = await this.#store.get(target.burrowId, id);
    if (!record) throw unknownScreen();
    return record;
  }

  /** Whether the box's own screen shows now (*Show Whombat on this screen*, DK-20). */
  async #boxOn(): Promise<boolean> {
    const [display, choice, row] = await Promise.all([
      this.display.display(),
      loadScreenChoice(this.services.db),
      this.#row(),
    ]);
    return screenOn(choice, display, row !== null);
  }

  /** A screen's summary: the box's size as its page last said when nothing was kept yet. */
  #summary(record: ScreenRecord, boxOn: boolean) {
    const reported = this.#outputs?.list.find((o) => o.id === record.id)?.size ?? null;
    return screenSummary(record, screenOnline(record, this.#now(), boxOn), record.size ?? reported);
  }

  /** `desk.screens` (DK-128): every screen, the box's own first, then monitors, then devices; whether one can be added. */
  async screensList(principal: SessionPrincipal): Promise<DeskScreensList> {
    const target = await this.#screensTarget(principal);
    const [list, boxOn, doorbell] = await Promise.all([
      this.#store.list(target.burrowId),
      this.#boxOn(),
      followsDoorbell(this.services, target.burrowId).catch(() => false),
    ]);
    const others = list.filter((r) => r.kind !== 'box').length;
    return {
      screens: list.map((r) => this.#summary(r, boxOn)),
      canAdd: others < DESK_SCREENS_MAX,
      ...(doorbell ? { doorbell } : {}),
    };
  }

  /** `desk.screen.get`: one screen with its layout and choices. */
  async screenGet(principal: SessionPrincipal, input: { screen: string }): Promise<DeskScreenDetail> {
    const target = await this.#screensTarget(principal);
    const record = await this.#recordOf(target, input.screen);
    return screenDetailFor(
      screenDetail(this.#summary(record, record.kind === 'box' ? await this.#boxOn() : false), record),
      principal.protocolMinor,
    );
  }

  /**
   * A layout the screen can keep (DK-131): the contract's rules, and every widget within its sizes — a panel's by the
   * view it draws, as last read.
   */
  async #checkLayout(target: DeskTarget, layout: DeskLayout): Promise<void> {
    const panels = deskLayoutWidgets(layout).filter((w) => w.type === 'panel');
    let kinds = new Map<string, string>();
    if (panels.length > 0) {
      const at = await this.glanceFor({ burrowId: target.burrowId, personId: target.id });
      if (at.place) {
        const resolved = await this.#resolver.resolve(
          this.#widgetCtx(at.place, this.services.clock()),
          panels,
          null,
          0,
        );
        kinds = new Map(
          [...resolved].flatMap(([id, r]) => (r.view.problem ? [] : [[id, r.view.kind] as [string, string]])),
        );
      }
    }
    const refusal = layoutRefusal(layout, (id) => kinds.get(id));
    if (refusal) throw badLayout(refusal);
  }

  /**
   * `desk.screen.update` (DK-128, DK-137, DK-143, DK-144): any of a screen's name (not the box's own), pop-ups, layout
   * and choices, one commit; the box's own choices are the paired screen's (`update_desk`, `not_paired` while nobody
   * paired it). `desk.changed` after.
   */
  async screenUpdate(
    principal: SessionPrincipal,
    input: {
      screen: string;
      name?: string;
      popups?: 'all' | 'problems' | 'none';
      doorbell?: 'big' | 'off';
      layout?: DeskLayout;
      show?: DeskShowPatch;
    },
  ): Promise<DeskScreenDetail> {
    const target = await this.#screensTarget(principal);
    const record = await this.#recordOf(target, input.screen);
    // An app that can't read a page's times sends its pages without them, and one from before the weather and the news
    // without those widgets: both stay as they were.
    const older = principal.protocolMinor !== undefined && principal.protocolMinor < SCREEN_TIMES_MINOR;
    const timed = input.layout && older ? keepPageTimes(input.layout, record.layout) : input.layout;
    const layout = timed ? withHiddenWidgets(timed, record.layout, principal.protocolMinor) : undefined;
    if (layout) await this.#checkLayout(target, layout);
    const box = record.kind === 'box';
    if (box && input.show) await this.update(principal, { show: input.show });
    const name = !box && input.name !== undefined ? input.name.trim() : undefined;
    if (input.name !== undefined && !box && !name)
      throw new ApiError('validation_failed', 'Give the screen a name.');
    const changes = {
      ...(name ? { name } : {}),
      ...(input.popups ? { popups: input.popups } : {}),
      ...(input.doorbell ? { doorbell: input.doorbell } : {}),
      ...(layout ? { layout } : {}),
      ...(!box && input.show ? { show: applyDeskShowPatch(record.show, input.show) } : {}),
    };
    if (Object.keys(changes).length > 0) {
      await this.#commit(target, updateScreen, { id: record.id, ...changes });
      // What was tried is saved now, or replaced by what was.
      if (layout) this.#trying.delete(record.id);
      // *Don’t*: a moment showing now ends too.
      if (input.doorbell === 'off') this.#spotlights.forget(record.id);
      await this.#screensChanged(target.burrowId);
    }
    return this.screenGet(principal, { screen: record.id });
  }

  /**
   * `desk.screen.addPage`: the assistant's “make me a page”. Each widget asked must be one *Add a widget*
   * offers (else it's left out, `unknown`); they go on a new page in the order asked, on the screen's shape as it last
   * said its size, each at its asked size within its limits (`placePage`; what doesn't fit is left out, `no_room`). A
   * seventh page is refused unless it replaces one. One commit, as the editor's Save.
   */
  async screenAddPage(
    principal: SessionPrincipal,
    input: DeskScreenAddPageInput,
  ): Promise<DeskScreenAddPageOutput> {
    const target = await this.#screensTarget(principal);
    const record = await this.#recordOf(target, input.screen);
    const name = input.name.replace(/\s+/g, ' ').trim();
    if (!name) throw new ApiError('validation_failed', 'Give the page a name.');
    for (const [i, w] of input.widgets.entries()) {
      const problem = deskWidgetSpecProblem({ type: w.type, ref: w.ref, opts: w.opts ?? {} });
      if (problem) throw badLayout(`widget ${i + 1}: ${problem}`);
    }
    const place = await this.placeOf({ burrowId: target.burrowId, personId: target.id });
    if (!place) throw noOwnAssistant();
    const ctx = this.#widgetCtx(place, this.services.clock());
    const groups = await this.#catalogOf(ctx, input.widgets);
    const asked = input.widgets.map((w) => ({ w, item: catalogItemFor(groups, w) }));
    const known = asked.filter((a) => a.item !== null);
    const size =
      record.size ?? this.#outputs?.list.find((o) => o.id === record.id)?.size ?? DEFAULT_SCREEN_SIZE;
    const grid = gridOfScreen(size.width, size.height, record.layout.size);
    const placed = placePage({
      layout: record.layout,
      shape: { cols: grid.cols, rows: grid.rows },
      name,
      widgets: known.map(({ w, item }) => ({
        ...w,
        opts: { ...(item?.opts ?? {}), ...(w.opts ?? {}) },
        view: item?.view,
      })),
      show: input.show,
      replace: input.replace,
    });
    if (!placed.ok)
      throw badLayout(
        placed.why === 'pages_full'
          ? 'a screen has at most 6 pages: replace one'
          : `no page ${input.replace ?? ''} on this screen`,
      );
    const views = new Map(placed.ids.map((id, i) => [id, known[i]?.item?.view]));
    const refusal = layoutRefusal(placed.layout, (id) => views.get(id) ?? undefined);
    if (refusal) throw badLayout(refusal);
    await this.#commit(target, updateScreen, { id: record.id, layout: placed.layout });
    await this.#screensChanged(target.burrowId);
    const noRoom = new Set(known.filter((_, i) => placed.ids[i] === null).map((k) => k.w));
    const left = asked.flatMap(({ w, item }) => {
      if (item && !noRoom.has(w)) return [];
      const named = item ? screenText(item.name, 60) : '';
      return [
        {
          type: w.type,
          ...(w.ref ? { ref: w.ref } : {}),
          ...(named ? { name: named } : {}),
          why: item ? ('no_room' as const) : ('unknown' as const),
        },
      ];
    });
    return { screen: record.id, page: placed.page, left };
  }

  /**
   * What *Add a widget* offers for the widgets asked: Whombat's own always, the servers when one is asked, each thing
   * and account asked (its page read now) and Home's widgets when one is asked.
   */
  async #catalogOf(ctx: WidgetCtx, widgets: readonly AskedWidget[]): Promise<DeskCatalogGroup[]> {
    const refs = [...new Set(widgets.flatMap((w) => (w.ref ? [w.ref] : [])))].slice(0, 24);
    const things = refs.filter((r) => /^(connection|device|account):/.test(r));
    const warn = (what: string) => (err: unknown) => {
      this.services.log.warn({ err: String(err) }, `desk: ${what} weren’t listed for a new page`);
      return [] as DeskCatalogGroup[];
    };
    const [fleet, thingGroups, homeWidgets] = await Promise.all([
      refs.some((r) => r.startsWith('server:'))
        ? deskFleet(this.services, ctx.viewer.burrowId, CALM_SOURCE_WAIT_MS).catch(() => null)
        : null,
      Promise.all(
        things.map((ref) =>
          (isAccountRef(ref as DeskWidgetRef)
            ? this.#resolver.accounts.groups(ctx, ref as DeskWidgetRef)
            : this.#things.groups(ctx, ref as DeskWidgetRef)
          ).catch(warn(ref)),
        ),
      ),
      refs.some((r) => r.startsWith('widget:'))
        ? screenHomeWidgets(this.services.db, ctx.viewer.principal, ctx.now).catch(
            () => [] as ScreenHomeWidget[],
          )
        : ([] as ScreenHomeWidget[]),
    ]);
    const home = homeWidgetsGroup(homeWidgets, ctx.assistant);
    return [ownGroup(ctx.assistant), ...serverGroups(fleet), ...thingGroups.flat(), ...(home ? [home] : [])];
  }

  /**
   * `desk.screen.views` (DK-143): the views of any widgets as that screen would draw them now, unlocked, with the calm
   * glance and what needs the person — for Settings' scenario when given (`deskPreviewInput`). Widgets never read are
   * waited for a moment.
   */
  async screenViews(
    principal: SessionPrincipal,
    input: { screen: string; widgets: DeskWidgetSpec[]; scenario?: DeskPreviewScenario | undefined },
  ): Promise<DeskScreenViews> {
    const target = await this.#screensTarget(principal);
    const record = await this.#recordOf(target, input.screen);
    const cache = await this.glanceFor({ burrowId: target.burrowId, personId: target.id });
    const place = cache.place;
    if (!place) throw noOwnAssistant();
    const now = this.services.clock();
    const real = cache.calm ?? (await this.#calmInput(place, cache.full ?? EMPTY_GLANCE, now));
    const name = (await this.#whombatName()) ?? (screenText(place.burrow.name, 40) || 'Whombat');
    const preview = calmPreview(real, record.show, input.scenario ?? 'now', name, now);
    const input2 = input.scenario
      ? deskPreviewInput({ ...real, now }, record.show, input.scenario, DESK_CALM_WORDS)
      : { ...real, now };
    const specs = input.widgets.slice(0, DESK_SCREEN_VIEWS_MAX);
    const widgetCtx = this.#widgetCtx(place, now);
    const resolved = await this.#resolver.resolve(
      widgetCtx,
      specs,
      this.#factsOf(cache, place, now),
      SCREEN_VIEWS_WAIT_MS,
    );
    return {
      name: preview.name,
      calm: preview.calm,
      views: viewsFor(
        screenViews(specs, resolved, 'everything', undefined, widgetCtx.locale),
        principal.protocolMinor,
      ),
      attention: deskAttentionFor(input2, record.show, 'everything', record.popups),
    };
  }

  /**
   * `desk.screen.try` (DK-143): that screen shows the draft for `DESK_TRY_S`, then its own again. Memory only: a restart
   * ends it. Touching the screen doesn't end it, so the person can turn its pages.
   */
  async screenTry(
    principal: SessionPrincipal,
    input: { screen: string; layout: DeskLayout },
  ): Promise<{ until: string }> {
    const target = await this.#screensTarget(principal);
    const record = await this.#recordOf(target, input.screen);
    const layout = withHiddenWidgets(input.layout, record.layout, principal.protocolMinor);
    await this.#checkLayout(target, layout);
    const until = this.#now() + DESK_TRY_S * 1_000;
    this.#trying.set(record.id, { layout, until });
    return { until: new Date(until).toISOString() };
  }

  /**
   * `desk.screen.remove` (DK-146, DK-147): a device's screen ends at once (its endpoint revoked); a monitor's forgets
   * its layout and starts over when it's seen again. The box's own can't be removed.
   */
  async screenRemove(principal: SessionPrincipal, input: { screen: string }): Promise<{ ok: true }> {
    const target = await this.#screensTarget(principal);
    const record = await this.#recordOf(target, input.screen);
    if (record.kind === 'box')
      throw new ApiError('not_allowed', 'This Whombat’s own screen can’t be removed.');
    if (record.kind === 'device')
      await revokeScreenDevice(this.services, record, {
        ...target,
        endpointId: principal.endpoint?.id ?? null,
      });
    else await this.#commit(target, forgetScreen, { id: record.id });
    this.#trying.delete(record.id);
    this.#spotlights.forget(record.id);
    await this.#screensChanged(target.burrowId);
    return { ok: true };
  }

  /**
   * `desk.widgets` (DK-139): *Add a widget* — Whombat's own, the servers, the connections and devices, the widgets made
   * for Home; with `thing`, only that thing's (its page read now).
   */
  async widgets(
    principal: SessionPrincipal,
    input: { screen: string; thing?: DeskWidgetRef },
  ): Promise<DeskCatalog> {
    const target = await this.#screensTarget(principal);
    await this.#recordOf(target, input.screen);
    const place = await this.placeOf({ burrowId: target.burrowId, personId: target.id });
    if (!place) throw noOwnAssistant();
    const now = this.services.clock();
    const ctx = this.#widgetCtx(place, now);
    if (input.thing) {
      const groups = isAccountRef(input.thing)
        ? await this.#resolver.accounts.groups(ctx, input.thing)
        : await this.#things.groups(ctx, input.thing);
      return { groups: catalogFor(groups.slice(0, 200), principal.protocolMinor) };
    }
    const [fleet, thingGroups, accountGroups, homeWidgets] = await Promise.all([
      deskFleet(this.services, place.burrow.id, CALM_SOURCE_WAIT_MS).catch(() => null),
      this.#things.groups(ctx).catch((err) => {
        this.services.log.warn({ err: String(err) }, 'desk: the things’ widgets weren’t listed');
        return [];
      }),
      this.#resolver.accounts.groups(ctx).catch((err) => {
        this.services.log.warn({ err: String(err) }, 'desk: the accounts’ widgets weren’t listed');
        return [];
      }),
      screenHomeWidgets(this.services.db, place.person, now).catch(() => [] as ScreenHomeWidget[]),
    ]);
    return {
      groups: catalogFor(
        deskCatalog({
          assistant: ctx.assistant,
          fleet,
          things: thingGroups,
          accounts: accountGroups,
          widgets: homeWidgets,
        }),
        principal.protocolMinor,
      ),
    };
  }

  /* Helpers ----------------------------------------------------------------------------------- */

  async #commit<S extends CommandDef>(
    actor: { id: string; burrowId: string },
    command: S,
    input: unknown,
  ): Promise<unknown> {
    const res = await this.services.pipeline.commit(command, input, {
      burrowId: actor.burrowId,
      actorId: actor.id,
    });
    if (res.status !== 'ok') throw new ApiError('forbidden', res.message);
    return res.result;
  }

  /** A command as the paired person, for what the screen did (a PIN): their removal reads as not paired. */
  async #commitAs(row: DeskRow, command: CommandDef, input: unknown): Promise<unknown> {
    try {
      return await this.#commit({ id: row.personId, burrowId: row.burrowId }, command, input);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'forbidden' || err.code === 'not_found'))
        throw notPaired();
      throw err;
    }
  }

  /** Takes the phone's notification away once the request is answered or over. */
  async #clearPush(row: DeskRow, request: UnlockRequest): Promise<void> {
    const accountId = await this.#pairedAccount(row);
    if (!accountId) return;
    await this.options.push
      ?.forAccounts([accountId], 'security', unlockPushWhat(request.id), {
        group: unlockPushWhat(request.id),
        clear: true,
      })
      .catch((err) => this.services.log.warn({ err: String(err) }, 'desk: the unlock push wasn’t cleared'));
  }

  #at(ms: number, fn: () => Promise<void>): void {
    if (this.#closed) return;
    const timer = setTimeout(
      () => {
        this.#timers.delete(timer);
        fn().catch((err) => this.services.log.warn({ err: String(err) }, 'desk: a timer failed'));
      },
      Math.max(0, Math.min(ms, 86_400_000)),
    );
    timer.unref?.();
    this.#timers.add(timer);
  }

  /** `desk.changed` to the person (and `extra`, a person paired before). */
  async #changed(extra: string[] = []): Promise<void> {
    const row = await this.#row();
    const burrow =
      row?.burrowId ?? (await this.services.db.select({ id: burrows.id }).from(burrows).limit(1))[0]?.id;
    const person = burrow ? await thePerson(this.services.db, burrow) : null;
    const people = new Set([...(person ? [person.id] : []), ...extra, ...(row ? [row.personId] : [])]);
    const at = this.services.clock().toISOString();
    for (const id of people)
      this.services.bus.publish({
        topic: topics.me(id),
        event: { type: 'desk.changed' },
        eventId: null,
        at,
        outboxId: null,
      });
  }
}
