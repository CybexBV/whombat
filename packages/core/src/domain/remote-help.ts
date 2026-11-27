/**
 * Remote help (0.120, CT-930…CT-937; Whombat docs/decisions/remote-help.md RH-01…RH-13): an owner lets Whombat support
 * into this Whombat for a limited time, at one of two levels — *Look* (a fixed list of read-only commands) or *Look and
 * fix* (also a root command line, restarts and connections to the box's own ports and sockets). Off by default and off
 * after every expiry; the support service on the box (`whombat-support`) is the only judge of what is allowed.
 *
 * This module holds what every surface shares: the levels, durations and Look commands, the help code's form, the
 * bounds, and the words (`REMOTE_HELP_WORDS`) with their helpers — the state line, the steps of a visit, the desk's
 * line and the admin panel's. The shapes that cross a wire are in `@whombat/protocol/session` (`RemoteHelpState`,
 * `RemoteHelpVisit`, `RemoteHelpStep`) and `@whombat/control-contracts/local` (the support socket). Pure: no I/O.
 */

import { z } from 'zod';
import { FEEDBACK_REFERENCE_ALPHABET } from '../feedback/install.js';
import { coreTree, tCore, type WordTree } from '../i18n/catalog.js';
import { type DateInput, daysAgo, formatClock, formatDate, formatShortWeekday } from '../text/time.js';
import { deskText } from './desk.js';

/* Levels and durations (RH-02, RH-03) ------------------------------------------------------------------------- */

/** *Look*: read-only commands as an unprivileged user. *Look and fix*: also root, restarts and local connections. */
export const REMOTE_HELP_LEVELS = ['look', 'fix'] as const;
export const RemoteHelpLevel = z.enum(REMOTE_HELP_LEVELS);
export type RemoteHelpLevel = z.infer<typeof RemoteHelpLevel>;

/** How long a grant lasts. `forever` only on test Whombats (`foreverAllowed`, RH-03): the support service decides. */
export const REMOTE_HELP_DURATIONS = ['hour', 'day', 'week', 'forever'] as const;
export const RemoteHelpDuration = z.enum(REMOTE_HELP_DURATIONS);
export type RemoteHelpDuration = z.infer<typeof RemoteHelpDuration>;

/** Each limited duration in seconds; `forever` has none. */
export const REMOTE_HELP_DURATION_S = { hour: 3_600, day: 86_400, week: 604_800 } as const;

/** A duration's seconds, null for `forever` (Go `local.RemoteHelpDurationSeconds`). */
export function remoteHelpDurationSeconds(duration: RemoteHelpDuration): number | null {
  return duration === 'forever' ? null : REMOTE_HELP_DURATION_S[duration];
}

/* The help code (RH-05) ------------------------------------------------------------------------------------------ */

/** A help code is six characters of Crockford's base32 (no I, L, O, U), shown as `KQ7·2MX`. */
export const HELP_CODE_LENGTH = 6;
/** The help code's 32 characters (`FEEDBACK_REFERENCE_ALPHABET`); a random byte maps by its low 5 bits. */
export const HELP_CODE_ALPHABET = FEEDBACK_REFERENCE_ALPHABET;
/** A normalized help code: six upper-case characters of `HELP_CODE_ALPHABET`. */
export const HELP_CODE_RE = /^[0-9A-HJKMNP-TV-Z]{6}$/;
export const HelpCode = z.string().regex(HELP_CODE_RE);
export type HelpCode = z.infer<typeof HelpCode>;

/**
 * The characters a help code may be typed with that aren't part of it: space, tab, no-break space, `·`, `.`, `-`, the
 * Unicode hyphens and dashes (U+2010…U+2015) and the minus sign.
 */
const HELP_CODE_SEPARATORS = new Set([
  0x20, 0x09, 0xa0, 0xb7, 0x2e, 0x2d, 0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212,
]);

/**
 * What someone typed or said as a help code (Go `local.NormalizeHelpCode`): the separators dropped (space, tab, no-break
 * space, `·`, `.`, `-` and the Unicode dashes), ASCII letters upper-cased, `O` read as `0` and `I`/`L` as `1`; the code,
 * or null when that isn't six characters of the alphabet (`U` and anything else refuse). The support service compares
 * the result with its own code in constant time.
 */
export function normalizeHelpCode(input: string): string | null {
  let code = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    if (HELP_CODE_SEPARATORS.has(cp)) continue;
    const upper = cp >= 0x61 && cp <= 0x7a ? String.fromCharCode(cp - 0x20) : ch;
    code += upper === 'O' ? '0' : upper === 'I' || upper === 'L' ? '1' : upper;
    if (code.length > HELP_CODE_LENGTH) return null;
  }
  return HELP_CODE_RE.test(code) ? code : null;
}

/** `KQ72MX` → `KQ7·2MX`, as the card and the desk show it. Anything that isn't a help code stays as it is. */
export function formatHelpCode(code: string): string {
  return HELP_CODE_RE.test(code) ? `${code.slice(0, 3)}·${code.slice(3)}` : code;
}

/** A help code from six random bytes (each by its low 5 bits, so unbiased; Go `local.HelpCodeFromBytes`). */
export function helpCodeFromBytes(bytes: Uint8Array): string {
  if (bytes.length < HELP_CODE_LENGTH) throw new RangeError(`need ${HELP_CODE_LENGTH} bytes`);
  let code = '';
  for (const b of bytes.subarray(0, HELP_CODE_LENGTH)) code += HELP_CODE_ALPHABET[b & 31];
  return code;
}

/* What support does (RH-02, RH-07) ------------------------------------------------------------------------------- */

/** The Look commands: the only things *Look* runs (each with its fixed argument grammar on the box). */
export const REMOTE_HELP_LOOK_COMMANDS = [
  'help',
  'status',
  'units',
  'logs',
  'boots',
  'hardware',
  'network',
  'disks',
  'memory',
  'processes',
  'updates',
  'report',
] as const;
export const LookCommand = z.enum(REMOTE_HELP_LOOK_COMMANDS);
export type LookCommand = z.infer<typeof LookCommand>;

/**
 * A step of a visit: someone `connected` or `left`, ran a `look` command, a Fix command (`exec`), used a command line
 * (`shell`, its length in `seconds`), `restart`ed a part, opened a connection (`forward`, its `target` and `bytes`), was
 * `refused` (`reason`), or typed a `wrong_code`.
 */
export const REMOTE_HELP_STEP_KINDS = [
  'connected',
  'left',
  'look',
  'exec',
  'shell',
  'restart',
  'forward',
  'refused',
  'wrong_code',
] as const;
export const RemoteHelpStepKind = z.enum(REMOTE_HELP_STEP_KINDS);
export type RemoteHelpStepKind = z.infer<typeof RemoteHelpStepKind>;

/**
 * Why the box stopped something: it needs *Look and fix* (`level`), a wrong help code (`code`), the certificate
 * (`certificate`), a bound (`limit`), not a Look command (`unknown_command`) or arguments outside its grammar
 * (`bad_arguments`).
 */
export const REMOTE_HELP_REFUSALS = [
  'level',
  'code',
  'certificate',
  'limit',
  'unknown_command',
  'bad_arguments',
] as const;
export const RemoteHelpRefusal = z.enum(REMOTE_HELP_REFUSALS);
export type RemoteHelpRefusal = z.infer<typeof RemoteHelpRefusal>;

/** A systemd unit as Look's grammar takes it (`whombat-voice.service`). */
export const REMOTE_HELP_UNIT_RE = /^[A-Za-z0-9@._-]{1,80}$/;

/**
 * The bounds (RH-07): a visit ends after `visitIdleS` without a connection; records stay `keepDays` and at most
 * `keepBytes` on the box; `wrongCodes` wrong help codes end the grant; a visit keeps at most `stepsPerVisit` steps
 * (answers show the newest `stepsShown`) and `transcriptBytesPerVisit` of command-line output; a Fix command line is
 * kept to `commandLineChars` code points; who visits is named in at most `nameChars`; at most `connectedMax` people
 * are connected at once.
 */
export const REMOTE_HELP_LIMITS = {
  visitIdleS: 900,
  keepDays: 90,
  keepBytes: 500 * 2 ** 20,
  wrongCodes: 5,
  stepsPerVisit: 2_000,
  stepsShown: 200,
  commandLineChars: 500,
  nameChars: 40,
  transcriptBytesPerVisit: 50 * 2 ** 20,
  connectedMax: 8,
} as const;

/* Words (Whombat remote-help.md §4) ------------------------------------------------------------------------------ */

const REMOTE_HELP_WORDS_SHAPE = {
  title: 0,
  off: 0,
  notAvailable: 0,
  howMuch: 0,
  forHowLong: 0,
  levels: {
    look: {
      label: 0,
      hint: 0,
    },
    fix: {
      label: 0,
      hint: 0,
    },
  },
  durations: {
    hour: 0,
    day: 0,
    week: 0,
    forever: 0,
  },
  turnOn: 0,
  passkeyHint: 0,
  /** The dialog of an owner without a passkey (`remoteHelpConfirmText`). */
  confirm: {
    title: 0,
    body: 0,
    levels: {
      look: 0,
      fix: 0,
    },
    durations: {
      hour: 0,
      day: 0,
      week: 0,
      forever: 0,
    },
    turnOn: 0,
    cancel: 0,
  },
  /** `remoteHelpStateLine`: “On · Look and fix · until tomorrow 14:00”. */
  state: {
    on: 0,
    until: 0,
    forever: 0,
  },
  stop: 0,
  helpCode: 0,
  helpCodeHint: 0,
  connected: 0,
  visits: 0,
  noVisits: 0,
  /** `remoteHelpStepText`. */
  steps: {
    connected: 0,
    left: 0,
    look: {
      help: 0,
      status: 0,
      units: 0,
      logs: 0,
      boots: 0,
      hardware: 0,
      network: 0,
      disks: 0,
      memory: 0,
      processes: 0,
      updates: 0,
      report: 0,
    },
    logsOf: 0,
    /** The command line in code style. */
    exec: 0,
    shellMinute: 0,
    shellMinutes: 0,
    shellShort: 0,
    restart: 0,
    forward: 0,
    refused: 0,
    why: {
      level: 0,
      code: 0,
      other: 0,
    },
    wrongCode: 0,
  },
  transcript: {
    show: 0,
    title: 0,
    download: 0,
  },
  /** The refusals' words, by `details.code` (`remoteHelpRefusalText`). */
  refusals: {
    forever_not_allowed: 0,
    passkey_failed: 0,
    remote_help_busy: 0,
    remote_help_unavailable: 0,
  },
  /** What the person's assistant says (`remoteHelpVisitText`, `remoteHelpTurnedOnText`). */
  messages: {
    visit: 0,
    turnedOn: 0,
    durations: {
      hour: 0,
      day: 0,
      week: 0,
      forever: 0,
    },
    lockedOut: 0,
  },
  /** The box's screen (`remoteHelpDeskLine`). */
  desk: {
    on: 0,
    onForever: 0,
    connected: 0,
    stop: 0,
  },
  /** The admin panel's device page (`remoteHelpPanelLine`). */
  panel: {
    off: 0,
    on: 0,
    forever: 0,
    connected: 0,
  },
  /** Who a visitor is when their certificate names nobody (`remoteHelpWho`). */
  someone: 0,
} as const;

/**
 * Every word remote help shows, shared by the web, the phone, the desk, the admin panel and the runtime's messages.
 * `{who}`, `{n}`, … are filled by the helpers below (`fillRemoteHelpWords`).
 */
export function remoteHelpWords(locale?: string | null): WordTree<typeof REMOTE_HELP_WORDS_SHAPE> {
  return coreTree(locale, 'remoteHelp', REMOTE_HELP_WORDS_SHAPE);
}

export const REMOTE_HELP_WORDS = remoteHelpWords('en');

/** Fills `{who}`-style holes in one of `REMOTE_HELP_WORDS`; a hole without a value stays as it is. */
export function fillRemoteHelpWords(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{([a-z]+)\}/g, (hole, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : hole,
  );
}

/** “Look”, “Look and fix”. */
export function remoteHelpLevelLabel(level: RemoteHelpLevel, locale?: string | null): string {
  return remoteHelpWords(locale).levels[level].label;
}

/** “Whombat support can look and fix for 1 hour.”, “… until you stop it.” */
export function remoteHelpConfirmText(
  level: RemoteHelpLevel,
  duration: RemoteHelpDuration,
  locale?: string | null,
): string {
  const c = remoteHelpWords(locale).confirm;
  return fillRemoteHelpWords(c.body, { level: c.levels[level], duration: c.durations[duration] });
}

/**
 * When a grant ends, in the zone's clock: today the clock (“14:00”), “tomorrow 14:00”, otherwise the short weekday and
 * date (“Thu 23 Oct, 14:00”, with the year when it isn't now's).
 */
export function remoteHelpUntilText(
  until: DateInput,
  now: DateInput,
  timeZone = 'UTC',
  locale?: string | null,
): string {
  const clock = formatClock(until, timeZone);
  const days = -daysAgo(until, now, timeZone);
  if (days <= 0) return clock;
  if (days === 1) return `${tCore(locale, 'time.tomorrowLower')} ${clock}`;
  return `${formatShortWeekday(until, timeZone, locale)} ${formatDate(until, timeZone, { now }, locale)}, ${clock}`;
}

/**
 * The card's line while remote help is on: “On · Look and fix · until tomorrow 14:00”, “On · Look · until Thu 23 Oct,
 * 14:00”, “On · Look and fix · forever” (`until` null). Times in `timeZone` (the viewer's; UTC when absent).
 */
export function remoteHelpStateLine(s: {
  level: RemoteHelpLevel;
  until: string | null;
  now: Date;
  timeZone?: string;
  locale?: string | null;
}): string {
  const w = remoteHelpWords(s.locale).state;
  const when =
    s.until === null
      ? w.forever
      : fillRemoteHelpWords(w.until, { time: remoteHelpUntilText(s.until, s.now, s.timeZone, s.locale) });
  return `${w.on} · ${remoteHelpLevelLabel(s.level, s.locale)} · ${when}`;
}

/** The desk's line: “Remote help is on · until 14:00”, “… · until tomorrow 14:00”, “Remote help is on · forever”. */
export function remoteHelpDeskLine(s: { until: string | null; now: Date; timeZone?: string }): string {
  const d = REMOTE_HELP_WORDS.desk;
  return s.until === null
    ? d.onForever
    : fillRemoteHelpWords(d.on, { time: remoteHelpUntilText(s.until, s.now, s.timeZone) });
}

/**
 * The admin panel's line from a status report's `support` (`DeviceStatusReport.support`): “Remote help: off”, “Remote
 * help: Look · 3 h left” (hours rounded up), “Remote help: Look and fix · forever”.
 */
export function remoteHelpPanelLine(support: {
  state: 'off' | RemoteHelpLevel;
  untilS: number | null;
}): string {
  const p = REMOTE_HELP_WORDS.panel;
  if (support.state === 'off') return p.off;
  const level = remoteHelpLevelLabel(support.state);
  if (support.untilS === null) return fillRemoteHelpWords(p.forever, { level });
  return fillRemoteHelpWords(p.on, { level, n: Math.max(1, Math.ceil(support.untilS / 3_600)) });
}

/** “Support is looking at this Whombat now through remote help. You can stop it in Settings → This Whombat → About.” */
export function remoteHelpVisitText(who: string): string {
  return fillRemoteHelpWords(REMOTE_HELP_WORDS.messages.visit, { who });
}

/** “Mara turned on remote help: Look and fix, for 1 day.”, “… Look, forever.” */
export function remoteHelpTurnedOnText(level: RemoteHelpLevel, duration: RemoteHelpDuration): string {
  const m = REMOTE_HELP_WORDS.messages;
  return fillRemoteHelpWords(m.turnedOn, {
    level: remoteHelpLevelLabel(level),
    duration: m.durations[duration],
  });
}

/** The words of a refusal's `details.code`, or null for a code remote help doesn't name. */
export function remoteHelpRefusalText(code: string, locale?: string | null): string | null {
  const r: Readonly<Record<string, string>> = remoteHelpWords(locale).refusals;
  return Object.hasOwn(r, code) ? (r[code] ?? null) : null;
}

/**
 * A part of the box as people read it: `whombat-voice.service` → `voice`; another unit without `.service`
 * (`nginx.service` → `nginx`, `whombat-presence.socket` → `presence.socket`).
 */
export function remoteHelpUnitName(unit: string): string {
  const name = unit.endsWith('.service') ? unit.slice(0, -'.service'.length) : unit;
  return name.startsWith('whombat-') && name.length > 'whombat-'.length
    ? name.slice('whombat-'.length)
    : name;
}

/**
 * Who a visitor is, from their certificate's key id (Go `local.RemoteHelpWho`): the name before a trailing ` (…)` —
 * control writes `Support (op_7Hq2 via john)` — as display text of at most `nameChars` code points; “Someone” when
 * nothing is left. The box shows and records only this, never the ids.
 */
export function remoteHelpWho(keyId: string): string {
  const open = keyId.endsWith(')') ? keyId.lastIndexOf(' (') : -1;
  const name = deskText(open >= 0 ? keyId.slice(0, open) : keyId, REMOTE_HELP_LIMITS.nameChars);
  return name === '' ? REMOTE_HELP_WORDS.someone : name;
}

function joinAnd(parts: readonly string[], locale?: string | null): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return tCore(locale, 'recipe.and', {
    items: parts.slice(0, -1).join(', '),
    last: parts[parts.length - 1] ?? '',
  });
}

/** What `remoteHelpStepText` reads of a step (`RemoteHelpStep` of `@whombat/protocol/session` is one). */
export interface RemoteHelpStepView {
  kind: RemoteHelpStepKind;
  command?: LookCommand;
  units?: readonly string[];
  line?: string;
  seconds?: number;
  target?: string;
  reason?: RemoteHelpRefusal;
}

/**
 * A step of “What support did” (§4): “Support connected”, “Read the logs of voice and server”, “Ran systemctl status”,
 * “Used a command line for 3 minutes”, “Restarted voice”, “Opened a connection to 127.0.0.1:8123”, “Was stopped: that
 * needs Look and fix”, “Typed a wrong help code”. `who` names the visitor.
 */
export function remoteHelpStepText(step: RemoteHelpStepView, who: string, locale?: string | null): string {
  const s = remoteHelpWords(locale).steps;
  switch (step.kind) {
    case 'connected':
      return fillRemoteHelpWords(s.connected, { who });
    case 'left':
      return fillRemoteHelpWords(s.left, { who });
    case 'look': {
      const command = step.command ?? 'help';
      if (command === 'logs' && step.units && step.units.length > 0)
        return fillRemoteHelpWords(s.logsOf, { names: joinAnd(step.units.map(remoteHelpUnitName), locale) });
      return s.look[command];
    }
    case 'exec':
      return fillRemoteHelpWords(s.exec, { line: step.line ?? '' });
    case 'shell': {
      const seconds = step.seconds ?? 0;
      if (seconds < 60) return s.shellShort;
      const n = Math.round(seconds / 60);
      return n === 1 ? s.shellMinute : fillRemoteHelpWords(s.shellMinutes, { n });
    }
    case 'restart':
      return fillRemoteHelpWords(s.restart, { name: remoteHelpUnitName(step.units?.[0] ?? '') });
    case 'forward':
      return fillRemoteHelpWords(s.forward, { target: step.target ?? '' });
    case 'refused':
      return fillRemoteHelpWords(s.refused, {
        why: step.reason === 'level' ? s.why.level : step.reason === 'code' ? s.why.code : s.why.other,
      });
    case 'wrong_code':
      return s.wrongCode;
  }
}
