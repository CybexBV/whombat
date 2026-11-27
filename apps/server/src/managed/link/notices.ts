/**
 * What the owner hears when Whombat Link stops (docs/decisions/whombat-link.md LNK-06, LNK-06a): one Inbox item while
 * the 7 days of grace run, asking to turn on Tailscale as a second way in and to check the paper copy of the backup
 * details, with one push to their devices when grace starts; then, once Link ended, one Inbox item saying what still
 * works and how to come back. Both start on (watch-defaults.md): the box is about to lose, or lost, its way in from
 * away, and the person can act. The items follow the state (no store); the push is marked so a restart doesn't repeat it.
 */
import type { NeedsYouItem } from '@whombat/core';
import { eq } from 'drizzle-orm';
import { applianceState, burrows } from '../../db/schema/index';
import { homeAudience, publishHomeChanged } from '../../home/notify';
import { registerNeedsYouSource, type SourceCtx, sourceLocale } from '../../home/registry';
import { type ServerMessageKey, tServer } from '../../i18n/catalog';
import { loadPrincipalRow } from '../../read/principals';
import type { Services } from '../../services';
import { checkStartsOn, registerChecks } from '../../things/quiet/defaults';
import { dayText } from '../own-address/notices';
import type { ControlPush } from '../push';
import type { LinkService, LinkView } from './service';

export const LINK_CHECKS = [
  // Link stops in a few days: the box is about to lose its way in from away; Tailscale and the paper copy fix it.
  { check: 'link.grace', startsOn: true },
  // Link stopped: the person can't reach the box from away; turning on Tailscale or subscribing again fixes it.
  { check: 'link.ended', startsOn: true },
] as const;
registerChecks(LINK_CHECKS);

/** This Whombat, where Reach (Link, the address, Tailscale) is. */
export const REACH_HREF = '/settings?tab=appliance&section=about';
/** Where the backup details' paper copy is checked. */
export const BACKUP_DETAILS_HREF = '/settings?tab=appliance&section=backups';

/** The words in a locale, one place each (CLAUDE.md: short and plain; push-words.md for the push). */
export function linkWords(locale?: string | null) {
  const t = (key: ServerMessageKey, vars?: Record<string, string>) => tServer(locale, key, vars);
  return {
    graceTitle: t('managed.link.graceTitle'),
    graceBody: (date: string) => t('managed.link.graceBody', { date }),
    graceTailscale: t('managed.link.graceTailscale'),
    graceBackup: t('managed.link.graceBackup'),
    endedTitle: t('managed.link.endedTitle'),
    // Every client shows this as it is, the iPhone app included, and an iPhone app names no price, sign-up or place to
    // buy: the e-mail, the box's screen and the account site say how to subscribe again.
    endedBody: t('managed.link.endedBody'),
    endedOpen: t('managed.link.endedOpen'),
    pushTitle: t('managed.link.pushTitle'),
    pushBody: (date: string) => t('managed.link.pushBody', { date }),
  };
}

export const LINK_WORDS = linkWords(null);

/** The items for Link now (pure). */
export function linkItems(view: LinkView, locale?: string | null): NeedsYouItem[] {
  if (!view.enabled || view.assumed) return [];
  const words = linkWords(locale);
  const link = view.link;
  if (link.state === 'grace' && checkStartsOn('link.grace')) {
    const ends = link.graceEndsAt ?? link.since;
    return [
      {
        id: `link.grace:${ends}`.slice(0, 200),
        ref: { kind: 'link', id: `grace:${ends}`.slice(0, 200) },
        kind: 'alert',
        severity: 'warn',
        nature: 'you',
        title: words.graceTitle,
        body: words.graceBody(dayText(ends, locale)),
        at: link.since,
        actions: [
          { id: 'open', label: words.graceTailscale, style: 'primary', kind: 'open', href: REACH_HREF },
          {
            id: 'backup',
            label: words.graceBackup,
            style: 'secondary',
            kind: 'open',
            href: BACKUP_DETAILS_HREF,
          },
        ],
        href: REACH_HREF,
      },
    ];
  }
  if (link.state === 'ended' && checkStartsOn('link.ended'))
    return [
      {
        id: `link.ended:${link.since}`.slice(0, 200),
        ref: { kind: 'link', id: `ended:${link.since}`.slice(0, 200) },
        kind: 'alert',
        severity: 'warn',
        nature: 'you',
        title: words.endedTitle,
        body: words.endedBody,
        at: link.since,
        actions: [{ id: 'open', label: words.endedOpen, style: 'primary', kind: 'open', href: REACH_HREF }],
        href: REACH_HREF,
      },
    ];
  return [];
}

/** Registers the Needs you source (the runtime does at its start). */
export function registerLinkSource(link: () => LinkService | null): void {
  registerNeedsYouSource('link', async (ctx: SourceCtx) => {
    const service = link();
    if (!service) return [];
    const person = ctx.reads?.person ?? (await loadPrincipalRow(ctx.db, ctx.personId));
    if (person?.kind !== 'person') return [];
    return linkItems(service.view(), await sourceLocale(ctx));
  });
}

/**
 * Follows Link for the owner: Home reads its Inbox again when the state moved, and the start of grace is pushed once
 * per stop (its grace's end marks it).
 */
export function followLinkNotices(
  services: Services,
  link: LinkService,
  push: Pick<ControlPush, 'notice'>,
  accounts: () => Promise<string[]>,
): () => void {
  return link.onChange((after, before) => {
    if (after.link.state === before.link.state && after.enabled === before.enabled) return;
    void (async () => {
      const rows = await services.db.select({ id: burrows.id }).from(burrows);
      await services.pipeline.transactAccount(async (tx, session) => {
        for (const { id } of rows) publishHomeChanged(session, await homeAudience({ tx }, id), ['needsYou']);
      });
      if (after.assumed || after.link.state !== 'grace' || !checkStartsOn('link.grace')) return;
      const ends = after.link.graceEndsAt ?? after.link.since;
      const mark = `grace:${ends}`;
      const claimed = await services.pipeline.transactAccount(async (tx) => {
        const [row] = await tx
          .select({ noticed: applianceState.linkNoticed })
          .from(applianceState)
          .where(eq(applianceState.id, 1))
          .for('update');
        if (!row || row.noticed === mark) return false;
        await tx.update(applianceState).set({ linkNoticed: mark }).where(eq(applianceState.id, 1));
        return true;
      });
      if (!claimed) return;
      const date = dayText(ends);
      await push.notice('security', await accounts(), `link-grace:${ends}`, {
        title: LINK_WORDS.pushTitle,
        body: LINK_WORDS.pushBody(date),
        path: REACH_HREF,
        words: (locale) => {
          const w = linkWords(locale);
          return { title: w.pushTitle, body: w.pushBody(dayText(ends, locale)) };
        },
      });
    })().catch((err) => services.log.warn({ err: String(err) }, 'link: the notice wasn’t given'));
  });
}
