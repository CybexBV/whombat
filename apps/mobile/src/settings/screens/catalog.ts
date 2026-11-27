/**
 * *Add a widget* on the phone (Whombat desk-display.md DK-139, DK-143, DK-145, DK-153, DK-154, DK-159, DK-163, DK-164;
 * desk-display-android.md AP-6017, AP-6035, AP-6120…, AP-9980…): what the editor adds for a row of the shared rows
 * (`catalogRows`) and remembers of it for the tile, an account's name and what its widgets show, what's private on a
 * locked screen, and a server widget's part on another server. Pure.
 */

import type {
  DeskCatalog,
  DeskCatalogGroup,
  DeskCatalogItem,
  DeskWidget,
  NewWidget,
} from '@whombat/client/desk';
import { catalogName, isAccountGroup, sameWidget } from '@whombat/client/desk';
import { DESK_ACCOUNT_GITHUB } from '@whombat/core';
import { mobileTranslator } from '../../i18n/translate';
import type { KnownWidget } from './tiles';

/**
 * What the editor adds for an item, and what it remembers of it for the tile: its name (a server's by the server,
 * “pve-01 · Storage”), mark and view, and the thing or account it belongs to (“Google · anna@example.com”).
 */
export function fromCatalog(
  item: DeskCatalogItem,
  group: Pick<DeskCatalogGroup, 'key' | 'label' | 'thing'> & { mark?: string | null | undefined },
  locale?: string | null,
): { widget: NewWidget; known: KnownWidget } {
  const account = isAccountGroup(group);
  const mark = item.mark ?? (account ? group.mark : undefined);
  return {
    widget: { type: item.type, ...(item.ref ? { ref: item.ref } : {}), opts: { ...item.opts } },
    known: {
      name: item.type === 'server' ? catalogName(group, item) : item.name,
      ...(mark ? { mark } : {}),
      ...(item.view ? { view: item.view } : {}),
      ...(account ? { of: accountName(group, locale) } : group.thing ? { of: group.label } : {}),
    },
  };
}

/** Who holds an account, by its mark (the runtime marks an account by its provider). */
const ACCOUNT_PROVIDERS: Readonly<Record<string, string>> = {
  google: 'Google',
  microsoft: 'Microsoft 365',
  github: 'GitHub',
};

/**
 * An account by who holds it and its address, “Google · anna@example.com”: the runtime's label with the provider in
 * front where the label doesn't say it already (“GitHub” stays “GitHub”).
 */
export function accountName(
  group: { label: string; mark?: string | null | undefined },
  locale?: string | null,
): string {
  const email = mobileTranslator(locale).t('settings2.catalog.email');
  const provider = group.mark
    ? group.mark === 'mail' || group.mark === 'imap'
      ? email
      : ACCOUNT_PROVIDERS[group.mark]
    : undefined;
  if (!provider || group.label.toLowerCase().startsWith(provider.toLowerCase())) return group.label;
  return `${provider} · ${group.label}`;
}

/** What an account's widget shows, for its icon where it has no brand mark of its own. */
export type AccountShows = 'calendar' | 'mail' | 'pulls';

/**
 * What an account's widget shows, by its panel (*Today* and *Next meeting* a calendar, *Unread mail* mail, *Pull
 * requests* and *Waiting for review* pull requests; everything of the Whombat's GitHub is pull requests), or null for
 * a widget that isn't an account's or a panel it doesn't recognise.
 */
export function accountShows(w: {
  ref?: string | undefined;
  opts: Readonly<Record<string, string>>;
}): AccountShows | null {
  if (!w.ref?.startsWith('account:')) return null;
  if (w.ref === DESK_ACCOUNT_GITHUB) return 'pulls';
  const panel = w.opts.panel ?? '';
  if (/mail|unread|inbox/.test(panel)) return 'mail';
  if (/pull|review|^prs?\b/.test(panel)) return 'pulls';
  if (/today|next|meeting|calendar|agenda|event/.test(panel)) return 'calendar';
  return null;
}

/** An account widget's account in the catalogue: its group, by the widget's ref. */
export function accountGroup(
  catalog: DeskCatalog | undefined,
  ref: string | undefined,
): DeskCatalogGroup | null {
  if (!ref?.startsWith('account:')) return null;
  return catalog?.groups.find((g) => isAccountGroup(g) && (g.key === ref || g.thing === ref)) ?? null;
}

/**
 * Whether a widget shows what a locked screen leaves out (DK-138), so its sheet offers *On a locked screen*: as the
 * item it comes from says (`private`: what was read of the thing's page, a server's alerts, an account's calendar and
 * mail), else by what it draws — what's playing, camera stills and photos are — or by what it names: an account's
 * widgets are, but for the Whombat's GitHub.
 */
export function widgetPrivate(
  w: Pick<DeskWidget, 'type' | 'ref' | 'opts'>,
  groups: readonly Pick<DeskCatalogGroup, 'items'>[],
  view: string | undefined,
): boolean {
  if (w.type !== 'panel' && w.type !== 'figures' && w.type !== 'widget' && w.type !== 'server') return false;
  for (const g of groups)
    for (const item of g.items) if (sameWidget(item, w) && item.private !== undefined) return item.private;
  if (w.ref?.startsWith('account:')) return w.ref !== DESK_ACCOUNT_GITHUB;
  return w.type !== 'server' && (view === 'posters' || view === 'camera' || view === 'photo');
}

/** Whether a panel widget shows limits (Fusebox's): its sheet offers *Limits*, used or left. */
export function widgetLimits(
  w: Pick<DeskWidget, 'type' | 'ref' | 'opts'>,
  groups: readonly Pick<DeskCatalogGroup, 'items'>[],
): boolean {
  if (w.type !== 'panel') return false;
  return groups.some((g) => g.items.some((item) => sameWidget(item, w) && item.limits === true));
}

/** A server widget's options showing part `show` (the overview's is empty: no `show`), its other choices kept. */
export function withServerPart(opts: Readonly<Record<string, string>>, show: string): Record<string, string> {
  const { show: _was, ...rest } = opts;
  return show && show !== 'overview' ? { ...rest, show } : rest;
}

/** A server widget moved to another server: the same part when that server offers it, else its overview. */
export function onAnotherServer(
  opts: Readonly<Record<string, string>>,
  parts: readonly { show: string }[],
): Record<string, string> {
  const show = opts.show ?? '';
  return parts.some((p) => p.show === show) ? { ...opts } : withServerPart(opts, '');
}
