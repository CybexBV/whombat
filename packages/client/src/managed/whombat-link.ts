/**
 * Whombat Link in both apps (Whombat docs/decisions/whombat-link.md, LNK-06, LNK-40…LNK-44): how a box is reached
 * (Link, its own address, Tailscale) in Settings → This Whombat → Reach, turning Link on (the code the person types at
 * the account site) or off, the update channel, the Link-ended banner with “Turn on Tailscale”, the one-time Link offer
 * on the setup of a box without Link, and the boxes this device knows for the switcher. Pure: the apps draw it.
 *
 * On the iPhone the app shows no price, no sign-up and no way to buy (`offerLink: false`): Link's state is said, but
 * turning it on, the price and the account site are left out.
 */
import { LINK_OFFER_TEXT, type LinkState } from '@whombat/protocol';
import type {
  LinkSummary,
  ReachGetOutput,
  TailscaleStatus,
  UpdatesChannelOutput,
} from '@whombat/protocol/session';
import { OperationError, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';
import type { ApplianceSummary } from './control';
import { ownAddressText } from './own-address';
import type { KnownAppliance } from './registry';

export type { LinkSummary, ReachGetOutput, UpdatesChannelOutput } from '@whombat/protocol/session';

/** Whether a refusal is a box that doesn't know the op yet (before 4.4). */
function unknownOp(error: unknown): boolean {
  return error instanceof OperationError && error.code === 'unknown_op';
}

/** How this Whombat is reached, or null on a box before Link (`unknown_op`). Other failures throw. */
export async function readReach(session: ApplianceSession): Promise<ReachGetOutput | null> {
  try {
    return await sessionOps.reachGet(session);
  } catch (error) {
    if (unknownOp(error)) return null;
    throw error;
  }
}

/** The update channel, or null on a box that can't choose one (before 4.4, or `update_channel_unavailable`). */
export async function readUpdatesChannel(session: ApplianceSession): Promise<UpdatesChannelOutput | null> {
  try {
    return await sessionOps.updatesChannelGet(session);
  } catch (error) {
    if (unknownOp(error) || reasonOf(error) === 'update_channel_unavailable') return null;
    throw error;
  }
}

function reasonOf(error: unknown): string | null {
  if (!(error instanceof OperationError)) return null;
  const code = (error.details as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : error.code;
}

/* Words ------------------------------------------------------------------------------------------------------------ */

/**
 * Easy or Expert, the installer's words (Whombat one-environment.md): Whombat Link with what it gives and its one offer
 * sentence, or Tailscale or Headscale with what to know. Reach in Settings and the setup's Link card say the same; the
 * iPhone leaves out the price and anything to buy.
 */
export const REACH_CHOICE_TEXT = {
  title: 'How will you reach this Whombat?',
  sub: 'You can change this later in Settings.',
  easy: {
    kind: 'Easy',
    name: 'Whombat Link',
    label: 'Easy · Whombat Link',
    tag: 'Recommended',
    price: LINK_OFFER_TEXT,
    more: 'What you get',
    points: [
      'Open your Whombat from anywhere, without port forwarding',
      'Its own secure web address',
      'Notifications on your iPhone and Android phone',
      'The Whombat apps away from home',
      'Sign-ins like Google work',
      'Supports Whombat’s open-source work',
    ],
  },
  expert: {
    kind: 'Expert',
    name: 'Tailscale or Headscale',
    label: 'Expert · Tailscale or Headscale',
    tag: 'Free',
    line: 'You set up Tailscale on each of your devices.',
    more: 'What to know',
    points: [
      'No notifications on your phone while the app is closed',
      'Some sign-ins, like Google, aren’t available',
    ],
  },
} as const;

export const REACH_TEXT = {
  section: 'REACH',
  link: {
    name: 'Whombat Link',
    off: 'Whombat Link is off',
    /** The iPhone: no way to buy, so only what is true now. */
    offMetaPlain: 'This Whombat works at home and on Tailscale.',
    turnOn: 'Turn on',
    turningOn: 'Turning on…',
    starting: 'Waiting for you to confirm',
    /** Design LNK-13: “Open app.whombat.com/link and enter ABCD-EFGH”. */
    enter: (where: string, code: string) => `Open ${where} and enter ${code}.`,
    left: (time: string) => `The code works for ${time} more.`,
    codeOver: 'The code ran out.',
    newCode: 'New code',
    startingPlain: 'Whombat Link is starting',
    startingPlainMeta: 'Finish it where you turned it on.',
    gettingCode: 'Getting a code…',
    waitingAddress: 'Waiting for an address',
    waitingAddressMeta: 'Your address usually comes within a few minutes. It arrives by itself.',
    on: 'Whombat Link is on',
    onMeta: 'Open this Whombat from anywhere, with notifications on your phones.',
    trial: (date: string) => `Free month until ${date}.`,
    account: (email: string) => `Linked to ${email}.`,
    turnOff: 'Turn off',
    turningOff: 'Turning off…',
    cancel: 'Cancel',
    grace: (date: string) => `Whombat Link ends on ${date}`,
    graceMeta:
      'After that, this Whombat works at home and on Tailscale. Turn on Tailscale now as a second way in.',
    graceKeep: 'To keep it, subscribe at app.whombat.com.',
    ended: 'Whombat Link ended',
    endedMeta:
      'This Whombat works at home and on Tailscale. Your data, agents, automations, backups and updates are all still here.',
    endedBack: 'To turn it on again, subscribe at app.whombat.com.',
    offConfirm: 'Turn off Whombat Link?',
    offConfirmMeta:
      'Your Whombat’s address and notifications on your phones stop. It keeps working at home and on Tailscale.',
    errors: {
      unavailable: 'Whombat Link isn’t available on this Whombat.',
      busy: 'Whombat Link is changing. Try again in a moment.',
      rateLimited: 'Too many tries. Wait a few minutes, then try again.',
      unreachable: 'Whombat’s service didn’t answer. Try again in a moment.',
      failed: 'That didn’t work. Try again.',
    },
  },
  address: {
    title: 'Its address',
    none: 'No address yet',
    noneMeta: 'It gets one when Whombat Link is on.',
    coming: 'Getting its address…',
    comingMeta: 'Its own web address shows here once it’s ready.',
  },
  tailscale: {
    title: 'Tailscale',
    on: (name: string) => `On as ${name}`,
    off: 'Off',
    signIn: 'Waiting for you to sign in',
    turnOn: 'Turn on Tailscale',
    /** LNK-14: one plain line with the reason. */
    keyExpiry:
      'In Tailscale’s admin console, turn off key expiry for this Whombat. Otherwise Tailscale signs it out after a few months and you can’t reach it away from home.',
  },
  /** The banner while Link ends or after (LNK-06): what still works, and the way back. */
  banner: {
    grace: (date: string) =>
      `Whombat Link ends on ${date}. Turn on Tailscale so you can still reach this Whombat away from home.`,
    graceTailscale: (date: string) =>
      `Whombat Link ends on ${date}. You can still reach this Whombat at home and on Tailscale.`,
    ended:
      'Whombat Link ended. This Whombat still works at home. Turn on Tailscale to reach it away from home.',
    endedTailscale: 'Whombat Link ended. This Whombat still works at home and on Tailscale.',
  },
  /** The one-time offer on the setup of a box reached without Link (LNK-40): a card, never a gate; Easy's words. */
  offer: {
    title: REACH_CHOICE_TEXT.easy.label,
    tag: REACH_CHOICE_TEXT.easy.tag,
    price: REACH_CHOICE_TEXT.easy.price,
    points: REACH_CHOICE_TEXT.easy.points,
    turnOn: 'Turn on Whombat Link',
    notNow: 'Not now',
  },
} as const;

export const CHANNEL_TEXT = {
  title: 'Updates from',
  label: 'Update channel',
  production: 'Production',
  /** People see Beta; on the wire and in the update repository it stays `development`. */
  development: 'Beta',
  productionMeta: 'Tested versions. This is right for almost everyone.',
  developmentMeta: 'New versions first, before they’re fully tested. Something may break.',
  /** Beta → Production never downgrades (LNK-21). */
  staysOn: (release: string) =>
    `This Whombat keeps ${release} until Production has a newer version, then moves on by itself.`,
  switched: (channel: 'production' | 'development') =>
    channel === 'production' ? 'This Whombat takes Production updates.' : 'This Whombat takes Beta updates.',
  unavailable: 'This Whombat can’t choose where its updates come from.',
  failed: 'That didn’t work. Try again.',
} as const;

/** What a refused `link.on` or `link.off` says. */
export function whombatLinkErrorText(error: unknown): string {
  const t = REACH_TEXT.link.errors;
  switch (reasonOf(error)) {
    case 'whombat_link_unavailable':
    case 'unknown_op':
      return t.unavailable;
    case 'whombat_link_busy':
      return t.busy;
    case 'whombat_link_rate_limited':
    case 'rate_limited':
      return t.rateLimited;
    case 'control_unreachable':
    case 'unavailable':
      return t.unreachable;
    default:
      return t.failed;
  }
}

/** What a refused `updates.channel.set` says. */
export function channelErrorText(error: unknown): string {
  return reasonOf(error) === 'update_channel_unavailable' ? CHANNEL_TEXT.unavailable : CHANNEL_TEXT.failed;
}

/* Views ------------------------------------------------------------------------------------------------------------ */

const day = (iso: string, locale?: string) =>
  new Date(iso).toLocaleDateString(locale ?? 'en-GB', { day: 'numeric', month: 'short' });

/** Minutes and seconds left (`9:59`), or null once it ran out. */
export function timeLeft(expiresAt: string, now: number = Date.now()): string | null {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.ceil(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The link page as people type it: `app.whombat.com/link`. */
export function linkPageText(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** The link page with the code filled in (`?code=`), for a link people click instead of typing. */
export function linkPageHref(url: string, code: string): string {
  const u = new URL(url);
  u.searchParams.set('code', code);
  return u.toString();
}

export interface LinkRowView {
  state: LinkState;
  tone: 'ok' | 'warn' | 'bad' | 'mut';
  title: string;
  /** One or two plain lines. */
  meta: string;
  /** While Link starts: the code to show big and where to type it. */
  code: { code: string; where: string; url: string; left: string | null } | null;
  /** The row's button: turn Link on, a new code, turn it off (or cancel while it starts), or none. */
  action: 'on' | 'newCode' | 'off' | 'cancel' | null;
  /** “What you get” folds out under the row: while Link is off, what turning it on gives. */
  more: boolean;
}

/**
 * The Link row of Reach. `offerLink: false` (the iPhone): no turning on, no account site, no price — only what is true.
 */
export function linkRowView(
  link: LinkSummary,
  options: { offerLink: boolean; now?: number; locale?: string },
): LinkRowView {
  const t = REACH_TEXT.link;
  const { offerLink, locale } = options;
  const now = options.now ?? Date.now();
  const base = { state: link.state, code: null, more: false };
  switch (link.state) {
    case 'off':
      return {
        ...base,
        tone: 'mut',
        title: t.off,
        meta: offerLink ? REACH_CHOICE_TEXT.easy.price : t.offMetaPlain,
        action: offerLink ? 'on' : null,
        more: true,
      };
    case 'starting': {
      if (link.waitingForAddress)
        return { ...base, tone: 'warn', title: t.waitingAddress, meta: t.waitingAddressMeta, action: null };
      if (!offerLink)
        return { ...base, tone: 'warn', title: t.startingPlain, meta: t.startingPlainMeta, action: null };
      const pending = link.pending;
      if (!pending)
        return { ...base, tone: 'warn', title: t.starting, meta: t.gettingCode, action: 'cancel' };
      const left = timeLeft(pending.expiresAt, now);
      const where = linkPageText(pending.url);
      return {
        ...base,
        tone: 'warn',
        title: t.starting,
        meta: left ? `${t.enter(where, pending.code)} ${t.left(left)}` : t.codeOver,
        code: { code: pending.code, where, url: linkPageHref(pending.url, pending.code), left },
        action: left ? 'cancel' : 'newCode',
      };
    }
    case 'on': {
      const lines = [
        link.trialEndsAt && Date.parse(link.trialEndsAt) > now
          ? t.trial(day(link.trialEndsAt, locale))
          : t.onMeta,
        offerLink && link.email ? t.account(link.email) : null,
      ].filter(Boolean);
      return { ...base, tone: 'ok', title: t.on, meta: lines.join(' '), action: 'off' };
    }
    case 'grace':
      return {
        ...base,
        tone: 'warn',
        title: link.graceEndsAt ? t.grace(day(link.graceEndsAt, locale)) : t.ended,
        meta: offerLink ? `${t.graceMeta} ${t.graceKeep}` : t.graceMeta,
        action: null,
      };
    case 'ended':
      return {
        ...base,
        tone: 'bad',
        title: t.ended,
        meta: offerLink ? `${t.endedMeta} ${t.endedBack}` : t.endedMeta,
        action: offerLink ? 'on' : null,
      };
  }
}

export interface TailscaleRowView {
  tone: 'ok' | 'warn' | 'bad' | 'mut';
  title: string;
  on: boolean;
}

/** Reach's Tailscale line (the full controls stay in the Tailscale section). */
export function tailscaleRowView(t: TailscaleStatus | null): TailscaleRowView | null {
  if (!t) return null;
  const r = REACH_TEXT.tailscale;
  if (t.state === 'on') return { tone: 'ok', title: r.on(t.name ?? ''), on: true };
  if (t.state === 'needs_sign_in' || t.state === 'needs_approval' || t.state === 'starting')
    return { tone: 'warn', title: r.signIn, on: false };
  return { tone: t.state === 'error' ? 'bad' : 'mut', title: r.off, on: false };
}

/**
 * Reach's address line: the own address; while Link starts or runs, that it is coming; else that it comes with Link.
 * `offerLink: false` (the iPhone, where Link can't be turned on): no line while there is no address coming, because
 * “it gets one when Whombat Link is on” points at something the app doesn't offer.
 */
export function addressRowView(
  reach: ReachGetOutput,
  options: { offerLink?: boolean } = {},
): { title: string; meta: string } | null {
  if (reach.ownAddress)
    return { title: ownAddressText(reach.ownAddress.url), meta: REACH_TEXT.address.title };
  if (!reach.link) return null;
  const coming = reach.link.state === 'starting' || reach.link.state === 'on' || reach.link.state === 'grace';
  if (coming) return { title: REACH_TEXT.address.coming, meta: REACH_TEXT.address.comingMeta };
  return options.offerLink === false
    ? null
    : { title: REACH_TEXT.address.none, meta: REACH_TEXT.address.noneMeta };
}

export interface LinkBannerView {
  text: string;
  tone: 'warn' | 'bad';
  /** “Turn on Tailscale” while Tailscale isn't on yet. */
  tailscale: boolean;
}

/** The banner while Link ends (`grace`) or after (`ended`), or null (LNK-06, LNK-06a). */
export function linkBannerView(
  reach: Pick<ReachGetOutput, 'link' | 'tailscale'> | null,
  locale?: string,
): LinkBannerView | null {
  const link = reach?.link;
  if (!link || (link.state !== 'grace' && link.state !== 'ended')) return null;
  const b = REACH_TEXT.banner;
  const tailscaleOn = reach?.tailscale?.state === 'on';
  // A box without Tailscale (it isn't in this image) can't offer it.
  const canTailscale = reach?.tailscale !== null && reach?.tailscale !== undefined && !tailscaleOn;
  if (link.state === 'grace') {
    const date = link.graceEndsAt ? day(link.graceEndsAt, locale) : null;
    if (!date)
      return { text: tailscaleOn ? b.endedTailscale : b.ended, tone: 'warn', tailscale: canTailscale };
    return {
      text: tailscaleOn ? b.graceTailscale(date) : b.grace(date),
      tone: 'warn',
      tailscale: canTailscale,
    };
  }
  return { text: tailscaleOn ? b.endedTailscale : b.ended, tone: 'bad', tailscale: canTailscale };
}

/** Whether Link is in a state a poll should follow (it changes by itself: the person confirms elsewhere). */
export function linkPollMs(link: LinkSummary | null | undefined): number | null {
  if (!link) return null;
  if (link.state === 'starting') return link.waitingForAddress ? 60_000 : 3_000;
  return null;
}

/** The channel row: which is chosen, its line, and the line when a switch to Production waits. */
export function channelView(c: UpdatesChannelOutput): {
  channel: 'production' | 'development';
  meta: string;
} {
  const meta = c.staysOn
    ? CHANNEL_TEXT.staysOn(c.staysOn)
    : c.channel === 'development'
      ? CHANNEL_TEXT.developmentMeta
      : CHANNEL_TEXT.productionMeta;
  return { channel: c.channel, meta };
}

/* The setup on the box's page (LNK-40) ------------------------------------------------------------------------------ */

/**
 * The setup's steps before the app opens: Link your Whombat (done on the account site, when the page came from there),
 * the claim, who you are (only when the account site didn't send the email along) and the box's passkey or, away from
 * its own address, how to reach it.
 */
export type BoxClaimStep = 'link' | 'claim' | 'account' | 'passkey' | 'reach';
/** The app's own setup that follows on the box's page: only Set up your AI (the Whombat and its agent get defaults). */
export type BoxAppStep = 'ai';
export type BoxSetupStep = BoxClaimStep | BoxAppStep;

/** The app's setup steps on the box's page. */
export const BOX_APP_STEPS: readonly BoxAppStep[] = ['ai'];

/** How the box's page was opened, which decides the steps it counts. */
export interface BoxSetupPage {
  /** The page is the box's own address: the passkey step is here; elsewhere, Reach it from anywhere. */
  atAddress: boolean;
  /** Opened from the account site's link page: Link your Whombat counts as the first step, done. */
  fromLink?: boolean;
  /** The account site sent the person's email along: Who are you? isn't asked. */
  knowsAccount?: boolean;
}

/**
 * The claim's steps on the box's page: (Link your Whombat, done) → the letters → (who you are) → the box's passkey or
 * how to reach it.
 */
export function boxClaimSteps(page: BoxSetupPage): BoxClaimStep[] {
  return [
    ...(page.fromLink ? (['link'] as const) : []),
    'claim',
    ...(page.knowsAccount ? [] : (['account'] as const)),
    page.atAddress ? 'passkey' : 'reach',
  ];
}

/**
 * The one setup's steps, one count from the link page to Chat: the claim's, then Set up your AI in the app, which the
 * box's page opens next. Whatever way the page was opened, the count is the same length (four).
 */
export function boxSetupSteps(page: BoxSetupPage): BoxSetupStep[] {
  return [...boxClaimSteps(page), ...BOX_APP_STEPS];
}

/**
 * The link page's own steps while it links a new Whombat: the box's page that opens next carries on this count.
 */
export const LINK_JOURNEY_STEPS: readonly BoxSetupStep[] = boxSetupSteps({
  atAddress: true,
  fromLink: true,
  knowsAccount: true,
});

/**
 * Connect your AI's kicker when it follows the box's setup on a box that already has a Whombat: Set up your AI's place
 * in the setup's count, the last.
 */
export function boxSetupAiKicker(): string {
  const steps = boxSetupSteps({ atAddress: false });
  return BOX_SETUP_TEXT.stepLabel(steps.indexOf('ai'), steps.length);
}

/**
 * The Whombat's name when the setup gives it one by itself: “Mara’s Whombat” from the person's first name, else “My
 * Whombat”. The person can change it in Settings.
 */
export function defaultWhombatName(personName: string | null | undefined): string {
  const first = (personName ?? '').trim().split(/\s+/)[0]?.slice(0, 60) ?? '';
  return first ? `${first}’s Whombat` : 'My Whombat';
}

export const BOX_SETUP_TEXT = {
  steps: {
    link: { t: 'Add your Whombat', d: 'To your account' },
    claim: { t: 'Claim your Whombat', d: 'The letters on its screen' },
    account: { t: 'Who are you?', d: 'It stays on this Whombat' },
    passkey: { t: 'Make its passkey', d: 'For this Whombat only' },
    reach: { t: 'Reach it from anywhere', d: 'Tailscale or Whombat Link' },
    ai: { t: 'Set up your AI', d: 'Pick and sign in' },
  } satisfies Record<BoxSetupStep, { t: string; d: string }>,
  stepLabel: (i: number, of: number) => `STEP ${i + 1} OF ${of}`,
  account: {
    title: 'Who are you?',
    sub: 'This Whombat is yours alone. Your name is how your agent greets you.',
    tip: 'Your name and email stay on this Whombat.',
  },
  /** The claim's own field when the account site sent the email but not the name. */
  name: {
    hint: 'How your agent greets you.',
  },
  reach: {
    title: 'Reach it from anywhere',
    sub: 'Use this Whombat away from home with Tailscale, or with Whombat Link.',
    tip: 'You can change this later in Settings → This Whombat.',
    onTailscale: (name: string) => `This Whombat is ${name} on your tailnet.`,
  },
  /** Set up your AI on the box's page: the names the setup gave, and where they change. */
  named: (whombat: string, agent: string) =>
    `Your Whombat is called ${whombat} and your agent is ${agent}. You can change both in Settings.`,
  next: 'Continue',
} as const;

/** The Tailscale page (`<name>.<tailnet>.ts.net`) this setup runs on, or null. */
export function tailscalePageName(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return /\.ts\.net$/.test(host) ? host : null;
}

/* The boxes this device knows (LNK-43) ------------------------------------------------------------------------------ */

export interface KnownBoxRow {
  device: string;
  name: string;
  here: boolean;
  /** Where it opens on the web (its own address or its Tailscale page), or null when this device knows none. */
  web: string | null;
  meta: string;
}

export const KNOWN_BOXES_TEXT = {
  here: 'This Whombat',
  unnamed: 'Your Whombat',
  notIn: 'Set up this device',
  web: (host: string) => host,
  noAddress: 'On this device',
} as const;

/**
 * The switcher's rows from the boxes this device remembers (its registry), not an account's list: the open one first,
 * then the others by name. Each says where it opens.
 */
export function knownBoxRows(known: readonly KnownAppliance[], current: string): KnownBoxRow[] {
  const t = KNOWN_BOXES_TEXT;
  const rows = known.map((a): KnownBoxRow => {
    const web = a.ownAddress ?? a.direct?.routes?.find((r) => r.web?.startsWith('https://'))?.web ?? null;
    const here = a.device === current;
    return {
      device: a.device,
      name: a.name ?? t.unnamed,
      here,
      web,
      meta: here ? t.here : !a.enrolled ? t.notIn : web ? ownAddressText(web) : t.noAddress,
    };
  });
  return [
    ...rows.filter((r) => r.here),
    ...rows.filter((r) => !r.here).sort((x, y) => x.name.localeCompare(y.name)),
  ];
}

/** The boxes this device knows as the switcher's list (LNK-43): the ones it is let in to, as a directory would list them. */
export function knownSummaries(known: readonly KnownAppliance[]): ApplianceSummary[] {
  return known
    .filter((a) => a.enrolled)
    .map((a) => ({
      device: a.device,
      orgId: a.orgId,
      name: a.name,
      state: 'claimed' as const,
      contentPeerId: a.peerId,
      lastSeenAt: null,
      revocationsPending: 0,
    }));
}
