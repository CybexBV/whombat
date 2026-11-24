/**
 * A connection's or device's page on the phone (Whombat connection-pages.md CP-01…CP-19; connection-pages-mobile.md
 * AP-1950…AP-1999): what the screen draws from `things.page`, as plain data — the tabs (the server's, Activity, then
 * Connection, which opens the Connection screen; service-settings.md SST-06), the head's words, where “Runs on” and a panel's buttons go, which
 * panels show, notices with their way out, lists and what Whombat may do. The server words and formats everything;
 * this only arranges it for a narrow screen. Pure; the screen is `screens/ThingPageScreen.tsx`, the panels
 * `screens/thing/Panels.tsx`; figures, chart cards, bar lists and tables (the Summary's, contracts 0.89) are
 * `data/dashboard.ts`. What the assistant found out about what needs a look here is a card at the top of the Summary
 * (`thingLookCard`; Whombat look-research.md LR-09, look-research-mobile.md AP-5923).
 */
import {
  doneWhen,
  heldLine,
  type LookPlanCardView,
  type LookResearchView,
  lineNature,
  lookResearchView,
  lookThreadHref,
  noticeGroups,
  noticeLink,
  noticeRef,
  type QuietMenuView,
  quietLineText,
  quietMenu,
  quietUndo,
  researchPlanView,
  thingPageIsLive,
  thingRefreshMs,
  thingTabs,
} from '@whombat/client';
import {
  type ChatSubject,
  FEEDBACK_THING_ID,
  GITHUB_THING_ID,
  isAccountPageId,
  type LookResearch,
  type NoticeNature,
  type NoticeRef,
  parseThingId,
  type ThingImage,
  type ThingLine,
  type ThingNoticeIcon,
  type ThingPage,
  type ThingPageAccessItem,
  type ThingPageButton,
  type ThingPageLink,
  type ThingPageNotice,
  type ThingPagePanel,
  type ThingRunsOn,
} from '@whombat/core';
import type { AccountPage } from '../navigation/connectionLinks';
import { OVERVIEW_TITLE } from './shell';

export const THING_PAGE_COPY = {
  back: OVERVIEW_TITLE,
  loading: 'Loading its page',
  failed: 'This page didn’t load.',
  notFound: 'That isn’t one of your connections.',
  openSettings: 'Open its settings',
  tabs: (name: string) => `${name}: what to show`,
  settingsHint: 'Opens its settings',
  runsOn: 'Runs on',
  runsOnHint: 'Opens the machine it runs on',
  alsoConnected: 'Also connected',
  ask: (name: string) => `Ask about ${name}`,
  open: (label: string) => `Opens ${label.replace(/^Open /, '')} in your browser`,
  /** The Open button's word; its full name (“Open Home Assistant”) is what screen readers say. */
  openWord: 'Open',
  moreDetail: 'More detail',
  addressCopied: 'Address copied.',
  copyAddress: (address: string) => `Copy the address ${address}`,
  change: 'Change',
  changeHint: 'Opens its settings',
  lookOnly: 'Look only: every change is refused.',
  showAll: (n: number) => `Show all ${n}`,
  showEverything: 'Show all',
  showEverythingHint: 'Opens Activity',
  showOlder: 'Show older',
  undo: 'Undo',
  undone: 'Undone',
  review: 'Review',
  undoAsked: 'Undo waits for a person’s approval.',
  undoDone: 'Undone.',
  remove: 'Remove',
  removeHint: (title: string) => `Takes “${title}” off this page`,
  activityEmpty: (name: string) => `Nothing was changed on ${name} yet.`,
  activityFailed: 'What changed here didn’t load.',
  cancel: 'Cancel',
  /** A service's ⋯ in its back bar (Restart, its own buttons), and the sheet's way out. */
  more: (name: string) => `More for ${name}`,
  close: 'Close',
  figuresFrom: (when: string) => `Figures from ${when}.`,
} as const;

/** How many rows a table or list shows before “Show all” (a long Integrations table stays quick). */
export const PANEL_ROWS_FIRST = 25;
/** Activity's page size (`changes.list?thing=`). */
export const ACTIVITY_PAGE = 20;
/**
 * How often an open page reads again (CP-04, SD-09; AP-4535): its `refreshS` (5 s while something downloads or plays,
 * 10 s for controls and snapshots), else a minute — only while its screen is focused; TanStack's `focusManager` (bound
 * to the app's state) holds it while the app is in the background.
 */
export function thingPageInterval(
  focused: boolean,
  page: Pick<ThingPage, 'refreshS'> | null | undefined,
): number | false {
  return focused ? thingRefreshMs(page) : false;
}

/** A live page shown again (back on its screen) reads at once when its copy is older than its interval (AP-4535). */
export function readOnShow(
  page: Pick<ThingPage, 'refreshS'> | null | undefined,
  readAt: number,
  now: number,
): boolean {
  return !!page && thingPageIsLive(page) && now - readAt >= thingRefreshMs(page);
}

/* Tabs ------------------------------------------------------------------------------------------------------------ */

export interface PhoneThingTab {
  key: string;
  label: string;
  count: number | null;
  /**
   * Connection (the clients' own settings) opens the Connection screen instead of showing a tab (CP-19); an account's
   * opens its own screen (`thingSettingsOpens`).
   */
  settings: boolean;
  /** “Integrations, 171”. */
  spoken: string;
  /** Other tabs' keys a link may name for this one (a server's Summary links `docker` to the phone's Guests). */
  aliases?: readonly string[];
  /** The server a tab is about, which the screen draws from that server's own reads (Find My's Mac); else none. */
  server?: string | null;
}

/** The page's tabs: the server's in order, Activity, then Connection when the page has one (CP-05; AP-2634; SST-06). */
export function phoneThingTabs(
  page: Pick<ThingPage, 'tabs' | 'settings' | 'connectionId' | 'catalogId'>,
): PhoneThingTab[] {
  // An account's Connection is its own screen, which GitHub and Website feedback have without a connection id.
  return thingTabs(page)
    .filter((t) => t.own !== 'settings' || !!page.connectionId || isAccountPageId(page.catalogId))
    .map((t) => ({
      key: t.key,
      label: t.label,
      count: t.count,
      settings: t.own === 'settings',
      spoken: t.count === null ? t.label : `${t.label}, ${t.count}`,
      server: t.server,
    }));
}

/**
 * Where a page's Connection goes: an account's own screen (Google, Microsoft 365, Email, GitHub, Website feedback: its
 * sign-in, services and what the assistant may do, as Settings → Connections shows it), else the connection's
 * Connection screen; null without either. Before the page answers, or when an older box answers 404, the row the app
 * holds names the catalog entry, and GitHub's and Website feedback's ids name themselves.
 */
export type ThingSettingsOpens =
  | { screen: 'ConnectAccount'; page: AccountPage }
  | { screen: 'Connection'; connectionId: string };

export function thingSettingsOpens(
  thingId: string,
  catalogId: string | null | undefined,
  connectionId: string | null | undefined,
): ThingSettingsOpens | null {
  const account =
    catalogId ?? (thingId === GITHUB_THING_ID ? 'github' : thingId === FEEDBACK_THING_ID ? 'feedback' : null);
  if (isAccountPageId(account)) return { screen: 'ConnectAccount', page: account };
  return connectionId ? { screen: 'Connection', connectionId } : null;
}

/** The tab a link or an address asks for, if the page shows it as a tab; else the first (Overview). */
export function shownTab(tabs: readonly PhoneThingTab[], wanted: string | null | undefined): string {
  const shown = tabs.filter((t) => !t.settings);
  return shown.find((t) => t.key === wanted)?.key ?? shown[0]?.key ?? 'overview';
}

/* The head -------------------------------------------------------------------------------------------------------- */

/** A fact line as read aloud: its parts' words. */
export function lineText(line: ThingLine): string {
  return line
    .map((p) => p.text)
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The head as TalkBack reads it: “Home Assistant, Needs a look”; the name alone before its status is known. */
export function headSpoken(page: { name: string; badge: string | null }): string {
  return page.badge ? `${page.name}, ${page.badge}` : page.name;
}

/** Where “Runs on pve-02 · CT 131” goes: the guest's screen, else the server's page. */
export type RunsOnTarget =
  | { screen: 'Guest'; serverId: string; guestId: string; title: string }
  | { screen: 'Thing'; thingId: string; title: string };

export function runsOnTarget(runsOn: ThingRunsOn): RunsOnTarget {
  if (runsOn.guestId)
    return { screen: 'Guest', serverId: runsOn.serverId, guestId: runsOn.guestId, title: runsOn.name };
  return { screen: 'Thing', thingId: `server:${runsOn.serverId}`, title: runsOn.name };
}

/** The chat's subject for “Ask about …” (CP-17): the thing's own id, as `chats.list` filters by it. */
export function thingSubject(page: Pick<ThingPage, 'id' | 'kind' | 'name'>): ChatSubject | null {
  const parsed = parseThingId(page.id);
  if (!parsed || parsed.kind === 'server') return null;
  return { kind: parsed.kind, id: parsed.id, name: page.name };
}

/** The line under the head when the figures couldn't be read this time (CP-04): why, and how old the figures are. */
export function problemLine(
  page: Pick<ThingPage, 'problem' | 'readAt'>,
  now: Date | number,
  timeZone: string,
): string | null {
  if (!page.problem) return null;
  const from = page.readAt ? ` ${THING_PAGE_COPY.figuresFrom(doneWhen(page.readAt, now, timeZone))}` : '';
  return `${page.problem}${from}`;
}

/* What the assistant found out ------------------------------------------------------------------------------------- */

export interface ThingLookCardView {
  /** The page's research, which the step's button sends (`looks.fix`). */
  research: LookResearch;
  /** Its words and buttons (the shared `lookResearchView`): the step and Ask {assistant}; no Ignore here (AP-5923). */
  view: LookResearchView;
  /** The card's colour: green once fixed; else the page's, red when it is down or in trouble, amber otherwise. */
  tone: 'ok' | 'bad' | 'warn';
  /** Where Ask {assistant} goes: the look's thread in Chat; null asks about the thing in a new chat instead. */
  thread: string | null;
  /** The assistant's plan for everything here, when it offers one (handle-it.md): drawn as the plan card. */
  plan: LookPlanCardView | null;
  /** The plan card's colour while it waits. */
  planTone: 'bad' | 'warn';
}

/**
 * The card at the top of the Summary for what the assistant found out here (LR-09; AP-5923), as the web's: its title
 * (none while it looks: the page's head and Worth a look already say what is wrong), its words by its face, the step it
 * offers and Ask {assistant}. Null without research or once it failed (LR-11): the page as before.
 */
export function thingLookCard(
  page: Pick<ThingPage, 'research' | 'status'> & { name?: string },
  assistant: string,
): ThingLookCardView | null {
  const research = page.research;
  const view = lookResearchView(research, assistant);
  if (!research || !view) return null;
  const bad = page.status === 'bad' || page.status === 'offline';
  return {
    research,
    view,
    tone: view.fixed ? 'ok' : bad ? 'bad' : 'warn',
    thread: lookThreadHref(research),
    // A plan of several steps (handle-it.md): the plan card instead, Go ahead and Change something.
    plan: page.name ? researchPlanView(research, page.name) : null,
    planTone: bad ? 'bad' : 'warn',
  };
}

/* Buttons --------------------------------------------------------------------------------------------------------- */

/** What a panel's or notice's button does on the phone. */
export type LinkRun =
  | { kind: 'ask'; question: string }
  | { kind: 'tab'; tab: string }
  | { kind: 'settings' }
  | { kind: 'href'; href: string }
  | { kind: 'url'; url: string };

/**
 * A link's way out here: Ask opens the new-chat sheet with the question ready; a tab switches (Settings opens the
 * Connection screen); an app path opens its screen; an outside page the browser. A tab the page doesn't have: none.
 */
export function linkRun(
  link: ThingPageLink | undefined,
  tabs: readonly PhoneThingTab[],
): { label: string; run: LinkRun } | null {
  if (!link) return null;
  switch (link.kind) {
    case 'ask':
      return { label: link.label, run: { kind: 'ask', question: link.question } };
    case 'tab': {
      const own = tabs.find((t) => t.key === link.tab);
      const tab = own ?? tabs.find((t) => t.aliases?.includes(link.tab));
      if (!tab) return null;
      // “Open System” opens the phone's Array: the button says where it goes.
      const label = !own && /^Open /.test(link.label) ? `Open ${tab.label}` : link.label;
      return { label, run: tab.settings ? { kind: 'settings' } : { kind: 'tab', tab: tab.key } };
    }
    case 'href':
      return { label: link.label, run: { kind: 'href', href: link.href } };
    case 'url':
      return { label: link.label, run: { kind: 'url', url: link.url } };
  }
}

/* Panels ---------------------------------------------------------------------------------------------------------- */

/**
 * The panels the phone draws, in order (stacked: phones ignore widths): one with nothing to say is left out (less is
 * more, AP-1752) — a table or list without rows and words for none, an empty `access` — except `notices`, which says
 * its `empty`. `changes` and `widgets` decide once their lists are read.
 */
export function shownPanels(panels: readonly ThingPagePanel[]): ThingPagePanel[] {
  return panels.filter((p) => {
    switch (p.kind) {
      case 'table':
        return p.rows.length > 0 || !!p.empty;
      case 'list':
      case 'bars':
        return p.items.length > 0 || !!p.empty;
      case 'facts':
        return p.items.length > 0;
      case 'access':
        return p.items.length > 0 || p.lookOnly;
      case 'chart':
        return p.series.some((s) => s.values.some((v) => v !== null));
      // Contracts 0.121 (CT-1004, CT-1005): a gallery without items and a controls panel without tiles say `empty`.
      case 'gallery':
        return p.items.length > 0 || !!p.empty;
      case 'controls':
        return p.groups.some((g) => g.items.length > 0) || !!p.empty;
      // A service's settings (service-settings.md SST-01): a group without rows says `empty`.
      case 'settings':
        return p.rows.length > 0 || !!p.empty;
      default:
        return true;
    }
  });
}

/* Worth a look */

export interface NoticeRowView {
  id: string;
  /** The dot's tone; null for information and for a quiet line (greyed). */
  tone: 'bad' | 'warn' | null;
  icon: ThingNoticeIcon;
  title: string;
  /** The line's detail; a quiet line shows its quiet words instead (`quiet`). */
  detail: string | null;
  /** Its way out by its kind (QN-02, QN-S49: only a problem asks); none on a quiet line. */
  action: { label: string; run: LinkRun } | null;
  /** A button after the link (0.121, CT-1012): Retry, Clear, Dismiss. */
  button: ThingPageButton | null;
  /** Problem · Only you · Heads-up (QN-01). */
  nature: NoticeNature;
  /** The line as the quiet actions take it (its title, check, item and Ignore). */
  line: Pick<ThingPageNotice, 'title' | 'check' | 'subject' | 'ignore'>;
  /** Its ⋯ menu (QN-10): for who may quiet it, on a Whombat that can; null otherwise. */
  menu: QuietMenuView | null;
  /** A quiet line's grey words (QN-14): “Ignored by John until it’s back online”; null while it asks. */
  quiet: string | null;
  /** Undo on a quiet line, for who may quiet it: the line it takes back. */
  undo: NoticeRef | null;
  /**
   * End now on a line held by the thing kept quiet: it ends the whole window, not this
   * line's quiet. A line held by a cause has neither: it lifts when the cause is back.
   */
  endNow: boolean;
  /** Quiet with the whole thing (kept quiet, or down because of something else); null for its own or none. */
  held: 'window' | 'cause' | null;
  spoken: string;
}

/** A tone's words for TalkBack beside the dot. */
const NOTICE_TONE_WORDS = { bad: 'Problem', warn: 'Needs a look', info: null } as const;

/** The words a quiet line's Undo and ⋯ button are read with. */
export const QUIET_LINE_COPY = {
  /** “Undo: Hallway AP is offline”. */
  undoLabel: (title: string) => `Undo: ${title}`,
  undoHint: 'It asks again',
  menuHint: 'Ignore, remind you tomorrow or stop watching',
} as const;

/**
 * Worth a look's lines on the phone (QN-01…QN-14; quiet-notices-mobile.md AP-4860…AP-4862): each line's way out by its
 * kind — only a problem asks (“Ask Neo”, `askLabel`), an only-you line or a heads-up keeps where it's done or what shows more —,
 * its ⋯ menu for who may quiet it (`quiet`: the Whombat has `things.quiet`; an older runtime's lines get none), and a
 * quiet line greyed with its words and, for who may quiet it, Undo. The server sends quiet lines last; so they stay.
 */
export function noticeRows(
  panel: Extract<ThingPagePanel, { kind: 'notices' }>,
  tabs: readonly PhoneThingTab[],
  { quiet = false, askLabel }: { quiet?: boolean; askLabel?: string } = {},
): NoticeRowView[] {
  return panel.items.map((n) => {
    const quietText = quietLineText(n);
    const action = linkRun(noticeLink(n, askLabel), tabs);
    const words = quietText ? null : NOTICE_TONE_WORDS[n.tone];
    const detail = n.detail?.trim() || null;
    const held = heldLine(n);
    const ref = quiet && !held && quietUndo(n) ? noticeRef(n) : null;
    return {
      id: n.id,
      tone: n.tone === 'info' || quietText ? null : n.tone,
      icon: n.icon,
      title: n.title,
      detail: quietText ? null : detail,
      action,
      button: quietText ? null : (n.action ?? null),
      nature: lineNature(n),
      line: {
        title: n.title,
        ...(n.check ? { check: n.check } : {}),
        ...(n.subject ? { subject: n.subject } : {}),
        ...(n.ignore ? { ignore: n.ignore } : {}),
      },
      menu: quiet ? quietMenu(n) : null,
      quiet: quietText,
      undo: ref,
      endNow: quiet && held === 'window',
      held,
      spoken: (quietText ? [n.title, quietText] : [words, n.title, detail]).filter(Boolean).join('. '),
    };
  });
}

/**
 * The count beside “Worth a look”, in the worst tone: the lines that still ask (QN-14: a quiet line counts for nothing,
 * a heads-up neither: it waits folded); none when none does.
 */
export function noticesBadge(
  panel: Extract<ThingPagePanel, { kind: 'notices' }>,
): { text: string; tone: 'bad' | 'warn' | 'mut' } | null {
  const active = noticeGroups(panel.items).asking;
  if (!active.length) return null;
  const tone = active.some((n) => n.tone === 'bad')
    ? 'bad'
    : active.some((n) => n.tone === 'warn')
      ? 'warn'
      : 'mut';
  return { text: String(active.length), tone };
}

/* Lists */

export interface ListRowView {
  id: string;
  title: string;
  detail: string | null;
  right: string | null;
  tone: 'ok' | 'warn' | 'bad' | 'info' | null;
  icon: ThingNoticeIcon | null;
  /** A small picture before the words instead of the icon (0.121, CT-1002). */
  image: ThingImage | null;
  /** Buttons on the line (CT-1002): Mark resolved, Done. */
  actions: readonly ThingPageButton[];
  /** The service's own page for the line (CT-1013), opened in the browser. */
  url: string | null;
  spoken: string;
}

export function listRows(
  panel: Extract<ThingPagePanel, { kind: 'list' }>,
  now: Date | number,
  timeZone: string,
): ListRowView[] {
  return panel.items.map((it) => {
    const right = it.right?.trim() || (it.at ? doneWhen(it.at, now, timeZone) : null);
    return {
      id: it.id,
      title: it.title,
      detail: it.detail?.trim() || null,
      right,
      tone: it.tone ?? null,
      icon: it.icon ?? null,
      image: it.image ?? null,
      actions: it.actions ?? [],
      url: it.url ?? null,
      spoken: [it.title, it.detail, right].filter(Boolean).join('. '),
    };
  });
}

/* What Whombat may do */

export const ACCESS_TIER_WORDS: Record<ThingPageAccessItem['tier'], string> = {
  allowed: 'Allowed',
  ask: 'Asks you',
  off: 'Off',
  mixed: 'Mixed',
};

export interface AccessRowView {
  label: string;
  tier: string;
  tone: 'ok' | 'warn' | 'neutral';
  count: number;
  spoken: string;
}

export function accessRows(panel: Extract<ThingPagePanel, { kind: 'access' }>): AccessRowView[] {
  return panel.items.map((a) => {
    const tier = ACCESS_TIER_WORDS[a.tier];
    return {
      label: a.label,
      tier,
      tone: a.tier === 'allowed' ? 'ok' : a.tier === 'ask' ? 'warn' : 'neutral',
      count: a.count,
      spoken: `${a.label}: ${tier}, ${a.count === 1 ? '1 tool' : `${a.count} tools`}`,
    };
  });
}

/* Home and Things ------------------------------------------------------------------------------------------------- */

/** The things that are part of a server (“Also connected: Proxmox VE API”, CP-10): `partOf` is its thingId. */
export function partsOf<T extends { partOf?: string | undefined }>(
  things: readonly T[],
  serverId: string,
): T[] {
  return things.filter((t) => t.partOf === `server:${serverId}` || t.partOf === serverId);
}

/**
 * Worth a look's lines as the final pages fold them (16-final/connection; overview-server-connection-final.md): the
 * current problems shown with their buttons, and every heads-up — one with a button too — folded with the quiet lines
 * behind “Show 5 heads-ups”, not counted in the card's count (`noticesBadge` counts only what asks).
 */
export function foldHeadsUps<T extends Parameters<typeof noticeGroups>[0][number]>(
  items: readonly T[],
): { shown: T[]; folded: T[]; foldLabel: string | null } {
  const g = noticeGroups(items);
  const asking = new Set<T>(g.asking);
  const headsUps = items.filter((n) => !n.quiet && !asking.has(n));
  const quiet = items.filter((n) => n.quiet);
  // The shared label's quiet words (“2 ignored”), after its heads-ups count when it has one.
  const quietWords = quiet.length ? (g.foldLabel?.replace(/^Show (\d+ heads-ups? and )?/, '') ?? null) : null;
  const parts = [
    headsUps.length ? `${headsUps.length} heads-up${headsUps.length === 1 ? '' : 's'}` : null,
    quietWords,
  ].filter(Boolean);
  return {
    shown: [...g.asking],
    folded: [...headsUps, ...quiet],
    foldLabel: parts.length ? `Show ${parts.join(' and ')}` : null,
  };
}

/**
 * A page's Summary in reading order: what needs a look (Worth a look) before its controls, so the current problems come
 * first on every width; the rest keep their order.
 */
export function problemsFirst(panels: readonly ThingPagePanel[]): ThingPagePanel[] {
  const firstControls = panels.findIndex((p) => p.kind === 'controls');
  const look = panels.findIndex((p) => p.kind === 'notices');
  if (firstControls < 0 || look < 0 || look < firstControls) return [...panels];
  const out = panels.filter((_, i) => i !== look);
  out.splice(firstControls, 0, panels[look] as ThingPagePanel);
  return out;
}
