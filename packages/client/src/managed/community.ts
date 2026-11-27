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
import { interpolate } from '@whombat/core/i18n';
import { normalizeLocaleTag } from '@whombat/core/i18n/locale';
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
  LOCALE_MINOR,
  type LocalLinkParts,
  parseLocalLink,
  protocolAtLeast,
} from '@whombat/protocol/session';
import { clientTree } from '../i18n/catalog';
import { COMMUNITY_WORDS } from '../i18n/messages/hostManaged/community';
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
  /** Preferred BCP-47 locale tag; sent only when the box speaks session minor >= LOCALE_MINOR. */
  locale?: string | null;
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
export function localClaimAccountProblem(
  account: { name: string; email: string },
  locale?: string | null,
): string | null {
  const field = claimAccountProblem(account);
  return field ? communityText(locale).account.errors[field] : null;
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
  const normalizedLocale = normalizeLocaleTag(input.locale);
  const st = typeof session.state === 'function' ? session.state() : null;
  const protocol = st?.status === 'open' ? st.info.protocol : null;
  const locale = normalizedLocale && protocolAtLeast(protocol, LOCALE_MINOR) ? normalizedLocale : undefined;
  return sessionOps.claimLocal(
    session,
    {
      claimId: start.claimId,
      account: { name: input.account.name.trim(), email: input.account.email.trim() },
      endpoint: input.endpoint,
      ...(locale ? { locale } : {}),
    },
    { tie },
  );
}

/** What a failed claim on the box's page says (the claim's words where they fit; AP-5402). */
export function localClaimErrorText(
  error: unknown,
  now: number = Date.now(),
  locale?: string | null,
): string {
  const words = communityText(locale);
  const t = words.claim.errors;
  if (error instanceof LocalClaimLettersError) return t.letters;
  if (error instanceof LocalClaimAccountError) return words.account.errors[error.field];
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
  return claimErrorText(error, 'code', now, locale);
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

export function localClaimNext(
  error: unknown,
  now: number = Date.now(),
  locale?: string | null,
): LocalClaimNext {
  if (localClaimAlreadyClaimed(error)) return { to: 'taken' };
  const text = localClaimErrorText(error, now, locale);
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
export function linkErrorText(error: unknown, locale?: string | null): string {
  const t = linkText(locale).errors;
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
 * The setup on a community box's own page (AP-5421), in a locale (English when none is given): three steps in
 * onboarding's frame, then the app's own onboarding (Name your Whombat → Set up your AI → Meet your agent).
 */
export function communityText(locale?: string | null) {
  const w = clientTree(locale, COMMUNITY_WORDS);
  return {
    steps: [w.steps.claim, w.steps.account, w.steps.reach],
    stepLabel: (i: number) => interpolate(w.stepLabel, { n: i + 1 }),
    claim: {
      ...w.claim,
      errors: {
        ...w.claim.errors,
        tooMany: (minutes: number) => interpolate(w.claim.errors.tooMany, { minutes }),
      },
    },
    account: w.account,
    tailscale: { ...w.tailscale, on: (name: string) => interpolate(w.tailscale.on, { name }) },
    /** Notifications and passkeys where there's no control behind the box (AP-5406, AP-5428). */
    push: w.push,
    passkeys: w.passkeys,
    /** On the box's page of a claimed box, for a browser it doesn't know yet. */
    welcome: w.welcome,
  } as const;
}

/** The community setup's words in English. */
export const COMMUNITY_TEXT = communityText('en');

/** Links and QR codes the box makes (AP-5403, AP-5422…AP-5425), in a locale (English when none is given). */
export function linkText(locale?: string | null) {
  const w = clientTree(locale, COMMUNITY_WORDS).link;
  return {
    device: { ...w.device, left: (time: string) => interpolate(w.device.left, { time }) },
    errors: w.errors,
  } as const;
}

/** The links' words in English. */
export const LINK_TEXT = linkText('en');
