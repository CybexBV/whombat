/**
 * The community edition in both apps (Whombat hermes-engine.md HE-58…HE-61; contracts CT-1300…CT-1308;
 * hermes-engine-app.md AP-5400…AP-5406): a box with no relay, control, remote help, licence or phone push, claimed on
 * its own page with the four letters on its screen, a new device of the person's added with a link or QR code it makes,
 * and reached only on its direct ways (the local network and Tailscale).
 *
 * - `runLocalClaim`: the claim on the box's page or in the app at its address (`enroll.claim.local.start` → CPace bound
 *   to both Noise keys → the proofs → `enroll.claim.local` with the person's account), the box's tag checked before the
 *   person is named.
 * - `joinWithLink`: what a link the box made does on the new device (a device of your own), over the enrollment channel
 *   of the direct connection to the PeerId the link names.
 * - The words of the setup and the links (`COMMUNITY_TEXT`, `LINK_TEXT`).
 */
import {
  type ClaimConfirmTags,
  claimConfirmEqual,
  localClaimPakeInitiator,
  localClaimPakeInitiatorFinish,
  normalizeClaimCode,
} from '@whombat/protocol/claim';
import {
  claimAccountProblem,
  type Edition,
  type EditionPart,
  editionHas,
  type LocalLinkParts,
  parseLocalLink,
} from '@whombat/protocol/session';
import { OperationError, sessionOps } from '../session/managed-ops';
import {
  type ApplianceSession,
  ConnectionLostError,
  type ConnectionTie,
  DeadlineExceededError,
  NotDeliveredError,
  OutcomeUnknownError,
  SessionClosedError,
  type SessionInfo,
} from '../session/types';
import { ClaimMismatchError, claimBackoffMinutes, claimErrorText } from './claim';

export type { Edition, EditionPart, LocalLinkKind, LocalLinkParts } from '@whombat/protocol/session';
export { editionHas, parseLocalLink } from '@whombat/protocol/session';

/** Whether a box is the community edition (an open session's `welcome.edition`, or the page's `/v1/direct`). */
export function isCommunity(edition: Edition | null | undefined): boolean {
  return edition === 'community';
}

/** Whether the box of this session has `part` (`editionHas`); a session that isn't open yet reads as commercial. */
export function sessionHas(
  info: Pick<SessionInfo, 'edition'> | null | undefined,
  part: EditionPart,
): boolean {
  return editionHas(info?.edition ?? 'commercial', part);
}

/* The claim on the box's own page --------------------------------------------------------------------------- */

export interface LocalClaimInput {
  /** An open enrollment session to the box this page came from (pinned to `appliancePeerId`). */
  session: ApplianceSession;
  /** The four letters from the box's screen, as typed (`normalizeClaimCode` reads them). */
  letters: string;
  /** The box's PeerId as this side's Noise session has it. */
  appliancePeerId: string;
  /** This device's PeerId (its Noise static key). */
  clientPeerId: string;
  /** The person whose Whombat it is. */
  account: { name: string; email: string };
  endpoint: { label: string; platform: 'web' | 'android' | 'ios' | 'desktop' | 'cli' };
  /**
   * The claim link's secret (`/c/<secret>` on the box's screen, 4.3): a box set up at its own address takes a claim
   * there only with it. Left out elsewhere.
   */
  link?: string | null;
  randomBytes?: (n: number) => Uint8Array;
}

/** The first owner and this device, as the claim answers them (`enroll.claim.local`). */
export type LocalClaimed = Awaited<ReturnType<typeof sessionOps.claimLocal>>;

/** The typed letters aren't four letters of the claim alphabet: nothing was sent. */
export class LocalClaimLettersError extends Error {
  override name = 'LocalClaimLettersError';
  constructor() {
    super('Enter the 4 letters from its screen.');
  }
}

/** The name or the email isn't one the box takes: nothing was sent. */
export class LocalClaimAccountError extends Error {
  override name = 'LocalClaimAccountError';
  constructor(readonly field: 'name' | 'email') {
    super(COMMUNITY_TEXT.account.errors[field]);
  }
}

const cryptoRandom = (n: number) => crypto.getRandomValues(new Uint8Array(n));

/** Whether what was typed is four letters of the box's alphabet (it has no I, L, O, S, U or Z). */
export function localClaimLettersReady(letters: string): boolean {
  return normalizeClaimCode(letters).kind === 'letters';
}

/**
 * What is wrong with the name or the email by the box's own rules (`ClaimAccount`), in words for under the field, or
 * null. Asked before an exchange starts: a try isn't spent on something the box would refuse anyway.
 */
export function localClaimAccountProblem(account: { name: string; email: string }): string | null {
  const field = claimAccountProblem(account);
  return field ? COMMUNITY_TEXT.account.errors[field] : null;
}

/**
 * The claim on a box's own page, or in the app at its address. The letters and the account are checked
 * first, so nothing is spent on a typo. Then the box's claim id, `enroll.claim.local.begin` with this side's CPace
 * share, and the proofs alone (`enroll.claim.local.prove`): the box checks this side's tag (a wrong guess is its
 * `claim_invalid`), and this side checks the box's (`ClaimMismatchError` otherwise: whatever answered isn't the box on
 * the screen). Only then, once and on the same session, the person's name, email and this device's label
 * (`enroll.claim.local`): they never go to something that only poses as the box.
 *
 * Every step runs on one connection of the session (`ConnectionTie`): the one that delivered the box's proof is the
 * one the person's details go on. When it drops in between, the step that follows isn't sent on the next connection
 * (`ConnectionLostError`): the box kept the exchange with the connection, and the caller asks the box what it is now
 * (`localClaimNext`).
 */
export async function runLocalClaim(input: LocalClaimInput): Promise<LocalClaimed> {
  const code = normalizeClaimCode(input.letters);
  if (code.kind !== 'letters') throw new LocalClaimLettersError();
  const field = claimAccountProblem(input.account);
  if (field) throw new LocalClaimAccountError(field);
  const { session } = input;
  const tie: ConnectionTie = {};
  const start = await sessionOps.claimLocalStart(session, input.link ? { link: input.link } : {}, { tie });
  const { share, state } = localClaimPakeInitiator(
    {
      password: code.letters,
      appliancePeerId: input.appliancePeerId,
      clientPeerId: input.clientPeerId,
      claimId: start.claimId,
    },
    input.randomBytes ?? cryptoRandom,
  );
  const begun = await sessionOps.claimLocalBegin(session, { claimId: start.claimId, share }, { tie });
  let tags: ClaimConfirmTags;
  try {
    tags = localClaimPakeInitiatorFinish(state, begun.share);
  } catch {
    throw new ClaimMismatchError();
  }
  const proved = await sessionOps.claimLocalProve(
    session,
    { claimId: start.claimId, confirm: tags.client },
    { tie },
  );
  if (!claimConfirmEqual(tags.appliance, proved.confirm)) throw new ClaimMismatchError();
  return sessionOps.claimLocal(
    session,
    {
      claimId: start.claimId,
      account: { name: input.account.name.trim(), email: input.account.email.trim() },
      endpoint: input.endpoint,
    },
    { tie },
  );
}

/** What a failed claim on the box's page says (the claim's words where they fit; AP-5402). */
export function localClaimErrorText(error: unknown, now: number = Date.now()): string {
  const t = COMMUNITY_TEXT.claim.errors;
  if (error instanceof LocalClaimLettersError) return t.letters;
  if (error instanceof LocalClaimAccountError) return COMMUNITY_TEXT.account.errors[error.field];
  // The letters, never “the code”: the screen asked for letters.
  if (error instanceof OperationError) {
    if (error.code === 'claim_invalid') return t.wrong;
    if (error.code === 'claim_backoff') return t.tooMany(claimBackoffMinutes(error, now) ?? 1);
    if (error.code === 'claim_rate_limited' || error.code === 'claim_window_closed') return t.newLetters;
    if (error.code === 'claim_local_unavailable') return t.notCommunity;
    if (error.code === 'claim_update_app') return t.updateApp;
    if (error.code === 'claim_busy') return t.busy;
    // A box from before the proof round: this app never falls back to naming the person first.
    if (error.code === 'unknown_op') return t.boxTooOld;
    if (error.code === 'claim_used') return t.taken;
    if (LETTERS_RAN_OUT.has(error.code)) return t.tooLong;
  }
  // Nothing reached the box (its session never connected): “try again” alone wouldn't say why.
  if (error instanceof NotDeliveredError && !(error instanceof ConnectionLostError)) return t.unreachable;
  // The connection or the answer was lost on the way: what the letters screen says once the box was asked again.
  if (localClaimLostTouch(error)) return t.lostTouch;
  return claimErrorText(error, 'code', now);
}

/** The exchange or its proof ran out, or the letters changed under it: the letters are asked again. */
const LETTERS_RAN_OUT: ReadonlySet<string> = new Set([
  'claim_start_missing',
  'claim_begin_missing',
  'claim_proof_missing',
]);

/**
 * Whether a failed claim asks for the letters again, not the person's name: a wrong guess, bad letters, too many tries,
 * or an exchange or proof that ran out (the box may show other letters by now).
 */
export function localClaimWantsLetters(error: unknown): boolean {
  return (
    error instanceof LocalClaimLettersError ||
    (error instanceof OperationError &&
      (error.code === 'claim_invalid' ||
        error.code === 'claim_backoff' ||
        error.code === 'claim_rate_limited' ||
        error.code === 'claim_window_closed' ||
        LETTERS_RAN_OUT.has(error.code)))
  );
}

/** Whether a failed claim found the box claimed already (another device won): its state is read again. */
export function localClaimAlreadyClaimed(error: unknown): boolean {
  return error instanceof OperationError && error.code === 'claim_used';
}

/**
 * Whether a failed claim lost touch with the box on the way: its connection dropped (a step wasn't sent, or an answer
 * never came), or the box no longer has this session's proof. What the box kept for the exchange went with the
 * connection, and the box may be another by now: someone else claimed it, its screen shows other letters or none, or
 * this very claim went through and only its answer was lost. Nothing is assumed: the box is asked what it is now.
 */
export function localClaimLostTouch(error: unknown): boolean {
  return (
    error instanceof NotDeliveredError ||
    error instanceof OutcomeUnknownError ||
    error instanceof DeadlineExceededError ||
    error instanceof SessionClosedError ||
    (error instanceof OperationError && error.code === 'claim_proof_missing')
  );
}

/**
 * Where a failed claim sends the person, the same on the box's page and in the app: to the box as it is now (`taken`:
 * another device claimed it), to the box asked again (`reread`: touch was lost, so it is read first; claimed, it is
 * `taken`; not claimed, the letters with `text`), back to the letters with what to say there, or it stays on the name
 * and email.
 */
export type LocalClaimNext =
  | { to: 'taken' }
  | { to: 'reread'; text: string }
  | { to: 'letters' | 'account'; text: string };

export function localClaimNext(error: unknown, now: number = Date.now()): LocalClaimNext {
  if (localClaimAlreadyClaimed(error)) return { to: 'taken' };
  const text = localClaimErrorText(error, now);
  if (localClaimLostTouch(error)) return { to: 'reread', text };
  return { to: localClaimWantsLetters(error) ? 'letters' : 'account', text };
}

/* Links the box makes ---------------------------------------------------------------------------------------- */

/** A link this page or app can open: what it is, the box it names and the ways to it (`parseLocalLink`). */
export function readLocalLink(text: string): LocalLinkParts | null {
  return parseLocalLink(text);
}

/** A device let in by a link (`enroll.link.accept`): its account and endpoint. */
export type LinkEnrolled = Awaited<ReturnType<typeof sessionOps.linkAccept>>;

/**
 * Opens a link the box made on the new device (CT-1305), over an enrollment session pinned to the PeerId the link
 * names: a device link lets this device in to the account that made it.
 */
export function joinWithLink(
  session: ApplianceSession,
  link: Pick<LocalLinkParts, 'secret'>,
  endpoint: LocalClaimInput['endpoint'],
): Promise<LinkEnrolled> {
  return sessionOps.linkAccept(session, { secret: link.secret, endpoint });
}

/** What a refused link says (AP-5403). */
export function linkErrorText(error: unknown): string {
  const t = LINK_TEXT.errors;
  const code = error instanceof OperationError ? error.code : null;
  switch (code) {
    case 'link_invalid':
      return t.invalid;
    case 'link_expired':
      return t.expired;
    case 'link_used':
      return t.used;
    case 'endpoint_enrolled':
      return t.enrolled;
    case 'rate_limited':
      return t.rateLimited;
    case 'link_unavailable':
      return t.unavailable;
    default:
      return t.failed;
  }
}

/** Minutes and seconds left on a five-minute link (`4:59`), or null once it ran out. */
export function linkTimeLeft(expiresAt: string, now: number = Date.now()): string | null {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* Words ------------------------------------------------------------------------------------------------------ */

/**
 * The setup on a community box's own page (AP-5421): three steps in onboarding's frame, then the app's own onboarding
 * (Name your Whombat → Set up your AI → Meet your agent).
 */
export const COMMUNITY_TEXT = {
  steps: [
    { t: 'Claim your Whombat', d: 'The letters on its screen' },
    { t: 'Make your account', d: 'It’s yours alone' },
    { t: 'Reach it from anywhere', d: 'Tailscale, if you like' },
  ],
  stepLabel: (i: number) => `STEP ${i + 1} OF 3`,
  claim: {
    title: 'Claim your Whombat',
    sub: 'Your Whombat shows four letters on its screen. Type them here to make it yours.',
    tip: 'No screen on it? Look at the console of the machine it runs on.',
    letters: 'LETTERS',
    lettersPlaceholder: 'ABCD',
    next: 'Continue',
    errors: {
      letters: 'Enter the 4 letters from its screen.',
      notCommunity: 'This Whombat is claimed in the Whombat app, not on this page.',
      tooLong: 'That took too long. Enter the letters on its screen again.',
      // True whether the letters changed after the wrong try or stay for a while (new letters asked for at the box).
      wrong: 'Those letters aren’t right. Look at your Whombat’s screen and try again.',
      tooMany: (minutes: number) =>
        `Too many wrong letters. Try again in ${minutes} min, or choose New letters on your Whombat’s screen.`,
      newLetters: 'Too many tries. Choose New letters on your Whombat’s screen, then try again.',
      updateApp: 'Update the Whombat app, then try again.',
      busy: 'Your Whombat is busy. Try again in a moment.',
      // The connection dropped in the middle of a claim; shown on the letters once the box was asked again.
      lostTouch: 'The connection dropped. Enter the letters on its screen again.',
      boxTooOld:
        'This Whombat needs an update before it can be claimed here. It updates by itself; try again in a while.',
      taken: 'Someone already claimed this Whombat.',
      unreachable: 'This device can’t reach your Whombat. Check that it’s on and on the same network.',
    },
  },
  account: {
    title: 'Make your account',
    sub: 'This Whombat is yours alone. Your name is how your agent greets you.',
    tip: 'Your account stays on this Whombat. There’s nothing to sign up for.',
    name: 'YOUR NAME',
    email: 'EMAIL',
    claim: 'Claim it',
    claiming: 'Claiming…',
    back: 'Back',
    errors: {
      name: 'Enter your name, up to 120 characters.',
      email: 'Enter an email address, like you@example.com.',
    },
  },
  tailscale: {
    title: 'Reach it from anywhere',
    sub: 'Turn on Tailscale to use this Whombat away from home, from any device on your tailnet.',
    tip: 'You can do this later in Settings → This Whombat.',
    turnOn: 'Turn on Tailscale',
    turningOn: 'Turning on…',
    own: 'Use your own login server',
    ownHint: 'For Headscale or your company’s server. Leave it empty for Tailscale’s own.',
    ownLabel: 'LOGIN SERVER',
    ownPlaceholder: 'https://headscale.example.com',
    signIn: 'Sign in to Tailscale',
    signInMeta: 'Sign in with the account this Whombat should join, then come back here.',
    approval: 'Approve this Whombat in your Tailscale admin console.',
    on: (name: string) => `This Whombat is ${name} on your tailnet.`,
    noHttps: 'Turn on HTTPS in your tailnet’s DNS settings to open it in a browser there.',
    notHere: 'Tailscale isn’t on this Whombat.',
    skip: 'Skip for now',
    next: 'Continue',
  },
  /** Notifications and passkeys where there's no control behind the box (AP-5406, AP-5428). */
  push: {
    phoneTitle: 'No notifications on this phone',
    phoneMeta:
      'This Whombat doesn’t send notifications to phones. The app checks for news each time you open it.',
    insecureTitle: 'Not available on this page',
    insecureMeta:
      'Notifications work on this Whombat’s secure Tailscale page, whose address starts with https.',
  },
  passkeys: 'Passkeys work on this Whombat’s secure Tailscale page, whose address starts with https.',
  /** On the box's page of a claimed box, for a browser it doesn't know yet. */
  welcome: {
    kicker: 'THIS WHOMBAT',
    title: 'Add this device',
    sub: 'This Whombat lets your devices in with a link or QR code from a device you already use it on.',
    tip: 'Make a QR code on that device under Settings → This Whombat → Devices.',
    pair: 'Pair with another device',
  },
} as const;

/** Links and QR codes the box makes (AP-5403, AP-5422…AP-5425). */
export const LINK_TEXT = {
  device: {
    title: 'Add this device',
    sub: 'This link lets this device in to your account.',
    join: 'Add this device',
    joining: 'Adding…',
    section: 'Add a device with a QR code',
    meta: 'Scan it with the new device, or open the link there. It works once, for 5 minutes.',
    make: 'Show QR code',
    making: 'Making a code…',
    qrLabel: 'QR code that adds a device to your account',
    left: (time: string) => `Works for ${time} more.`,
    over: 'This code ran out.',
    again: 'New code',
    copy: 'Copy link',
    copied: 'Link copied.',
    hide: 'Done',
  },
  errors: {
    invalid: 'This link doesn’t work. Make a new one on your other device.',
    expired: 'This link ran out. Make a new one on your other device.',
    used: 'This link was used already. Make a new one on your other device.',
    enrolled: 'This device is already in.',
    rateLimited: 'Too many tries. Wait a few minutes, then try again.',
    unavailable: 'This Whombat has no address to put in a link right now. Check its network, then try again.',
    failed: 'That didn’t work. Try again.',
    notThisBox: 'This link is for another Whombat.',
  },
} as const;
