/**
 * A server's Summary on the phone (Whombat dashboards.md DS-02, DS-09, DS-16, DS-17; dashboards-mobile.md
 * AP-2127…AP-2131): what the screen needs around `serverDashboard`'s panels — the phone's tabs as the renderer's (with
 * the web's tab keys each one stands for, so “Docker →” opens Guests) and where a link into the same server goes (one
 * of its tabs, a guest's screen, or nowhere for a console, which stays on the web). The panels and their words are
 * `@whombat/client/hosts` `serverDashboard`; the screen is `screens/ServerScreen.tsx`.
 */
import { parseThingId } from '@whombat/core';
import { SERVER_COPY } from './servers';
import type { PhoneThingTab } from './thingPage';

/** The server segments the phone has (the rest stay on the web). */
export type ServerTab = 'summary' | 'guests' | 'backups' | 'array' | 'plugins' | 'screen' | 'findmy';

/**
 * The web's tab keys each phone segment stands for: a Summary's link to Docker, Containers, VMs or Instances opens
 * Guests; Unraid's notifications (its System on the web) and pools are on Array; its updates on Plugins.
 */
const SERVER_TAB_ALIASES: Record<ServerTab, readonly string[]> = {
  summary: ['overview'],
  guests: ['docker', 'containers', 'vms', 'instances'],
  backups: [],
  array: ['pools', 'disks', 'notifications', 'system'],
  plugins: ['updates'],
  // A Mac's screen and its Find My (macos-servers.md).
  screen: [],
  findmy: [],
};

/** The phone's segments as the renderer's tabs, with the keys a link may name for each. */
export function serverPhoneTabs(tabs: readonly ServerTab[]): PhoneThingTab[] {
  return tabs.map((key) => ({
    key,
    label: SERVER_COPY[key],
    count: null,
    settings: false,
    spoken: SERVER_COPY[key],
    aliases: SERVER_TAB_ALIASES[key],
  }));
}

/** The phone segment a web tab key stands for, if the phone has it. */
export function serverTabFor(key: string, tabs: readonly ServerTab[]): ServerTab | null {
  const direct = tabs.find((t) => t === key);
  if (direct) return direct;
  return tabs.find((t) => SERVER_TAB_ALIASES[t].includes(key)) ?? null;
}

/** Where a link into a server's own page goes: a tab (`?tab=`), a guest (`?guest=`, `gtab`), its console. */
export interface ServerLinkTarget {
  tab: string | null;
  guest: string | null;
  guestTab: string | null;
  console: boolean;
}

/**
 * A link's target when it is this server's own page (`/things/server%3Apve-02?tab=storage`, with or without a burrow
 * before it); null for anything else (another server, a chat, an outside page), which opens as any link.
 */
export function serverLinkTarget(href: string, serverId: string): ServerLinkTarget | null {
  let url: URL;
  try {
    url = new URL(href, 'https://whombat.invalid');
  } catch {
    return null;
  }
  const m = /^(?:\/[^/]+)?\/things\/([^/]+)\/?$/.exec(url.pathname);
  if (!m?.[1]) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  const thing = parseThingId(id);
  if (thing?.kind !== 'server' || thing.id !== serverId) return null;
  const q = url.searchParams;
  return {
    tab: q.get('tab'),
    guest: q.get('guest'),
    guestTab: q.get('gtab'),
    console: q.has('console'),
  };
}
