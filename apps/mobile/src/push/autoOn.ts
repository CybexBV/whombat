/**
 * Notifications on by themselves wherever the phone lets them be (docs/app/decisions/mobile-reach.md): what the app does
 * the first time a session that can register opens. Allowed already (Android 12 and older, where apps may notify unless
 * the person turned it off, or allowed earlier): register, without a word. An iPhone never asked: allow them quietly
 * (iOS's provisional authorization, no question shown) and register; they wait in Notification Center, where iOS offers
 * Keep or Turn off. Android 13 and later never asked: one sheet with the reason, whose Turn on brings Android's
 * question. Refused, or “Not now” on this phone: nothing; Settings → Notifications keeps Turn on. Pure.
 */

/** Where the phone stands, as the app reads it without asking anything. */
export interface PushFacts {
  platform: 'ios' | 'android' | 'other';
  /** Android's API level (33 is Android 13), iOS's major version; 0 where unknown. */
  osVersion: number;
  /** The system's answer: allowed, refused, or never asked. A quiet iPhone is `undetermined` with `provisional`. */
  status: 'granted' | 'denied' | 'undetermined';
  /** The system may still ask (false after a refusal it remembers). */
  canAskAgain: boolean;
  /** iOS: allowed quietly (provisional), which counts as on. */
  provisional: boolean;
  /** The person said “Not now” on this phone. */
  notNow: boolean;
}

/**
 * `register`: allowed, register at once. `quietly`: ask iOS for quiet notifications (no question shows), then register.
 * `sheet`: show the reason with Turn on and Not now. `nothing`: leave it to Settings.
 */
export type PushStart = 'register' | 'quietly' | 'sheet' | 'nothing';

/** Android 13, the first to ask before an app notifies. */
export const ANDROID_ASKS_FROM = 33;
/** iOS 12, the first with quiet (provisional) notifications. */
export const IOS_QUIET_FROM = 12;

export function pushStart(f: PushFacts): PushStart {
  if (f.status === 'granted' || f.provisional) return 'register';
  if (f.status === 'denied' || !f.canAskAgain) return 'nothing';
  // Never asked. Someone who said “Not now” isn't turned on behind their back, even quietly.
  if (f.notNow) return 'nothing';
  if (f.platform === 'ios') return f.osVersion >= IOS_QUIET_FROM || f.osVersion === 0 ? 'quietly' : 'sheet';
  if (f.platform === 'android') return f.osVersion >= ANDROID_ASKS_FROM ? 'sheet' : 'nothing';
  return 'nothing';
}

/** The parts of expo-notifications' permission answer this reads. */
export interface PermissionAnswer {
  status: string;
  granted: boolean;
  canAskAgain: boolean;
  ios?: { status?: number | null } | null;
}

/** iOS's authorization statuses that let notifications through without the full yes: provisional and ephemeral. */
const IOS_PROVISIONAL = 3;
const IOS_EPHEMERAL = 4;

/**
 * Whether the answer lets notifications through: allowed, or on an iPhone allowed quietly. expo-notifications reports
 * a quiet iPhone as `undetermined` and not `granted`, with `ios.status` PROVISIONAL.
 */
export function allowedQuietly(answer: PermissionAnswer): boolean {
  const ios = answer.ios?.status;
  return ios === IOS_PROVISIONAL || ios === IOS_EPHEMERAL;
}

/** The facts from an answer, the platform and its version (`notNow` is the phone's own). */
export function pushFacts(
  answer: PermissionAnswer,
  platform: PushFacts['platform'],
  osVersion: number,
  notNow: boolean,
): PushFacts {
  const provisional = !answer.granted && allowedQuietly(answer);
  const status =
    answer.granted || answer.status === 'granted'
      ? 'granted'
      : answer.status === 'denied'
        ? 'denied'
        : 'undetermined';
  return { platform, osVersion, status, canAskAgain: answer.canAskAgain, provisional, notNow };
}

/** “14”, “17.2”, 34: the major version as a number, 0 where it can't be read. */
export function osMajor(version: string | number | null | undefined): number {
  if (typeof version === 'number') return Number.isFinite(version) ? Math.floor(version) : 0;
  const n = Number.parseInt(String(version ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}
