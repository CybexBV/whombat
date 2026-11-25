/**
 * The Inbox tab on the phone (Whombat inbox.md IBX-01…; needs-you-list.md NYL-01…NYL-09): the phone's parts around the
 * shared list (`@whombat/client`'s `needsYouListView`, its groups, buttons and words). Which way a row goes — what needs
 * the person, Later and Settled open its sheet; what the assistant is on opens its thread; a heads-up opens its place —
 * what a row swipes left to (Settle or Bring back at the edge, More beside it), and the sheet: its badge, words, what the
 * assistant says and every button stacked (More's too). Pure; the screen is `screens/NeedsYouScreen.tsx`, the sheet
 * `screens/NeedsYouSheet.tsx`.
 */

import {
  type InboxGroup,
  type LookResearchView,
  lookThreadHref,
  NEEDS_YOU_WORDS,
  type NeedsYouApprovalCard,
  type NeedsYouButton,
  type NeedsYouListGroupView,
  type NeedsYouListRow,
  needsYouApprovalCard,
  needsYouGroupLabel,
  needsYouMore,
  needsYouStatusLevel,
  needsYouSwipe,
  teamReportDraftOfHref,
} from '@whombat/client';
import {
  DESK_WORDS,
  fillDeskWords,
  formatPowerLeft,
  type HomeOverview,
  type HomeSeverity,
} from '@whombat/core';
import { formatClock } from '@whombat/core/text';

/** The tab's own words; the list's are the shared `NEEDS_YOU_WORDS`. */
export const NEEDS_YOU_TAB = {
  title: NEEDS_YOU_WORDS.title,
  loading: NEEDS_YOU_WORDS.loading,
  failed: NEEDS_YOU_WORDS.readFailed,
  /** What TalkBack calls a row's More sheet. */
  moreLabel: 'Inbox actions',
  opensSheet: 'Shows what you can do',
  opensThread: 'Opens its thread',
  opensPlace: 'Opens its page',
} as const;

/** Where a row goes when tapped: its sheet, an address (its thread, its place), or nowhere. */
export type PhoneRowOpens = { to: 'sheet' } | { to: 'href'; href: string } | null;

/**
 * What tapping a row does (NYL-07): what needs the person, Later and Settled open the sheet with their buttons; what the
 * assistant is on opens the thread where it works; a heads-up opens where it is.
 */
export function phoneRowOpens(row: Pick<NeedsYouListRow, 'group' | 'item' | 'href'>): PhoneRowOpens {
  switch (row.group) {
    case 'you':
    case 'later':
    case 'settled':
      return { to: 'sheet' };
    case 'assistant': {
      const href = row.item.research ? lookThreadHref(row.item.research) : null;
      return href ? { to: 'href', href } : null;
    }
    case 'fyi':
      return row.href ? { to: 'href', href: row.href } : null;
  }
}

/** What TalkBack hears after the row: what tapping it does. */
export function phoneRowHint(opens: PhoneRowOpens, group: InboxGroup): string | undefined {
  if (!opens) return undefined;
  if (opens.to === 'sheet') return NEEDS_YOU_TAB.opensSheet;
  return group === 'assistant' ? NEEDS_YOU_TAB.opensThread : NEEDS_YOU_TAB.opensPlace;
}

export interface PhoneSheetButton {
  id: string;
  label: string;
  variant: 'primary' | 'secondary' | 'quiet';
  button: NeedsYouButton;
}

export interface PhoneSheetView {
  /** `Needs you · pve-02`, `Settled`. */
  badge: string;
  /** Its severity; `ok` once the assistant fixed it, `mut` when it is quiet. */
  tone: HomeSeverity | 'ok' | 'mut';
  title: string;
  body: string;
  /** What the assistant says by its face; null without. */
  says: LookResearchView | null;
  /** “Since 07:12 · 3 h” under the title of a finding, as the desk's card; null otherwise. */
  since: string | null;
  /** “Until tomorrow 09:00”, “Ignored” on a quiet one. */
  note: string | null;
  buttons: PhoneSheetButton[];
  /** An approval's quiet words (Talk to Neo about it, Remind me tomorrow) sit side by side under its answers. */
  linksInRow: boolean;
  /** An approval's facts as the one approval card has them, before its answers; null for anything else. */
  approval: NeedsYouApprovalCard | null;
}

/**
 * A row's sheet: its group (and thing) as the badge, its words, what the assistant says, and every button stacked —
 * the row's way forward first, Settle (or Bring it back), then More's as quiet words. An approval's answers are equal
 * outlined buttons (none looks recommended), after its card's facts, and its quiet words share a row.
 */
export function phoneSheet(
  row: NeedsYouListRow,
  words: { Name: string },
  when?: { now: number; timeZone: string },
): PhoneSheetView {
  const where = row.item.subject?.name;
  const label = needsYouGroupLabel(row.group, words);
  const ordered = [...row.buttons.filter((b) => !b.more), ...needsYouMore(row)];
  const approval = row.item.kind === 'approval';
  return {
    badge: where ? `${label} · ${where}` : label,
    tone: row.says?.fixed ? 'ok' : row.group === 'later' || row.group === 'settled' ? 'mut' : row.tone,
    title: row.title,
    body: row.body,
    says: row.says,
    since:
      row.says && row.says.state === 'found' && when
        ? fillDeskWords(DESK_WORDS.calm.since, {
            clock: formatClock(row.item.at, when.timeZone),
            ago: formatPowerLeft((when.now - Date.parse(row.item.at)) / 60_000),
          })
        : null,
    note: row.state,
    buttons: ordered.map((b) => ({
      id: b.id,
      label: b.label,
      // An approval's answers are equal: none filled, so none looks recommended.
      variant: approval && b.kind === 'action' ? 'secondary' : b.look,
      button: b,
    })),
    linksInRow: approval,
    approval: when ? needsYouApprovalCard(row, { timeZone: when.timeZone, assistant: words.Name }) : null,
  };
}

/**
 * The tab's badge: the one count, `warn` — `bad` only when something that needs the person isn't working (the web's top
 * bar rule, `needsYouStatusLevel`): an ask is amber however serious. iPhone's bar draws the count in the unread pill's colours (`GlassTabs`).
 */
export function needsYouTabBadge(
  overview: Pick<HomeOverview, 'summary' | 'needsYou' | 'needsYouList'> | undefined,
): { count: number; tone: HomeSeverity | null } {
  if (!overview || overview.summary.needsYou === 0)
    return { count: overview?.summary.needsYou ?? 0, tone: null };
  const items = overview.needsYouList ?? overview.needsYou;
  const broken = items.some((i) => (i.group ?? 'you') === 'you' && needsYouStatusLevel(i) === 'notWorking');
  return { count: overview.summary.needsYou, tone: broken ? 'bad' : 'warn' };
}

/**
 * What a row swipes left to (inbox.md IBX-04): at the edge Settle, or Bring back on Later and Settled (a full swipe runs
 * it), and More beside it with the rest; a row with neither shows no swipe. `edge` and `more` are the row's buttons.
 */
export interface PhoneRowSwipe {
  edge: NeedsYouButton | null;
  more: NeedsYouButton[];
}

export function phoneRowSwipe(row: Pick<NeedsYouListRow, 'buttons'>): PhoneRowSwipe | null {
  const edge = needsYouSwipe(row);
  // Settle sits at the edge; More holds the rest (a line's More lists Settle too, but the swipe has it already).
  const more = needsYouMore(row).filter((b) => b !== edge);
  return edge || more.length ? { edge, more } : null;
}

/** The swipe's word at the edge: Settle, or the short Bring back. */
export function swipeEdgeLabel(edge: NeedsYouButton): string {
  return edge.kind === 'back' ? NEEDS_YOU_WORDS.backShort : edge.label;
}

/** What a screen reader gets for a row it can't swipe: the edge's action and More's, by the button's id. */
export function phoneRowActions(row: Pick<NeedsYouListRow, 'buttons'>): { name: string; label: string }[] {
  const swipe = phoneRowSwipe(row);
  if (!swipe) return [];
  return [...(swipe.edge ? [swipe.edge] : []), ...swipe.more].map((b) => ({ name: b.id, label: b.label }));
}

/**
 * What a Needs you row shows under its words (the one approval card, inbox.md): an approval its answers, equal and in
 * the one order, and so the 1Password guard's two; anything else its one way forward. The rest waits under More. Other groups show nothing inline: they
 * swipe and open their sheet.
 */
export interface PhoneRowInline {
  /** An approval's answers (Yes, now · Yes, tonight · No), all outlined alike. */
  answers: NeedsYouButton[];
  /** A line's one way forward (Ask Neo to handle it, Choose); null on an approval or with none. */
  lead: NeedsYouButton | null;
  more: NeedsYouButton[];
}

export function phoneRowInline(
  row: Pick<NeedsYouListRow, 'group' | 'item' | 'buttons'>,
): PhoneRowInline | null {
  if (row.group !== 'you') return null;
  const shown = row.buttons.filter((b) => !b.more);
  const more = needsYouMore(row);
  if (row.item.kind === 'approval') return { answers: shown, lead: null, more };
  // The 1Password guard's two answers are equal ways forward, like an approval's (Whombat onepassword-sync.md).
  if (shown.length > 1 && shown.every((b) => b.action?.kind === 'onepassword_removals'))
    return { answers: shown, lead: null, more };
  const [lead = null, ...rest] = shown;
  return { answers: [], lead, more: [...rest, ...more] };
}

/**
 * What an approval row offers after its answers: for the assistant's draft report its Edit, the form with the draft
 * (`draftId`); and where the Inbox doesn't take the yes (a draft too long to read there in full) the approval's own
 * screen (`approvalNumber`), whose card holds all of it and takes the yes. Null for what the row doesn't offer.
 */
export function approvalRowDoors(row: Pick<NeedsYouListRow, 'item' | 'buttons'>): {
  draftId: string | null;
  approvalNumber: number | null;
} {
  const draftId = teamReportDraftOfHref(row.item.href);
  const yes = row.buttons.some((b) => b.action?.kind === 'approve');
  const number = row.item.approvalNumber ?? null;
  return { draftId, approvalNumber: draftId && !yes && number ? number : null };
}

/** A group's heading with its count, the count left out when it is zero (“Settled”, never “Settled · 0”). */
export function groupHeading(group: Pick<NeedsYouListGroupView, 'label' | 'rows'>): string {
  return group.rows.length ? `${group.label} · ${group.rows.length}` : group.label;
}

/**
 * Whether an item's sheet still offers its buttons: while the Inbox lists the item, or one of its buttons is on its
 * way. An item that left (answered elsewhere, or an answer that may have gone through, which keeps it out until the
 * Whombat says otherwise) offers nothing more, so the same answer is never sent twice, as its page shows it gone.
 */
export function sheetOffersButtons(
  itemId: string,
  listed: readonly { id: string }[] | undefined,
  busy: boolean,
): boolean {
  return busy || !listed || listed.some((i) => i.id === itemId);
}
