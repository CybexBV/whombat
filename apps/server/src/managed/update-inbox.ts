/**
 * The Inbox's one item about an update waiting for the owner (docs/decisions/ask-before-updating.md ABU-05): while the
 * box's manager holds an update because the owner asked to approve each one, one calm item says it is ready and opens
 * This Whombat's updates, where Update now installs it. It goes once the update installs or the switch goes off. It
 * starts on: the owner asked to be asked, and an update nobody approves leaves security fixes out (watch-defaults.md).
 */
import type { UpdateFacts } from '@whombat/control-contracts/local';
import type { NeedsYouItem } from '@whombat/core';
import { burrows } from '../db/schema/index';
import { homeAudience, publishHomeChanged } from '../home/notify';
import { registerNeedsYouSource, type SourceCtx, sourceLocale } from '../home/registry';
import { tServer } from '../i18n/catalog';
import { loadPrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { checkStartsOn, registerChecks } from '../things/quiet/defaults';

/** The check behind the item. */
export const UPDATE_OWNER_CHECK = 'update.owner';
registerChecks([
  // The owner holds every update for their yes: without the ask, security fixes never reach the box. Update now fixes it.
  { check: UPDATE_OWNER_CHECK, startsOn: true },
]);

/** This Whombat → About, where the updates and the switch are. */
export const UPDATES_HREF = '/settings?tab=appliance&section=about';

/** The item's words in a locale. */
export function updateReadyWords(locale?: string | null) {
  return {
    title: tServer(locale, 'managed.update.title'),
    body: tServer(locale, 'managed.update.body'),
    open: tServer(locale, 'managed.update.open'),
  };
}

export const UPDATE_READY_WORDS = updateReadyWords(null);

/** The release waiting for the owner's yes, or null. */
export function ownerWaitOf(update: UpdateFacts | null | undefined): string | null {
  return update?.waiting?.reason === 'owner' && update.candidate ? update.candidate : null;
}

/** The item (pure): one per release, so a newer one waiting is a new item. */
export function updateReadyItem(release: string, since: string, locale?: string | null): NeedsYouItem {
  const words = updateReadyWords(locale);
  return {
    id: `update:owner:${release}`.slice(0, 200),
    ref: { kind: 'update', id: release },
    kind: 'alert',
    severity: 'info',
    nature: 'you',
    title: words.title,
    body: words.body,
    at: since,
    actions: [{ id: 'open', label: words.open, style: 'primary', kind: 'open', href: UPDATES_HREF }],
    href: UPDATES_HREF,
  };
}

/** Registers the source (idempotent; the managed runtime does at its start), reading the manager's last update facts. */
export function registerUpdateOwnerSource(update: () => UpdateFacts | null): void {
  registerNeedsYouSource('update-owner', async (ctx: SourceCtx): Promise<NeedsYouItem[]> => {
    if (!checkStartsOn(UPDATE_OWNER_CHECK)) return [];
    const facts = update();
    const release = ownerWaitOf(facts);
    if (!release || !facts?.waiting) return [];
    const person = ctx.reads?.person ?? (await loadPrincipalRow(ctx.db, ctx.personId));
    if (person?.kind !== 'person') return [];
    return [updateReadyItem(release, new Date(facts.waiting.since).toISOString(), await sourceLocale(ctx))];
  });
}

/** Home reads its Inbox again when the update waiting for the owner came, went or changed. */
export async function tellUpdateInbox(
  services: Services,
  before: UpdateFacts | null | undefined,
  after: UpdateFacts | null | undefined,
): Promise<void> {
  if (ownerWaitOf(before) === ownerWaitOf(after)) return;
  const rows = await services.db.select({ id: burrows.id }).from(burrows);
  await services.pipeline.transactAccount(async (tx, session) => {
    for (const { id } of rows) publishHomeChanged(session, await homeAudience({ tx }, id), ['needsYou']);
  });
}
