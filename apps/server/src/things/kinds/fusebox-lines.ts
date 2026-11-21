/**
 * Fusebox's Worth a look (fusebox-page.md FP-09; quiet-notices.md QN-01…QN-04, QN-S23): what each line is and how an
 * Ignore of it ends, built the same way for the page and for the health pass (from the accounts the gateway poller kept).
 * A tool used up, an expired sign-in and an API key out of credit are only yours (nobody else can add room, sign in or
 * pay, and an agent may run on this very gateway); a week that runs out early at this pace is a heads-up until the week resets; failing requests,
 * Fusebox's own faults and its history not saving are problems. Pure.
 */
import { GATEWAY_TOOL_LABELS, type GatewayAccountUsage, type GatewayProvider } from '@whombat/core';
import type { StoredGatewayFault } from '../../db/schema/index';
import type { KindCheck, KindNotice } from '../quiet/types';
import { clip, pct, span, thousands } from '../words';
import { isSubscription, type Pool, roundHour, TOOL_NAME, untilWords, usedUpTools } from './fusebox-pool';
import { subjectName } from './home/lines';

/** Every check Fusebox raises (What Whombat watches, QN-15). */
export const FUSEBOX_CHECKS: readonly KindCheck[] = [
  {
    check: 'fusebox.used_up',
    name: 'Claude or ChatGPT used up',
    nature: 'you',
    perItem: true,
    startsOn: false,
  },
  { check: 'fusebox.signin', name: 'Expired sign-ins', nature: 'you', perItem: true, startsOn: true },
  // Fusebox moves the requests to the other accounts meanwhile: a limit, so it starts off.
  { check: 'fusebox.credit', name: 'API keys out of credit', nature: 'you', perItem: true, startsOn: false },
  {
    check: 'fusebox.week_runs_out',
    name: 'A week running out early',
    nature: 'fyi',
    perItem: true,
    startsOn: false,
  },
  { check: 'fusebox.failing', name: 'Failing requests', nature: 'problem', perItem: false, startsOn: false },
  {
    check: 'fusebox.storage',
    name: 'Saving its usage history',
    nature: 'problem',
    perItem: false,
    startsOn: false,
  },
  {
    check: 'fusebox.fault',
    name: 'Fusebox’s own warnings',
    nature: 'problem',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'fusebox.subscription_used_up',
    name: 'One subscription used up',
    nature: 'fyi',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'fusebox.subscription_off',
    name: 'Subscriptions switched off',
    nature: 'fyi',
    perItem: true,
    startsOn: false,
  },
];

/** The checks that read the accounts and faults (left out together when the poller's read is missing or old). */
export const FUSEBOX_ACCOUNT_CHECKS: readonly string[] = FUSEBOX_CHECKS.map((c) => c.check).filter(
  (c) => c !== 'fusebox.failing',
);

/** Failing requests are counted over this last hour, whatever range the page shows (QN-S23). */
export const FAILING_WINDOW_MS = 3600_000;

/** “1.2 %”, “50 %”. */
const share = (n: number) => {
  const r = Math.round(n * 10) / 10;
  return `${Number.isInteger(r) ? r : r.toFixed(1)} %`;
};

export interface FuseboxLinesInput {
  accounts: readonly GatewayAccountUsage[];
  pools: readonly Pool[];
  faults: readonly StoredGatewayFault[];
  /** Fusebox's account id → the account's key. */
  ids: ReadonlyMap<string, string>;
  /** The accounts' names (their emails, FP-10). */
  labels: ReadonlyMap<string, string>;
  /** Requests that worked and failed over the last hour; null when they couldn't be counted. */
  lastHour: { ok: number; failed: number } | null;
  /** Whombat's own turns go through it (the used-up line's detail). */
  switches: { claude: boolean; codex: boolean };
  /** Fusebox's own dashboard. */
  url: string;
  now: Date;
  timeZone: string;
}

const toolSubject = (tool: GatewayProvider) => ({ id: `tool:${tool}`, name: TOOL_NAME[tool] });
const toolWords = (t: GatewayProvider) => GATEWAY_TOOL_LABELS[t];
const untilIso = (until: string | Date | null) => {
  const t = until ? new Date(until).getTime() : Number.NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
};

/** Worth a look (FP-09), worst first. */
export function fuseboxNotices(input: FuseboxLinesInput): KindNotice[] {
  const { accounts, now, timeZone } = input;
  const labelOf = (key: string) => input.labels.get(key) ?? 'A subscription';
  const accountSubject = (key: string) => ({
    id: `account:${key}`.slice(0, 160),
    name: subjectName(labelOf(key)),
  });
  const out: KindNotice[] = [];
  const usedUp = usedUpTools(accounts);
  for (const up of usedUp) {
    const until = up.until ? untilIso(up.until) : null;
    const words = up.until ? untilWords(up.until, now, timeZone) : null;
    out.push({
      id: `used-up-${up.tool}`,
      tone: 'bad',
      icon: 'clock',
      title: `${TOOL_NAME[up.tool]} is used up${words ? ` until ${words}` : ''}`,
      detail: input.switches[up.tool]
        ? `${toolWords(up.tool)} turns won’t start until then.`
        : 'Fusebox has no room left for it until then.',
      link: { kind: 'url', label: 'Open Fusebox', url: input.url },
      nature: 'you',
      check: 'fusebox.used_up',
      subject: toolSubject(up.tool),
      ignore: until
        ? { lifts: 'period', words: 'Until it resets.', until }
        : { lifts: 'fixed', words: 'Until it has room again.' },
      badge: clip(`${TOOL_NAME[up.tool]} used up${words ? ` until ${words}` : ''}`, 40),
    });
  }
  for (const a of accounts.filter((x) => x.status === 'signin_expired'))
    out.push({
      id: `signin-${a.key}`.slice(0, 120),
      tone: 'bad',
      icon: 'key',
      title: clip(`${labelOf(a.key)}’s sign-in has expired`, 120),
      detail: 'Fusebox skips it until someone signs in again.',
      link: { kind: 'url', label: 'Sign in again', url: input.url },
      nature: 'you',
      check: 'fusebox.signin',
      subject: accountSubject(a.key),
      ignore: { lifts: 'fixed', words: 'Until someone signs in again.' },
      badge: 'A sign-in has expired',
    });
  // An API key whose prepaid credit ran out (Fusebox 0.13+): only adding credit brings it back, so it has its own
  // line rather than “used up until”.
  const outOfCredit = new Set<string>();
  for (const f of input.faults) {
    const key = f.kind === 'credit' && f.accountId ? input.ids.get(f.accountId) : undefined;
    if (!key || outOfCredit.has(key)) continue;
    outOfCredit.add(key);
    out.push({
      id: `credit-${key}`.slice(0, 120),
      tone: 'bad',
      icon: 'key',
      title: clip(`${input.labels.get(key) ?? 'An API key'} is out of API credit`, 120),
      detail: 'Fusebox skips it until someone adds credit.',
      link: { kind: 'url', label: 'Open Fusebox', url: input.url },
      nature: 'you',
      check: 'fusebox.credit',
      subject: accountSubject(key),
      ignore: { lifts: 'fixed', words: 'Until it has credit again.' },
      badge: 'An API key is out of credit',
    });
  }
  const wholeTool = new Set(usedUp.map((u) => u.tool));
  for (const pool of input.pools.filter((p) => p.window === 'week' && p.runsOut && !wholeTool.has(p.tool))) {
    const early = pool.runsOut as NonNullable<Pool['runsOut']>;
    const top = [...pool.members].sort((a, b) => b.used - a.used)[0];
    const before = early.before.getTime() - early.at.getTime();
    out.push({
      id: `runs-out-${pool.tool}`,
      // A forecast: information, nothing anyone or any agent can fix (QN-01, FP-09).
      tone: 'info',
      icon: 'clock',
      title:
        `${TOOL_NAME[pool.tool]}’s week runs out ${untilWords(roundHour(early.at), now, timeZone)}`.replace(
          /(\d\d:\d\d)$/,
          'around $1',
        ),
      detail: clip(
        `${span(before)} before the first reset.${top && pool.members.length > 1 ? ` ${labelOf(top.key)} is at ${pct(top.used)}.` : ''}`,
        200,
      ),
      nature: 'fyi',
      check: 'fusebox.week_runs_out',
      subject: toolSubject(pool.tool),
      ignore: { lifts: 'period', words: 'Until the week resets.', until: early.before.toISOString() },
      badge: `${TOOL_NAME[pool.tool]}’s week runs out early`,
    });
  }
  const h = input.lastHour;
  const all = h ? h.ok + h.failed : 0;
  if (h && h.failed >= 10 && all > 0 && h.failed / all >= 0.02)
    out.push({
      id: 'failing',
      tone: 'warn',
      icon: 'warn',
      title: `${thousands(h.failed)} requests failed in the last hour`,
      detail: `That’s ${share((h.failed / all) * 100)} of ${thousands(all)}.`,
      link: { kind: 'url', label: 'Show them', url: `${input.url}/#/requests` },
      nature: 'problem',
      check: 'fusebox.failing',
      ignore: { lifts: 'fixed', words: 'Until they stop failing.' },
    });
  for (const f of input.faults) {
    const key = f.accountId ? input.ids.get(f.accountId) : undefined;
    const who =
      key && input.labels.has(key) ? labelOf(key) : (TOOL_NAME[f.provider as GatewayProvider] ?? f.provider);
    if (f.kind === 'storage')
      out.push({
        id: 'storage',
        tone: 'warn',
        icon: 'database',
        title: 'Fusebox can’t save its usage history',
        detail: 'Its figures of use and worth may miss requests.',
        link: { kind: 'url', label: 'Open Fusebox', url: `${input.url}/#/usage` },
        nature: 'problem',
        check: 'fusebox.storage',
        ignore: { lifts: 'fixed', words: 'Until Fusebox saves again.' },
        badge: 'Fusebox can’t save its history',
      });
    else if (f.kind === 'error' && f.key.startsWith('usage-refused:'))
      // Fusebox 0.14+: the provider keeps refusing the account's usage checks. That alone pauses none of its requests,
      // so it isn't “answers with an error”; the limits shown, Whombat's too, may be out of date.
      out.push({
        id: clip(`fault-${f.key}`, 120),
        tone: 'warn',
        icon: 'warn',
        title: clip(`${who}’s usage can’t be checked`, 120),
        detail:
          'Its provider refuses the usage checks, so the limits shown may be out of date. This alone doesn’t stop its requests.',
        link: { kind: 'url', label: 'Open Fusebox', url: input.url },
        nature: 'problem',
        check: 'fusebox.fault',
        subject: { id: `fault:${f.key}`.slice(0, 160), name: subjectName(who) },
        ignore: { lifts: 'fixed', words: 'Until the checks work again.' },
        badge: 'Usage checks refused',
      });
    else if (f.kind === 'failures' || f.kind === 'error') {
      const title = clip(
        f.kind === 'failures' ? `Requests keep failing on ${who}` : `${who} answers with an error`,
        120,
      );
      out.push({
        id: clip(`fault-${f.key}`, 120),
        tone: 'warn',
        icon: 'warn',
        title,
        link: { kind: 'url', label: 'Show them', url: `${input.url}/#/requests` },
        nature: 'problem',
        check: 'fusebox.fault',
        subject: { id: `fault:${f.key}`.slice(0, 160), name: subjectName(who) },
        ignore: { lifts: 'fixed', words: 'Until it clears.' },
        ...(title.length > 40 ? { badge: 'Requests keep failing' } : {}),
      });
    }
  }
  for (const a of accounts.filter(
    (x) => x.status === 'used_up' && !wholeTool.has(x.provider) && !outOfCredit.has(x.key),
  )) {
    const until = untilIso(a.until);
    out.push({
      id: `used-${a.key}`.slice(0, 120),
      tone: 'info',
      icon: 'clock',
      title: clip(
        `${labelOf(a.key)} is used up${a.until ? ` until ${untilWords(new Date(a.until), now, timeZone)}` : ''}`,
        120,
      ),
      detail: 'New sessions go to the others.',
      nature: 'fyi',
      check: 'fusebox.subscription_used_up',
      subject: accountSubject(a.key),
      ignore: until
        ? { lifts: 'period', words: 'Until it resets.', until }
        : { lifts: 'fixed', words: 'Until it has room again.' },
    });
  }
  for (const a of accounts.filter((x) => x.status === 'off' && isSubscription(x)))
    out.push({
      id: `off-${a.key}`.slice(0, 120),
      tone: 'info',
      icon: 'power',
      title: clip(`${labelOf(a.key)} is off in Fusebox`, 120),
      nature: 'fyi',
      check: 'fusebox.subscription_off',
      subject: accountSubject(a.key),
      ignore: { lifts: 'fixed', words: 'Until it’s on again.' },
    });
  const seen = new Set<string>();
  return out.filter((n) => {
    if (seen.has(n.id)) return false;
    seen.add(n.id);
    return true;
  });
}
