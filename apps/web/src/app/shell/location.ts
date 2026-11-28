/**
 * Where the user is inside a burrow, parsed from the (burrow-less, AP-360) pathname. The sidebar uses it for the selected
 * row; the keyboard layer for "close search" and Alt+↑/↓.
 */
/** The Inbox's address on the web (inbox.md IBX-01); core's `NEEDS_YOU_HREF` is the older one, which opens it. */
export const INBOX_PATH = '/inbox';

export type ShellLocation =
  /** `repo`: the room's repository from `?repo=` (essentials item 5, AP-496). */
  | { kind: 'pr'; number: number; repo?: string }
  | { kind: 'run'; number: number }
  | { kind: 'canvases'; slug?: string }
  | { kind: 'log' }
  | { kind: 'search' }
  /** `usage`: Usage's page (`?tab=advanced&part=spend`), named as itself when a thread opened from it. */
  | { kind: 'settings'; usage?: true }
  | { kind: 'automations' }
  /** The Vault (`/vault`, AP-671). */
  | { kind: 'vault' }
  /** Files (`/files`, `/files/pr/12`, … AP-773, AP-774). */
  | { kind: 'files' }
  /** Deploys (`/deploys`, work-removal.md AP-850). */
  | { kind: 'deploys' }
  | { kind: 'home' }
  /** Chat or the Feedback room (`/chat`, `/feedback`; chat-channel.md AP-2401). */
  | { kind: 'room'; room: 'chat' | 'feedback' }
  /**
   * Servers (`/servers`) or Connections (`/connected`) with no page picked (servers-connections-places.md); also the
   * connections' own pages (`/connections?connection=…`) and the Overview's old addresses, which open Connections.
   */
  | { kind: 'place'; place: 'servers' | 'connections' }
  /** The Inbox (`/inbox`, and the older `/needs-you` and Watch's `/watch`, which open it; inbox.md IBX-01). */
  | { kind: 'needsYou' }
  /** A task chat (`/chats/:id`), or a new one (`/chats/new`; AP-1260). */
  | { kind: 'chat'; id: string }
  /** A server, connection or device (`/things/:thing`, and its pages below it; AP-1258). `id` is the thingId. */
  | { kind: 'thing'; id: string }
  /** Everything Whombat did (`/done`; AP-1269). */
  | { kind: 'done' }
  | { kind: 'other' };

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** `?repo=owner/name` of a branch room's address, when it is one. */
function repoOf(search: Record<string, unknown> | undefined): string | undefined {
  const repo = search?.repo;
  return typeof repo === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : undefined;
}

export function parseShellLocation(pathname: string, search?: Record<string, unknown>): ShellLocation {
  const [, section, id, extra, more] = pathname.split('/').map(decode);
  // A thing's page and the pages under it (a guest of a server) keep its sidebar row selected (AP-1258).
  if (section === 'things' && id) return { kind: 'thing', id };
  if (section === 'files') return !id || (extra && !more) ? { kind: 'files' } : { kind: 'other' };
  if (extra) return { kind: 'other' };
  switch (section) {
    case undefined:
    case '':
      return { kind: 'home' };
    case 'pr':
    case 'runs': {
      const number = Number(id);
      if (!Number.isInteger(number) || number <= 0) return { kind: 'other' };
      if (section === 'runs') return { kind: 'run', number };
      const repo = repoOf(search);
      return repo ? { kind: 'pr', number, repo } : { kind: 'pr', number };
    }
    case 'canvases':
      return id ? { kind: 'canvases', slug: id } : { kind: 'canvases' };
    case 'log':
      return id ? { kind: 'other' } : { kind: 'log' };
    case 'search':
      return id ? { kind: 'other' } : { kind: 'search' };
    case 'settings':
      if (id) return { kind: 'other' };
      return search?.tab === 'advanced' && search.part === 'spend'
        ? { kind: 'settings', usage: true }
        : { kind: 'settings' };
    case 'deploys':
      return id ? { kind: 'other' } : { kind: 'deploys' };
    case 'vault':
      return id ? { kind: 'other' } : { kind: 'vault' };
    case 'automations':
    case 'automation-runs':
      return { kind: 'automations' };
    case 'inbox':
    case 'needs-you':
    case 'watch':
      return id ? { kind: 'other' } : { kind: 'needsYou' };
    case 'chat':
    case 'feedback':
      return id ? { kind: 'other' } : { kind: 'room', room: section };
    case 'connections':
    case 'dashboard':
      return id ? { kind: 'other' } : { kind: 'place', place: 'connections' };
    case 'servers':
      return id ? { kind: 'other' } : { kind: 'place', place: 'servers' };
    case 'connected':
      return id ? { kind: 'other' } : { kind: 'place', place: 'connections' };
    case 'chats':
      return id ? { kind: 'chat', id } : { kind: 'other' };
    case 'done':
      return id ? { kind: 'other' } : { kind: 'done' };
    default:
      return { kind: 'other' };
  }
}
