/**
 * Tailscale's page (service-dashboards.md SD-42): which devices are online, which wait for approval, whose keys end
 * soon, which clients can update, who has which devices; one button, **Approve** for a device that waits. Read with
 * `/api/v2/tailnet/-/devices?fields=all` (each device's Tailscale owner) and, kept an hour, `/api/v2/tailnet/-/users`
 * for the owners' names (left out when the key may not read users). Never expires, removes or renames a device.
 */
import type {
  ThingGalleryItem,
  ThingLine,
  ThingPageItem,
  ThingPageKpi,
  ThingPageRow,
  ThingPageTab,
} from '@whombat/core';
import type { CatalogConnectionRow } from '../../../connections/types';
import { shortHash } from '../../quiet/items';
import type { KindCheck, KindNotice } from '../../quiet/types';
import { clip, line, list, plural, rec, span, str, thousands } from '../../words';
import { actAs } from '../act';
import { type PageButton, pageButton } from '../buttons';
import { cachedRead, getJson } from '../read';
import type { KindAction, KindModule } from '../registry';
import { seenFromView } from '../registry';
import {
  addedNote,
  countLine,
  type InventoryPanel,
  inventory,
  type LivePanel,
  liveRows,
  type PeoplePanel,
  people,
  slotPanels,
} from '../slots';
import type { KindCtx, KindView } from '../types';
import {
  ago,
  type ButtonCtx,
  badgeOf,
  daysUntil,
  inTime,
  itemLines,
  linesSeen,
  notOffered,
  okStatus,
  snapshotReader,
  unreadView,
} from './shared';

const NAME = 'Tailscale';
export const TAILSCALE_ADMIN = 'https://login.tailscale.com/admin/machines';
const TAILSCALE_USERS = 'https://login.tailscale.com/admin/users';
const DAY = 86_400_000;
/** A key ending within this many days is worth a look (SD-42). */
const KEY_SOON_DAYS = 14;
/** Offline longer than this is an info line. */
const OFFLINE_LONG_MS = 7 * DAY;
/** An expired key on a device offline this long: most likely a device nobody uses any more (QN-04), a heads-up. */
const ABANDONED_MS = 30 * DAY;
/** Without `connectedToControl`, seen this recently counts as online. */
const ONLINE_MS = 5 * 60_000;

export interface TailscaleDevice {
  id: string;
  /** The machine name (the first label of its MagicDNS name). */
  name: string;
  /** The tailnet's domain (“tail1234.ts.net”). */
  domain: string | null;
  user: string | null;
  tagged: boolean;
  os: string | null;
  version: string | null;
  updateAvailable: boolean;
  online: boolean;
  lastSeen: Date | null;
  /** When its key ends; null when key expiry is off. */
  expires: Date | null;
  authorized: boolean;
  /** Shared into this tailnet from another: not this tailnet's to look after. */
  external: boolean;
  /** When it was added to the tailnet (`created`; empty for shared-in devices). */
  joined?: Date | null;
}

export interface TailscaleUser {
  /** `displayName`: “Anna de Vries”. */
  name: string | null;
  joined: Date | null;
}

export interface TailscaleSnapshot {
  readAt: Date;
  devices: TailscaleDevice[];
  /** The tailnet's members by login name (the devices' `user`); null when the key may not read them. */
  users?: Map<string, TailscaleUser> | null;
}

const dateOf = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const t = Date.parse(s);
  // “0001-01-01T00:00:00Z” is Tailscale's “never”.
  return Number.isFinite(t) && t > 0 ? new Date(t) : null;
};

/** One device of `/devices?fields=all`. */
export function tailscaleDevice(raw: unknown, now: Date): TailscaleDevice | null {
  const d = rec(raw);
  const id = str(d.nodeId) ?? str(d.id);
  if (!id) return null;
  const full = str(d.name) ?? str(d.hostname) ?? id;
  const [first, ...rest] = full.split('.');
  const lastSeen = dateOf(d.lastSeen);
  const connected = typeof d.connectedToControl === 'boolean' ? d.connectedToControl : null;
  const tags = list(d.tags);
  const user = str(d.user);
  return {
    id: id.slice(0, 200),
    name: clip(first || full, 120),
    domain: rest.length ? rest.join('.').slice(0, 120) : null,
    user: user && !tags.length ? user.slice(0, 120) : null,
    tagged: tags.length > 0,
    os: str(d.os),
    version: str(d.clientVersion)?.split('-')[0]?.slice(0, 30) ?? null,
    updateAvailable: d.updateAvailable === true,
    online: connected ?? (lastSeen !== null && now.getTime() - lastSeen.getTime() <= ONLINE_MS),
    lastSeen,
    expires: d.keyExpiryDisabled === true ? null : dateOf(d.expires),
    authorized: d.authorized !== false,
    external: d.isExternal === true,
    joined: dateOf(d.created),
  };
}

/** `/api/v2/tailnet/-/users` (`{users: [{loginName, displayName, created}]}`): the members by login name. */
export function parseUsers(body: unknown): Map<string, TailscaleUser> {
  const out = new Map<string, TailscaleUser>();
  for (const raw of list(rec(body).users).slice(0, 1000)) {
    const u = rec(raw);
    const login = str(u.loginName);
    if (!login) continue;
    out.set(login.slice(0, 120), {
      name: str(u.displayName) ? clip(str(u.displayName) as string, 60) : null,
      joined: dateOf(u.created),
    });
  }
  return out;
}

export function parseDevices(body: unknown, now: Date): TailscaleDevice[] {
  return list(rec(body).devices)
    .slice(0, 1000)
    .map((d) => tailscaleDevice(d, now))
    .filter((d): d is TailscaleDevice => d !== null);
}

/** The members' names change rarely: kept an hour, apart from the devices' 30 seconds. */
const USERS_CACHE_MS = 60 * 60_000;

export const tailscaleReader = snapshotReader<TailscaleSnapshot>(
  NAME,
  'tailscale',
  async (services, row, now) => {
    const [devices, users] = await Promise.all([
      getJson(services, row, NAME, '/api/v2/tailnet/-/devices', { fields: 'all' }),
      cachedRead(
        services,
        `tailscale-users:${row.id}`,
        row,
        async () => parseUsers(await getJson(services, row, NAME, '/api/v2/tailnet/-/users')),
        USERS_CACHE_MS,
      ).catch(() => null),
    ]);
    return { readAt: now, devices: parseDevices(devices, now), users };
  },
);

/* What it means ------------------------------------------------------------------------------------------------------- */

/** This tailnet's own devices (shared-in ones are another tailnet's to look after). */
const own = (s: TailscaleSnapshot) => s.devices.filter((d) => !d.external);
const waiting = (s: TailscaleSnapshot) => own(s).filter((d) => !d.authorized);
const expired = (s: TailscaleSnapshot, now: Date) =>
  own(s).filter((d) => d.authorized && d.expires !== null && d.expires <= now);
/** Keys ending within 14 days, expired ones included, soonest first. */
const ending = (s: TailscaleSnapshot, now: Date) =>
  own(s)
    .filter((d) => d.authorized && d.expires !== null && daysUntil(d.expires, now) < KEY_SOON_DAYS)
    .sort((a, b) => (a.expires as Date).getTime() - (b.expires as Date).getTime());
const offlineLong = (s: TailscaleSnapshot, now: Date) =>
  own(s).filter(
    (d) => !d.online && d.authorized && d.lastSeen && now.getTime() - d.lastSeen.getTime() > OFFLINE_LONG_MS,
  );
const names = (ds: readonly TailscaleDevice[]) => clip(ds.map((d) => d.name).join(' · '), 200);

const OS_WORDS: Record<string, string> = {
  linux: 'Linux',
  windows: 'Windows',
  macos: 'macOS',
  ios: 'iOS',
  ipados: 'iPadOS',
  tvos: 'tvOS',
  android: 'Android',
  freebsd: 'FreeBSD',
  openbsd: 'OpenBSD',
  illumos: 'illumos',
  js: 'Browser',
};
export const osWords = (os: string | null) => (os ? (OS_WORDS[os.toLowerCase()] ?? os) : '');

export function tailscaleKpis(s: TailscaleSnapshot, now: Date): ThingPageKpi[] {
  const mine = own(s);
  const up = mine.filter((d) => d.online).length;
  const wait = waiting(s);
  const end = ending(s, now);
  const gone = expired(s, now);
  const updates = mine.filter((d) => d.updateAvailable);
  return [
    {
      key: 'online',
      label: 'Online',
      value: String(up),
      rest: `of ${mine.length}`,
      sub: up === mine.length ? 'all online' : `${mine.length - up} offline`,
      ...(mine.length ? { meter: up / mine.length } : {}),
      color: 'green',
    },
    {
      key: 'waiting',
      label: 'Waiting for approval',
      value: String(wait.length),
      sub: wait.length ? clip(names(wait), 80) : 'nobody waiting',
      ...(wait.length ? { tone: 'warn' as const } : {}),
    },
    {
      key: 'keys',
      label: 'Keys ending',
      value: String(end.length),
      rest: 'in 14 days',
      sub: gone.length
        ? `${gone.length} expired`
        : end[0]?.expires
          ? `first ${inTime(end[0].expires, now)}`
          : 'none soon',
      ...(gone.length ? { tone: 'bad' as const } : end.length ? { tone: 'warn' as const } : {}),
    },
    {
      key: 'updates',
      label: 'Updates',
      value: String(updates.length),
      sub: updates.length ? `${updates.length === 1 ? 'client' : 'clients'} can update` : 'all up to date',
    },
  ];
}

/** Every check Tailscale's page can raise (QN-15). */
export const TAILSCALE_CHECKS: readonly KindCheck[] = [
  { check: 'tailscale.key', name: 'Device keys ending', nature: 'you', perItem: true, startsOn: true },
  {
    check: 'tailscale.waiting',
    name: 'Devices waiting for approval',
    nature: 'you',
    perItem: true,
    startsOn: false,
  },
  {
    check: 'tailscale.updates',
    name: 'Tailscale updates on devices',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
  {
    check: 'tailscale.offline',
    name: 'Devices offline for a week',
    nature: 'fyi',
    perItem: false,
    startsOn: false,
  },
];

const deviceSubject = (d: TailscaleDevice) => ({ id: clip(`device:${d.id}`, 160), name: clip(d.name, 80) });
const admin = { kind: 'url' as const, label: 'Open Tailscale', url: TAILSCALE_ADMIN };

function keyLine(d: TailscaleDevice, now: Date): KindNotice {
  const expires = d.expires as Date;
  const expired = expires <= now;
  const base = {
    icon: 'key' as const,
    link: admin,
    check: 'tailscale.key',
    subject: deviceSubject(d),
    // A renewed key ends later: that's a new one.
    episode: expires.toISOString(),
    ignore: { lifts: 'newer' as const, words: 'Until it’s signed in again.' },
  };
  const gone = !d.online && d.lastSeen && now.getTime() - d.lastSeen.getTime() > ABANDONED_MS;
  if (expired && gone)
    return {
      ...base,
      id: clip(`key-${d.id}`, 120),
      tone: 'info',
      title: clip(
        `${d.name}’s key has expired; it’s been offline for ${span(now.getTime() - (d.lastSeen as Date).getTime())}`,
        120,
      ),
      detail: 'If nobody uses it any more, remove it in Tailscale.',
      nature: 'fyi',
    };
  return {
    ...base,
    id: clip(`key-${d.id}`, 120),
    tone: expired ? 'bad' : 'warn',
    title: clip(
      expired ? `${d.name}’s key has expired` : `${d.name}’s key ends ${inTime(expires, now)}`,
      120,
    ),
    detail: expired
      ? 'It can’t connect until someone signs in on it again.'
      : 'Sign in on it again, or turn off key expiry for it in Tailscale.',
    nature: 'you',
    badge: badgeOf(expired ? `Key expired: ${d.name}` : `${d.name}’s key ends soon`),
  };
}

const moreLine =
  (id: string, what: (n: number) => string, extra: Partial<KindNotice> = {}) =>
  (rest: readonly KindNotice[]) => ({
    id,
    title: what(rest.length),
    detail: clip(rest.map((n) => n.subject?.name ?? n.title).join(' · '), 200),
    ...extra,
  });

/** Worth a look (SD-42; quiet-notices.md QN-01…QN-04): one line per device whose key ends or that waits. */
export function tailscaleNotices(s: TailscaleSnapshot, now: Date, ctx?: ButtonCtx): KindNotice[] {
  const out: KindNotice[] = [];
  // Expired first, then the soonest to end (`ending` is soonest first, expired included).
  const keys = ending(s, now).map((d) => keyLine(d, now));
  const rank = { bad: 0, warn: 1, info: 2 } as const;
  keys.sort((a, b) => rank[a.tone] - rank[b.tone]);
  const expiredKeys = keys.filter((k) => k.tone === 'bad');
  out.push(
    ...itemLines(
      expiredKeys,
      moreLine(
        'key-expired-more',
        (n) => `${plural(n, 'more device key has', 'more device keys have')} expired`,
        { link: admin },
      ),
    ),
  );
  const wait = waiting(s).map(
    (d): KindNotice => ({
      id: clip(`waiting-${d.id}`, 120),
      tone: 'warn',
      icon: 'device',
      title: clip(`${d.name} is waiting for approval`, 120),
      detail: 'It joins the tailnet once someone approves it.',
      ...(ctx ? { action: approveButton(ctx, d) } : { link: admin }),
      nature: 'you',
      check: 'tailscale.waiting',
      subject: deviceSubject(d),
      ignore: { lifts: 'fixed', words: 'Until it’s approved or removed.' },
      badge: badgeOf(`${d.name} waits for approval`),
    }),
  );
  out.push(
    ...itemLines(
      wait,
      moreLine(
        'waiting-more',
        (n) => `${plural(n, 'more device is', 'more devices are')} waiting for approval`,
        { link: admin },
      ),
    ),
  );
  const rest = keys.filter((k) => k.tone !== 'bad');
  out.push(
    ...itemLines(
      rest,
      moreLine(
        'key-ending-more',
        (n) => `${plural(n, 'more device key ends', 'more device keys end')} within 14 days`,
        { link: admin },
      ),
    ),
  );
  const updates = own(s).filter((d) => d.updateAvailable);
  if (updates.length)
    out.push({
      id: 'updates',
      tone: 'info',
      icon: 'update',
      title: `${plural(updates.length, 'device')} can update Tailscale`,
      detail: names(updates),
      nature: 'fyi',
      check: 'tailscale.updates',
      episode: shortHash(updates.map((d) => `${d.id}@${d.version ?? ''}`)),
      ignore: { lifts: 'newer', words: 'Until another device can update.' },
    });
  const long = offlineLong(s, now);
  if (long.length)
    out.push({
      id: 'offline-long',
      tone: 'info',
      icon: 'network',
      title: `${plural(long.length, 'device')} offline for over a week`,
      detail: names(long),
      nature: 'fyi',
      check: 'tailscale.offline',
      episode: shortHash(long.map((d) => d.id)),
      ignore: { lifts: 'newer', words: 'Until another device goes offline.' },
    });
  return out;
}

/** The head when nothing is worth a look (QN-S30): how many are online; the lines say what's wrong. */
export function tailscaleStatus(s: TailscaleSnapshot): NonNullable<KindView['status']> {
  const mine = own(s);
  return okStatus(`${mine.filter((d) => d.online).length} of ${mine.length} online`);
}

/** Approve for a device that waits (SD-42 ✱). */
export function approveButton(ctx: ButtonCtx, d: TailscaleDevice): PageButton {
  return pageButton(ctx, {
    action: 'approve',
    target: d.id,
    label: 'Approve',
    icon: 'check',
    tone: 'primary',
    confirm: {
      title: clip(`Let ${d.name} join the tailnet?`, 80),
      body: 'It can reach what the tailnet’s access rules allow, like any other device.',
      button: 'Approve',
    },
  });
}

function seenWords(d: TailscaleDevice, now: Date) {
  if (!d.authorized) return { text: 'Waiting for approval', dot: 'warn' as const };
  if (d.online) return { text: 'Online', dot: 'ok' as const };
  return { text: d.lastSeen ? ago(d.lastSeen, now) : 'Offline', dot: 'off' as const };
}

function keyWords(d: TailscaleDevice, now: Date): ThingPageRow['cells'][string] {
  if (!d.expires) return { text: 'Never', tone: 'muted' };
  if (d.expires <= now) return { text: 'Expired', tone: 'bad' };
  const days = daysUntil(d.expires, now);
  return { text: inTime(d.expires, now), ...(days < KEY_SOON_DAYS ? { tone: 'warn' as const } : {}) };
}

/** The Devices table: waiting first, then expired keys, then online, then by name. */
export function tailscaleRows(s: TailscaleSnapshot, now: Date, ctx: ButtonCtx): ThingPageRow[] {
  const rank = (d: TailscaleDevice) =>
    !d.authorized ? 0 : d.expires && d.expires <= now ? 1 : d.online ? 2 : 3;
  return [...s.devices]
    .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
    .slice(0, 300)
    .map((d) => ({
      id: d.id,
      cells: {
        device: {
          text: d.name,
          ...(d.external ? { note: 'Shared with you' } : d.tagged ? { note: 'Tagged' } : {}),
        },
        owner: d.user ? { text: d.user } : { text: '—', tone: 'muted' as const },
        os: { text: osWords(d.os) },
        seen: seenWords(d, now),
        version: {
          text: d.version ?? '',
          mono: true,
          ...(d.updateAvailable ? { note: 'update', tone: 'warn' as const } : {}),
        },
        key: keyWords(d, now),
        ...(!d.authorized && !d.external
          ? { approve: { text: 'Approve', action: approveButton(ctx, d) } }
          : {}),
      },
    }));
}

export function tailscaleColumns(waiting: boolean) {
  return [
    { key: 'device', label: 'Device' },
    { key: 'owner', label: 'Owner' },
    { key: 'os', label: 'OS' },
    { key: 'seen', label: 'Seen' },
    { key: 'version', label: 'Version' },
    { key: 'key', label: 'Key ends' },
    ...(waiting ? [{ key: 'approve', label: '' }] : []),
  ];
}

export function tailscaleFacts(s: TailscaleSnapshot): ThingLine[] {
  const facts: ThingLine[] = [];
  const domain = own(s).find((d) => d.domain)?.domain;
  if (domain) facts.push(line(`Tailnet **${domain}**`));
  const people = new Set(own(s).flatMap((d) => (d.user ? [d.user] : []))).size;
  facts.push(
    line(
      `**${plural(own(s).length, 'device')}**${people ? ` · **${plural(people, 'person', 'people')}**` : ''}`,
    ),
  );
  return facts;
}

export interface TailscaleInput {
  snapshot: TailscaleSnapshot;
  now: Date;
  row: ButtonCtx['row'];
}

/** A device's owner as people say it: their name in Tailscale, else their login before the “@”. */
export function ownerName(s: TailscaleSnapshot, login: string): string {
  return s.users?.get(login)?.name ?? login.split('@')[0] ?? login;
}

/** Devices in Live: about as tall as Inventory beside it; the Devices tab has them all. */
const LIVE_DEVICES = 4;

/** A device's tag in Live: waiting or its key, the worst first (updates are counted in Inventory). */
function deviceBadge(d: TailscaleDevice, now: Date): NonNullable<ThingGalleryItem['badge']> | null {
  if (!d.authorized) return { text: 'Waiting', tone: 'warn' };
  if (d.expires && d.expires <= now) return { text: 'Key expired', tone: 'bad' };
  if (d.expires && daysUntil(d.expires, now) < KEY_SOON_DAYS)
    return { text: clip(`Key ends ${inTime(d.expires, now)}`, 30), tone: 'warn' };
  return null;
}

/**
 * Live, “Online now”: devices waiting for a yes first (with Approve), then the online ones, an ending key first and
 * tagged servers last; while few are online, the ones seen last after them, greyed.
 */
export function tailscaleLive(s: TailscaleSnapshot, now: Date, ctx: ButtonCtx): LivePanel | null {
  const mine = own(s);
  if (!mine.length) return null;
  const rank = (d: TailscaleDevice) => {
    const b = deviceBadge(d, now);
    // People's own devices before tagged servers: a server being on is the usual.
    return !d.authorized ? 0 : b?.tone === 'bad' ? 1 : b?.tone === 'warn' ? 2 : d.tagged ? 4 : 3;
  };
  const up = mine.filter((d) => d.online || !d.authorized);
  const shown = [...up].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  // A quiet tailnet still shows what was there last.
  if (shown.length < 4)
    shown.push(
      ...mine
        .filter((d) => !d.online && d.authorized && d.lastSeen)
        .sort((a, b) => (b.lastSeen as Date).getTime() - (a.lastSeen as Date).getTime())
        .slice(0, 4 - shown.length),
    );
  const online = mine.filter((d) => d.online).length;
  return liveRows({
    id: 'online',
    title: 'Online now',
    meta: online === mine.length ? `All ${mine.length} online` : `${online} of ${mine.length} online`,
    shape: 'square',
    items: shown.slice(0, LIVE_DEVICES).map((d): ThingGalleryItem => {
      const badge = deviceBadge(d, now);
      const sub = [osWords(d.os), d.version, d.tagged ? 'Tagged' : null].filter(Boolean).join(' · ');
      return {
        id: d.id,
        title: clip(d.name, 120),
        ...(sub ? { sub: clip(sub, 120) } : {}),
        ...(d.user ? { person: { name: clip(ownerName(s, d.user), 60) } } : {}),
        ...(badge ? { badge } : {}),
        // A device waiting for approval says so in its tag, beside Approve.
        ...(d.authorized
          ? {
              noteEnd: d.online
                ? 'Online'
                : d.lastSeen
                  ? clip(`Seen ${ago(d.lastSeen, now)}`, 60)
                  : 'Offline',
            }
          : {}),
        ...(d.online || !d.authorized ? {} : { muted: true }),
        ...(!d.authorized ? { actions: [approveButton(ctx, d)] } : {}),
      };
    }),
  });
}

const WEEK_MS = 7 * DAY;

/** Inventory, “In the tailnet”: its devices and people with who joined this week, and keys, updates and shares while any. */
export function tailscaleInventory(s: TailscaleSnapshot, now: Date): InventoryPanel | null {
  const mine = own(s);
  if (!mine.length) return null;
  const items: ThingPageItem[] = [];
  const recent = (at: Date | null | undefined) => !!at && now.getTime() - at.getTime() < WEEK_MS;
  const newDevices = mine.filter((d) => recent(d.joined)).length;
  const online = mine.filter((d) => d.online).length;
  items.push(
    countLine({
      id: 'devices',
      title: 'Devices',
      icon: 'device',
      value: thousands(mine.length),
      detail: online === mine.length ? 'all online' : `${online} online`,
      ...(addedNote(newDevices) ?? {}),
      url: TAILSCALE_ADMIN,
    }),
  );
  const logins = [...new Set(mine.flatMap((d) => (d.user ? [d.user] : [])))];
  if (logins.length) {
    const joined = s.users ? logins.filter((l) => recent(s.users?.get(l)?.joined)).length : null;
    items.push(
      countLine({
        id: 'people',
        title: 'People',
        icon: 'key',
        value: thousands(logins.length),
        ...(addedNote(joined) ?? {}),
        url: TAILSCALE_USERS,
      }),
    );
  }
  const tagged = mine.filter((d) => d.tagged).length;
  if (tagged)
    items.push(
      countLine({
        id: 'tagged',
        title: 'Tagged devices',
        icon: 'device',
        value: thousands(tagged),
        note: 'servers and the like',
      }),
    );
  const end = ending(s, now);
  const gone = expired(s, now).length;
  if (end.length)
    items.push(
      countLine({
        id: 'keys',
        title: 'Keys ending',
        icon: 'key',
        value: thousands(end.length),
        ...(gone
          ? { note: `${gone} expired`, noteTone: 'bad' as const }
          : end[0]?.expires
            ? { note: clip(`first ${inTime(end[0].expires, now)}`, 40), noteTone: 'warn' as const }
            : {}),
        url: TAILSCALE_ADMIN,
      }),
    );
  const updates = mine.filter((d) => d.updateAvailable).length;
  if (updates)
    items.push(
      countLine({
        id: 'updates',
        title: 'Can update',
        icon: 'update',
        value: thousands(updates),
        note: 'Tailscale itself',
      }),
    );
  const shared = s.devices.filter((d) => d.external).length;
  if (shared)
    items.push(
      countLine({
        id: 'shared',
        title: 'Shared with you',
        icon: 'network',
        value: thousands(shared),
        note: 'from other tailnets',
      }),
    );
  return inventory({ id: 'inventory', title: 'In the tailnet', items });
}

/**
 * People, “Who’s on it”: each person by their devices, how many are online; tagged and shared-in devices aren't
 * anyone's. Left out for one person: Inventory says it. Side by side, as it has the row to itself.
 */
export function tailscalePeople(s: TailscaleSnapshot): PeoplePanel | null {
  const by = new Map<string, TailscaleDevice[]>();
  for (const d of own(s)) if (d.user) by.set(d.user, [...(by.get(d.user) ?? []), d]);
  if (by.size < 2) return null;
  const panel = people({
    id: 'people',
    title: 'Who’s on it',
    meta: 'by devices',
    unit: ['device'],
    items: [...by.entries()]
      .map(([login, ds]) => ({ login, ds, up: ds.filter((d) => d.online).length }))
      .sort((a, b) => b.ds.length - a.ds.length || b.up - a.up || a.login.localeCompare(b.login))
      .map(({ login, ds, up }) => ({
        name: ownerName(s, login),
        n: ds.length,
        note: up ? `${up} online` : 'all offline',
      })),
  });
  return panel ? { ...panel, columns: Math.min(3, panel.items.length) } : null;
}

/**
 * The page's Tailscale part (SD-42), its Summary in slots: what's online now beside what the tailnet holds, then who's
 * on it; every device with its owner, OS, version and key in the Devices tab (its table is a desk's). No machine: a
 * cloud service. Pure.
 */
export function tailscaleView({ snapshot: s, now, row }: TailscaleInput): KindView {
  const ctx: ButtonCtx = { row };
  const rows = tailscaleRows(s, now, ctx);
  const columns = tailscaleColumns(waiting(s).length > 0);
  const mine = own(s);
  const offline = mine.filter((d) => !d.online).length;
  const tabs: ThingPageTab[] = rows.length
    ? [
        {
          key: 'devices',
          label: 'Devices',
          count: s.devices.length,
          panels: [
            {
              kind: 'table',
              id: 'devices',
              title: 'Devices',
              meta: offline ? `${offline} offline` : 'all online',
              columns,
              rows,
            },
          ],
        },
      ]
    : [];
  return {
    // In slots its figures are in Online now and In the tailnet; the card keeps them (`tailscaleCardView`).
    kpis: [],
    machine: 'after',
    charts: [],
    notices: tailscaleNotices(s, now, ctx),
    ...slotPanels({
      live: tailscaleLive(s, now, ctx),
      inventory: tailscaleInventory(s, now),
      people: tailscalePeople(s),
      more: mine.length
        ? []
        : [
            {
              kind: 'list',
              id: 'empty',
              title: 'Devices',
              items: [],
              empty: 'No devices in this tailnet yet.',
            },
          ],
      // A cloud service: no machine.
      machine: [],
    }),
    tabs,
    facts: tailscaleFacts(s),
    status: tailscaleStatus(s),
    open: { label: 'Open Tailscale', url: TAILSCALE_ADMIN },
    actions: [],
    readAt: s.readAt,
    suggestions: ['Devices offline this week', 'Keys ending this month', 'Who has which devices'],
  };
}

/** The page's part as the card reads it: the page in slots has no row of figures, the card keeps Online and Waiting. */
export function tailscaleCardView(input: TailscaleInput): KindView {
  return { ...tailscaleView(input), kpis: tailscaleKpis(input.snapshot, input.now) };
}

export async function tailscalePage(ctx: KindCtx): Promise<KindView> {
  const read = await tailscaleReader.latest(ctx.services, ctx.row, ctx.now);
  if (!read.ok) return unreadView(read, NAME, { label: 'Open Tailscale', url: TAILSCALE_ADMIN }, []);
  return {
    ...tailscaleView({ snapshot: read.value, now: ctx.now, row: ctx.row }),
    refreshing: read.refreshing,
  };
}

/** Approve one device that waits (SD-42): only one the last read shows waiting. */
const approve: KindAction = async ({ services, row, now }, { target }) => {
  const s = await tailscaleReader.cached(services, row, now);
  const d = s.devices.find((x) => x.id === target && !x.authorized && !x.external);
  if (!d) throw notOffered('That device');
  await actAs(services, row, NAME, {
    method: 'POST',
    path: `/api/v2/device/${encodeURIComponent(d.id)}/authorized`,
    body: { authorized: true },
  });
  return {
    message: `Approved ${d.name}. It can join the tailnet now.`,
    title: clip(`Approved ${d.name} in Tailscale`, 200),
  };
};

export const TAILSCALE_KIND: KindModule = {
  page: tailscalePage,
  seen: async (services, row: CatalogConnectionRow, now) => {
    const s = await tailscaleReader.cached(services, row, now);
    const view = tailscaleCardView({ snapshot: s, now, row });
    return {
      glance: seenFromView(view, { figures: 2, line: plural(own(s).length, 'device') }),
      points: {},
      // One read of every device: nothing is left unread.
      ...linesSeen(view, []),
    };
  },
  checks: TAILSCALE_CHECKS,
  actions: { approve },
};
