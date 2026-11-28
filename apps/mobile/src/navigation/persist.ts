/**
 * Where the person was, kept across a killed process (MN-01). Pure: what of the navigation state is saved (route names,
 * plain params and the open tab — no keys), and what of a saved one is restored: not older than 24 hours, the same
 * burrow, the tabs at the bottom, and only screens on the list below whose data the app can still vouch for — a
 * conversation or Files place must still be in the sidebar; a run, approval,
 * thread, plan, pull request, Vault entry or connection is restored and then watched: if its read answers that it is gone
 * (`RESTORE_WATCH`, `isGoneError`), the app falls back to the tabs. The stack is cut at the first screen that fails, so a
 * screen is never restored above one that couldn't be. Screens not on the list (sharing, new message, and any
 * added later until they are listed) aren't restored. The app always opens on Chat (Whombat chat-channel.md CHT-22;
 * chat-channel.md AP-2451, one-layout-android.md AP-2645): a saved tab is never restored, the screens above it are.
 */
import { tabWords } from '../data/shell';
import { branchRoomFor, type SidebarLookup, stripLinkedActionParams } from './routes';

/** The file's name in the secure box (per storage scope). */
export const NAV_STATE_NAME = 'navigation';
/** An older saved place isn't restored. */
export const NAV_MAX_AGE_MS = 24 * 3600_000;
/** At most this many screens are restored (the tabs and the top ones). */
export const NAV_MAX_DEPTH = 8;

export interface SavedRoute {
  name: string;
  params?: Record<string, unknown>;
  state?: SavedState;
}

export interface SavedState {
  index: number;
  routes: SavedRoute[];
}

export interface SavedNavigation {
  v: 1;
  savedAt: number;
  /** The burrow (slug) the place belongs to. */
  burrow: string;
  state: SavedState;
}

/** As much of React Navigation's state as this reads. */
export interface NavigationStateLike {
  index?: number;
  routes: readonly { name: string; params?: object; state?: NavigationStateLike | object }[];
}

/** Plain JSON params, or nothing (functions, cycles and the like are not kept). */
function plainParams(params: object | undefined): Record<string, unknown> | undefined {
  if (!params) return undefined;
  try {
    const copy = JSON.parse(JSON.stringify(params)) as unknown;
    return copy && typeof copy === 'object' && !Array.isArray(copy) && Object.keys(copy).length
      ? (copy as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function snapshotState(state: NavigationStateLike): SavedState {
  const index = Math.min(Math.max(state.index ?? state.routes.length - 1, 0), state.routes.length - 1);
  // Only the routes up to the focused one: what is above it is gone already (a stack) or isn't where the person was.
  const routes = state.routes.slice(0, index + 1).map((r) => {
    const out: SavedRoute = { name: r.name };
    const params = plainParams(r.params);
    if (params) out.params = params;
    const nested = r.state as NavigationStateLike | undefined;
    if (nested && Array.isArray(nested.routes) && nested.routes.length) out.state = snapshotState(nested);
    return out;
  });
  return { index: routes.length - 1, routes };
}

/** What is saved of the root state now; null when there is nothing to save. */
export function snapshotNavigation(
  state: NavigationStateLike | undefined,
  burrow: string,
  now: number,
): SavedNavigation | null {
  if (!state || !Array.isArray(state.routes) || state.routes.length === 0) return null;
  return { v: 1, savedAt: now, burrow, state: snapshotState(state) };
}

/** What the app knows when it restores: the burrow's sidebar. */
export interface RestoreWorld {
  /** The sidebar: the person's Chat and Feedback room, and the branch rooms. */
  sidebar: SidebarLookup;
  /** Managed builds have This Whombat's screens (the Overview, Backups, Devices, About) and Backup file. */
  managed: boolean;
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200;
const positive = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v > 0;

function conversationKnown(params: Record<string, unknown>, world: RestoreWorld): boolean {
  const { sidebar } = world;
  if ('conversationId' in params) {
    const id = params.conversationId;
    return str(id) && [...sidebar.dms, ...sidebar.branchRooms].some((c) => c.id === id);
  }
  if ('room' in params) return params.room === 'chat' || params.room === 'feedback';
  if ('prNumber' in params) {
    const number = Number(params.prNumber);
    const repo = typeof params.repo === 'string' ? params.repo : undefined;
    return positive(number) && branchRoomFor(sidebar.branchRooms, number, repo) !== null;
  }
  return false;
}

/** Screens whose data can only be checked by reading it: restored, then the read is watched (`RESTORE_WATCH`). */
const ENTITY_PARAMS: Record<string, (p: Record<string, unknown>) => boolean> = {
  Run: (p) => positive(p.number),
  Approval: (p) => positive(p.number),
  Automation: (p) => str(p.id),
  AutomationRun: (p) => positive(p.number),
  Thread: (p) => str(p.messageId),
  Plan: (p) => str(p.planId),
  PullRequest: (p) => positive(p.number),
  PullRequestFile: (p) => positive(p.number) && str(p.path),
  VaultEntry: (p) => str(p.entryId),
  Connection: (p) => str(p.connectionId),
  Canvas: (p) => str(p.slug),
};

/**
 * Lists that need nothing but the burrow. The Work screen is gone (work-removal-android.md AP-861): a place saved on it
 * is cut there like any screen not listed, so it opens on the tabs beneath.
 */
const LISTS = new Set([
  'ServersPlace',
  'ConnectionsPlace',
  'Plans',
  'Deploys',
  'Vault',
  'Connections',
  'AddConnection',
  'Files',
  'AuditLog',
  // The Settings tab's pages, the assistant's, Advanced.
  'SettingsAgent',
  'SettingsProfile',
  'SettingsPrompts',
  'SettingsNotifications',
  'SettingsAi',
  'SettingsWhombat',
  'SettingsDesk',
  'SettingsNews',
  'SettingsAdvanced',
  // Search, with what was typed (phone-shell-final.md).
  'Search',
]);

/** Whether a saved screen may be restored now (see the file comment). */
export function restorableRoute(route: SavedRoute, world: RestoreWorld): boolean {
  const p = route.params ?? {};
  switch (route.name) {
    case 'Plans':
      // One conversation's plans (work-removal-android.md AP-859), or all of them.
      return !('conversationId' in p) || conversationKnown(p, world);
    case 'Conversation':
    case 'Pins':
    case 'ConversationFiles':
      return conversationKnown(p, world);
    case 'Spend':
      return true;
    case 'Memory':
      // What the agent remembers about you (AP-5271).
      return true;
    case 'Whombat':
    case 'WhombatBackups':
    case 'Devices':
    case 'WhombatAbout':
    case 'WhombatHardware':
    case 'WhombatRemoteHelp':
    case 'BackupFile':
    case 'BackupOptions':
      return world.managed;
    case 'BackupDetail':
      return world.managed && str(p.checkpointId);
    // The one-Whombat screens (AP-1374, AP-2451), then watched (`RESTORE_WATCH`).
    case 'Chat':
      return str(p.conversationId);
    case 'Done':
    case 'Skills':
    case 'Feedback':
      return true;
    case 'Skill':
      return str(p.name);
    // Settings → Screens → a screen and its layout (desk-display-android.md AP-6004): a screen that's gone says so.
    case 'SettingsScreen':
    case 'SettingsScreenLayout':
      return str(p.screen);
    // One of Advanced's own pages: an unknown one opens the list.
    case 'SettingsAdvancedPart':
      return str(p.part);
    case 'Thing':
      return str(p.thingId);
    case 'Guest':
      return str(p.serverId) && str(p.guestId);
    case 'ServerUpdates':
      return str(p.serverId);
    case 'Settled':
      return p.room === undefined || p.room === 'chat' || p.room === 'feedback';
    default: {
      if (LISTS.has(route.name)) return true;
      const entity = ENTITY_PARAMS[route.name];
      return !!entity && entity(p);
    }
  }
}

/**
 * The initial state to restore, or undefined (nothing usable: none saved, too old, another burrow or format, or
 * nothing above the tabs). Always the tabs at the bottom, on Chat; the screens above them as far as each may be
 * restored.
 */
export function restorableNavigation(
  saved: SavedNavigation | null | undefined,
  input: { now: number; burrow: string; world: RestoreWorld; locale?: string },
): SavedState | undefined {
  if (saved?.v !== 1 || saved.burrow !== input.burrow || !saved.state || !Array.isArray(saved.state.routes))
    return undefined;
  if (!(input.now - saved.savedAt < NAV_MAX_AGE_MS) || saved.savedAt > input.now + 60_000) return undefined;
  const [first, ...rest] = saved.state.routes;
  const above: SavedRoute[] = [];
  for (const route of first?.name === 'Tabs' ? rest : saved.state.routes) {
    if (typeof route?.name !== 'string' || !restorableRoute(route, input.world)) break;
    const params = chatParams(route, input.locale);
    above.push(params ? { name: route.name, params } : { name: route.name });
  }
  if (above.length === 0) return undefined;
  const routes: SavedRoute[] = [{ name: 'Tabs' }, ...above.slice(-(NAV_MAX_DEPTH - 1))];
  return stripLinkedActionParams({ index: routes.length - 1, routes });
}

/**
 * What the tabs that are gone used to be called (Code, and the Overview in English and Dutch): a page opened from one
 * goes back to the tabs, which open on Chat.
 */
const GONE_TAB_WORDS: readonly unknown[] = ['Code', 'Overview', 'Overzicht'];

/**
 * A saved screen's params as they read now that the Code and Overview tabs are gone: a page opened from one says
 * “‹ Chat” and goes back there, and Code's Settled is Chat's.
 */
function chatParams(route: SavedRoute, locale?: string): Record<string, unknown> | undefined {
  const p = route.params;
  const gone = !!p && GONE_TAB_WORDS.includes(p.back);
  if (!p || (!gone && !(route.name === 'Settled' && 'place' in p))) return p;
  const out = { ...p };
  if (gone) out.back = tabWords(locale).ChatRoom;
  if (route.name === 'Settled') delete out.place;
  return out;
}

/**
 * The read each entity screen opens with (endpoint id): when it answers that the thing is gone, a restored screen
 * falls back to the tabs.
 */
export const RESTORE_WATCH: Readonly<Record<string, string>> = {
  Run: 'runs.get',
  Approval: 'approvals.get',
  Automation: 'automations.get',
  AutomationRun: 'automations.run',
  Thread: 'messages.thread',
  Plan: 'plans.get',
  PullRequest: 'prs.get',
  PullRequestFile: 'prs.get',
  VaultEntry: 'vault.get',
  Connection: 'connections.tools',
  Canvas: 'canvases.content',
  Conversation: 'conversations.get',
  Chat: 'conversations.get',
  Thing: 'hosts.getServer',
  Guest: 'hosts.getGuest',
  ServerUpdates: 'hosts.getServer',
  Skill: 'skills.librarySkill',
};

/** A read's error that means the thing is gone for this person: not found, gone, or no longer allowed. */
export function isGoneError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { status, code } = error as { status?: unknown; code?: unknown };
  return status === 404 || status === 410 || status === 403 || code === 'not_found' || code === 'forbidden';
}
