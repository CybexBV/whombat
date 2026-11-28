/**
 * Burrow-less app paths (ui-improvements L, AP-360…): every burrow screen lives at the top level (`/chat`,
 * `/connections`, `/settings?tab=ai`) and the open burrow is the session's (hosted: the open appliance's; self-hosted:
 * remembered per browser). Links made before (and every link the servers make: emails, pushes, `linkPath()`, invites,
 * Android app links) carry the burrow as the first segment, `/<burrow>/<rest>`; they keep working by switching to that
 * burrow and going to `/<rest>`. `?burrow=<slug>` on a burrow-less path does the same switch.
 *
 * Pure and shared by web and mobile, so both read a path the same way.
 */
import { DEPLOYS_SECTION, type LinkRef, linkPath } from '@whombat/core';

/**
 * Every burrow screen's path, burrow-less, in the router's notation (`$param` is one segment). The web router's burrow
 * routes are exactly these (apps/web/src/app/router.test.tsx checks it).
 */
export const BURROW_ROUTES = [
  '/',
  '/pr/$number',
  '/runs/$number',
  // The Work view's old addresses (work-removal.md AP-851): still read as burrow screens, so old links, pushes and
  // Android app links resolve; the web redirects them (`workPath`).
  '/work',
  '/work/deploys',
  // The Inbox (web-efficiency.md WE-11).
  '/inbox',
  // Deploys, a page of its own (work-removal.md AP-850; was Work · Deploys, WE-17).
  '/deploys',
  '/canvases',
  '/canvases/$slug',
  '/log',
  '/search',
  '/settings',
  // The agent's own address (AgentLink; one-agent.md AP-4922): Settings → Agent.
  '/settings/agent',
  '/settings/feedback/new',
  '/settings/feedback/$id',
  // A screen's layout editor (Whombat desk-display.md DK-143; desk-display-web.md AP-5950).
  '/settings/screens/$id/layout',
  '/automations',
  '/automations/$id',
  '/automation-runs/$number',
  '/vault',
  // A conversation's Files (files-space.md AP-773, AP-774): the list, then one space in the conversations' own style.
  '/files',
  '/files/dm/$room',
  '/files/direct/$id',
  '/files/pr/$number',
  // The one-Whombat shell (app one-whombat-shell.md AP-1258…AP-1261, AP-1269): Needs you (Watch's address opens it,
  // needs-you-list.md NYL-05), task chats, a thing's page, Skills as a page, and everything Whombat did.
  '/needs-you',
  '/watch',
  // All chats (home-redesign.md AP-2215): Home's “All chats”; in the Chat shell they lead to Chat (chat-channel.md AP-2403).
  '/chats',
  '/chats/$id',
  // The Chat shell (Whombat chat-channel.md CHT-21; app chat-channel.md AP-2401): Chat, Feedback and Connections
  // (connections-page.md AP-2501; `/dashboard` its address before, still read and taken there).
  '/chat',
  // Code's address while Whombat had a separate Code list: still a screen (it goes to Chat), never a burrow's name.
  '/code',
  '/feedback',
  '/connections',
  '/dashboard',
  // Servers and Connections as places, a list beside a page (servers-connections-places.md); `/connections` is
  // Overview's, so Connections is `/connected`.
  '/servers',
  '/connected',
  '/things/$thing',
  '/skills',
  '/done',
  // What's protected (backup-trust.md): every thing that holds data and where its copy is.
  '/protected',
  // Reports to the Whombat Team (Whombat team-reports.md): the person's list, a new report (`?draft=` the assistant's
  // draft), and one report, which the box's Inbox item and push open.
  '/reports',
  '/reports/new',
  '/reports/$reportId',
  // What's new: the plain-language changelog, from This Whombat → About and the notice after an update. Under Settings,
  // so it takes no name a burrow may already have.
  '/settings/whats-new',
] as const;

/** The first segments of the burrow screens: a burrow named like one of these is read as the screen (AP-362). */
export const BURROW_SECTIONS: readonly string[] = [
  ...new Set(BURROW_ROUTES.map((r) => r.split('/')[1]).filter((s): s is string => !!s)),
];

const PATTERNS = BURROW_ROUTES.map((route) => new RegExp(`^${route.replace(/\$[a-z]+/gi, '[^/]+')}$`));

/** `/c/general/` → `/c/general`; `''` → `/`. */
function normalize(pathname: string): string {
  const p = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return p.length > 1 ? p.replace(/\/+$/, '') || '/' : p;
}

/** True when `pathname` is a burrow screen in the burrow-less form (`/chat`, `/`). */
export function isBurrowRoutePath(pathname: string): boolean {
  const p = normalize(pathname);
  return PATTERNS.some((re) => re.test(p));
}

export type SplitPath =
  /** A burrow screen in the new form: the open burrow's. */
  | { form: 'new'; path: string }
  /** The old form: `burrow` names the burrow, `path` is the screen in the new form. */
  | { form: 'old'; burrow: string; path: string };

/**
 * Which form a pathname is in (AP-362). A path that is a burrow screen as it stands is the new form, whatever its first
 * segment (so `/inbox` is the Inbox even where a burrow is called “inbox”). Otherwise the first segment is a burrow
 * when what follows it is a burrow screen (`/burrow-hq/c/general`, `/work/c/general`, `/burrow-hq`). Anything else is
 * neither (null): a page outside the burrow app, or nothing at all.
 */
export function splitBurrowPath(pathname: string): SplitPath | null {
  const p = normalize(pathname);
  if (isBurrowRoutePath(p)) return { form: 'new', path: p };
  const m = /^\/([^/]+)(\/.*)?$/.exec(p);
  if (!m?.[1]) return null;
  const rest = m[2] ?? '/';
  if (!isBurrowRoutePath(rest)) return null;
  let burrow: string;
  try {
    burrow = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return { form: 'old', burrow, path: rest };
}

/** Deploys: the environments board and the history (work-removal.md AP-850). */
export const DEPLOYS_PATH = '/deploys';

/**
 * Where a link to the Work view goes now that there is none (work-removal.md AP-851): its Deploys (`section` `deploys`,
 * `/work/deploys`) to Deploys, any other section (or none) to the Inbox. The
 * servers still send `{ type: 'work', section }` links (a deploy's event, a plan step without a place), and older
 * links say `/work?section=…` or `/work/deploys`; web and mobile read them all through this.
 */
export function workPath(section?: unknown): string {
  if (section === DEPLOYS_SECTION) return DEPLOYS_PATH;
  return '/inbox';
}

/**
 * The app path of a link, burrow-less (AP-364): `linkPath()` without its `/<burrow>` prefix. External links stay their
 * URL; a Work link is the Inbox or Deploys (`workPath`, AP-851). Every in-app link of the web uses this instead of
 * `linkPath()`.
 */
export function appPath(link: LinkRef, fallbackApprovalIn?: Parameters<typeof linkPath>[2]): string {
  if (link.type === 'work') return workPath(link.section);
  const full = linkPath('_', link, fallbackApprovalIn);
  if (link.type === 'external') return full;
  return full.startsWith('/_/') ? full.slice(2) : full;
}

/**
 * `path` for a given burrow, for a link that may be opened by someone in several burrows (a copied link, a push, a
 * link the phone opens in the browser): the burrow-less path with `?burrow=<slug>`, before any `#fragment`.
 */
export function withBurrow(path: string, burrow: string): string {
  const hashAt = path.indexOf('#');
  const before = hashAt < 0 ? path : path.slice(0, hashAt);
  const hash = hashAt < 0 ? '' : path.slice(hashAt);
  const param = `burrow=${encodeURIComponent(burrow)}`;
  return `${before}${before.includes('?') ? '&' : '?'}${param}${hash}`;
}
