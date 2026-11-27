/**
 * Whombat Link in both apps (Whombat docs/decisions/whombat-link.md, LNK-06, LNK-40…LNK-44): how a box is reached
 * (Link, its own address, Tailscale) in Settings → This Whombat → Reach, turning Link on (the code the person types at
 * the account site) or off, the update channel, the Link-ended banner with “Turn on Tailscale”, the one-time Link offer
 * on the setup of a box without Link, and the boxes this device knows for the switcher. Pure: the apps draw it.
 *
 * On the iPhone the app shows no price, no sign-up and no way to buy (`offerLink: false`): Link's state is said, but
 * turning it on, the price and the account site are left out.
 */
import { formatLocaleOf, interpolate } from '@whombat/core/i18n';
import { type LinkState, linkOfferText } from '@whombat/protocol';
import type {
  LinkSummary,
  ReachGetOutput,
  TailscaleStatus,
  UpdatesChannelOutput,
} from '@whombat/protocol/session';
import { clientTree } from '../i18n/catalog';
import { WHOMBAT_LINK_WORDS } from '../i18n/messages/hostManaged/whombatLink';
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
 * Easy or Expert, the installer's words (Whombat one-environment.md), in a locale (English when none is given):
 * Whombat Link with what it gives and its one offer sentence, or Tailscale or Headscale with what to know. Reach in
 * Settings and the setup's Link card say the same; the iPhone leaves out the price and anything to buy.
 */
export function reachChoiceText(locale?: string | null) {
  const w = clientTree(locale, WHOMBAT_LINK_WORDS).choice;
  const e = w.easy.points;
  const x = w.expert.points;
  return {
    title: w.title,
    sub: w.sub,
    easy: {
      kind: w.easy.kind,
      name: w.easy.name,
      label: w.easy.label,
      tag: w.easy.tag,
      price: linkOfferText(locale),
      more: w.easy.more,
      points: [e.one, e.two, e.three, e.four, e.five, e.six],
    },
    expert: {
      kind: w.expert.kind,
      name: w.expert.name,
      label: w.expert.label,
      tag: w.expert.tag,
      line: w.expert.line,
      more: w.expert.more,
      points: [x.one, x.two],
    },
  } as const;
}

/** Easy or Expert in English. */
export const REACH_CHOICE_TEXT = reachChoiceText('en');

/** Reach's words, in a locale (English when none is given). */
export function reachText(locale?: string | null) {
  const w = clientTree(locale, WHOMBAT_LINK_WORDS).reach;
  const choice = reachChoiceText(locale);
  return {
    section: w.section,
    link: {
      ...w.link,
      /** The iPhone: no way to buy, so only what is true now. */
      offMetaPlain: w.link.offMetaPlain,
      /** Design LNK-13: “Open app.whombat.com/link and enter ABCD-EFGH”. */
      enter: (where: string, code: string) => interpolate(w.link.enter, { where, code }),
      left: (time: string) => interpolate(w.link.left, { time }),
      trial: (date: string) => interpolate(w.link.trial, { date }),
      account: (email: string) => interpolate(w.link.account, { email }),
      grace: (date: string) => interpolate(w.link.grace, { date }),
    },
    address: w.address,
    tailscale: {
      ...w.tailscale,
      on: (name: string) => interpolate(w.tailscale.on, { name }),
      /** LNK-14: one plain line with the reason. */
      keyExpiry: w.tailscale.keyExpiry,
    },
    /** The banner while Link ends or after (LNK-06): what still works, and the way back. */
    banner: {
      grace: (date: string) => interpolate(w.banner.grace, { date }),
      graceTailscale: (date: string) => interpolate(w.banner.graceTailscale, { date }),
      ended: w.banner.ended,
      endedTailscale: w.banner.endedTailscale,
    },
    /** The one-time offer on the setup of a box reached without Link (LNK-40): a card, never a gate; Easy's words. */
    offer: {
      title: choice.easy.label,
      tag: choice.easy.tag,
      price: choice.easy.price,
      points: choice.easy.points,
      turnOn: w.offer.turnOn,
      notNow: w.offer.notNow,
    },
  } as const;
}

/** Reach's words in English. */
export const REACH_TEXT = reachText('en');

/** The update channel's words, in a locale (English when none is given). */
export function channelText(locale?: string | null) {
  const w = clientTree(locale, WHOMBAT_LINK_WORDS).channel;
  return {
    title: w.title,
    label: w.label,
    production: w.production,
    /** People see Beta; on the wire and in the update repository it stays `development`. */
    development: w.development,
    productionMeta: w.productionMeta,
    developmentMeta: w.developmentMeta,
    /** Beta → Production never downgrades (LNK-21). */
    staysOn: (release: string) => interpolate(w.staysOn, { release }),
    switched: (channel: 'production' | 'development') =>
      channel === 'production' ? w.switchedProduction : w.switchedDevelopment,
    unavailable: w.unavailable,
    failed: w.failed,
  } as const;
}

/** The update channel's words in English. */
export const CHANNEL_TEXT = channelText('en');

/** What a refused `link.on` or `link.off` says. */
export function whombatLinkErrorText(error: unknown, locale?: string | null): string {
  const t = reachText(locale).link.errors;
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
export function channelErrorText(error: unknown, locale?: string | null): string {
  const t = channelText(locale);
  return reasonOf(error) === 'update_channel_unavailable' ? t.unavailable : t.failed;
}

/* Views ------------------------------------------------------------------------------------------------------------ */

const day = (iso: string, locale?: string | null) =>
  new Date(iso).toLocaleDateString(formatLocaleOf(locale), { day: 'numeric', month: 'short' });

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
  options: { offerLink: boolean; now?: number; locale?: string | null },
): LinkRowView {
  const t = reachText(options.locale).link;
  const { offerLink, locale } = options;
  const now = options.now ?? Date.now();
  const base = { state: link.state, code: null, more: false };
  switch (link.state) {
    case 'off':
      return {
        ...base,
        tone: 'mut',
        title: t.off,
        meta: offerLink ? linkOfferText(locale) : t.offMetaPlain,
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
export function tailscaleRowView(t: TailscaleStatus | null, locale?: string | null): TailscaleRowView | null {
  if (!t) return null;
  const r = reachText(locale).tailscale;
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
  options: { offerLink?: boolean; locale?: string | null } = {},
): { title: string; meta: string } | null {
  const a = reachText(options.locale).address;
  if (reach.ownAddress) return { title: ownAddressText(reach.ownAddress.url), meta: a.title };
  if (!reach.link) return null;
  const coming = reach.link.state === 'starting' || reach.link.state === 'on' || reach.link.state === 'grace';
  if (coming) return { title: a.coming, meta: a.comingMeta };
  return options.offerLink === false ? null : { title: a.none, meta: a.noneMeta };
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
  locale?: string | null,
): LinkBannerView | null {
  const link = reach?.link;
  if (!link || (link.state !== 'grace' && link.state !== 'ended')) return null;
  const b = reachText(locale).banner;
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
export function channelView(
  c: UpdatesChannelOutput,
  locale?: string | null,
): {
  channel: 'production' | 'development';
  meta: string;
} {
  const t = channelText(locale);
  const meta = c.staysOn
    ? t.staysOn(c.staysOn)
    : c.channel === 'development'
      ? t.developmentMeta
      : t.productionMeta;
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
export function boxSetupAiKicker(locale?: string | null): string {
  const steps = boxSetupSteps({ atAddress: false });
  return boxSetupText(locale).stepLabel(steps.indexOf('ai'), steps.length);
}

/**
 * The Whombat's name when the setup gives it one by itself: “Mara’s Whombat” from the person's first name, else “My
 * Whombat”. The person can change it in Settings.
 */
export function defaultWhombatName(personName: string | null | undefined, locale?: string | null): string {
  const w = clientTree(locale, WHOMBAT_LINK_WORDS).defaultName;
  const first = (personName ?? '').trim().split(/\s+/)[0]?.slice(0, 60) ?? '';
  return first ? interpolate(w.named, { first }) : w.plain;
}

/** The setup on the box's page, in a locale (English when none is given). */
export function boxSetupText(locale?: string | null) {
  const w = clientTree(locale, WHOMBAT_LINK_WORDS).boxSetup;
  return {
    steps: w.steps satisfies Record<BoxSetupStep, { t: string; d: string }>,
    stepLabel: (i: number, of: number) => interpolate(w.stepLabel, { n: i + 1, of }),
    account: w.account,
    /** The claim's own field when the account site sent the email but not the name. */
    name: w.name,
    reach: { ...w.reach, onTailscale: (name: string) => interpolate(w.reach.onTailscale, { name }) },
    /** Set up your AI on the box's page: the names the setup gave, and where they change. */
    named: (whombat: string, agent: string) => interpolate(w.named, { whombat, agent }),
    next: w.next,
  } as const;
}

/** The setup on the box's page in English. */
export const BOX_SETUP_TEXT = boxSetupText('en');

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

/** The boxes this device knows, in a locale (English when none is given). */
export function knownBoxesText(locale?: string | null) {
  const w = clientTree(locale, WHOMBAT_LINK_WORDS).knownBoxes;
  return {
    here: w.here,
    unnamed: w.unnamed,
    notIn: w.notIn,
    web: (host: string) => host,
    noAddress: w.noAddress,
  } as const;
}

/** The boxes this device knows in English. */
export const KNOWN_BOXES_TEXT = knownBoxesText('en');

/**
 * The switcher's rows from the boxes this device remembers (its registry), not an account's list: the open one first,
 * then the others by name. Each says where it opens.
 */
export function knownBoxRows(
  known: readonly KnownAppliance[],
  current: string,
  locale?: string | null,
): KnownBoxRow[] {
  const t = knownBoxesText(locale);
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
