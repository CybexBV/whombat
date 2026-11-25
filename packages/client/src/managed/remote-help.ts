/**
 * Remote help (Whombat remote-help.md RH-01…RH-13; app docs/decisions/remote-help.md AP-4440…): the person lets Whombat
 * support into this Whombat for a while, sees who is connected and what they did, and stops it. Shared by the web and
 * the phone, which bring only their UI, their `PasskeyPlatform` and the no-passkey dialog:
 *
 * - `remoteHelpApi(session)`: the `remoteHelp.*` ops as one object (or the fake world's, `createFakeRemoteHelp`).
 * - `turnOnRemoteHelp`: the confirmation (RH-04). The Whombat begins it for this exact choice; with a passkey the
 *   challenge is **recomputed before anything is signed** (`passkeyRemoteHelpChallenge` of the nonce, this device's
 *   key, the level and the duration) and a mismatch signs nothing; without a passkey the person confirms in a dialog.
 * - `remoteHelpCard`, `remoteHelpVisitRows`: what the card shows (off, on, not available) and “What support did”.
 * - `remoteHelpErrorText`: a refusal in the brief's words.
 */
import {
  fillRemoteHelpWords,
  formatHelpCode,
  REMOTE_HELP_DURATIONS,
  REMOTE_HELP_LEVELS,
  REMOTE_HELP_WORDS,
  type RemoteHelpDuration,
  type RemoteHelpLevel,
  remoteHelpRefusalText,
  remoteHelpStateLine,
  remoteHelpStepText,
} from '@whombat/core/domain';
import { daysAgo, formatClock, formatDate } from '@whombat/core/text';
import {
  passkeyRemoteHelpChallengeBase64url,
  type RemoteHelpState,
  type RemoteHelpStep,
  type RemoteHelpVisit,
  remoteHelpTranscriptName,
} from '@whombat/protocol/session';
import { NeedsNewerAppError } from '../http/errors';
import { OperationError, type RemoteHelpConfirmBegin, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import {
  canonicalAssertion,
  operationReason,
  type PasskeyAssertionJSON,
  PasskeyCancelled,
  PasskeyError,
  type PasskeyPlatform,
  type PasskeyRequestOptionsJSON,
} from './passkeys';

// What the screens use of the contract (contracts 0.120: `@whombat/core/domain`, `@whombat/protocol/session`).
export {
  formatHelpCode,
  REMOTE_HELP_WORDS,
  type RemoteHelpDuration,
  type RemoteHelpLevel,
  remoteHelpConfirmText,
  remoteHelpStateLine,
} from '@whombat/core/domain';
export type { RemoteHelpState, RemoteHelpStep, RemoteHelpVisit } from '@whombat/protocol/session';

const W = REMOTE_HELP_WORDS;

/** What the owner picks: how much, for how long. */
export interface RemoteHelpChoice {
  level: RemoteHelpLevel;
  duration: RemoteHelpDuration;
}

/** The card's first choice (the sketch's): Look, for 1 day. */
export const REMOTE_HELP_DEFAULT_CHOICE: RemoteHelpChoice = { level: 'look', duration: 'day' };

/** How often the card asks again while remote help is on or someone is connected (RH-07: steps come as they happen). */
export const REMOTE_HELP_POLL_MS = 10_000;

/** The app's own words around the brief's (AP-4446): only where §4 says nothing. */
export const REMOTE_HELP_TEXT = {
  /** The owner has a passkey, and this device can't use passkeys at all. */
  passkeyHere: 'This device can’t use your passkey. Turn remote help on from a device that can.',
  /** A visit with more steps than are shown (`truncated`): the oldest are left out. */
  earlier: 'Earlier steps aren’t shown.',
  /** A transcript that didn't load. */
  transcriptFailed: 'Couldn’t load the command line. Try again.',
  /** The card's state or list didn't load. */
  loadError: 'Couldn’t load remote help. Try again.',
  retry: 'Try again',
  failed: 'That didn’t work. Try again.',
  /** The transcript modal's other button. */
  close: 'Close',
  /** Accessible names. */
  onLabel: 'Remote help is on',
  connectedLabel: 'Connected',
  /** About's short card: remote help's state while it's off, and the way to its page. */
  offTitle: 'Off',
  offLine: 'Nobody can get in. Turn it on when Whombat support asks.',
  open: 'Open remote help',
  /** What support did, grouped by visit (`remoteHelpVisitGroups`). */
  visitCount: (n: number) => (n === 1 ? '1 visit' : `${n} visits`),
  stepCount: (n: number) => (n === 1 ? '1 step' : `${n} steps`),
  today: (clock: string) => `Today ${clock}`,
  yesterday: (clock: string) => `Yesterday ${clock}`,
  now: 'Now',
  allSteps: (n: number) => `Show all ${n} steps`,
  fewerSteps: 'Show fewer',
  earlierVisits: (n: number) => (n === 1 ? 'Show 1 earlier visit' : `Show ${n} earlier visits`),
} as const;

/** The viewer's time zone unless one is given (core's helpers say UTC without one). */
function zone(timeZone?: string): string {
  return timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/* The ops ---------------------------------------------------------------------------------------------------------- */

/** A visit's command line: as text for the modal, and the file to save. */
export interface RemoteHelpTranscript {
  name: string;
  text: string;
  bytes: Uint8Array;
}

/** The `remoteHelp.*` ops as one object: the session's, or a fixture world's (`createFakeRemoteHelp`). */
export interface RemoteHelpApi {
  get(): Promise<RemoteHelpState>;
  confirmBegin(choice: RemoteHelpChoice): Promise<RemoteHelpConfirmBegin>;
  start(input: RemoteHelpChoice & { passkey?: PasskeyAssertionJSON }): Promise<RemoteHelpState>;
  stop(): Promise<RemoteHelpState>;
  /** The newest visits first. */
  visits(input?: { before?: string; limit?: number }): Promise<RemoteHelpVisit[]>;
  transcript(visitId: string, options?: { signal?: AbortSignal }): Promise<RemoteHelpTranscript>;
  /**
   * Whether the viewer has a passkey that confirms it here (the hint under the button): a box passkey on the box's own
   * address, a hosted one anywhere else; null when it can't tell.
   */
  hasPasskey(): Promise<boolean | null>;
}

/**
 * The ops over this session. `boxHost`: the box's own host when this is a page at it, where the box's own passkeys
 * confirm (the hosted app's can't run there).
 */
export function remoteHelpApi(
  session: ApplianceSession,
  where: { boxHost?: string | null } = {},
): RemoteHelpApi {
  return {
    get: () => sessionOps.remoteHelpGet(session),
    confirmBegin: (choice) => sessionOps.remoteHelpConfirmBegin(session, choice),
    start: (input) => sessionOps.remoteHelpStart(session, input),
    stop: () => sessionOps.remoteHelpStop(session),
    visits: async (input) => (await sessionOps.remoteHelpVisits(session, input ?? {})).visits,
    async transcript(visitId, options) {
      const file = await sessionOps.remoteHelpTranscript(session, visitId, options ?? {});
      return remoteHelpTranscriptOf(visitId, file.bytes, file.name);
    },
    async hasPasskey() {
      const s = session.state();
      const me = s.status === 'open' ? s.info.account?.id : null;
      if (!me) return null;
      try {
        const here = (rpId: string | undefined) => (where.boxHost ? rpId === where.boxHost : !rpId);
        return (await sessionOps.passkeysList(session)).passkeys.some(
          (p) => p.accountId === me && here(p.rpId),
        );
      } catch {
        return null;
      }
    },
  };
}

// Terminal sequences: CSI (`ESC [ … final`), OSC (`ESC ] … BEL|ST`), other two-character escapes, then any other control.
// biome-ignore lint/suspicious/noControlCharactersInRegex: they are what it takes out
const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: they are what it takes out
const OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: they are what it takes out
const ESC = /\u001b[@-_]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: they are what it takes out
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/**
 * A command line's record as the modal shows it: what's left of terminal control sequences (the runtime takes them out
 * already, RH-07) taken out again, carriage returns as new lines, nothing but text, new lines and tabs.
 */
export function cleanTranscript(text: string): string {
  return text.replace(CSI, '').replace(OSC, '').replace(ESC, '').replace(/\r\n?/g, '\n').replace(CONTROL, '');
}

/** The transcript's text and the file a download saves (`whombat-remote-help-<visit>.txt` unless the box names it). */
export function remoteHelpTranscriptOf(
  visitId: string,
  bytes: Uint8Array,
  name?: string | null,
): RemoteHelpTranscript {
  return {
    name: name || remoteHelpTranscriptName(visitId),
    text: cleanTranscript(new TextDecoder('utf-8', { fatal: false }).decode(bytes)),
    bytes,
  };
}

/* Turning it on (RH-04) ------------------------------------------------------------------------------------------- */

export type RemoteHelpProblemCode =
  /** The Whombat's challenge isn't the one this device computes for the choice: nothing was signed. */
  | 'challenge_mismatch'
  /** The owner has a passkey and this device can't use passkeys. */
  | 'passkey_here';

export class RemoteHelpError extends Error {
  override name = 'RemoteHelpError';
  constructor(
    readonly code: RemoteHelpProblemCode,
    message: string = code,
  ) {
    super(message);
  }
}

/**
 * The Whombat's options for the authenticator, refused unless their challenge is exactly
 * `passkeyRemoteHelpChallenge({nonce, endpoint, level, duration})` for this device and this choice: the assertion then
 * confirms that and nothing else. Always user verification.
 */
export function remoteHelpPasskeyOptions(
  begin: RemoteHelpConfirmBegin,
  endpoint: string,
  choice: RemoteHelpChoice,
): PasskeyRequestOptionsJSON {
  const options = begin.options;
  if (!options || !begin.nonce)
    throw new RemoteHelpError('challenge_mismatch', 'The Whombat sent no nonce for its passkey request.');
  let expected: string;
  try {
    expected = passkeyRemoteHelpChallengeBase64url({ nonce: begin.nonce, endpoint, ...choice });
  } catch {
    throw new RemoteHelpError('challenge_mismatch', 'The passkey request can’t be checked.');
  }
  if (options.challenge !== expected)
    throw new RemoteHelpError('challenge_mismatch', 'The challenge isn’t this choice on this device.');
  return { ...(options as PasskeyRequestOptionsJSON), userVerification: 'required' };
}

export interface TurnOnRemoteHelpDeps {
  api: Pick<RemoteHelpApi, 'confirmBegin' | 'start'>;
  /** This device's passkeys; null where it can't use them. */
  platform: PasskeyPlatform | null;
  /** This device's key (its session PeerId), which the challenge names. */
  endpoint: string;
  /** An owner without a passkey confirms in a dialog (“Turn on remote help?”): true goes on. */
  confirm(choice: RemoteHelpChoice): Promise<boolean>;
  signal?: AbortSignal;
}

export type TurnOnRemoteHelpOutcome = { kind: 'on'; state: RemoteHelpState } | { kind: 'cancelled' };

/**
 * Turns remote help on (or changes its level or time, RH-04): `confirmBegin` for the choice, then the passkey (checked
 * challenge, `get` on the platform) or the dialog, then `start`. A dismissed prompt or dialog is `cancelled` and changes
 * nothing. Throws `RemoteHelpError`, `PasskeyError` and the ops' `OperationError` (`remoteHelpErrorText` words them).
 */
export async function turnOnRemoteHelp(
  deps: TurnOnRemoteHelpDeps,
  choice: RemoteHelpChoice,
): Promise<TurnOnRemoteHelpOutcome> {
  const begin = await deps.api.confirmBegin(choice);
  if (!begin.options) {
    if (!(await deps.confirm(choice))) return { kind: 'cancelled' };
    return { kind: 'on', state: await deps.api.start(choice) };
  }
  const options = remoteHelpPasskeyOptions(begin, deps.endpoint, choice);
  if (!deps.platform) throw new RemoteHelpError('passkey_here');
  let raw: unknown;
  try {
    raw = await deps.platform.get(options, deps.signal ? { signal: deps.signal } : {});
  } catch (error) {
    if (error instanceof PasskeyCancelled) return { kind: 'cancelled' };
    throw error;
  }
  return { kind: 'on', state: await deps.api.start({ ...choice, passkey: canonicalAssertion(raw) }) };
}

/** A failure of the card's actions in words; null for a dismissed prompt (said nowhere). */
export function remoteHelpErrorText(error: unknown): string | null {
  if (error instanceof PasskeyCancelled) return null;
  if (error instanceof RemoteHelpError)
    return error.code === 'passkey_here' ? REMOTE_HELP_TEXT.passkeyHere : W.refusals.passkey_failed;
  if (error instanceof PasskeyError) return W.refusals.passkey_failed;
  if (error instanceof OperationError) {
    const reason = operationReason(error);
    // An owner with a passkey who sent none: the same words as one that didn't verify.
    if (reason === 'passkey_required') return W.refusals.passkey_failed;
    return remoteHelpRefusalText(reason) ?? REMOTE_HELP_TEXT.failed;
  }
  if (error instanceof NeedsNewerAppError) return REMOTE_HELP_TEXT.loadError;
  return REMOTE_HELP_TEXT.failed;
}

/* What the card shows -------------------------------------------------------------------------------------------- */

export interface RemoteHelpCardInput {
  /** `remoteHelp.get`; null until it answers. */
  state: RemoteHelpState | null;
  /** The viewer has a passkey here (`RemoteHelpApi.hasPasskey`); null while unknown (no hint). */
  hasPasskey: boolean | null;
  now: Date;
  timeZone?: string;
}

export interface RemoteHelpOption<T extends string> {
  value: T;
  label: string;
}

export type RemoteHelpCard =
  | { kind: 'loading' }
  /** An older runtime, or a box that can't (no support key pinned, RH-10). */
  | { kind: 'unavailable'; text: string }
  | {
      kind: 'off';
      intro: string;
      howMuch: string;
      levels: (RemoteHelpOption<RemoteHelpLevel> & { text: string })[];
      howLong: string;
      /** Forever only where the box allows it (RH-03). */
      durations: RemoteHelpOption<RemoteHelpDuration>[];
      button: string;
      /** “You’ll confirm with your passkey.” when the owner has one. */
      hint: string | null;
    }
  | {
      kind: 'on';
      /** `On · Look and fix · until tomorrow 14:00`. */
      line: string;
      level: RemoteHelpLevel;
      stop: string;
      helpCode: { label: string; code: string; hint: string } | null;
      /** “{who} is connected now” (“Support is connected now”), one per connection. */
      connected: { key: string; text: string }[];
    };

/** The durations an owner may pick on this Whombat. */
export function remoteHelpDurations(state: Pick<RemoteHelpState, 'foreverAllowed'>): RemoteHelpDuration[] {
  return REMOTE_HELP_DURATIONS.filter((d) => d !== 'forever' || state.foreverAllowed);
}

/** A choice this Whombat takes: Forever falls back to 1 day where it isn't allowed. */
export function remoteHelpChoice(
  choice: RemoteHelpChoice,
  state: Pick<RemoteHelpState, 'foreverAllowed'> | null,
): RemoteHelpChoice {
  return choice.duration === 'forever' && !state?.foreverAllowed ? { ...choice, duration: 'day' } : choice;
}

export function remoteHelpCard(input: RemoteHelpCardInput): RemoteHelpCard {
  const s = input.state;
  if (!s) return { kind: 'loading' };
  const g = s.grant;
  if (g)
    return {
      kind: 'on',
      line: remoteHelpStateLine({
        level: g.level,
        until: g.until,
        now: input.now,
        timeZone: zone(input.timeZone),
      }),
      level: g.level,
      stop: W.stop,
      helpCode: g.helpCode
        ? { label: W.helpCode, code: formatHelpCode(g.helpCode), hint: W.helpCodeHint }
        : null,
      connected: s.connected.map((c) => ({
        key: c.visitId,
        text: fillRemoteHelpWords(W.connected, { who: c.who }),
      })),
    };
  if (!s.available) return { kind: 'unavailable', text: W.notAvailable };
  return {
    kind: 'off',
    intro: W.off,
    howMuch: W.howMuch,
    levels: REMOTE_HELP_LEVELS.map((value) => ({
      value,
      label: W.levels[value].label,
      text: W.levels[value].hint,
    })),
    howLong: W.forHowLong,
    durations: remoteHelpDurations(s).map((value) => ({ value, label: W.durations[value] })),
    button: W.turnOn,
    hint: input.hasPasskey ? W.passkeyHint : null,
  };
}

/** How long until the card asks again: while it's on or someone is connected; null when it's off. */
export function remoteHelpPollMs(state: RemoteHelpState | null | undefined): number | null {
  return state && (state.grant || state.connected.length > 0) ? REMOTE_HELP_POLL_MS : null;
}

/* What support did (RH-07) --------------------------------------------------------------------------------------- */

export interface RemoteHelpStepRow {
  key: string;
  /** `14:02` today, `20 Oct 14:02` another day. */
  time: string;
  at: string;
  /** The step's words; for a command, `Ran` and the line in `code`. */
  text: string;
  /** A Fix command line, shown in code style after `text`. */
  code: string | null;
  /** The visit whose command line “Show” opens, on the first command step of a visit with a record. */
  transcript: string | null;
  /** A quiet line: “Earlier steps aren’t shown.” */
  muted: boolean;
}

/** A step's time: the clock today, the date and the clock before. */
export function remoteHelpStepTime(at: string, now: Date, timeZone?: string): string {
  const tz = zone(timeZone);
  const clock = formatClock(at, tz);
  return daysAgo(at, now, tz) <= 0 ? clock : `${formatDate(at, tz, { now })} ${clock}`;
}

function stepRow(
  visit: RemoteHelpVisit,
  step: RemoteHelpStep,
  i: number,
  now: Date,
  timeZone: string | undefined,
): RemoteHelpStepRow {
  const exec = step.kind === 'exec' && step.line;
  return {
    key: `${visit.id}:${i}`,
    time: remoteHelpStepTime(step.at, now, timeZone),
    at: step.at,
    // “Ran {line}”: the words before the line, the line in code style.
    text: exec ? (W.steps.exec.split('{line}')[0] ?? '').trim() : remoteHelpStepText(step, visit.who),
    code: exec ? (step.line as string) : null,
    transcript: null,
    muted: false,
  };
}

/**
 * The visits as one list (AP-4444): the newest visit first, each visit's steps in the order they happened, an
 * “Earlier steps aren’t shown.” line first when the box left older ones out, and “Show” on the visit's first command
 * line or command (else its first step) when the box kept what the command line showed.
 */
export function remoteHelpVisitRows(
  visits: readonly RemoteHelpVisit[],
  options: { now: Date; timeZone?: string },
): RemoteHelpStepRow[] {
  const rows: RemoteHelpStepRow[] = [];
  for (const visit of visits) {
    const own = visit.steps.map((step, i) => stepRow(visit, step, i, options.now, options.timeZone));
    if (visit.transcriptBytes > 0 && own.length > 0) {
      const at = visit.steps.findIndex((s) => s.kind === 'shell' || s.kind === 'exec');
      const row = own[at >= 0 ? at : 0] as RemoteHelpStepRow;
      row.transcript = visit.id;
    }
    if (visit.truncated)
      rows.push({
        key: `${visit.id}:earlier`,
        time: '',
        at: visit.startedAt,
        text: REMOTE_HELP_TEXT.earlier,
        code: null,
        transcript: null,
        muted: true,
      });
    rows.push(...own);
  }
  return rows;
}

/** One visit in What support did: who, how much, when, and its steps (oldest first). */
export interface RemoteHelpVisitGroup {
  key: string;
  visitId: string;
  /** “Whombat support”. */
  who: string;
  level: RemoteHelpLevel;
  /** “Look and fix · 12 steps”. */
  line: string;
  /** “Today 14:02”, “Yesterday 09:15”, “20 Oct 14:02”: when it started. */
  when: string;
  /** Still going (no end yet). */
  ongoing: boolean;
  /** The steps the box kept, oldest first, after “Earlier steps aren’t shown.” where it left older ones out. */
  steps: RemoteHelpStepRow[];
  /** How many steps it had in all that the box says: the kept ones. */
  stepCount: number;
  /** The visit whose command line can be opened, or null where none was kept. */
  transcript: string | null;
}

function visitWhen(at: string, now: Date, timeZone: string | undefined): string {
  const tz = zone(timeZone);
  const clock = formatClock(at, tz);
  const days = daysAgo(at, now, tz);
  if (days <= 0) return REMOTE_HELP_TEXT.today(clock);
  if (days === 1) return REMOTE_HELP_TEXT.yesterday(clock);
  return `${formatDate(at, tz, { now })} ${clock}`;
}

/**
 * What support did, one group per visit (newest first), so a long history folds: each visit says who came, how much
 * they could do, when, and how many steps, over its own steps. The steps are `remoteHelpVisitRows`' without “Show” on a
 * step: the visit carries its command line itself.
 */
export function remoteHelpVisitGroups(
  visits: readonly RemoteHelpVisit[],
  options: { now: Date; timeZone?: string },
): RemoteHelpVisitGroup[] {
  return visits.map((visit) => {
    const steps = visit.steps.map((step, i) => stepRow(visit, step, i, options.now, options.timeZone));
    if (visit.truncated)
      steps.unshift({
        key: `${visit.id}:earlier`,
        time: '',
        at: visit.startedAt,
        text: REMOTE_HELP_TEXT.earlier,
        code: null,
        transcript: null,
        muted: true,
      });
    return {
      key: visit.id,
      visitId: visit.id,
      who: visit.who,
      level: visit.level,
      line: [W.levels[visit.level].label, REMOTE_HELP_TEXT.stepCount(visit.steps.length)].join(' · '),
      when: visitWhen(visit.startedAt, options.now, options.timeZone),
      ongoing: visit.endedAt === null,
      steps,
      stepCount: visit.steps.length,
      transcript: visit.transcriptBytes > 0 ? visit.id : null,
    };
  });
}
